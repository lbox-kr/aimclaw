import { describe, expect, it, vi } from 'vitest';

import type { Adapter, Message as ChatMessage } from 'chat';

import { collectSlackInlineMentions } from './slack-mentions.js';

describe('collectSlackInlineMentions', () => {
  it('maps self and user mentions to their exact positions', async () => {
    const getUser = vi.fn(async (id: string) => ({
      userId: id,
      userName: id === 'U_BOT' ? '에이미' : '민수',
      fullName: id === 'U_BOT' ? '에이미' : '김민수',
      isBot: id === 'U_BOT',
    }));
    const adapter = {
      name: 'slack',
      userName: 'aimclaw',
      botUserId: 'U_BOT',
      getUser,
    } as unknown as Adapter;
    const text = '@U_BOT 이 내용을 @민수에게 보내줘';
    const message = {
      text,
      raw: { text: '<@U_BOT> 이 내용을 <@U_MIN>에게 보내줘' },
    } as unknown as ChatMessage;

    await expect(collectSlackInlineMentions(adapter, message)).resolves.toEqual([
      {
        id: 'U_BOT',
        name: '에이미',
        target: 'self',
        start: text.indexOf('@U_BOT'),
        end: text.indexOf('@U_BOT') + '@U_BOT'.length,
      },
      {
        id: 'U_MIN',
        name: '민수',
        target: 'user',
        start: text.indexOf('@민수'),
        end: text.indexOf('@민수') + '@민수'.length,
      },
    ]);
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('does nothing for non-Slack messages', async () => {
    const getUser = vi.fn();
    const adapter = { name: 'discord', getUser } as unknown as Adapter;
    const message = { text: '@Aimy hi', raw: { text: '<@U_BOT> hi' } } as unknown as ChatMessage;

    await expect(collectSlackInlineMentions(adapter, message)).resolves.toEqual([]);
    expect(getUser).not.toHaveBeenCalled();
  });
});
