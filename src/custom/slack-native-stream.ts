/**
 * Slack native structured stream lifecycle.
 *
 * Container task events arrive as ordered system actions. The first meaningful
 * task starts one Chat SDK stream for the session, later actions append task
 * cards, and delivery.ts supplies the final answer before closing the queue.
 * If streaming is unavailable or fails, delivery falls back to postMessage.
 */
import type Database from 'better-sqlite3';

import type { NativeStreamChunk, NativeStreamContext } from '../channels/adapter.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { getDeliveryAdapter, registerDeliveryAction, registerFinalMessageDelivery } from '../delivery.js';
import { log } from '../log.js';
import { pauseTypingRefreshAfterDelivery, updateTypingStatus } from '../modules/typing/index.js';
import { onShutdown } from '../response-registry.js';
import type { Session } from '../types.js';
import { removeSlackProcessingReaction } from './slack-processing-reaction.js';

const MAX_STREAM_MS = 30 * 60 * 1000;
const STREAM_CLOSE_TIMEOUT_MS = 20_000;
const VALID_TASK_STATUSES = new Set(['in_progress', 'complete', 'error']);

interface StreamRouting {
  platformId: string;
  channelType: 'slack';
  threadId: string | null;
  inReplyTo: string | null;
}

class AsyncChunkQueue implements AsyncIterable<NativeStreamChunk> {
  private chunks: NativeStreamChunk[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(chunk: NativeStreamChunk): void {
    if (this.closed) return;
    this.chunks.push(chunk);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<NativeStreamChunk> {
    while (!this.closed || this.chunks.length > 0) {
      if (this.chunks.length > 0) {
        yield this.chunks.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

interface ActiveStream {
  routing: StreamRouting;
  instance?: string;
  queue: AsyncChunkQueue;
  completion: Promise<string | undefined>;
  failed: boolean;
  lastTasks: Map<string, string>;
  timeout: NodeJS.Timeout | null;
}

const activeStreams = new Map<string, ActiveStream>();

registerDeliveryAction('set_status', async (content, session) => {
  if (typeof content.status !== 'string') return;
  const status = content.status.trim().slice(0, 100);
  if (status) updateTypingStatus(session.id, status);
});

function parseRouting(value: unknown): StreamRouting | null {
  if (!value || typeof value !== 'object') return null;
  const routing = value as Record<string, unknown>;
  if (routing.channelType !== 'slack' || typeof routing.platformId !== 'string') return null;
  return {
    channelType: 'slack',
    platformId: routing.platformId,
    threadId: typeof routing.threadId === 'string' ? routing.threadId : null,
    inReplyTo: typeof routing.inReplyTo === 'string' ? routing.inReplyTo : null,
  };
}

function parseTask(value: unknown): Extract<NativeStreamChunk, { type: 'task_update' }> | null {
  if (!value || typeof value !== 'object') return null;
  const task = value as Record<string, unknown>;
  if (
    typeof task.id !== 'string' ||
    typeof task.title !== 'string' ||
    typeof task.status !== 'string' ||
    !VALID_TASK_STATUSES.has(task.status)
  ) {
    return null;
  }
  const chunk: Extract<NativeStreamChunk, { type: 'task_update' }> = {
    type: 'task_update',
    id: task.id.trim().slice(0, 100),
    title: task.title.trim().slice(0, 80),
    status: task.status as 'in_progress' | 'complete' | 'error',
  };
  if (!chunk.id || !chunk.title) return null;
  return chunk;
}

function sameRouting(a: StreamRouting, b: StreamRouting): boolean {
  return a.platformId === b.platformId && a.threadId === b.threadId;
}

function resolveInstance(session: Session, routing: StreamRouting): string | undefined {
  const origin = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (origin?.channel_type === routing.channelType && origin.platform_id === routing.platformId) return origin.instance;
  return getMessagingGroupByPlatform(routing.channelType, routing.platformId)?.instance;
}

function readStreamContext(inDb: Database.Database, routing: StreamRouting): NativeStreamContext | undefined {
  const row = routing.inReplyTo
    ? (inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(routing.inReplyTo) as
        | { content: string }
        | undefined)
    : (inDb
        .prepare(
          `SELECT content FROM messages_in
           WHERE channel_type = ? AND platform_id = ?
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(routing.channelType, routing.platformId) as { content: string } | undefined);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.content) as { _nanoclawStreamContext?: NativeStreamContext };
    return parsed._nanoclawStreamContext;
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

async function closeActive(sessionId: string, markdown?: string): Promise<{ handled: boolean; messageId?: string }> {
  const active = activeStreams.get(sessionId);
  if (!active) return { handled: false };
  activeStreams.delete(sessionId);
  if (active.timeout) clearTimeout(active.timeout);
  if (markdown) active.queue.push({ type: 'markdown_text', text: markdown });
  active.queue.close();
  let closeTimer: NodeJS.Timeout | undefined;
  const messageId = await Promise.race([
    active.completion,
    new Promise<undefined>((resolve) => {
      closeTimer = setTimeout(() => resolve(undefined), STREAM_CLOSE_TIMEOUT_MS);
      closeTimer.unref();
    }),
  ]);
  if (closeTimer) clearTimeout(closeTimer);
  if (!messageId && !active.failed) {
    active.failed = true;
    log.warn('Slack native stream stop timed out; using postMessage fallback', { sessionId });
  }
  return active.failed || !messageId ? { handled: false } : { handled: true, messageId };
}

async function startStream(
  session: Session,
  inDb: Database.Database,
  routing: StreamRouting,
): Promise<ActiveStream | null> {
  const delivery = getDeliveryAdapter();
  const context = readStreamContext(inDb, routing);
  if (!delivery?.stream || !context?.recipientUserId || !context.recipientTeamId) {
    log.warn('Slack native stream unavailable; keeping status + postMessage fallback', { sessionId: session.id });
    return null;
  }

  const queue = new AsyncChunkQueue();
  const active: ActiveStream = {
    routing,
    instance: resolveInstance(session, routing),
    queue,
    completion: Promise.resolve<string | undefined>(undefined),
    failed: false,
    lastTasks: new Map<string, string>(),
    timeout: null,
  };
  active.timeout = setTimeout(() => {
    if (activeStreams.get(session.id) !== active) return;
    log.warn('Slack native stream expired; closing without blocking later postMessage fallback', {
      sessionId: session.id,
    });
    void closeActive(session.id);
  }, MAX_STREAM_MS);
  active.timeout?.unref();
  activeStreams.set(session.id, active);
  active.completion = delivery
    .stream(
      routing.channelType,
      routing.platformId,
      routing.threadId,
      queue,
      {
        recipientUserId: context.recipientUserId,
        recipientTeamId: context.recipientTeamId,
        taskDisplayMode: 'timeline',
      },
      active.instance,
    )
    .catch((err) => {
      active.failed = true;
      log.warn('Slack native stream failed; final answer will use postMessage', { sessionId: session.id, err });
      return undefined;
    });
  return active;
}

registerDeliveryAction('stream_task_update', async (content, session, inDb) => {
  const routing = parseRouting(content.routing);
  const task = parseTask(content.task);
  if (!routing || !task) return;

  let active = activeStreams.get(session.id);
  if (active && !sameRouting(active.routing, routing)) {
    await closeActive(session.id);
    active = undefined;
  }
  active ??= (await startStream(session, inDb, routing)) ?? undefined;
  if (!active || active.failed) return;

  const signature = `${task.status}\0${task.title}`;
  if (active.lastTasks.get(task.id) === signature) return;
  active.lastTasks.set(task.id, signature);
  active.queue.push(task);
});

registerDeliveryAction('stream_end', async (content, session, inDb) => {
  const routing = parseRouting(content.routing);
  const active = activeStreams.get(session.id);
  if (!routing || !active || !sameRouting(active.routing, routing)) return;
  const result = await closeActive(session.id);
  if (!result.handled) return;
  pauseTypingRefreshAfterDelivery(session.id);
  void removeSlackProcessingReaction(inDb, routing.inReplyTo, active.instance).catch((err) => {
    log.warn('Slack processing reaction removal after stream end failed', { sessionId: session.id, err });
  });
});

/** Final-answer delivery hook. `handled:false` means caller must post normally. */
export async function finishSlackNativeStream(
  sessionId: string,
  routing: { channelType: string; platformId: string; threadId: string | null },
  markdown: string,
): Promise<{ handled: boolean; messageId?: string }> {
  const active = activeStreams.get(sessionId);
  if (
    !active ||
    routing.channelType !== 'slack' ||
    active.routing.platformId !== routing.platformId ||
    active.routing.threadId !== routing.threadId
  ) {
    return { handled: false };
  }
  return closeActive(sessionId, markdown);
}

registerFinalMessageDelivery(async (content, message, session) => {
  if (typeof content.text !== 'string' || message.channel_type !== 'slack' || !message.platform_id) {
    return { handled: false };
  }
  return finishSlackNativeStream(
    session.id,
    { channelType: message.channel_type, platformId: message.platform_id, threadId: message.thread_id },
    content.text,
  );
});

export async function resetSlackNativeStreamsForTest(): Promise<void> {
  await Promise.all([...activeStreams.keys()].map((sessionId) => closeActive(sessionId)));
}

onShutdown(async () => {
  await Promise.all([...activeStreams.keys()].map((sessionId) => closeActive(sessionId)));
});
