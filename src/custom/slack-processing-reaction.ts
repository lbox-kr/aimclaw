/**
 * Immediate Slack processing acknowledgement.
 *
 * This runs on the host as soon as routing confirms that an agent will handle
 * the request. It deliberately bypasses the model and container tool policy:
 * receipt acknowledgement is transport UX, not an agent judgment.
 */
import { getChannelAdapterExact } from '../channels/channel-registry.js';
import type { InboundEvent } from '../channels/adapter.js';

export async function addSlackProcessingReaction(event: InboundEvent): Promise<void> {
  if (event.channelType !== 'slack' || !event.message.id) return;

  await getChannelAdapterExact(event.instance ?? event.channelType)?.deliver(event.platformId, event.threadId, {
    kind: 'chat',
    content: {
      operation: 'reaction',
      messageId: event.message.id,
      emoji: 'eyes',
    },
  });
}
