/**
 * Read-only current-thread context bridge for the built-in MCP tool.
 *
 * The container sends only a request id and limit. Platform coordinates are
 * resolved from the host-owned session, so an agent cannot use this path to
 * browse another Slack channel or thread.
 */
import { getChannelAdapterExact } from '../channels/channel-registry.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { insertMessage } from '../db/session-db.js';
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';

const ACTION = 'read_current_thread';
const RESPONSE_TYPE = 'current_thread_response';

registerDeliveryAction(ACTION, async (content, session, inDb) => {
  const requestId = typeof content.requestId === 'string' ? content.requestId : '';
  const limit = content.limit;
  if (!requestId) {
    log.warn('Current-thread request missing requestId', { sessionId: session.id });
    return;
  }

  let messages: unknown;
  let error: string | undefined;
  try {
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
      throw new Error('limit must be an integer from 1 to 100');
    }
    if (!session.messaging_group_id || !session.thread_id) {
      throw new Error('The current session is not bound to a platform thread.');
    }

    const messagingGroup = getMessagingGroup(session.messaging_group_id);
    if (!messagingGroup) throw new Error('Current messaging group was not found.');

    const adapter = getChannelAdapterExact(messagingGroup.instance ?? messagingGroup.channel_type);
    if (!adapter?.fetchThreadMessages) {
      throw new Error(`Thread history is not supported for ${messagingGroup.channel_type}.`);
    }
    messages = await adapter.fetchThreadMessages(session.thread_id, limit as number);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  insertMessage(inDb, {
    id: `current-thread-response-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: RESPONSE_TYPE, requestId, messages, error }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
});
