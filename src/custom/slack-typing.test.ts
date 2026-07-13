import { describe, expect, it } from 'vitest';

import type { ChannelDefaults, InboundEvent } from '../channels/adapter.js';
import { enableSlackTypingThread, withAimClawSlackDefaults } from './slack-typing.js';

const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

function event(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    channelType: 'slack',
    platformId: 'slack:D1',
    threadId: 'slack:D1:',
    message: {
      id: '1712345678.000100',
      kind: 'chat-sdk',
      content: JSON.stringify({ text: 'hello' }),
      timestamp: '2026-07-13T08:00:00.000Z',
      isGroup: false,
    },
    ...overrides,
  };
}

describe('Slack typing-first policy', () => {
  it('promotes a top-level DM message to its Assistant thread root', () => {
    expect(enableSlackTypingThread(event()).threadId).toBe('slack:D1:1712345678.000100');
  });

  it('preserves existing Slack threads and non-DM events', () => {
    expect(enableSlackTypingThread(event({ threadId: 'slack:D1:1712345000.000001' })).threadId).toBe(
      'slack:D1:1712345000.000001',
    );
    expect(enableSlackTypingThread(event({ message: { ...event().message, isGroup: true } })).threadId).toBe(
      'slack:D1:',
    );
    expect(enableSlackTypingThread(event({ message: { ...event().message, id: '' } })).threadId).toBe('slack:D1:');
  });

  it('enables inherited Slack DM threading without changing other channel defaults', () => {
    expect(withAimClawSlackDefaults(event(), defaults).dm.threads).toBe(true);
    expect(withAimClawSlackDefaults(event({ message: { ...event().message, isGroup: true } }), defaults)).toBe(
      defaults,
    );
  });
});
