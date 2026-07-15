import { describe, expect, it } from 'vitest';

import { lookup } from '../cli/registry.js';
import { buildGhEnvironment, executeGitHubRequest, type GhRunner } from './lbox-github.js';

const repo = 'lbox-kr/lbox-server';
const parse = (operation: string, args: Record<string, unknown>) => lookup(`github-${operation}`)!.parseArgs(args);

describe('LBox GitHub repository policy', () => {
  it('accepts a host-synced repository', () => {
    expect(parse('pr-list', { repo })).toMatchObject({ operation: 'pr-list', repo });
  });

  it('rejects repositories outside the allowlist and invalid targets', () => {
    expect(() => parse('pr-list', { repo: 'other/private' })).toThrow(/not allowed/);
    expect(() => parse('pr-view', { repo, id: '../1' })).toThrow(/positive PR or issue number/);
  });

  it('bounds list and write input', () => {
    expect(parse('pr-list', { repo, state: 'all', limit: '100' })).toMatchObject({ state: 'all', limit: 100 });
    expect(() => parse('issue-list', { repo, limit: '101' })).toThrow(/between 1 and 100/);
    expect(() => parse('issue-create', { repo, title: 'x' })).toThrow(/--body is required/);
    expect(() => parse('issue-create', { repo, title: 'x', body: 'x'.repeat(2_001) })).toThrow(/--body is too long/);
  });
});

describe('LBox GitHub host environment', () => {
  it('uses the host keyring without inherited tokens or OneCLI proxy settings', () => {
    const env = buildGhEnvironment({
      PATH: '/bin',
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'channel-secret',
      GH_DEBUG: 'api',
      GH_REPO: 'other/repo',
      HTTPS_PROXY: 'http://host.docker.internal:10255',
    });

    expect(env).toMatchObject({
      PATH: '/bin',
      GH_HOST: 'github.com',
      GH_PROMPT_DISABLED: '1',
      GH_PAGER: 'cat',
      NO_COLOR: '1',
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_DEBUG).toBeUndefined();
    expect(env.GH_REPO).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});

describe('LBox GitHub command construction', () => {
  it('constructs only fixed PR read commands and accepts pending checks', async () => {
    const calls: Array<{ args: string[]; allowed?: number[] }> = [];
    const runner: GhRunner = async (args, allowed) => {
      calls.push({ args, allowed });
      return '[]';
    };

    await executeGitHubRequest(
      { operation: 'pr-list', repo: 'lbox-kr/frontend', state: 'open', limit: 30, search: 'author:@me' },
      { caller: 'host' },
      runner,
    );
    await executeGitHubRequest(
      { operation: 'pr-checks', repo: 'lbox-kr/frontend', number: 42 },
      { caller: 'host' },
      runner,
    );

    expect(calls[0].args.slice(0, 8)).toEqual([
      'pr',
      'list',
      '--repo',
      'lbox-kr/frontend',
      '--state',
      'open',
      '--limit',
      '30',
    ]);
    expect(calls[0].args).toContain('--json');
    expect(calls[0].args.slice(-2)).toEqual(['--search', 'author:@me']);
    expect(calls[1]).toMatchObject({
      args: ['pr', 'checks', '42', '--repo', 'lbox-kr/frontend', '--json', expect.any(String)],
      allowed: [8],
    });
  });

  it('constructs bounded issue and comment writes and returns their URLs', async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async (args) => {
      calls.push(args);
      return args[1] === 'create'
        ? 'https://github.com/lbox-kr/frontend/issues/51\n'
        : 'https://github.com/lbox-kr/frontend/pull/42#issuecomment-1\n';
    };

    const created = await executeGitHubRequest(
      { operation: 'issue-create', repo: 'lbox-kr/frontend', title: '버그', body: '본문' },
      { caller: 'host' },
      runner,
    );
    const commented = await executeGitHubRequest(
      { operation: 'pr-comment', repo: 'lbox-kr/frontend', number: 42, body: '확인했습니다.' },
      { caller: 'agent', sessionId: 's1', agentGroupId: 'ag1', messagingGroupId: 'mg1', requesterUserId: 'slack:U1' },
      runner,
    );

    expect(calls[0]).toEqual(['issue', 'create', '--repo', 'lbox-kr/frontend', '--title', '버그', '--body', '본문']);
    expect(calls[1]).toEqual(['pr', 'comment', '42', '--repo', 'lbox-kr/frontend', '--body', '확인했습니다.']);
    expect(created).toEqual({ state: 'created', url: 'https://github.com/lbox-kr/frontend/issues/51' });
    expect(commented).toEqual({
      state: 'commented',
      url: 'https://github.com/lbox-kr/frontend/pull/42#issuecomment-1',
    });
  });
});
