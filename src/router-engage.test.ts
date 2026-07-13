import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/aimclaw-test-router-engage' };
});

const TEST_DIR = '/tmp/aimclaw-test-router-engage';
const CHANNEL = 'slack:C1';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { evaluateEngage } from './router.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

function stickyAgent(): MessagingGroupAgent {
  return {
    id: 'wiring-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  };
}

function groupChat(): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: CHANNEL,
    instance: 'slack',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: new Date().toISOString(),
  };
}

function seedSession(threadId: string, trigger: 0 | 1): void {
  const { session } = resolveSession('ag-1', 'mg-1', threadId, 'per-thread');
  writeSessionMessage('ag-1', session.id, {
    id: `message-${trigger}-${threadId}`,
    kind: 'chat-sdk',
    timestamp: new Date().toISOString(),
    platformId: CHANNEL,
    channelType: 'slack',
    threadId,
    content: JSON.stringify({ text: 'hello' }),
    trigger,
  });
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  createMessagingGroup(groupChat());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('mention-sticky engagement', () => {
  it('always engages on an explicit mention', () => {
    expect(evaluateEngage(stickyAgent(), 'hello', true, groupChat(), `${CHANNEL}:thread-1`)).toBe(true);
  });

  it('does not engage an unmentioned channel root', () => {
    seedSession(CHANNEL, 1);
    expect(evaluateEngage(stickyAgent(), 'hello', false, groupChat(), CHANNEL)).toBe(false);
  });

  it('does not treat an accumulate-only session as an invocation', () => {
    const threadId = `${CHANNEL}:thread-2`;
    seedSession(threadId, 0);
    expect(evaluateEngage(stickyAgent(), 'hello', false, groupChat(), threadId)).toBe(false);
  });

  it('continues an actually invoked thread without another mention', () => {
    const threadId = `${CHANNEL}:thread-3`;
    seedSession(threadId, 1);
    expect(evaluateEngage(stickyAgent(), 'hello', false, groupChat(), threadId)).toBe(true);
  });
});
