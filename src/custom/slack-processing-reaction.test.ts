import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import type { InboundEvent } from '../channels/adapter.js';

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  getChannelAdapterExact: vi.fn(),
}));

vi.mock('../channels/channel-registry.js', () => ({
  getChannelAdapterExact: mocks.getChannelAdapterExact,
}));

import { addSlackProcessingReaction, removeSlackProcessingReaction } from './slack-processing-reaction.js';

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
        emoji: 'hourglass_flowing_sand',
      },
    });
  });

  it('removes the loading reaction from the replied-to Slack message', async () => {
    const get = vi.fn().mockReturnValue({
      channel_type: 'slack',
      platform_id: 'slack:C1',
      thread_id: 'slack:C1:1712345678.000100',
      content: JSON.stringify({ _nanoclawPlatformMessageId: '1712345678.000100' }),
    });
    const inDb = { prepare: vi.fn().mockReturnValue({ get }) } as unknown as Database.Database;

    await removeSlackProcessingReaction(inDb, '1712345678.000100:ag-1', 'slack');

    expect(get).toHaveBeenCalledWith('1712345678.000100:ag-1');
    expect(mocks.deliver).toHaveBeenCalledWith('slack:C1', 'slack:C1:1712345678.000100', {
      kind: 'chat',
      content: {
        operation: 'remove_reaction',
        messageId: '1712345678.000100',
        emoji: 'hourglass_flowing_sand',
      },
    });
  });

  it('does nothing for non-Slack channels', async () => {
    await addSlackProcessingReaction(event('discord'));

    expect(mocks.getChannelAdapterExact).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
