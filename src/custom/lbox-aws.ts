import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { register } from '../cli/registry.js';
import type { CallerContext } from '../cli/frame.js';
import { DATA_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getSession } from '../db/sessions.js';
import { isSafeAttachmentName } from '../attachment-safety.js';
import { isPathInside } from '../inbox-safety.js';
import { log } from '../log.js';
import {
  notifyAgent,
  registerApprovalHandler,
  requestApproval,
  type ApprovalHandler,
} from '../modules/approvals/index.js';
import { registerApprovalResolvedHandler } from '../modules/approvals/primitive.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { sessionDir } from '../session-manager.js';

const ACTION = 'lbox_aws_deploy_static_file';
const COMMAND = 'lbox-aws-deploy-static-file';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_PROFILES = new Set(['lbox-system']);
const TARGETS_PATH = path.join(process.cwd(), 'container', 'skills', 'lbox-aws', 'references', 'targets.json');
const STATE_ROOT = path.join(DATA_DIR, 'team-lbox-aws');

export interface StaticFileTargetPreset {
  description?: string;
  profile: string;
  s3UriPrefix: string;
  contentType: string;
  sse: 'AES256';
  distributionId: string;
  invalidationPathPrefix: string;
  cdnUrlPrefix: string;
  allowedExtensions?: string[];
}

export interface StaticFileTarget {
  description?: string;
  profile: string;
  s3Uri: string;
  contentType: string;
  sse: 'AES256';
  distributionId: string;
  invalidationPath: string;
  cdnUrl: string;
  allowedExtensions?: string[];
}

export interface StaticFileDeployRequest extends StaticFileTarget {
  attachment: string;
  target?: string;
}

export interface StagedStaticFileDeploy extends StaticFileDeployRequest {
  deploymentId: string;
  stagedPath: string;
  originalName: string;
  size: number;
  sourceSha256: string;
}

export interface StaticFileDeployResult {
  deploymentId: string;
  sourceSha256: string;
  downloadedSha256: string;
  uploadVerified: true;
  invalidationId: string;
  invalidationStatus: 'Completed';
  cdnUrl: string;
  backupPath: string;
}

export type AwsRunner = (args: string[]) => Promise<string>;

