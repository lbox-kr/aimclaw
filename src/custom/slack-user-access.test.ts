import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDefaults, InboundEvent } from '../channels/adapter.js';
import { registerChannelAdapter } from '../channels/channel-registry.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import {
  createMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import {
  createPendingChannelApproval,
  getPendingChannelApproval,
} from '../modules/permissions/db/pending-channel-approvals.js';
import { createUser } from '../modules/permissions/db/users.js';
import { grantRole, isGlobalAdmin, isOwner } from '../modules/permissions/db/user-roles.js';
import { applyRequestPolicy, changeAdministrator, parseAdministratorCommand } from './slack-user-access.js';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/aimclaw-test-slack-user-access' };
});

const TEST_DIR = '/tmp/aimclaw-test-slack-user-access';
const now = () => new Date().toISOString();

const slackDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('slack', { factory: () => null, defaults: slackDefaults });

function user(id: string): void {
  createUser({ id, kind: 'slack', display_name: null, created_at: now() });
}

function event(text: string): InboundEvent {
  return {
    channelType: 'slack',
    platformId: 'slack:C1',
    threadId: 'T1',
    message: {
      id: 'm1',
      kind: 'chat-sdk',
      content: JSON.stringify({ text, senderId: 'UOWNER' }),
      timestamp: now(),
    },
  };
}

function groupMention(platformId = 'slack:CNEW'): InboundEvent {
  return {
    channelType: 'slack',
    instance: 'slack',
    platformId,
    threadId: 'thread-1',
    message: {
      id: 'message-1',
      kind: 'chat-sdk',
      content: JSON.stringify({ text: '<@UBOT> 안녕하세요', senderId: 'U123', senderName: '팀원' }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await import('../modules/permissions/index.js');

  const { wakeContainer } = await import('../container-runner.js');
  vi.mocked(wakeContainer).mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('request authorization', () => {
  it('resolves owner and global admin as administrators, everyone else as a member', () => {
    user('slack:owner');
    user('slack:admin');
    user('slack:member');
    grantRole({ user_id: 'slack:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'slack:admin', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });

    const ownerEvent = event('hi');
    applyRequestPolicy(ownerEvent, 'slack:owner', 'ag-1');
    expect(JSON.parse(ownerEvent.message.content)._nanoclawAuthorization.role).toBe('administrator');

    const adminEvent = event('hi');
    applyRequestPolicy(adminEvent, 'slack:admin', 'ag-1');
    expect(JSON.parse(adminEvent.message.content)._nanoclawAuthorization.role).toBe('administrator');

    const memberEvent = event('hi');
    applyRequestPolicy(memberEvent, 'slack:member', 'ag-1');
    const member = JSON.parse(memberEvent.message.content)._nanoclawAuthorization;
    expect(member).toMatchObject({
      role: 'member',
      allowedTools: ['WebSearch', 'WebFetch', 'mcp__nanoclaw__read_current_thread'],
      allowedCommands: [],
      skillTools: {},
    });
  });

  it('automatically registers a Slack workspace sender as a general user of the addressed agent', () => {
    user('slack:U2');

    applyRequestPolicy(event('안녕하세요'), 'slack:U2', 'ag-1');

    expect(isMember('slack:U2', 'ag-1')).toBe(true);
  });
});

describe('Slack administrator commands', () => {
  it('parses a bot-mentioned Korean command with a Slack target mention', () => {
    expect(parseAdministratorCommand(event('<@UBOT> 관리자 추가 <@U222>'))).toEqual({
      action: 'add',
      targetUserId: 'slack:U222',
    });
  });

  it('adds and removes a global administrator in user_roles', () => {
    user('slack:owner');
    grantRole({ user_id: 'slack:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    expect(changeAdministrator('slack:owner', { action: 'add', targetUserId: 'slack:U222' }).ok).toBe(true);
    expect(isGlobalAdmin('slack:U222')).toBe(true);
    expect(changeAdministrator('slack:owner', { action: 'remove', targetUserId: 'slack:U222' }).ok).toBe(true);
    expect(isGlobalAdmin('slack:U222')).toBe(false);
  });

  it('prevents the last administrator from deleting themself', () => {
    user('slack:owner');
    grantRole({ user_id: 'slack:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    const result = changeAdministrator('slack:owner', { action: 'remove', targetUserId: 'slack:owner' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('마지막 관리자');
    expect(isOwner('slack:owner')).toBe(true);
  });

  it('rejects changes from a general user', () => {
    user('slack:member');
    expect(changeAdministrator('slack:member', { action: 'add', targetUserId: 'slack:U222' }).ok).toBe(false);
  });
});

describe('Slack channel automatic connection', () => {
  it('connects the first mentioned group to the sole agent and routes the same message', async () => {
    const { routeInbound } = await import('../router.js');
    const { wakeContainer } = await import('../container-runner.js');

    await routeInbound(groupMention());

    const messagingGroup = getMessagingGroupByPlatform('slack', 'slack:CNEW', 'slack');
    expect(messagingGroup).toBeDefined();
    expect(getMessagingGroupAgentByPair(messagingGroup!.id, 'ag-1')).toMatchObject({
      engage_mode: 'mention-sticky',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
    });
    expect(isMember('slack:U123', 'ag-1')).toBe(true);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('keeps the approval flow when more than one agent exists', async () => {
    createAgentGroup({
      id: 'ag-other',
      name: '다른 에이전트',
      folder: 'other',
      agent_provider: null,
      created_at: now(),
    });
    const { routeInbound } = await import('../router.js');

    await routeInbound(groupMention('slack:CMULTI'));

    const messagingGroup = getMessagingGroupByPlatform('slack', 'slack:CMULTI', 'slack');
    expect(messagingGroup).toBeDefined();
    expect(getMessagingGroupAgentByPair(messagingGroup!.id, 'ag-1')).toBeUndefined();
    expect(getMessagingGroupAgentByPair(messagingGroup!.id, 'ag-other')).toBeUndefined();
  });

  it('clears an existing approval card when the channel is automatically connected', async () => {
    createMessagingGroup({
      id: 'mg-pending',
      channel_type: 'slack',
      platform_id: 'slack:CPENDING',
      instance: 'slack',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: now(),
    });
    createPendingChannelApproval({
      messaging_group_id: 'mg-pending',
      agent_group_id: 'ag-1',
      original_message: JSON.stringify(groupMention('slack:CPENDING')),
      approver_user_id: 'slack:owner',
      created_at: now(),
      title: 'Connect to 에이미',
      options_json: '[]',
    });
    const { routeInbound } = await import('../router.js');

    await routeInbound(groupMention('slack:CPENDING'));

    expect(getPendingChannelApproval('mg-pending')).toBeUndefined();
    expect(getMessagingGroupAgentByPair('mg-pending', 'ag-1')).toBeDefined();
  });
});
