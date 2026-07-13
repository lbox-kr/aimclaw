/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;
const DEFAULT_WORKING_STATUS = '요청을 처리하고 있어요';

interface TypingAdapter {
  setTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance?: string,
    status?: string,
  ): Promise<void>;
  clearTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  status: string;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();
const typingOperations = new Map<string, Promise<void>>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

function queueTypingOperation(sessionId: string, operation: () => Promise<void>): Promise<void> {
  const previous = typingOperations.get(sessionId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(operation)
    .catch(() => {});
  typingOperations.set(sessionId, current);
  void current.then(() => {
    if (typingOperations.get(sessionId) === current) typingOperations.delete(sessionId);
  });
  return current;
}

function triggerTyping(
  sessionId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
  status?: string,
): Promise<void> {
  return queueTypingOperation(sessionId, async () => {
    await adapter?.setTyping?.(channelType, platformId, threadId, instance, status);
  });
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
  status = DEFAULT_WORKING_STATUS,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    void triggerTyping(sessionId, channelType, platformId, threadId, instance, status);
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    // Keep the stored entry self-consistent: a re-trigger can arrive from
    // a different chat address (agent-shared sessions span messaging
    // groups, possibly on different platforms/instances), so the address
    // fields and the owning instance must move together — a torn entry
    // (old address + new instance) would hand e.g. a telegram platformId
    // to a Slack instance's setTyping on the next interval tick.
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.instance = instance;
    existing.status = status;
    return;
  }

  // Immediate tick + periodic refresh.
  void triggerTyping(sessionId, channelType, platformId, threadId, instance, status);
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      void triggerTyping(sessionId, entry.channelType, entry.platformId, entry.threadId, entry.instance, entry.status);
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, clear the remote
    // indicator as well as the local refresher.
    void completeTypingRefresh(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    status,
    interval,
    startedAt,
    pausedUntil: 0,
  });
}

/** Replace the native working text for an active request and display it
 * immediately. The periodic refresher keeps the same text alive while the
 * container heartbeat remains fresh. */
export function updateTypingStatus(sessionId: string, status: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.status = status;
  entry.pausedUntil = 0;
  void triggerTyping(sessionId, entry.channelType, entry.platformId, entry.threadId, entry.instance, status);
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

/** Finish one request. Stop future refreshes first, then enqueue the remote
 * clear behind any in-flight status update so a late response cannot revive
 * the indicator after completion. */
export async function completeTypingRefresh(sessionId: string): Promise<void> {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) {
    await typingOperations.get(sessionId);
    return;
  }
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
  await queueTypingOperation(sessionId, async () => {
    await adapter?.clearTyping?.(entry.channelType, entry.platformId, entry.threadId, entry.instance);
  });
}

export function stopTypingRefresh(sessionId: string): void {
  void completeTypingRefresh(sessionId);
}