function stringArg(raw: Record<string, unknown>, name: string): string | undefined {
  const value = raw[name] ?? raw[name.replace(/-/g, '_')];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${name} must be a non-empty string`);
  return value.trim();
}

export function loadStaticFileTargets(): Record<string, StaticFileTargetPreset> {
  const parsed = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')) as Record<string, StaticFileTargetPreset>;
  for (const [name, target] of Object.entries(parsed)) validateTargetPreset(target, `target ${name}`);
  return parsed;
}

export function parseStaticFileDeployRequest(raw: Record<string, unknown>): StaticFileDeployRequest {
  const attachment = stringArg(raw, 'attachment');
  if (!attachment) throw new Error('--attachment is required');

  const targetName = stringArg(raw, 'target');
  if (targetName) {
    const overrideNames = [
      'profile',
      's3-uri',
      'content-type',
      'sse',
      'distribution-id',
      'invalidation-path',
      'cdn-url',
    ];
    const override = overrideNames.find(
      (name) => raw[name] !== undefined || raw[name.replace(/-/g, '_')] !== undefined,
    );
    if (override) throw new Error(`--${override} cannot override preset target "${targetName}"`);

    const preset = loadStaticFileTargets()[targetName];
    if (!preset) throw new Error(`unknown LBox AWS target: ${targetName}`);
    const destination = normalizeDestination(stringArg(raw, 'destination') ?? path.posix.basename(attachment));
    const encodedDestination = encodeUrlPath(destination);
    const request: StaticFileDeployRequest = {
      attachment,
      target: targetName,
      profile: preset.profile,
      s3Uri: `${preset.s3UriPrefix}${destination}`,
      contentType: preset.contentType,
      sse: preset.sse,
      distributionId: preset.distributionId,
      invalidationPath: `${preset.invalidationPathPrefix}${encodedDestination}`,
      cdnUrl: `${preset.cdnUrlPrefix}${encodedDestination}`,
      allowedExtensions: preset.allowedExtensions,
    };
    validateTarget(request, `target ${targetName} destination`);
    return request;
  }

  if (stringArg(raw, 'destination')) throw new Error('--destination requires --target');

  const request: StaticFileDeployRequest = {
    attachment,
    profile: stringArg(raw, 'profile') ?? '',
    s3Uri: stringArg(raw, 's3-uri') ?? '',
    contentType: stringArg(raw, 'content-type') ?? '',
    sse: (stringArg(raw, 'sse') ?? '') as 'AES256',
    distributionId: stringArg(raw, 'distribution-id') ?? '',
    invalidationPath: stringArg(raw, 'invalidation-path') ?? '',
    cdnUrl: stringArg(raw, 'cdn-url') ?? '',
  };
  validateTarget(request, 'request');
  return request;
}

function normalizeDestination(destination: string): string {
  if (
    destination.startsWith('/') ||
    /[\\\x00-\x1f\x7f]/.test(destination) ||
    destination.length > 512 ||
    destination.split('/').some((part) => !isSafeAttachmentName(part) || part.length > 255)
  ) {
    throw new Error('destination must be a safe relative path inside the preset target');
  }
  return destination;
}

function encodeUrlPath(destination: string): string {
  return destination
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join('/');
}

function validateTargetPreset(target: StaticFileTargetPreset, label: string): void {
  if (!target.s3UriPrefix.endsWith('/')) throw new Error(`${label}: S3 URI prefix must end with /`);
  const s3 = parseS3Uri(`${target.s3UriPrefix}placeholder`);
  if (!s3.bucket.startsWith('lbox-')) throw new Error(`${label}: S3 bucket must be an LBox bucket`);
  validateSharedTargetFields(target, label);
  if (
    !target.invalidationPathPrefix.startsWith('/') ||
    !target.invalidationPathPrefix.endsWith('/') ||
    target.invalidationPathPrefix.includes('..') ||
    /[\x00-\x1f\x7f]/.test(target.invalidationPathPrefix)
  ) {
    throw new Error(`${label}: invalid CloudFront invalidation path prefix`);
  }
  validateCdnUrl(target.cdnUrlPrefix, target.invalidationPathPrefix, label);
}

function validateSharedTargetFields(
  target: Pick<StaticFileTarget, 'profile' | 'contentType' | 'sse' | 'distributionId' | 'allowedExtensions'>,
  label: string,
): void {
  if (!ALLOWED_PROFILES.has(target.profile)) {
    throw new Error(`${label}: unsupported AWS profile "${target.profile}"`);
  }
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(target.contentType)) throw new Error(`${label}: invalid content type`);
  if (target.sse !== 'AES256') throw new Error(`${label}: only AES256 SSE is allowed`);
  if (!/^E[A-Z0-9]+$/.test(target.distributionId)) throw new Error(`${label}: invalid CloudFront distribution id`);
  if (target.allowedExtensions?.some((extension) => !/^\.[a-z0-9]+$/.test(extension))) {
    throw new Error(`${label}: invalid allowed extension`);
  }
}

function validateCdnUrl(cdnUrl: string, expectedPath: string, label: string): void {
  let cdn: URL;
  try {
    cdn = new URL(cdnUrl);
  } catch {
    throw new Error(`${label}: invalid CDN URL`);
  }
  if (cdn.protocol !== 'https:' || (cdn.hostname !== 'lbox.kr' && !cdn.hostname.endsWith('.lbox.kr'))) {
    throw new Error(`${label}: CDN URL must use an lbox.kr HTTPS host`);
  }
  if (cdn.username || cdn.password || cdn.search || cdn.hash || cdn.pathname !== expectedPath) {
    throw new Error(`${label}: CDN URL path must exactly match the CloudFront invalidation path`);
  }
}

function validateTarget(target: StaticFileTarget, label: string): void {
  validateSharedTargetFields(target, label);
  const s3 = parseS3Uri(target.s3Uri);
  if (!s3.bucket.startsWith('lbox-')) throw new Error(`${label}: S3 bucket must be an LBox bucket`);
  if (!target.invalidationPath.startsWith('/') || target.invalidationPath.includes('..')) {
    throw new Error(`${label}: invalid CloudFront invalidation path`);
  }
  validateCdnUrl(target.cdnUrl, target.invalidationPath, label);
  const extension = path.posix.extname(s3.key).toLowerCase();
  if (target.allowedExtensions && !target.allowedExtensions.includes(extension)) {
    throw new Error(`${label}: target does not accept ${extension || 'extensionless'} destinations`);
  }
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (
    !match ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(match[1]) ||
    /[\x00-\x1f\x7f]/.test(match[2]) ||
    match[2].length > 1024 ||
    match[2].split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`invalid S3 URI: ${uri || '(empty)'}`);
  }
  return { bucket: match[1], key: match[2] };
}

export function resolveSessionAttachment(sessionRoot: string, attachment: string): string {
  const relative = attachment.startsWith('/workspace/') ? attachment.slice('/workspace/'.length) : attachment;
  const parts = relative.split('/');
  if (
    parts.length !== 3 ||
    parts[0] !== 'inbox' ||
    !isSafeAttachmentName(parts[1]) ||
    !isSafeAttachmentName(parts[2])
  ) {
    throw new Error('attachment must be /workspace/inbox/<message-id>/<filename>');
  }

  const inboxRoot = path.join(sessionRoot, 'inbox');
  const candidate = path.join(inboxRoot, parts[1], parts[2]);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('attachment must be a regular file');
  const resolved = fs.realpathSync(candidate);
  const resolvedInbox = fs.realpathSync(inboxRoot);
  if (!isPathInside(resolvedInbox, resolved)) throw new Error('attachment escaped the session inbox');
  if (stat.size === 0 || stat.size > MAX_FILE_BYTES) {
    throw new Error(`attachment size must be between 1 byte and ${MAX_FILE_BYTES} bytes`);
  }
  return resolved;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function stageAttachment(
  request: StaticFileDeployRequest,
  ctx: Extract<CallerContext, { caller: 'agent' }>,
): StagedStaticFileDeploy {
  const source = resolveSessionAttachment(sessionDir(ctx.agentGroupId, ctx.sessionId), request.attachment);
  const originalName = path.basename(source);

  const deploymentId = `aws-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const stagingDir = path.join(STATE_ROOT, 'staging', deploymentId);
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const stagedPath = path.join(stagingDir, originalName);
  fs.copyFileSync(source, stagedPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(stagedPath, 0o600);
  const stat = fs.statSync(stagedPath);

  return {
    ...request,
    deploymentId,
    stagedPath,
    originalName,
    size: stat.size,
    sourceSha256: sha256File(stagedPath),
  };
}

export async function requestStaticFileDeployment(
  request: StaticFileDeployRequest,
  ctx: CallerContext,
  applyDeployment: ApprovalHandler = applyStaticFileDeployment,
): Promise<Record<string, unknown>> {
  if (ctx.caller !== 'agent') throw new Error(`${COMMAND} must be requested from an agent session`);
  const session = getSession(ctx.sessionId);
  if (!session || session.agent_group_id !== ctx.agentGroupId) throw new Error('requesting session was not found');
  const staged = stageAttachment(request, ctx);
  const agentName = getAgentGroup(ctx.agentGroupId)?.name ?? ctx.agentGroupId;
  const administrator =
    !!ctx.requesterUserId && hasAdminPrivilege(ctx.requesterUserId, ctx.agentGroupId) ? ctx.requesterUserId : null;

  if (administrator) {
    log.info('LBox AWS static file deployment auto-authorized', {
      deploymentId: staged.deploymentId,
      requestedBy: administrator,
      target: staged.target ?? staged.s3Uri,
    });
    void applyDeployment({
      session,
      payload: { ...staged },
      userId: administrator,
      notify: (text) => notifyAgent(session, text),
    }).catch((error) => {
      log.error('Auto-authorized LBox AWS deployment handler failed', {
        deploymentId: staged.deploymentId,
        requestedBy: administrator,
        err: error,
      });
    });

    return {
      state: 'deployment_started',
      deployment_id: staged.deploymentId,
      target: staged.target ?? 'explicit',
      profile: staged.profile,
      s3_uri: staged.s3Uri,
      sha256: staged.sourceSha256,
    };
  }

  await requestApproval({
    session,
    agentName,
    action: ACTION,
    payload: { ...staged },
    title: 'LBox AWS 정적 파일 배포',
    question: [
      `Agent: ${agentName}`,
      `File: ${staged.originalName} (${staged.size} bytes)`,
      `SHA-256: ${staged.sourceSha256}`,
      `Profile: ${staged.profile}`,
      `S3: ${staged.s3Uri}`,
      `CloudFront: ${staged.distributionId} ${staged.invalidationPath}`,
    ].join('\n'),
  });

  return {
    state: 'approval_requested',
    deployment_id: staged.deploymentId,
    target: staged.target ?? 'explicit',
    profile: staged.profile,
    s3_uri: staged.s3Uri,
    sha256: staged.sourceSha256,
  };
}

function resolveAwsCli(): string {
  for (const candidate of ['/opt/homebrew/bin/aws', '/usr/local/bin/aws', '/usr/bin/aws']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('AWS CLI v2 is not installed on the Mac host');
}

export const runAws: AwsRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(resolveAwsCli(), args, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message)
          .trim()
          .slice(0, 1200);
        reject(new Error(detail));
        return;
      }
      resolve(String(stdout));
    });
  });

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function restoreBackup(request: StagedStaticFileDeploy, backupPath: string, runner: AwsRunner): Promise<void> {
  await runner([
    '--profile',
    request.profile,
    's3',
    'cp',
    backupPath,
    request.s3Uri,
    '--content-type',
    request.contentType,
    '--sse',
    request.sse,
    '--only-show-errors',
  ]);
}

