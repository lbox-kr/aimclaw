/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import crypto from 'crypto';

import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

/**
 * The a2a reply stamp: the id of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it and stamp it onto outbound
 * rows so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This lives in outbound.db rather than module state because the MCP server
 * runs as a separate stdio subprocess from the poll loop — module state set
 * by the poll loop is invisible to it. Both processes open outbound.db
 * (journal_mode=DELETE + busy_timeout make intra-container access safe).
 */
const IN_REPLY_TO_KEY = 'current_in_reply_to';
const REQUEST_MESSAGE_KEY = 'current_request_message_id';
const TURN_SEND_KEY_PREFIX = 'turn_send:';
const TURN_SEND_SEPARATOR = '\0';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const ACTIVE_STAMP_MAX_AGE_MS = 30 * 60 * 1000;

function getFreshValue(key: string): string | null {
  const row = getOutboundDb().prepare('SELECT value, updated_at FROM session_state WHERE key = ?').get(key) as
    | { value: string; updated_at: string }
    | undefined;
  if (!row) return null;
  const age = Date.now() - new Date(row.updated_at).getTime();
  return Number.isFinite(age) && age <= ACTIVE_STAMP_MAX_AGE_MS ? row.value : null;
}

export function setCurrentInReplyTo(id: string | null): void {
  if (id === null) {
    clearCurrentInReplyTo();
    return;
  }
  setValue(IN_REPLY_TO_KEY, id);
}

export function clearCurrentInReplyTo(): void {
  deleteValue(IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  return getFreshValue(IN_REPLY_TO_KEY);
}

/**
 * Host-authenticated request attribution uses the exact inbound row whose
 * execution policy is active. The ncl subprocess reads this value and returns
 * only the message id; the host keeps the associated user identity privately.
 */
export function setCurrentRequestMessageId(id: string | null): void {
  if (id === null) deleteValue(REQUEST_MESSAGE_KEY);
  else setValue(REQUEST_MESSAGE_KEY, id);
}

function turnSendKey(channelType: string | null, platformId: string | null, threadId: string | null, text: string) {
  const requestMessageId = getFreshValue(REQUEST_MESSAGE_KEY);
  if (!requestMessageId) return null;
  const digest = crypto
    .createHash('sha256')
    .update([requestMessageId, channelType ?? '', platformId ?? '', threadId ?? '', text].join(TURN_SEND_SEPARATOR))
    .digest('hex');
  return [`${TURN_SEND_KEY_PREFIX}${digest}`, requestMessageId] as const;
}

/** Record a user-facing message delivered this turn via send_message. */
export function recordTurnSend(
  channelType: string | null,
  platformId: string | null,
  threadId: string | null,
  text: string,
): void {
  const record = turnSendKey(channelType, platformId, threadId, text);
  if (record) setValue(...record);
}

/** True if this exact text was already sent to this destination this turn. */
export function wasSentThisTurn(
  channelType: string | null,
  platformId: string | null,
  threadId: string | null,
  text: string,
): boolean {
  const record = turnSendKey(channelType, platformId, threadId, text);
  return record !== null && getValue(record[0]) !== undefined;
}

/** Clear the record — called when a turn completes. */
export function clearTurnSends(): void {
  getOutboundDb().prepare("DELETE FROM session_state WHERE key GLOB 'turn_send:*'").run();
}
