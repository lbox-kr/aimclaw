import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { CallerContext } from '../cli/frame.js';
import { register } from '../cli/registry.js';
import { log } from '../log.js';

const REPOS_PATH = path.join(process.cwd(), 'container', 'skills', 'lbox-product-code-search', 'repos.txt');
// Generic ncl approval cards include the command arguments. Keep write bodies
// below Slack card limits so a non-admin/system request can always be reviewed.
const MAX_BODY_LENGTH = 2_000;
const MAX_LIST_LIMIT = 100;
const GH_TIMEOUT_MS = 30_000;

const PR_LIST_FIELDS = [
  'number',
  'title',
  'state',
  'isDraft',
  'author',
  'headRefName',
  'baseRefName',
  'updatedAt',
  'url',
].join(',');
const PR_VIEW_FIELDS = [
  'number',
  'title',
  'state',
  'isDraft',
  'author',
  'assignees',
  'reviewDecision',
  'mergeStateStatus',
  'baseRefName',
  'headRefName',
  'body',
  'comments',
  'reviews',
  'updatedAt',
  'url',
].join(',');
const PR_CHECK_FIELDS = [
  'bucket',
  'completedAt',
  'description',
  'event',
  'link',
  'name',
  'startedAt',
  'state',
  'workflow',
].join(',');
const ISSUE_LIST_FIELDS = ['number', 'title', 'state', 'author', 'assignees', 'labels', 'updatedAt', 'url'].join(',');
const ISSUE_VIEW_FIELDS = [
  'number',
  'title',
  'state',
  'author',
  'assignees',
  'labels',
  'body',
  'comments',
  'updatedAt',
  'url',
].join(',');

const COMMANDS = [
  ['pr-list', 'List pull requests in an allowed LBox repository.'],
  ['pr-view', 'View a pull request in an allowed LBox repository.'],
  ['pr-checks', 'View pull request checks in an allowed LBox repository.'],
  ['issue-list', 'List issues in an allowed LBox repository.'],
  ['issue-view', 'View an issue in an allowed LBox repository.'],
  ['issue-create', 'Create an issue in an allowed LBox repository.'],
  ['pr-comment', 'Comment on a pull request in an allowed LBox repository.'],
  ['issue-comment', 'Comment on an issue in an allowed LBox repository.'],
] as const;
type GitHubOperation = (typeof COMMANDS)[number][0];

interface GitHubRequest {
  operation: GitHubOperation;
  repo: string;
  number?: number;
  state?: 'open' | 'closed' | 'merged' | 'all';
  limit?: number;
  search?: string;
  title?: string;
  body?: string;
}

export type GhRunner = (args: string[], allowedExitCodes?: number[]) => Promise<string>;