export async function executeStaticFileDeployment(
  request: StagedStaticFileDeploy,
  runner: AwsRunner = runAws,
  backupRoot = path.join(STATE_ROOT, 'backups'),
): Promise<StaticFileDeployResult> {
  validateTarget(request, 'approved request');
  if (sha256File(request.stagedPath) !== request.sourceSha256)
    throw new Error('staged attachment changed after approval');

  try {
    await runner(['--profile', request.profile, 'sts', 'get-caller-identity', '--output', 'json']);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/sso|token.*expired|login/i.test(detail)) {
      throw new Error(`AWS_SSO_LOGIN_REQUIRED: aws sso login --profile ${request.profile}`);
    }
    throw error;
  }

  const safeTarget = (
    request.target ?? crypto.createHash('sha256').update(request.s3Uri).digest('hex').slice(0, 12)
  ).replace(/[^a-z0-9-]/gi, '-');
  const backupDir = path.join(backupRoot, safeTarget);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, `${timestampForFilename()}-${request.deploymentId}-${request.originalName}`);
  const downloadedPath = path.join(path.dirname(request.stagedPath), 'remote-download');
  const profile = ['--profile', request.profile];

  await runner([...profile, 's3', 'cp', request.s3Uri, backupPath, '--only-show-errors']);
  await runner([
    ...profile,
    's3',
    'cp',
    request.stagedPath,
    request.s3Uri,
    '--content-type',
    request.contentType,
    '--sse',
    request.sse,
    '--only-show-errors',
  ]);
  await runner([...profile, 's3', 'cp', request.s3Uri, downloadedPath, '--only-show-errors']);

  const downloadedSha256 = sha256File(downloadedPath);
  if (downloadedSha256 !== request.sourceSha256) {
    await restoreBackup(request, backupPath, runner);
    throw new Error(`remote SHA-256 mismatch; previous object restored (${downloadedSha256})`);
  }

  const { bucket, key } = parseS3Uri(request.s3Uri);
  const head = JSON.parse(
    await runner([...profile, 's3api', 'head-object', '--bucket', bucket, '--key', key, '--output', 'json']),
  ) as { ContentType?: string; ServerSideEncryption?: string };
  if (head.ContentType !== request.contentType || head.ServerSideEncryption !== request.sse) {
    await restoreBackup(request, backupPath, runner);
    throw new Error('remote metadata mismatch; previous object restored');
  }

  const created = JSON.parse(
    await runner([
      ...profile,
      'cloudfront',
      'create-invalidation',
      '--distribution-id',
      request.distributionId,
      '--paths',
      request.invalidationPath,
      '--output',
      'json',
    ]),
  ) as { Invalidation?: { Id?: string } };
  const invalidationId = created.Invalidation?.Id;
  if (!invalidationId) throw new Error('CloudFront did not return an invalidation ID');

  await runner([
    ...profile,
    'cloudfront',
    'wait',
    'invalidation-completed',
    '--distribution-id',
    request.distributionId,
    '--id',
    invalidationId,
  ]);
  const current = JSON.parse(
    await runner([
      ...profile,
      'cloudfront',
      'get-invalidation',
      '--distribution-id',
      request.distributionId,
      '--id',
      invalidationId,
      '--output',
      'json',
    ]),
  ) as { Invalidation?: { Status?: string } };
  if (current.Invalidation?.Status !== 'Completed') throw new Error('CloudFront invalidation is not Completed');

  return {
    deploymentId: request.deploymentId,
    sourceSha256: request.sourceSha256,
    downloadedSha256,
    uploadVerified: true,
    invalidationId,
    invalidationStatus: 'Completed',
    cdnUrl: request.cdnUrl,
    backupPath,
  };
}

