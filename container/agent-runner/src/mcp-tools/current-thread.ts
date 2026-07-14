/** Read missing context from the platform thread bound to this agent session. */
import { openInboundDb, getOutboundDb } from '../db/connection.js';
import { markCompleted, type MessageInRow } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const RESPONSE_TYPE = 'current_thread_response';

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function requestCurrentThread(limit: number): Promise<{ messages?: unknown; error?: string }> {
  const requestId = `current-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ action: 'read_current_thread', requestId, limit }),
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = findResponse(requestId);
    if (response) {
      markCompleted([response.id]);
      try {
        return JSON.parse(response.content) as { messages?: unknown; error?: string };
      } catch {
        return { error: 'Invalid response from the host.' };
      }
    }
    await sleep(250);
  }
  return { error: 'Current thread request timed out.' };
}

export const readCurrentThread: McpToolDefinition = {
  tool: {
    name: 'read_current_thread',
    description:
      '현재 Slack 입력만으로 필요한 앞선 맥락을 알 수 없을 때 현재 thread를 한 번 읽습니다. 본문 없는 mention에서는 같은 작성자의 아직 답변되지 않은 명시적 요청을 하나로 특정할 수 있고 새 권한이나 위험한 작업이 아닐 때만 이어서 처리하세요. 다른 사용자의 요청, 이미 답변된 요청, 민감한 작업을 추측하지 말고 불명확하면 짧게 물어보세요. 요청 자체에 충분한 맥락이 있으면 호출하지 마세요. 다른 채널이나 thread는 조회할 수 없습니다.',
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
