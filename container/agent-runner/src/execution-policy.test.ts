import { describe, expect, it } from 'bun:test';

import { authorizeTool, setExecutionPolicyForMessages } from './execution-policy.js';

const message = (
  policy: Record<string, unknown> | null,
  trigger = 1,
): { kind: string; channel_type: string | null; trigger: number; content: string } => ({
  kind: 'chat-sdk',
  channel_type: 'slack',
  trigger,
  content: JSON.stringify(policy ? { _nanoclawAuthorization: policy } : {}),
});

describe('tool execution policy', () => {
  it('allows every available tool for an administrator', () => {
    setExecutionPolicyForMessages([
      message({ userId: 'slack:U1', role: 'administrator', allowedTools: [], skillTools: {} }),
    ]);
    expect(authorizeTool('Bash', {}).allowed).toBe(true);
    expect(authorizeTool('mcp__external__write', {}).allowed).toBe(true);
  });

  it('allows basic tools and only selected skill tools for a general user', () => {
    setExecutionPolicyForMessages([
      message({
        userId: 'slack:U2',
        role: 'member',
        allowedTools: ['WebSearch', 'WebFetch'],
        skillTools: { notify: ['Skill', 'mcp__nanoclaw__send_*'] },
      }),
    ]);

    expect(authorizeTool('WebFetch', {}).allowed).toBe(true);
    expect(authorizeTool('Bash', {}).allowed).toBe(false);
    expect(authorizeTool('Skill', { skill: 'notify' }).allowed).toBe(true);
    expect(authorizeTool('mcp__nanoclaw__send_message', {}).allowed).toBe(true);
    expect(authorizeTool('Write', {}).allowed).toBe(false);
  });

  it('blocks unlisted skills and resets grants for the newest triggering sender', () => {
    setExecutionPolicyForMessages([
      message({
        userId: 'slack:OLD',
        role: 'member',
        allowedTools: [],
        skillTools: { notify: ['Skill', 'mcp__nanoclaw__send_message'] },
      }),
    ]);
    expect(authorizeTool('Skill', { skill: 'notify' }).allowed).toBe(true);

    setExecutionPolicyForMessages([
      message({ userId: 'slack:OLD', role: 'administrator', allowedTools: [], skillTools: {} }, 0),
      message({ userId: 'slack:CURRENT', role: 'member', allowedTools: [], skillTools: {} }),
    ]);
    expect(authorizeTool('Skill', { skill: 'notify' }).allowed).toBe(false);
    expect(authorizeTool('mcp__nanoclaw__send_message', {}).allowed).toBe(false);
  });

  it('fails legacy channel chat closed but trusts host system work', () => {
    setExecutionPolicyForMessages([message(null)]);
    expect(authorizeTool('WebFetch', {}).allowed).toBe(false);

    setExecutionPolicyForMessages([{ ...message(null), kind: 'task', channel_type: null }]);
    expect(authorizeTool('Bash', {}).allowed).toBe(true);
  });
});
