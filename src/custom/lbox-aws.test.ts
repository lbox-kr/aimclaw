import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/aimclaw-test-lbox-aws-data' };
});

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../db/index.js';
import { createUser } from '../modules/permissions/db/users.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { resolveSession, sessionDir } from '../session-manager.js';

import {
  executeStaticFileDeployment,
  parseStaticFileDeployRequest,
  requestStaticFileDeployment,
  resolveSessionAttachment,
  type AwsRunner,
  type StagedStaticFileDeploy,
} from './lbox-aws.js';

const tempDirs: string[] = [];
const REQUEST_TEST_DATA = '/tmp/aimclaw-test-lbox-aws-data';

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimclaw-lbox-aws-'));
  tempDirs.push(dir);
  return dir;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stagedRequest(root: string): StagedStaticFileDeploy {
  const bytes = Buffer.from('<!doctype html><title>경찰청 MOU</title>');
  const stagedPath = path.join(root, 'police-mou-guide.html');
  fs.writeFileSync(stagedPath, bytes);
  return {
    deploymentId: 'aws-test',
    target: 'lbox-static-html',
    attachment: '/workspace/inbox/m1/police-mou-guide.html',
    stagedPath,
    originalName: 'police-mou-guide.html',
    size: bytes.length,
    sourceSha256: sha256(bytes),
    profile: 'lbox-system',
    s3Uri: 's3://lbox-eng-prd-s3-cdn-lbox/public/lbox/static-html/police-mou-guide.html',
    contentType: 'text/html',
    sse: 'AES256',
    distributionId: 'E1WVH20E0K2UEH',
    invalidationPath: '/public/lbox/static-html/police-mou-guide.html',
    cdnUrl: 'https://cdn.lbox.kr/public/lbox/static-html/police-mou-guide.html',
    allowedExtensions: ['.html'],
  };
}

function fakeAws(initialRemote: Buffer, metadata = { ContentType: 'text/html', ServerSideEncryption: 'AES256' }) {
  let remote = Buffer.from(initialRemote);
  const calls: string[][] = [];
  const runner: AwsRunner = async (args) => {
    calls.push(args);
    const command = args.slice(2);
    if (command[0] === 'sts') return '{}';
    if (command[0] === 's3' && command[1] === 'cp') {
      const source = command[2];
      const destination = command[3];
      if (source.startsWith('s3://')) fs.writeFileSync(destination, remote);
      else if (destination.startsWith('s3://')) remote = fs.readFileSync(source);
      return '';
    }
    if (command[0] === 's3api') return JSON.stringify(metadata);
    if (command[0] === 'cloudfront' && command[1] === 'create-invalidation') {
      return JSON.stringify({ Invalidation: { Id: 'I123' } });
    }
    if (command[0] === 'cloudfront' && command[1] === 'wait') return '';
    if (command[0] === 'cloudfront' && command[1] === 'get-invalidation') {
      return JSON.stringify({ Invalidation: { Status: 'Completed' } });
    }
    throw new Error(`unexpected fake AWS call: ${command.join(' ')}`);
  };
  return { calls, runner, remote: () => remote };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('LBox AWS request parsing', () => {
  it('derives the destination from the attachment name inside a preset scope', () => {
    const request = parseStaticFileDeployRequest({
      target: 'lbox-static-html',
      attachment: '/workspace/inbox/m1/police-mou-guide.html',
    });

    expect(request).toMatchObject({
      profile: 'lbox-system',
      distributionId: 'E1WVH20E0K2UEH',
      contentType: 'text/html',
      s3Uri: 's3://lbox-eng-prd-s3-cdn-lbox/public/lbox/static-html/police-mou-guide.html',
      invalidationPath: '/public/lbox/static-html/police-mou-guide.html',
      cdnUrl: 'https://cdn.lbox.kr/public/lbox/static-html/police-mou-guide.html',
    });
  });

  it('deploys adjacent files through the same preset and allows a safe destination override', () => {
    const adjacent = parseStaticFileDeployRequest({
      target: 'lbox-static-html',
      attachment: '/workspace/inbox/m1/another-guide.html',
    });
    const renamed = parseStaticFileDeployRequest({
      target: 'lbox-static-html',
      attachment: '/workspace/inbox/m1/uploaded-file.html',
      destination: 'police-mou-guide.html',
    });

    expect(adjacent.s3Uri).toBe('s3://lbox-eng-prd-s3-cdn-lbox/public/lbox/static-html/another-guide.html');
    expect(adjacent.cdnUrl).toBe('https://cdn.lbox.kr/public/lbox/static-html/another-guide.html');
    expect(renamed.s3Uri).toBe('s3://lbox-eng-prd-s3-cdn-lbox/public/lbox/static-html/police-mou-guide.html');
  });

  it('keeps preset infrastructure fixed and rejects destinations outside its scope', () => {
    expect(() =>
      parseStaticFileDeployRequest({
        target: 'lbox-static-html',
        attachment: '/workspace/inbox/m1/guide.html',
        profile: 'lbox-data-prd',
      }),
    ).toThrow(/cannot override preset/);
    expect(() =>
      parseStaticFileDeployRequest({
        target: 'lbox-static-html',
        attachment: '/workspace/inbox/m1/guide.html',
        destination: '../outside.html',
      }),
    ).toThrow(/safe relative path/);
  });

  it('rejects an unsupported profile in detailed mode', () => {
    expect(() =>
      parseStaticFileDeployRequest({
        attachment: '/workspace/inbox/m1/guide.html',
        profile: 'lbox-data-prd',
        's3-uri': 's3://lbox-bucket/path/guide.html',
        'content-type': 'text/html',
        sse: 'AES256',
        'distribution-id': 'E123',
        'invalidation-path': '/path/guide.html',
        'cdn-url': 'https://cdn.lbox.kr/path/guide.html',
      }),
    ).toThrow(/unsupported AWS profile/);
  });

  it('rejects a CDN URL that does not match the invalidation path', () => {
    expect(() =>
      parseStaticFileDeployRequest({
        attachment: '/workspace/inbox/m1/guide.html',
        profile: 'lbox-system',
        's3-uri': 's3://lbox-bucket/path/guide.html',
        'content-type': 'text/html',
        sse: 'AES256',
        'distribution-id': 'E123',
        'invalidation-path': '/path/guide.html',
        'cdn-url': 'https://cdn.lbox.kr/a-different-path.html',
      }),
    ).toThrow(/exactly match/);
  });
});

describe('LBox AWS attachment containment', () => {
  it('accepts only a regular file below the session inbox', () => {
    const root = tempDir();
    const dir = path.join(root, 'inbox', 'm1');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'guide.html');
    fs.writeFileSync(file, '<html></html>');

    expect(resolveSessionAttachment(root, '/workspace/inbox/m1/guide.html')).toBe(fs.realpathSync(file));
    expect(() => resolveSessionAttachment(root, '/workspace/agent/guide.html')).toThrow(/workspace\/inbox/);
  });
});

