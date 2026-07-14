import type { Adapter, Message as ChatMessage } from 'chat';

import type { InboundMessage, ThreadHistoryMessage } from '../channels/adapter.js';

export interface InlineMention {
  id: string;
  name: string;
  target: 'self' | 'user';
  start: number;
  end: number;
}

const SLACK_USER_MENTION_RE = /<@([A-Z0-9_]+)(?:\|([^<>]+))?>/g;

/**
 * Preserve Slack user mentions as positioned metadata before Chat SDK drops
 * their IDs while normalizing message text. User lookups reuse the adapter's
 * existing cache, so repeated mentions do not add repeated Slack API calls.
 */
export async function collectSlackInlineMentions(adapter: Adapter, message: ChatMessage): Promise<InlineMention[]> {
  if (adapter.name !== 'slack' || typeof message.text !== 'string') return [];

  const raw = message.raw as { text?: unknown } | undefined;
  if (typeof raw?.text !== 'string') return [];

  const occurrences = [...raw.text.matchAll(SLACK_USER_MENTION_RE)].map((match) => ({
    id: match[1],
    inlineName: match[2],
  }));
  if (occurrences.length === 0) return [];

  const names = new Map<string, string>();
  await Promise.all(
    [...new Set(occurrences.map(({ id }) => id))].map(async (id) => {
      const user = await adapter.getUser?.(id);
      const fallback = id === adapter.botUserId ? adapter.userName : id;
      names.set(id, user?.userName || user?.fullName || fallback);
    }),
  );

  const mentions: InlineMention[] = [];
  let cursor = 0;
  for (const { id, inlineName } of occurrences) {
    const target = id === adapter.botUserId ? 'self' : 'user';
    const name = names.get(id) ?? inlineName ?? id;
    const expectedLabel = inlineName ? `@${inlineName}` : target === 'self' ? `@${id}` : `@${name}`;
    const fallbackLabel = expectedLabel === `@${id}` ? `@${name}` : `@${id}`;
    let start = message.text.indexOf(expectedLabel, cursor);
    let label = expectedLabel;
    if (start < 0) {
      start = message.text.indexOf(fallbackLabel, cursor);
      label = fallbackLabel;
    }
    if (start < 0) continue;

    mentions.push({ id, name, target, start, end: start + label.length });
    cursor = start + label.length;
  }

  return mentions;
}

type ThreadHistoryFetcher = (threadId: string, limit: number) => Promise<ThreadHistoryMessage[]>;

function contentRecord(message: InboundMessage): Record<string, unknown> | null {
  return message.content && typeof message.content === 'object' ? (message.content as Record<string, unknown>) : null;
}

/** A platform-confirmed self mention with no request text needs the preceding thread request. */
export function isSlackMentionOnly(message: InboundMessage): boolean {
  if (message.isMention !== true || message.isGroup !== true) return false;
  const content = contentRecord(message);
  const text = typeof content?.text === 'string' ? content.text : '';
  if (!text) return false;

  const mentions = Array.isArray(content?.inlineMentions)
    ? (content.inlineMentions as Array<Partial<InlineMention>>)
        .filter(
          (mention) =>
            mention?.target === 'self' &&
            Number.isInteger(mention.start) &&
            Number.isInteger(mention.end) &&
            (mention.start as number) >= 0 &&
            (mention.end as number) <= text.length &&
            (mention.end as number) > (mention.start as number),
        )
        .sort((a, b) => (b.start as number) - (a.start as number))
    : [];
  if (mentions.length === 0) return false;

  let remainder = text;
  for (const mention of mentions) {
    remainder = remainder.slice(0, mention.start as number) + remainder.slice(mention.end as number);
  }
  return remainder.replace(/[\s!?.,~…]+/gu, '') === '';
}

function isBareMentionText(text: string): boolean {
  return /^(?:<@[A-Z0-9_]+(?:\|[^<>]+)?>|@\S+)[\s!?.,~…]*$/u.test(text.trim());
}

/**
 * Attach the nearest unanswered request from the same sender as reply context.
 * Never borrow another participant's request or override an explicit reply.
 */
export async function enrichSlackMentionOnlyContext(
  message: InboundMessage,
  threadId: string | null,
  botUserId: string | undefined,
  fetchThreadHistory: ThreadHistoryFetcher,
): Promise<InboundMessage> {
  const content = contentRecord(message);
  if (!threadId || !content || content.replyTo || !isSlackMentionOnly(message)) return message;

  const currentSenderId =
    typeof content.senderId === 'string'
      ? content.senderId
      : content.author &&
          typeof content.author === 'object' &&
          typeof (content.author as Record<string, unknown>).userId === 'string'
        ? ((content.author as Record<string, unknown>).userId as string)
        : undefined;
  const currentAt = Date.parse(message.timestamp);
  if (!currentSenderId) return message;

  const history = await fetchThreadHistory(threadId, 20);
  const candidates = history
    .filter((entry) => {
      if (entry.id === message.id || !entry.text.trim() || isBareMentionText(entry.text)) return false;
      if (botUserId && entry.senderId === botUserId) return false;
      const at = Date.parse(entry.timestamp);
      return !Number.isFinite(currentAt) || !Number.isFinite(at) || at <= currentAt;
    })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const previous = candidates.find((entry) => entry.senderId === currentSenderId);
  if (!previous) return message;

  const previousAt = Date.parse(previous.timestamp);
  const botAlreadyReplied = Boolean(
    botUserId &&
    history.some((entry) => {
      if (entry.senderId !== botUserId) return false;
      const at = Date.parse(entry.timestamp);
      return (
        Number.isFinite(at) &&
        Number.isFinite(previousAt) &&
        at > previousAt &&
        (!Number.isFinite(currentAt) || at <= currentAt)
      );
    }),
  );
  if (botAlreadyReplied) return message;

  return {
    ...message,
    content: {
      ...content,
      replyTo: { id: previous.id, sender: previous.sender, text: previous.text },
    },
  };
}
