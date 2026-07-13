/**
 * Immediate Slack processing acknowledgement.
 *
 * This runs on the host as soon as routing confirms that an agent will handle
 * the request. It deliberately bypasses the model and container tool policy:
 * receipt acknowledgement is transport UX, not an agent judgment.
 */
import type Database from 'better-sqlite3';

import { getChannelAdapterExact } from '../channels/channel-registry.js';
import type { InboundEvent } from '../channels/adapter.js';

const PROCESSING_EMOJI = 'hourglass_flowing_sand';

export async function addSlackProcessingReaction(event: InboundEvent): Promise<void> {
  if (event.channelType !== 'slack' || !event.message.id) return;

  await getChannelAdapterExact(event.instance ?? event.channelType)?.deliver(event.platformId, event.threadId, {
    kind: 'chat',
    content: {
      operation: 'reaction',
      messageId: event.message.id,
      emoji: PROCESSING_EMOJI,
    },
  });
}

export async function removeSlackProcessingReaction(
  inDb: Database.Database,
  inReplyTo: string | null,
  instance?: string,
): Promise<void> {
  if (!inReplyTo) return;

  const row = inDb
    .prepare('SELECT channel_type, platform_id, thread_id, content FROM messages_in WHERE id = ?')
    .get(inReplyTo) as
    | { channel_type: string | null; platform_id: string | null; thread_id: string | null; content: string }
    | undefined;
  if (row?.channel_type !== 'slack' || !row.platform_id) return;

  let messageId: unknown;
  try {
    messageId = (JSON.parse(row.content) as Record<string, unknown>)._nanoclawPlatformMessageId;
  } catch {
    return;
  }
  if (typeof messageId !== 'string' || !messageId) return;

  await getChannelAdapterExact(instance ?? row.channel_type)?.deliver(row.platform_id, row.thread_id, {
    kind: 'chat',
    content: { operation: 'remove_reaction', messageId, emoji: PROCESSING_EMOJI },
  });
}
