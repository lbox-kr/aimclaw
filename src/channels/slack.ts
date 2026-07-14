/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Socket Mode opt-in: set SLACK_APP_TOKEN (xapp-…) to receive events over an
 * outbound WebSocket instead of an inbound HTTPS webhook.
 */
import { createSlackAdapter } from '@chat-adapter/slack';
import type { Message as ChatMessage } from 'chat';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { enrichSlackMentionOnlyContext } from '../custom/slack-mentions.js';
import type { ChannelDefaults, InboundMessage, NativeStreamContext } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

interface SlackAssistantStatusAdapter {
  decodeThreadId(threadId: string): { channel: string; threadTs?: string };
  setAssistantStatus(channelId: string, threadTs: string, status: string): Promise<void>;
}

/** Use the Assistants API directly so one status is rendered without the
 * adapter's duplicate `loading_messages` row. An empty status explicitly
 * clears Slack's remote indicator. */
export async function setSlackAssistantStatus(
  adapter: SlackAssistantStatusAdapter,
  threadId: string,
  status: string,
): Promise<void> {
  const { channel, threadTs } = adapter.decodeThreadId(threadId);
  if (!threadTs) return;
  await adapter.setAssistantStatus(channel, threadTs, status);
}

/**
 * Dedicated bot app on a threaded platform. group threads:true keeps
 * mention-sticky bounded — engagement sticks per-thread, not forever.
 * DM threads stay enabled so Slack's native assistant status and streaming
 * surfaces can anchor each request, and concurrent requests cannot merge into
 * one running provider turn.
 */
const SLACK_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

/**
 * Slack encodes a top-level DM as `slack:D…` without a thread timestamp.
 * Native agent status and streaming require the user's message timestamp as
 * `thread_ts`, and Slack explicitly expects the eventual reply in that same
 * thread. Anchor only root DMs; existing DM threads and channel threads keep
 * the adapter-provided id.
 */
export function anchorSlackRootDm(threadId: string | null, message: InboundMessage): string | null {
  if (message.isGroup !== false || !threadId || !/^slack:D[^:]+$/.test(threadId) || !/^\d+\.\d+$/.test(message.id)) {
    return threadId;
  }
  return `${threadId}:${message.id}`;
}

/** Preserve only the Slack IDs required by chat.startStream. Tokens and the
 * rest of the raw event never leave the bridge process. */
export function extractSlackStreamContext(
  message: Pick<ChatMessage, 'author' | 'raw'>,
): NativeStreamContext | undefined {
  const raw = (message.raw ?? {}) as { team_id?: string; team?: string };
  const recipientUserId = message.author.userId;
  const recipientTeamId = raw.team_id ?? raw.team;
  if (!recipientUserId || !recipientTeamId) return undefined;
  return { recipientUserId, recipientTeamId };
}

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN']);
    if (!env.SLACK_BOT_TOKEN) return null;
    // SLACK_APP_TOKEN (xapp-…) enables Socket Mode: events arrive over an
    // outbound WebSocket, so no public HTTPS endpoint is required. When set,
    // the signing secret is optional (Slack signs socket frames separately).
    const useSocketMode = Boolean(env.SLACK_APP_TOKEN);
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
      appToken: env.SLACK_APP_TOKEN,
      mode: useSocketMode ? 'socket' : 'webhook',
    });
    const bridge = createChatSdkBridge({
      adapter: slackAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: SLACK_DEFAULTS,
      extractStreamContext: extractSlackStreamContext,
      // Slack recommends keeping messages below 4,000 characters for
      // readability. The bridge prefers paragraph boundaries when splitting.
      maxTextLength: 4000,
    });
    bridge.setTyping = (platformId, threadId, status) =>
      setSlackAssistantStatus(slackAdapter, threadId ?? platformId, status ?? 'Typing...');
    bridge.clearTyping = (platformId, threadId) => setSlackAssistantStatus(slackAdapter, threadId ?? platformId, '');
    const setupBridge = bridge.setup.bind(bridge);
    bridge.setup = (hostConfig) =>
      setupBridge({
        ...hostConfig,
        onInbound: async (platformId, threadId, message) => {
          const anchoredThreadId = anchorSlackRootDm(threadId, message);
          let inbound = message;
          if (bridge.fetchThreadMessages) {
            try {
              inbound = await enrichSlackMentionOnlyContext(
                message,
                anchoredThreadId,
                slackAdapter.botUserId,
                bridge.fetchThreadMessages.bind(bridge),
              );
            } catch (err) {
              log.warn('Failed to enrich Slack mention-only context', { threadId: anchoredThreadId, err });
            }
          }
          await hostConfig.onInbound(platformId, anchoredThreadId, inbound);
        },
      });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
  defaults: SLACK_DEFAULTS,
});
