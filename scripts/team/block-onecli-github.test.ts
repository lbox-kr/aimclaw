import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = path.join(process.cwd(), 'scripts/team/block-onecli-github.sh');
const script = fs.readFileSync(scriptPath, 'utf8');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('OneCLI GitHub block policy', () => {
  it('blocks both API and git-over-HTTPS hosts at project scope', () => {
    expect(script).toContain('GITHUB_HOSTS=("api.github.com" "github.com")');
    expect(script).toContain('--action block');
    expect(script).not.toContain('--agent-id');
    expect(script).toContain('(.agentId == null)');
  });

  it('updates named rules idempotently and verifies the final policy', () => {
    expect(script).toContain('onecli rules update');
    expect(script).toContain('onecli rules create');
    expect(script).toContain('onecli rules list --max 100');
    expect(script).toContain('Failed to verify the OneCLI GitHub block rule');
  });

  it('accepts the OneCLI array response and refreshes both existing rules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimclaw-onecli-'));
    tempDirs.push(dir);
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

    const output = execFileSync('bash', [scriptPath], {
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
  });
});
