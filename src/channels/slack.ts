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
import type { ChannelDefaults, InboundMessage, NativeStreamContext } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

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
    const setupBridge = bridge.setup.bind(bridge);
    bridge.setup = (hostConfig) =>
      setupBridge({
        ...hostConfig,
        onInbound: (platformId, threadId, message) =>
          hostConfig.onInbound(platformId, anchorSlackRootDm(threadId, message), message),
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
