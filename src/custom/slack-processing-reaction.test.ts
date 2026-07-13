import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../channels/adapter.js';

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  getChannelAdapterExact: vi.fn(),
}));

vi.mock('../channels/channel-registry.js', () => ({
  getChannelAdapterExact: mocks.getChannelAdapterExact,
}));

import { addSlackProcessingReaction } from './slack-processing-reaction.js';

function event(channelType = 'slack'): InboundEvent {
  return {
    channelType,
    instance: channelType,
    platformId: 'slack:C1',
    threadId: 'slack:C1:1712345678.000100',
    message: {
      id: '1712345678.000100',
      kind: 'chat-sdk',
      content: JSON.stringify({ text: 'hello' }),
      timestamp: new Date().toISOString(),
    },
  };
}

beforeEach(() => {
  mocks.deliver.mockReset().mockResolvedValue(undefined);
  mocks.getChannelAdapterExact.mockReset().mockReturnValue({ deliver: mocks.deliver });
});

describe('Slack processing reaction', () => {
  it('reacts immediately through the existing adapter with the raw message id', async () => {
    await addSlackProcessingReaction(event());

    expect(mocks.getChannelAdapterExact).toHaveBeenCalledWith('slack');
    expect(mocks.deliver).toHaveBeenCalledWith('slack:C1', 'slack:C1:1712345678.000100', {
      kind: 'chat',
      content: {
        operation: 'reaction',
        messageId: '1712345678.000100',
        emoji: 'eyes',
      },
    });
  });

  it('does nothing for non-Slack channels', async () => {
    await addSlackProcessingReaction(event('discord'));

    expect(mocks.getChannelAdapterExact).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