describe('LBox AWS request authorization', () => {
  beforeEach(() => {
    fs.rmSync(REQUEST_TEST_DATA, { recursive: true, force: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-1',
      name: '에이미',
      folder: 'aimy',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'slack',
      platform_id: 'D1',
      instance: 'slack',
      name: '관리자 DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      denied_at: null,
      created_at: new Date().toISOString(),
    });
    createUser({ id: 'slack:UADMIN', kind: 'slack', display_name: '관리자', created_at: new Date().toISOString() });
    grantRole({
      user_id: 'slack:UADMIN',
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(REQUEST_TEST_DATA, { recursive: true, force: true });
  });

  it('starts deployment without an approval card for a host-attributed administrator', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const inbox = path.join(sessionDir('ag-1', session.id), 'inbox', 'message-1');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'guide.html'), '<!doctype html><title>guide</title>');
    const applyDeployment = vi.fn().mockResolvedValue(undefined);

    const result = await requestStaticFileDeployment(
      parseStaticFileDeployRequest({
        target: 'lbox-static-html',
        attachment: '/workspace/inbox/message-1/guide.html',
      }),
      {
        caller: 'agent',
        sessionId: session.id,
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        requesterUserId: 'slack:UADMIN',
      },
      applyDeployment,
    );

    expect(result.state).toBe('deployment_started');
    expect(applyDeployment).toHaveBeenCalledTimes(1);
    expect(applyDeployment.mock.calls[0][0]).toMatchObject({ userId: 'slack:UADMIN' });
  });
});

describe('LBox AWS static-file deployment', () => {
  it('reports the exact login command when the host SSO token is expired', async () => {
    const root = tempDir();
    const request = stagedRequest(root);
    const runner: AwsRunner = async () => {
      throw new Error('Error when retrieving token from sso: Token has expired and refresh failed');
    };

    await expect(executeStaticFileDeployment(request, runner, path.join(root, 'backups'))).rejects.toThrow(
      'AWS_SSO_LOGIN_REQUIRED: aws sso login --profile lbox-system',
    );
  });

  it('backs up, uploads, verifies, and waits for CloudFront completion', async () => {
    const root = tempDir();
    const request = stagedRequest(root);
    const aws = fakeAws(Buffer.from('previous object'));

    const result = await executeStaticFileDeployment(request, aws.runner, path.join(root, 'backups'));

    expect(result).toMatchObject({
      sourceSha256: request.sourceSha256,
      downloadedSha256: request.sourceSha256,
      uploadVerified: true,
      invalidationId: 'I123',
      invalidationStatus: 'Completed',
      cdnUrl: request.cdnUrl,
    });
    expect(aws.remote()).toEqual(fs.readFileSync(request.stagedPath));

    const commands = aws.calls.map((args) => args.slice(2));
    expect(commands[1].slice(0, 3)).toEqual(['s3', 'cp', request.s3Uri]);
    expect(commands[2]).toContain('--content-type');
    expect(commands[2]).toContain('--sse');
    expect(commands.some((args) => args[0] === 's3api' && args[1] === 'head-object')).toBe(true);
    expect(commands.some((args) => args[0] === 'cloudfront' && args[1] === 'wait')).toBe(true);
    expect(aws.calls.every((args) => args[0] === '--profile' && args[1] === 'lbox-system')).toBe(true);
  });

  it('restores the backup when uploaded metadata does not match', async () => {
    const root = tempDir();
    const request = stagedRequest(root);
    const previous = Buffer.from('previous object');
    const aws = fakeAws(previous, { ContentType: 'text/plain', ServerSideEncryption: 'AES256' });

    await expect(executeStaticFileDeployment(request, aws.runner, path.join(root, 'backups'))).rejects.toThrow(
      /metadata mismatch/,
    );

    expect(aws.remote()).toEqual(previous);
    expect(aws.calls.some((args) => args.includes('create-invalidation'))).toBe(false);
  });
});
