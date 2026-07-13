import type { Adapter, Message as ChatMessage } from 'chat';

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
