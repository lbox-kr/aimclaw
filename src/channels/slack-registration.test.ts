/**
 * Integration test for the slack channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs slack.ts's
 * top-level `registerChannelAdapter('slack', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './slack.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and slack.ts
 * builds the SDK adapter / bridge only inside its factory (invoked at host startup),
 * never at import. It does require the adapter package to be installed, which holds
 * in a composed install: the skill's `pnpm install` step runs before this test.
 *
 * Note on the Chat SDK family: slack.ts also consumes a load-bearing *core* API —
 * `createChatSdkBridge(...)` from ./chat-sdk-bridge.js — with a specific options
 * shape. That core-consumption is a typed call, so the build/typecheck leg
 * (`pnpm run build`) guards it against upstream drift, not this test. Every Chat SDK
 * channel (discord, telegram, teams, gchat, webex, …) follows this same shape:
 * swap the channel name below and the adapter package in the build.
 */
import { describe, it, expect, vi } from 'vitest';

import { getChannelDefaults, getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration
import { anchorSlackRootDm, extractSlackStreamContext, setSlackAssistantStatus } from './slack.js';

describe('slack channel registration', () => {
  it('registers slack via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('slack');
  });

  it('keeps DM requests in threads for native assistant status and isolation', () => {
    expect(getChannelDefaults('slack').dm.threads).toBe(true);
  });

  it('anchors a top-level DM to the user message for native agent status', () => {
    const message = {
      id: '1783934548.123400',
      kind: 'chat-sdk' as const,
      content: {},
      timestamp: '2026-07-13T09:22:28.000Z',
      isGroup: false,
    };

    expect(anchorSlackRootDm('slack:D123', message)).toBe('slack:D123:1783934548.123400');
    expect(anchorSlackRootDm('slack:D123:1783934000.000100', message)).toBe('slack:D123:1783934000.000100');
    expect(anchorSlackRootDm('slack:C123', { ...message, isGroup: true })).toBe('slack:C123');
  });

  it('keeps only non-secret stream addressing metadata from the raw Slack event', () => {
    expect(
      extractSlackStreamContext({
        author: { userId: 'U123' },
        raw: { team_id: 'T123', token: 'must-not-be-projected', text: 'private message' },
      } as never),
    ).toEqual({ recipientUserId: 'U123', recipientTeamId: 'T123' });
  });

  it('sets and clears one native status without loading-message duplication', async () => {
    const setAssistantStatus = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      decodeThreadId: vi.fn().mockReturnValue({ channel: 'D123', threadTs: '1783934548.123400' }),
      setAssistantStatus,
    };

    await setSlackAssistantStatus(adapter, 'slack:D123:1783934548.123400', '요청을 처리하고 있어요');
    await setSlackAssistantStatus(adapter, 'slack:D123:1783934548.123400', '');

    expect(setAssistantStatus.mock.calls).toEqual([
      ['D123', '1783934548.123400', '요청을 처리하고 있어요'],
      ['D123', '1783934548.123400', ''],
    ]);
  });
});
