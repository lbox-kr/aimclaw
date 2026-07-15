import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { clearTurnSends, recordTurnSend, setCurrentRequestMessageId } from './db/session-state.js';
import { formatMessages, extractRouting } from './formatter.js';
import { isCorruptionError, processQuery } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
  // Turn-send records live in session_state; reset them so a prior test
  // cannot suppress a message here.
  clearTurnSends();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(
    id: string,
    kind: string,
    content: object,
    channelType: string | null,
    platformId: string | null,
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

function makeRetryQuery(first: ProviderEvent, second: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  let releaseRetry: (() => void) | undefined;
  const retryPushed = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield first;
    await retryPushed;
    yield second;
  }
  return {
    pushes,
    query: {
      push: (message: string) => {
        pushes.push(message);
        releaseRetry?.();
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

describe('error result with no <message> envelope', () => {
  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(budgetText);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });

  it('still nudges (and does not deliver) a normal unwrapped result', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });
});

describe('Slack response density guard', () => {
  it('holds an over-dense final answer and delivers its one-time compressed retry', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-main', 'Slack', 'channel', 'slack', 'slack:C1', NULL)`,
      )
      .run();
    const first = `<message to="slack-main">검증 결과는 맞아요.

**정확히 확인된 부분**

- 첫 번째 근거
- 두 번째 근거
- 세 번째 근거

**세부가 다른 부분**

- 네 번째 근거</message>`;
    const compressed = '<message to="slack-main">검증 결과는 맞아요. 세부 호출 지점 하나만 정정하면 됩니다.</message>';
    const { query, pushes } = makeRetryQuery({ type: 'result', text: first }, { type: 'result', text: compressed });

    await processQuery(
      query,
      {
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: null,
        inReplyTo: 'm1',
        taskFire: false,
      },
      ['m1'],
      'claude',
      undefined,
      'prompt',
      undefined,
      'brief',
    );

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('밀도 검사에서 보류');
    expect(pushes[0]).toContain('Markdown과 emoji');
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('검증 결과는 맞아요. 세부 호출 지점 하나만 정정하면 됩니다.');
  });
});

