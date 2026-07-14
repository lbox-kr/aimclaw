import { describe, expect, it, vi } from 'vitest';

import type { Adapter, Message as ChatMessage } from 'chat';

import type { InboundMessage, ThreadHistoryMessage } from '../channels/adapter.js';
import { collectSlackInlineMentions, enrichSlackMentionOnlyContext, isSlackMentionOnly } from './slack-mentions.js';

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

function inbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'm-current',
    kind: 'chat-sdk',
    timestamp: '2026-07-14T04:00:00.000Z',
    isMention: true,
    isGroup: true,
    content: {
      text,
      senderId: 'U-CURRENT',
      inlineMentions: [{ id: 'U-BOT', name: '에이미', target: 'self', start: 0, end: 4 }],
    },
    ...overrides,
  };
}

describe('Slack mention-only context', () => {
  it('recognizes a self mention without request text', () => {
    expect(isSlackMentionOnly(inbound('@에이미'))).toBe(true);
    expect(isSlackMentionOnly(inbound('@에이미, 질문이 있어요'))).toBe(false);
  });

  it('attaches the nearest prior request from the same sender', async () => {
    const history: ThreadHistoryMessage[] = [
      {
        id: 'm-current',
        sender: '정현수',
        senderId: 'U-CURRENT',
        text: '@에이미',
        timestamp: '2026-07-14T04:00:00.000Z',
      },
      {
        id: 'm-bot',
        sender: '에이미',
        senderId: 'U-BOT',
        text: '네, 말씀하세요.',
        timestamp: '2026-07-14T03:59:50.000Z',
      },
      {
        id: 'm-other',
        sender: '다른 팀원',
        senderId: 'U-OTHER',
        text: '이 메시지가 더 최근이에요.',
        timestamp: '2026-07-14T03:59:40.000Z',
      },
      {
        id: 'm-question',
        sender: '정현수',
        senderId: 'U-CURRENT',
        text: 'FE 코드와 관련된 부분이 있는가? 위치는?',
        timestamp: '2026-07-14T03:59:30.000Z',
      },
    ];
    const fetchHistory = vi.fn(async () => history);

    const result = await enrichSlackMentionOnlyContext(inbound('@에이미'), 'slack:C1:thread', 'U-BOT', fetchHistory);

    expect(fetchHistory).toHaveBeenCalledWith('slack:C1:thread', 20);
    expect(result.content).toMatchObject({
      replyTo: {
        id: 'm-question',
        sender: '정현수',
        text: 'FE 코드와 관련된 부분이 있는가? 위치는?',
      },
    });
  });

  it('does not fetch when the mention includes a request or already replies to a message', async () => {
    const fetchHistory = vi.fn(async () => []);
    const withRequest = await enrichSlackMentionOnlyContext(
      inbound('@에이미 코드 위치를 찾아줘'),
      'slack:C1:thread',
      'U-BOT',
      fetchHistory,
    );
    const withReply = await enrichSlackMentionOnlyContext(
      inbound('@에이미', { content: { ...(inbound('@에이미').content as object), replyTo: { id: 'm1' } } }),
      'slack:C1:thread',
      'U-BOT',
      fetchHistory,
    );

    expect(withRequest).toEqual(inbound('@에이미 코드 위치를 찾아줘'));
    expect(withReply.content).toMatchObject({ replyTo: { id: 'm1' } });
    expect(fetchHistory).not.toHaveBeenCalled();
  });
});