const activeTargets = new Set<string>();

function cleanupStagedDeployment(request: Partial<StagedStaticFileDeploy>): void {
  if (!request.stagedPath) return;
  try {
    fs.rmSync(path.dirname(request.stagedPath), { recursive: true, force: true });
  } catch (error) {
    log.warn('Failed to clean LBox AWS staging directory', { deploymentId: request.deploymentId, err: error });
  }
}

export const applyStaticFileDeployment: ApprovalHandler = async ({ payload, notify, userId }) => {
  const request = payload as unknown as StagedStaticFileDeploy;
  if (activeTargets.has(request.s3Uri)) {
    notify(`같은 S3 target의 LBox AWS 배포가 이미 진행 중입니다: ${request.s3Uri}`);
    cleanupStagedDeployment(request);
    return;
  }

  activeTargets.add(request.s3Uri);
  try {
    const result = await executeStaticFileDeployment(request);
    notify(
      [
        'LBox AWS 정적 파일 배포가 완료됐습니다.',
        `- 업로드 검증: SHA-256 일치 (${result.sourceSha256})`,
        `- invalidation ID: ${result.invalidationId}`,
        `- invalidation 상태: ${result.invalidationStatus}`,
        `- CDN URL: ${result.cdnUrl}`,
      ].join('\n'),
    );
    log.info('LBox AWS static file deployed', {
      deploymentId: request.deploymentId,
      target: request.target ?? request.s3Uri,
      invalidationId: result.invalidationId,
      approvedBy: userId,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    notify(`LBox AWS 정적 파일 배포에 실패했습니다: ${detail}`);
    log.error('LBox AWS static file deployment failed', {
      deploymentId: request.deploymentId,
      target: request.target ?? request.s3Uri,
      err: error,
    });
  } finally {
    activeTargets.delete(request.s3Uri);
    cleanupStagedDeployment(request);
  }
};

register({
  name: COMMAND,
  description: 'Stage a Slack attachment and request admin approval for an LBox S3 + CloudFront static-file deploy.',
  // Deliberately open at the generic CLI layer: this handler first copies the
  // mutable attachment into host-only staging and puts its hash on the custom
  // approval card. AWS mutation only happens in the approval handler below.
  access: 'open',
  parseArgs: parseStaticFileDeployRequest,
  handler: requestStaticFileDeployment,
});

registerApprovalHandler(ACTION, applyStaticFileDeployment);
registerApprovalResolvedHandler(({ approval }) => {
  if (approval.action !== ACTION) return;
  try {
    cleanupStagedDeployment(JSON.parse(approval.payload) as Partial<StagedStaticFileDeploy>);
  } catch (error) {
    log.warn('Failed to clean LBox AWS staging directory', { approvalId: approval.approval_id, err: error });
  }
});
