import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InboundEvent } from '../channels/adapter.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import { createUser } from '../modules/permissions/db/users.js';
import { grantRole, isGlobalAdmin, isOwner } from '../modules/permissions/db/user-roles.js';
import { applyRequestPolicy, changeAdministrator, parseAdministratorCommand } from './slack-user-access.js';

const now = () => new Date().toISOString();

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

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
});

afterEach(() => closeDb());

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
      allowedTools: ['WebSearch', 'WebFetch'],
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