function stringArg(
  raw: Record<string, unknown>,
  name: string,
  options: { required?: boolean; maxLength?: number; multiline?: boolean } = {},
): string | undefined {
  const value = raw[name] ?? raw[name.replace(/-/g, '_')];
  if (value === undefined) {
    if (options.required) throw new Error(`--${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${name} must be a non-empty string`);
  const normalized = options.multiline ? value.trim() : value.trim().replace(/\s+/g, ' ');
  if (
    [...normalized].some((char) => {
      const code = char.charCodeAt(0);
      return code === 127 || code === 0 || (code < 32 && (!options.multiline || !'\n\r\t'.includes(char)));
    })
  ) {
    throw new Error(`--${name} contains unsupported control characters`);
  }
  if (normalized.length > (options.maxLength ?? 1_000)) throw new Error(`--${name} is too long`);
  return normalized;
}

function numberArg(raw: Record<string, unknown>): number {
  const value = raw.number ?? raw.id;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('a positive PR or issue number is required');
  return parsed;
}

function limitArg(raw: Record<string, unknown>): number {
  const value = raw.limit;
  if (value === undefined) return 30;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
    throw new Error(`--limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  return parsed;
}

function stateArg(raw: Record<string, unknown>, operation: GitHubOperation): GitHubRequest['state'] {
  const value = stringArg(raw, 'state') ?? 'open';
  const allowed =
    operation === 'pr-list' ? new Set(['open', 'closed', 'merged', 'all']) : new Set(['open', 'closed', 'all']);
  if (!allowed.has(value)) throw new Error(`unsupported --state for ${operation}: ${value}`);
  return value as GitHubRequest['state'];
}

function loadAllowedGitHubRepositories(): Set<string> {
  const repos = new Set<string>();
  const lines = fs.readFileSync(REPOS_PATH, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 2) throw new Error(`invalid repository entry: ${trimmed}`);
    const url = new URL(parts[1]);
    const repoPath = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !/^[\w.-]+\/[\w.-]+$/.test(repoPath)) {
      throw new Error(`unsupported GitHub repository URL: ${parts[1]}`);
    }
    repos.add(repoPath);
  }

  if (repos.size === 0) throw new Error(`no allowed GitHub repositories found in ${REPOS_PATH}`);
  return repos;
}

function parseGitHubRequest(operation: GitHubOperation, raw: Record<string, unknown>): GitHubRequest {
  const repo = stringArg(raw, 'repo', { required: true, maxLength: 200 })!;
  if (!loadAllowedGitHubRepositories().has(repo)) throw new Error(`GitHub repository is not allowed: ${repo}`);

  switch (operation) {
    case 'pr-list':
    case 'issue-list':
      return {
        operation,
        repo,
        state: stateArg(raw, operation),
        limit: limitArg(raw),
        search: stringArg(raw, 'search', { maxLength: 256 }),
      };
    case 'pr-view':
    case 'pr-checks':
    case 'issue-view':
      return { operation, repo, number: numberArg(raw) };
    case 'issue-create':
      return {
        operation,
        repo,
        title: stringArg(raw, 'title', { required: true, maxLength: 256 }),
        body: stringArg(raw, 'body', { required: true, maxLength: MAX_BODY_LENGTH, multiline: true }),
      };
    case 'pr-comment':
    case 'issue-comment':
      return {
        operation,
        repo,
        number: numberArg(raw),
        body: stringArg(raw, 'body', { required: true, maxLength: MAX_BODY_LENGTH, multiline: true }),
      };
  }
}

function resolveGhCli(): string {
  for (const candidate of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('GitHub CLI is not installed on the Mac host');
}

export function buildGhEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_DEBUG',
    'GH_REPO',
  ]) {
    delete env[key];
  }
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    if (/(?:onecli|host\.docker\.internal|:10255(?:\/|$))/i.test(env[key] ?? '')) delete env[key];
  }
  return {
    ...env,
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    PAGER: 'cat',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    CLICOLOR: '0',
  };
}

const runGh: GhRunner = (args, allowedExitCodes = []) =>
  new Promise((resolve, reject) => {
    execFile(
      resolveGhCli(),
      args,
      {
        encoding: 'utf8',
        env: buildGhEnvironment(),
        timeout: GH_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 5 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = (error as { code?: string | number } | null)?.code;
        if (error && !(typeof exitCode === 'number' && allowedExitCodes.includes(exitCode))) {
          const detail = String(stderr || error.message)
            .trim()
            .slice(0, 2_000);
          if (/auth login|not logged|authentication token|authentication failed/i.test(detail)) {
            reject(new Error('GITHUB_HOST_LOGIN_REQUIRED: gh auth login --hostname github.com'));
            return;
          }
          reject(new Error(detail || 'GitHub CLI command failed'));
          return;
        }
        resolve(String(stdout));
      },
    );
  });

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error('GitHub CLI returned invalid JSON', { cause: error });
  }
}

function resultUrl(output: string): string {
  const url = output
    .trim()
    .split(/\s+/)
    .find((part) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+(?:#.*)?$/.test(part));
  if (!url) throw new Error('GitHub CLI did not return a result URL');
  return url;
}

export async function executeGitHubRequest(
  request: GitHubRequest,
  ctx: CallerContext,
  runner: GhRunner = runGh,
): Promise<unknown> {
  const audit = {
    operation: request.operation,
    repo: request.repo,
    number: request.number,
    requestedBy: ctx.caller === 'agent' ? (ctx.requesterUserId ?? 'unattributed-agent') : 'host',
  };
  log.info('Host GitHub command started', audit);

  try {
    let result: unknown;
    switch (request.operation) {
      case 'pr-list': {
        const args = [
          'pr',
          'list',
          '--repo',
          request.repo,
          '--state',
          request.state!,
          '--limit',
          String(request.limit),
          '--json',
          PR_LIST_FIELDS,
        ];
        if (request.search) args.push('--search', request.search);
        result = parseJson(await runner(args));
        break;
      }
      case 'pr-view':
        result = parseJson(
          await runner(['pr', 'view', String(request.number), '--repo', request.repo, '--json', PR_VIEW_FIELDS]),
        );
        break;
      case 'pr-checks':
        result = parseJson(
          await runner(
            ['pr', 'checks', String(request.number), '--repo', request.repo, '--json', PR_CHECK_FIELDS],
            [8],
          ),
        );
        break;
      case 'issue-list': {
        const args = [
          'issue',
          'list',
          '--repo',
          request.repo,
          '--state',
          request.state!,
          '--limit',
          String(request.limit),
          '--json',
          ISSUE_LIST_FIELDS,
        ];
        if (request.search) args.push('--search', request.search);
        result = parseJson(await runner(args));
        break;
      }
      case 'issue-view':
        result = parseJson(
          await runner(['issue', 'view', String(request.number), '--repo', request.repo, '--json', ISSUE_VIEW_FIELDS]),
        );
        break;
      case 'issue-create': {
        const url = resultUrl(
          await runner(['issue', 'create', '--repo', request.repo, '--title', request.title!, '--body', request.body!]),
        );
        result = { state: 'created', url };
        break;
      }
      case 'pr-comment':
      case 'issue-comment': {
        const kind = request.operation === 'pr-comment' ? 'pr' : 'issue';
        const url = resultUrl(
          await runner([kind, 'comment', String(request.number), '--repo', request.repo, '--body', request.body!]),
        );
        result = { state: 'commented', url };
        break;
      }
    }
    log.info('Host GitHub command completed', {
      ...audit,
      resultUrl: typeof result === 'object' && result && 'url' in result ? result.url : undefined,
    });
    return result;
  } catch (error) {
    log.warn('Host GitHub command failed', { ...audit, err: error });
    throw error;
  }
}

for (const [operation, description] of COMMANDS) {
  register({
    name: `github-${operation}`,
    description,
    access: 'approval',
    parseArgs: (raw) => parseGitHubRequest(operation, raw),
    handler: (request, ctx) => executeGitHubRequest(request, ctx),
  });
}
