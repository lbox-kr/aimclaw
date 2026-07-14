/**
 * Host-trusted attribution for privileged actions initiated during one user turn.
 *
 * The container only returns the inbound message id it is currently processing.
 * Identity stays host-side: the router records the real sender for that exact
 * session/message pair, and every newer triggered message replaces the grant.
 * Missing, stale, mismatched, or post-restart state therefore fails closed.
 */

const AUTHORITY_TTL_MS = 15 * 60 * 1000;

interface ActiveRequestAuthority {
  messageId: string;
  userId: string | null;
  expiresAt: number;
}

const activeBySession = new Map<string, ActiveRequestAuthority>();

export function recordActiveRequester(sessionId: string, messageId: string, userId: string | null): void {
  activeBySession.set(sessionId, {
    messageId,
    userId,
    expiresAt: Date.now() + AUTHORITY_TTL_MS,
  });
}

export function resolveActiveRequester(sessionId: string, messageId: string | null): string | null {
  if (!messageId) return null;
  const active = activeBySession.get(sessionId);
  if (!active) return null;
  if (active.expiresAt <= Date.now()) {
    activeBySession.delete(sessionId);
    return null;
  }
  if (active.messageId !== messageId) return null;
  return active.userId;
}
