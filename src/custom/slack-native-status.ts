/**
 * Native working-status bridge.
 *
 * The agent emits a host-only `set_status` action before a slow operation.
 * The host updates the active typing target; Slack renders that target through
 * assistant.threads.setStatus while other channels keep their normal typing
 * behavior. No progress message is added to the conversation.
 */
import { registerDeliveryAction } from '../delivery.js';
import { updateTypingStatus } from '../modules/typing/index.js';

const MAX_STATUS_LENGTH = 100;

registerDeliveryAction('set_status', async (content, session) => {
  if (typeof content.status !== 'string') return;
  const status = content.status.trim().slice(0, MAX_STATUS_LENGTH);
  if (!status) return;
  updateTypingStatus(session.id, status);
});
