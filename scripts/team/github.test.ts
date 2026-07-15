import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const blockScriptPath = path.join(process.cwd(), 'scripts/team/block-onecli-github.sh');
const blockScript = fs.readFileSync(blockScriptPath, 'utf8');
const syncScript = fs.readFileSync(path.join(process.cwd(), 'scripts/team/install-repo-sync.sh'), 'utf8');

describe('OneCLI GitHub block policy', () => {
  it('blocks both API and git-over-HTTPS hosts at project scope', () => {
    expect(blockScript).toContain('GITHUB_HOSTS=("api.github.com" "github.com")');
    expect(blockScript).toContain('--action block');
    expect(blockScript).not.toContain('--agent-id');
    expect(blockScript).toContain('(.agentId == null)');
  });

  it('updates named rules idempotently and verifies the final policy', () => {
    expect(blockScript).toContain('onecli rules update');
    expect(blockScript).toContain('onecli rules create');
    expect(blockScript).toContain('onecli rules list --max 100');
    expect(blockScript).toContain('Failed to verify the OneCLI GitHub block rule');
  });

  it('accepts the OneCLI array response and refreshes both existing rules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimclaw-onecli-'));
    const callsFile = path.join(dir, 'calls.log');
    const onecli = path.join(dir, 'onecli');
    fs.writeFileSync(
      onecli,
      [
        '#!/bin/bash',
        'if [ "$1 $2" = "rules list" ]; then',
        '  printf \'%s\\n\' "$RULES_JSON"',
        'else',
        '  printf \'%s\\n\' "$*" >> "$CALLS_FILE"',
        'fi',
      ].join('\n'),
      { mode: 0o755 },
    );
    const rules = [
      {
        id: 'rule-api',
        name: 'aimclaw-host-gh-only-api.github.com',
        hostPattern: 'api.github.com',
        action: 'block',
        enabled: true,
        agentId: null,
      },
      {
        id: 'rule-git',
        name: 'aimclaw-host-gh-only-github.com',
        hostPattern: 'github.com',
        action: 'block',
        enabled: true,
        agentId: null,
      },
    ];

    try {
      const output = execFileSync('bash', [blockScriptPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          CALLS_FILE: callsFile,
          RULES_JSON: JSON.stringify(rules),
        },
      });
      const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n');

      expect(output).toContain('OneCLI GitHub access is blocked');
      expect(calls).toEqual([
        'rules update --id rule-api --name aimclaw-host-gh-only-api.github.com --host-pattern api.github.com --action block --enabled true',
        'rules update --id rule-git --name aimclaw-host-gh-only-github.com --host-pattern github.com --action block --enabled true',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('repository sync GitHub authentication', () => {
  it('proves host keychain auth without inherited GitHub tokens', () => {
    for (const variable of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      expect(syncScript).toContain(`-u ${variable}`);
    }
    expect(syncScript).toContain('for key in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy');
    expect(syncScript).toContain('*onecli*|*host.docker.internal*|*:10255*');
    expect(syncScript).toContain('without_github_auth_env "$GH_BIN" auth status');
    expect(syncScript).toContain('without_github_auth_env "$GH_BIN" auth setup-git');
    expect(syncScript).toContain('without_github_auth_env "$REPO_ROOT/scripts/team/sync-repos.sh"');
  });
});
