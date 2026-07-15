/** Read missing context from the platform thread bound to this agent session. */
import { openInboundDb, getOutboundDb } from '../db/connection.js';
import { markCompleted, type MessageInRow } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { isCorruptionError } from '../db/sqlite-errors.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const RESPONSE_TYPE = 'current_thread_response';
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
/**
 * Pending responses older than this are strays from a call that died
 * mid-poll (e.g. a torn read killed the poller before it could ack).
 * Nothing else ever consumes them — both poll-loop paths skip
 * kind='system' rows — so they would sit pending forever. Gated well past
 * REQUEST_TIMEOUT_MS so a concurrent call's live response is never swept.
 */
const STALE_RESPONSE_MS = 2 * 60_000;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return 50;
  const parsed = typeof value === 'number' ? value : NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

function findResponse(requestId: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  try {
    const row = inbound
      .prepare(
        `SELECT * FROM messages_in
          WHERE status = 'pending'
            AND json_extract(content, '$.type') = ?
            AND json_extract(content, '$.requestId') = ?`,
      )
      .get(RESPONSE_TYPE, requestId) as MessageInRow | undefined;
    if (!row) return undefined;
    const acked = getOutboundDb().prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(row.id);
    return acked ? undefined : row;
  } finally {
    inbound.close();
  }
}

/** Ack stray responses left behind by a previous call that never read them. */
function expireStaleResponses(): void {
  const inbound = openInboundDb();
  try {
    const cutoff = new Date(Date.now() - STALE_RESPONSE_MS).toISOString();
    const stray = inbound
      .prepare(
        `SELECT id FROM messages_in
          WHERE status = 'pending'
            AND json_extract(content, '$.type') = ?
            AND datetime(timestamp) < datetime(?)`,
      )
      .all(RESPONSE_TYPE, cutoff) as Array<{ id: string }>;
    if (stray.length > 0) markCompleted(stray.map((r) => r.id));
  } catch {
    // Hygiene only — never let the sweep block the actual request.
  } finally {
    inbound.close();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RequestCurrentThreadOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Test seam — production always polls inbound.db via findResponse. */
  find?: (requestId: string) => MessageInRow | undefined;
}

export async function requestCurrentThread(
  limit: number,
  options: RequestCurrentThreadOptions = {},
): Promise<{ messages?: unknown; error?: string }> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, pollIntervalMs = POLL_INTERVAL_MS, find = findResponse } = options;
  expireStaleResponses();

  const requestId = `current-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ action: 'read_current_thread', requestId, limit }),
  });

  const deadline = Date.now() + timeoutMs;
  let lastCorruptRead: string | undefined;
  while (Date.now() < deadline) {
    let response: MessageInRow | undefined;
    try {
      response = find(requestId);
      lastCorruptRead = undefined;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!isCorruptionError(message)) throw cause;
      // This poller reads inbound.db right up to the moment the host commits
      // the response row, so it is the likeliest reader to catch a torn page
      // (SQLITE_CORRUPT while the file itself is intact — see
      // db/sqlite-errors.ts). Treat it as "response not visible yet"; the
      // next tick opens a fresh connection and usually sees a clean view.
      lastCorruptRead = message;
    }
    if (response) {
      markCompleted([response.id]);
      try {
        return JSON.parse(response.content) as { messages?: unknown; error?: string };
      } catch {
        return { error: 'Invalid response from the host.' };
      }
    }
    await sleep(pollIntervalMs);
  }
  return {
    error: lastCorruptRead
      ? `Current thread request timed out; reads kept failing with a transient error (${lastCorruptRead}). ` +
        'Call the tool once more before reporting a system problem to the user.'
      : 'Current thread request timed out.',
  };
}

export const readCurrentThread: McpToolDefinition = {
  tool: {
    name: 'read_current_thread',
    description:
      '현재 Slack 입력만으로 필요한 앞선 맥락을 알 수 없을 때 현재 thread를 읽습니다. 사용자가 “위 내용”, “이 이슈”, “스레드”처럼 현재 입력에 없는 앞선 내용을 가리키거나 본문 없는 mention만 보내면 답하거나 되묻기 전에 먼저 호출하세요. 본문 없는 mention은 조회 후에도 같은 작성자의 아직 답변되지 않은 명시적 요청을 하나로 특정할 수 있고 새 권한이나 위험한 작업이 아닐 때만 이어서 처리하고, 다른 사용자의 요청, 이미 답변된 요청, 민감한 작업은 추측하지 말고 짧게 물어보세요. 요청 자체에 충분한 맥락이 있으면 호출하지 마세요. 다른 채널이나 thread는 조회할 수 없습니다.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: '가져올 최근 메시지 수(기본 50, 최대 100)',
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
  async handler(args) {
    const limit = parseLimit(args.limit);
    if (limit === null) return err('limit must be an integer from 1 to 100');

    const response = await requestCurrentThread(limit);
    if (response.error) return err(response.error);
    return ok(JSON.stringify(response.messages ?? [], null, 2));
  },
};

registerTools([readCurrentThread]);
