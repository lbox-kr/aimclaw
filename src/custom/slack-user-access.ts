/**
 * AimClaw Slack user authorization.
 *
 * The central NanoClaw role tables remain the only authority source. This
 * module auto-connects new Slack channels, resolves a fresh execution policy
 * for every routed request, and handles administrator changes before a
 * message can reach the LLM.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

import type { InboundEvent } from '../channels/adapter.js';
import { resolveUnknownSenderPolicy, resolveWiringDefaults } from '../channels/channel-defaults.js';
import { getAllAgentGroups } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupWithAgentCount,
  setMessagingGroupDeniedAt,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import { getDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { deletePendingChannelApproval } from '../modules/permissions/db/pending-channel-approvals.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { isGlobalAdmin, isOwner } from '../modules/permissions/db/user-roles.js';
import { registerMessageInterceptor, setRequestPolicyResolver } from '../router.js';

interface AllowlistFile {
  tools: string[];
  commands: string[];
  skills: Record<string, string[]>;
}

const ALLOWLIST_PATH = fileURLToPath(
  new URL('../../container/skills/team-user-access/allowlist.json', import.meta.url),
);

function loadAllowlist(): AllowlistFile {
  const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')) as Partial<AllowlistFile>;
  if (!Array.isArray(raw.tools) || !Array.isArray(raw.commands) || !raw.skills || typeof raw.skills !== 'object') {
    throw new Error('team-user-access allowlist must define tools[], commands[], and skills{}');
  }

  if (raw.tools.some((tool) => typeof tool !== 'string' || !tool)) throw new Error('Invalid allowlisted tool');
  if (raw.commands.some((command) => typeof command !== 'string' || !command.startsWith('/'))) {
    throw new Error('Invalid allowlisted command');
  }
  const skills: AllowlistFile['skills'] = {};
  for (const [name, tools] of Object.entries(raw.skills)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !Array.isArray(tools)) {
      throw new Error(`Invalid allowlisted skill: ${name}`);
    }
    if (!tools.includes('Skill') || tools.some((tool) => typeof tool !== 'string' || !tool)) {
      throw new Error(`Allowlisted skill "${name}" must explicitly include the Skill tool`);
    }
    skills[name] = [...new Set(tools)];
  }

  return {
    tools: [...new Set(raw.tools)],
    commands: [...new Set(raw.commands.map((command) => command.toLowerCase()))],
    skills,
  };
}

export function applyRequestPolicy(event: InboundEvent, userId: string | null, agentGroupId: string): void {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return;
  }

  const administrator = !!userId && (isOwner(userId) || isGlobalAdmin(userId));
  const allowlist = administrator ? { tools: [], commands: [], skills: {} } : loadAllowlist();
  if (!administrator && event.channelType === 'slack' && event.message.isGroup === true && userId) {
    const author = content.author as { isBot?: unknown } | undefined;
    if (author?.isBot !== true) {
      addMember({ user_id: userId, agent_group_id: agentGroupId, added_by: null, added_at: new Date().toISOString() });
    }
  }

  content._nanoclawAuthorization = {
    userId,
    role: administrator ? 'administrator' : 'member',
    allowedTools: allowlist.tools,
    allowedCommands: [...allowlist.commands, ...Object.keys(allowlist.skills).map((skill) => `/${skill}`)],
    skillTools: allowlist.skills,
  };
  event.message.content = JSON.stringify(content);
}

setRequestPolicyResolver(applyRequestPolicy);

type AdministratorCommand = { action: 'add' | 'remove'; targetUserId: string };

export function parseAdministratorCommand(event: InboundEvent): AdministratorCommand | null {
  if (event.channelType !== 'slack') return null;
  let text = '';
  try {
    const content = JSON.parse(event.message.content) as { text?: unknown };
    text = typeof content.text === 'string' ? content.text.trim() : '';
  } catch {
    return null;
  }

  const match = text.match(
    /^(?:<@[A-Z0-9]+>\s*|@\S+\s+)?관리자\s+(추가|삭제)\s+(?:<@([UW][A-Z0-9]+)>|([UW][A-Z0-9]+))\s*$/i,
  );
  if (!match) return null;
  return {
    action: match[1] === '추가' ? 'add' : 'remove',
    targetUserId: `slack:${match[2] ?? match[3]}`,
  };
}

function senderUserId(event: InboundEvent): string | null {
  try {
    const content = JSON.parse(event.message.content) as Record<string, unknown>;
    const author =
      content.author && typeof content.author === 'object' ? (content.author as Record<string, unknown>) : undefined;
    const raw =
      (typeof content.senderId === 'string' && content.senderId) ||
      (typeof author?.userId === 'string' && author.userId) ||
      null;
    if (!raw) return null;
    return raw.includes(':') ? raw : `slack:${raw}`;
  } catch {
    return null;
  }
}

export function changeAdministrator(
  actorUserId: string,
  command: AdministratorCommand,
): { ok: boolean; message: string } {
  if (!isOwner(actorUserId) && !isGlobalAdmin(actorUserId)) {
    return { ok: false, message: '관리자만 관리자 권한을 변경할 수 있습니다.' };
  }

  const db = getDb();
  const target = command.targetUserId;
  if (command.action === 'add') {
    upsertUser({ id: target, kind: 'slack', display_name: null, created_at: new Date().toISOString() });
    if (isOwner(target) || isGlobalAdmin(target)) {
      return { ok: true, message: `<@${target.slice('slack:'.length)}>님은 이미 관리자입니다.` };
    }
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, 'admin', NULL, ?, ?)`,
    ).run(target, actorUserId, new Date().toISOString());
    return { ok: true, message: `<@${target.slice('slack:'.length)}>님을 관리자로 추가했습니다.` };
  }

  return db.transaction(() => {
    const administrators = db
      .prepare("SELECT user_id FROM user_roles WHERE agent_group_id IS NULL AND role IN ('owner', 'admin')")
      .all() as Array<{ user_id: string }>;
    if (!administrators.some((row) => row.user_id === target)) {
      return { ok: false, message: `<@${target.slice('slack:'.length)}>님은 관리자가 아닙니다.` };
    }
    if (target === actorUserId && new Set(administrators.map((row) => row.user_id)).size === 1) {
      return { ok: false, message: '마지막 관리자 한 명은 자신의 관리자 권한을 삭제할 수 없습니다.' };
    }

    db.prepare(
      `DELETE FROM user_roles
       WHERE user_id = ? AND agent_group_id IS NULL AND role IN ('owner', 'admin')`,
    ).run(target);
    return { ok: true, message: `<@${target.slice('slack:'.length)}>님의 관리자 권한을 삭제했습니다.` };
  })();
}

registerMessageInterceptor(async (event) => {
  const isDm = event.channelType === 'slack' && event.message.isGroup === false;
  const dmActor = isDm ? senderUserId(event) : null;
  if (isDm && (!dmActor || (!isOwner(dmActor) && !isGlobalAdmin(dmActor)))) {
    log.info('Slack DM dropped — sender is not a current administrator', { userId: dmActor });
    return true;
  }

  if (event.channelType === 'slack' && (isDm || (event.message.isGroup === true && event.message.isMention === true))) {
    const instance = event.instance ?? event.channelType;
    const found = getMessagingGroupWithAgentCount(event.channelType, event.platformId, instance);

    if (isDm && found) {
      if (found.mg.is_group !== 0 || found.mg.unknown_sender_policy !== 'strict') {
        updateMessagingGroup(found.mg.id, { is_group: 0, unknown_sender_policy: 'strict' });
      }
      if (found.mg.denied_at) setMessagingGroupDeniedAt(found.mg.id, null);
    }

    const agentGroups = found?.agentCount || (!isDm && found?.mg.denied_at) ? [] : getAllAgentGroups();

    if (agentGroups.length === 1) {
      const isGroup = !isDm;
      const agentGroup = agentGroups[0];
      const now = new Date().toISOString();
      const messagingGroupId = found?.mg.id ?? `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const engage = resolveWiringDefaults(instance, isGroup, agentGroup.name, event.channelType);

      if (!found) {
        createMessagingGroup({
          id: messagingGroupId,
          channel_type: event.channelType,
          platform_id: event.platformId,
          instance,
          name: null,
          is_group: isGroup ? 1 : 0,
          unknown_sender_policy: isDm ? 'strict' : resolveUnknownSenderPolicy(instance, true, event.channelType),
          denied_at: null,
          created_at: now,
        });
      }

      createMessagingGroupAgent({
        id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        messaging_group_id: messagingGroupId,
        agent_group_id: agentGroup.id,
        engage_mode: engage.engage_mode,
        engage_pattern: engage.engage_pattern,
        sender_scope: 'known',
        // Missing context is fetched on demand through read_current_thread
        // after a real invocation. Plain channel traffic stays unpersisted.
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now,
      });
      deletePendingChannelApproval(messagingGroupId);
      log.info(
        isDm
          ? 'Slack administrator DM automatically connected to sole agent'
          : 'Slack channel automatically connected to sole agent',
        {
          messagingGroupId,
          agentGroupId: agentGroup.id,
          platformId: event.platformId,
        },
      );
    } else if (isDm && !found?.agentCount) {
      log.warn('Slack administrator DM dropped — exactly one agent group is required', { userId: dmActor });
      return true;
    }
  }

  const command = parseAdministratorCommand(event);
  if (!command) return false;

  const actor = senderUserId(event);
  const result = actor
    ? changeAdministrator(actor, command)
    : { ok: false, message: 'Slack 발신자를 확인할 수 없어 관리자 권한을 변경하지 못했습니다.' };
  const adapter = getDeliveryAdapter();
  if (adapter) {
    await adapter.deliver(
      event.channelType,
      event.platformId,
      event.threadId,
      event.message.kind,
      JSON.stringify({ text: result.message }),
      undefined,
      event.instance,
    );
  }
  return true;
});
