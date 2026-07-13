/**
 * AimClaw's Slack typing-first policy.
 *
 * The Chat SDK represents a top-level DM as `slack:<channel>:`. Slack's native
 * Assistant status requires a non-empty thread timestamp, so use the inbound
 * message timestamp as the root. The router still keeps DMs in one shared
 * agent session; only the platform reply address is threaded.
 */
import type { ChannelDefaults, InboundEvent } from '../channels/adapter.js';

function isSlackDm(event: InboundEvent): boolean {
  return event.channelType === 'slack' && event.message.isGroup === false;
}

export function enableSlackTypingThread(event: InboundEvent): InboundEvent {
  if (!isSlackDm(event) || !event.message.id || !event.threadId || !/^slack:[^:]+:$/.test(event.threadId)) {
    return event;
  }
  return { ...event, threadId: `${event.threadId}${event.message.id}` };
}

export function withAimClawSlackDefaults(event: InboundEvent, defaults: ChannelDefaults): ChannelDefaults {
  if (!isSlackDm(event) || defaults.dm.threads) return defaults;
  return { ...defaults, dm: { ...defaults.dm, threads: true } };
}