describe('task result deduplication', () => {
  function seedTaskSend(): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-main', 'Slack', 'channel', 'slack', 'slack:C1', NULL)`,
      )
      .run();
    writeMessageOut({
      id: 'mcp-send-1',
      in_reply_to: 'task-1',
      kind: 'chat',
      platform_id: 'slack:C1',
      channel_type: 'slack',
      thread_id: 'slack:C1:1712345678.000100',
      content: JSON.stringify({ text: '배포를 완료했어요.' }),
    });
  }

  const taskRouting = {
    platformId: 'slack:C1',
    channelType: 'slack',
    threadId: 'slack:C1:1712345678.000100',
    inReplyTo: 'task-1',
    taskFire: true,
  };

  it('does not nudge a bare final note after send_message already reported the result', async () => {
    seedTaskSend();
    const { query, pushes } = makeResultQuery({ type: 'result', text: '배포 완료 보고를 이미 전송했어요.' });

    await processQuery(query, taskRouting, ['task-1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });

  it('drops a differently worded final message to the same destination', async () => {
    seedTaskSend();
    const { query } = makeResultQuery({
      type: 'result',
      text: '<message to="slack-main">배포 성공 보고를 마쳤어요.</message>',
    });

    await processQuery(query, taskRouting, ['task-1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('배포를 완료했어요.');
  });
});

describe('interactive turn deduplication', () => {
  const routing = {
    platformId: 'slack:D1',
    channelType: 'slack',
    threadId: 'slack:D1:1712345678.000100',
    inReplyTo: 'm1',
  };

  function seedMidTurnSend(text: string): void {
    setCurrentRequestMessageId(routing.inReplyTo);
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('dm', 'DM', 'channel', 'slack', 'slack:D1', NULL)`,
      )
      .run();
    // The user's inbound DM — this is what getDestinationReplyRouting resolves
    // the reply thread_id from, so the final dispatch keys on the same thread
    // the mid-turn send recorded under.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, channel_type, platform_id, thread_id, content)
         VALUES ('m1', 2, 'chat-sdk', datetime('now'), 'processing', 1, 'slack', 'slack:D1', ?, ?)`,
      )
      .run(routing.threadId, JSON.stringify({ text: 'hi' }));
    // Mirror what the send_message MCP tool does: write the standalone chat row
    // (no _nanoclawFinal marker) and record the delivery for the turn.
    writeMessageOut({
      id: 'mcp-send-1',
      in_reply_to: routing.inReplyTo,
      kind: 'chat',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({ text }),
    });
    recordTurnSend(routing.channelType, routing.platformId, routing.threadId, text);
  }

  it('drops a turn-final <message> that echoes a mid-turn send_message', async () => {
    const text = 'AIM에서 여러 문제를 함께 풀면서 정이 든 팀이라서요.';
    seedMidTurnSend(text);
    const { query } = makeResultQuery({
      type: 'result',
      text: `<message to="dm">${text}</message>`,
    });

    await processQuery(query, routing, ['m1'], 'claude', undefined, 'prompt', undefined);

    // Only the mid-turn send survives — the identical final echo is dropped.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(text);
    expect(JSON.parse(out[0].content)._nanoclawFinal).toBeUndefined();
  });

  it('keeps a turn-final <message> whose text differs from the mid-turn send', async () => {
    seedMidTurnSend('중간 상태를 먼저 알려드려요.');
    const finalText = '정리하면 최종 답변은 이거예요.';
    const { query } = makeResultQuery({
      type: 'result',
      text: `<message to="dm">${finalText}</message>`,
    });

    await processQuery(query, routing, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const finalRow = out.find((m) => JSON.parse(m.content)._nanoclawFinal === true);
    expect(finalRow).toBeDefined();
    expect(JSON.parse(finalRow!.content).text).toBe(finalText);
  });

  it('keeps identical text when the question comes from a copied thread', async () => {
    const text = '복사한 스레드에서도 다시 답해 주세요.';
    seedMidTurnSend(text);
    const copiedThreadId = 'slack:D1:1712345678.000200';
    setCurrentRequestMessageId('m-copy');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, channel_type, platform_id, thread_id, content)
         VALUES ('m-copy', 4, 'chat-sdk', datetime('now'), 'processing', 1, 'slack', 'slack:D1', ?, ?)`,
      )
      .run(copiedThreadId, JSON.stringify({ text: 'same question' }));
    const { query } = makeResultQuery({
      type: 'result',
      text: `<message to="dm">${text}</message>`,
    });

    await processQuery(
      query,
      { ...routing, threadId: copiedThreadId, inReplyTo: 'm-copy' },
      ['m-copy'],
      'claude',
      undefined,
      'prompt',
      undefined,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const finalRow = out.find((message) => JSON.parse(message.content)._nanoclawFinal === true);
    expect(finalRow?.thread_id).toBe(copiedThreadId);
    expect(JSON.parse(finalRow!.content).text).toBe(text);
  });
});

describe('Slack native stream events', () => {
  it('orders task update, marked final answer, and stream end', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-main', 'Slack', 'channel', 'slack', 'slack:C1', NULL)`,
      )
      .run();
    insertMessage('m1', 'chat-sdk', { sender: 'User', text: '검토해줘' });

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield {
        type: 'task_update',
        task: { id: 'task-1', title: '검증 실행하기', status: 'in_progress' },
      };
      yield { type: 'result', text: '<message to="slack-main">검토가 끝났어요.</message>' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };
    await processQuery(
      query,
      {
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: 'slack:C1:1.000001',
        inReplyTo: 'm1',
        taskFire: false,
      },
      ['m1'],
      'claude',
      undefined,
      'prompt',
      undefined,
    );

    const out = getUndeliveredMessages();
    expect(out.map((row) => JSON.parse(row.content).action ?? 'chat')).toEqual([
      'stream_task_update',
      'chat',
      'stream_end',
    ]);
    expect(JSON.parse(out[1].content)).toEqual({ text: '검토가 끝났어요.', _nanoclawFinal: true });
  });

  it('closes an active task timeline when the provider iterator ends without a result', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield {
        type: 'task_update',
        task: { id: 'task-1', title: '외부 자료 확인하기', status: 'in_progress' },
      };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };

    await processQuery(
      query,
      {
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: 'slack:C1:1.000001',
        inReplyTo: 'm1',
        taskFire: false,
      },
      ['m1'],
      'claude',
      undefined,
      'prompt',
      undefined,
    );

    const out = getUndeliveredMessages();
    expect(out.map((row) => JSON.parse(row.content).action)).toEqual(['stream_task_update', 'stream_end']);
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});
