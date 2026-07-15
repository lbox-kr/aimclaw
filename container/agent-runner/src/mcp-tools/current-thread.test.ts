/**
 * Tests for the read_current_thread container-side poller.
 *
 * Pins the 2026-07-15 incident behavior: the host wrote the thread response
 * into inbound.db, but the tool's poller caught a torn read (`database disk
 * image is malformed`) at exactly that moment, had no retry, surfaced the
 * SQLite error to the user, and left the response row pending forever —
 * nothing else consumes kind='system' rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import type { MessageInRow } from '../db/messages-in.js';
import { requestCurrentThread } from './current-thread.js';

function insertResponseRow(id: string, requestId: string, ageMs = 0): void {
  const timestamp = new Date(Date.now() - ageMs).toISOString();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'system', ?, 'pending', 0, ?)`,
    )
    .run(
      id,
      timestamp,
      JSON.stringify({ type: 'current_thread_response', requestId, messages: [{ text: 'hi' }] }),
    );
}

function ackStatus(id: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
    .get(id) as { status: string } | undefined;
  return row?.status;
}

/** The tool writes its host request synchronously before the first await. */
function lastRequestId(): string {
  const row = getOutboundDb()
    .prepare("SELECT content FROM messages_out WHERE kind = 'system' ORDER BY rowid DESC LIMIT 1")
    .get() as { content: string };
  return (JSON.parse(row.content) as { requestId: string }).requestId;
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('requestCurrentThread', () => {
  it('returns messages once the host response lands', async () => {
    const pending = requestCurrentThread(50, { timeoutMs: 2_000, pollIntervalMs: 10 });
    insertResponseRow('resp-1', lastRequestId());

    const result = await pending;

    expect(result.error).toBeUndefined();
    expect(result.messages).toEqual([{ text: 'hi' }]);
    // Consumed responses are acked so they never ride along a later batch.
    expect(ackStatus('resp-1')).toBe('completed');
  });

  it('keeps polling through torn reads while the host writes (SQLITE_CORRUPT)', async () => {
    let calls = 0;
    const find = (): MessageInRow | undefined => {
      calls++;
      if (calls <= 3) throw new Error('database disk image is malformed');
      return { id: 'resp-2', content: JSON.stringify({ messages: [1] }) } as MessageInRow;
    };

    const result = await requestCurrentThread(50, { timeoutMs: 2_000, pollIntervalMs: 5, find });

    expect(result.error).toBeUndefined();
    expect(result.messages).toEqual([1]);
    expect(calls).toBe(4);
    expect(ackStatus('resp-2')).toBe('completed');
  });

  it('times out with a transient-read note when corruption persists', async () => {
    const find = (): MessageInRow | undefined => {
      throw new Error('SQLITE_CORRUPT: database disk image is malformed');
    };

    const result = await requestCurrentThread(50, { timeoutMs: 60, pollIntervalMs: 5, find });

    expect(result.error).toContain('timed out');
    expect(result.error).toContain('malformed');
  });

  it('does not blame a stale corruption once a later read succeeds', async () => {
    let calls = 0;
    const find = (): MessageInRow | undefined => {
      calls++;
      if (calls === 1) throw new Error('database disk image is malformed');
      return undefined; // healthy reads, response just never arrives
    };

    const result = await requestCurrentThread(50, { timeoutMs: 60, pollIntervalMs: 5, find });

    expect(result.error).toBe('Current thread request timed out.');
  });

  it('propagates non-corruption read errors unchanged', async () => {
    const find = (): MessageInRow | undefined => {
      throw new Error('no such table: messages_in');
    };

    await expect(requestCurrentThread(50, { timeoutMs: 60, pollIntervalMs: 5, find })).rejects.toThrow(
      'no such table',
    );
  });

  it('acks stray responses from a dead previous call, but never fresh ones', async () => {
    insertResponseRow('stray', 'req-old', 10 * 60_000);
    insertResponseRow('fresh', 'req-live', 1_000);

    const result = await requestCurrentThread(50, { timeoutMs: 30, pollIntervalMs: 5 });

    expect(result.error).toContain('timed out');
    expect(ackStatus('stray')).toBe('completed');
    expect(ackStatus('fresh')).toBeUndefined();
  });
});
