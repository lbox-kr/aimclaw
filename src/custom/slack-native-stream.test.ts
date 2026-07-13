import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { getDeliveryAction, setDeliveryAdapter } from '../delivery.js';
import type { Session } from '../types.js';
import { finishSlackNativeStream, resetSlackNativeStreamsForTest } from './slack-native-stream.js';

const session: Session = {
  id: 'session-1',
  agent_group_id: 'agent-1',
  messaging_group_id: null,
  thread_id: 'slack:C1:1.000001',
  agent_provider: 'claude',
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-07-13T00:00:00.000Z',
};

let inDb: Database.Database;

beforeEach(() => {
  runMigrations(initTestDb());
  inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER,
      channel_type TEXT,
      platform_id TEXT,
      content TEXT NOT NULL
    )
  `);
});

afterEach(async () => {
  await resetSlackNativeStreamsForTest();
  inDb.close();
  closeDb();
});

describe('Slack native stream lifecycle', () => {
  it('streams task updates and closes with the final answer', async () => {
    inDb.prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?)').run(
      'm1',
      2,
      'slack',
      'slack:C1',
      JSON.stringify({
        _nanoclawStreamContext: { recipientUserId: 'U1', recipientTeamId: 'T1' },
      }),
    );

    const chunks: unknown[] = [];
    setDeliveryAdapter({
      deliver: async () => 'fallback-1',
      stream: async (_channelType, _platformId, _threadId, updates, options) => {
        expect(options).toMatchObject({ recipientUserId: 'U1', recipientTeamId: 'T1' });
        for await (const update of updates) chunks.push(update);
        return 'stream-1';
      },
    });

    await getDeliveryAction('stream_task_update')!(
      {
        action: 'stream_task_update',
        routing: {
          channelType: 'slack',
          platformId: 'slack:C1',
          threadId: 'slack:C1:1.000001',
          inReplyTo: 'm1',
        },
        task: { id: 'task-1', title: '검증 실행하기', status: 'in_progress' },
      },
      session,
      inDb,
    );

    await expect(
      finishSlackNativeStream(
        session.id,
        { channelType: 'slack', platformId: 'slack:C1', threadId: 'slack:C1:1.000001' },
        '모두 확인했어요.',
      ),
    ).resolves.toEqual({ handled: true, messageId: 'stream-1' });
    expect(chunks).toEqual([
      { type: 'task_update', id: 'task-1', title: '검증 실행하기', status: 'in_progress' },
      { type: 'markdown_text', text: '모두 확인했어요.' },
    ]);
  });

  it('keeps postMessage fallback when Slack stream context is unavailable', async () => {
    let streamCalls = 0;
    setDeliveryAdapter({
      deliver: async () => 'fallback-1',
      stream: async () => {
        streamCalls++;
        return 'stream-1';
      },
    });
    await getDeliveryAction('stream_task_update')!(
      {
        action: 'stream_task_update',
        routing: {
          channelType: 'slack',
          platformId: 'slack:C1',
          threadId: 'slack:C1:1.000001',
          inReplyTo: 'missing',
        },
        task: { id: 'task-1', title: '검증 실행하기', status: 'in_progress' },
      },
      session,
      inDb,
    );
    expect(streamCalls).toBe(0);
    await expect(
      finishSlackNativeStream(
        session.id,
        { channelType: 'slack', platformId: 'slack:C1', threadId: 'slack:C1:1.000001' },
        '일반 답변',
      ),
    ).resolves.toEqual({ handled: false });
  });
});
