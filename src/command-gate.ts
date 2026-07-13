/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Normal messages: pass through unchanged
 */
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from './modules/permissions/db/user-roles.js';

export type GateResult = { action: 'pass' } | { action: 'filter' } | { action: 'deny'; command: string };

const FILTERED_COMMANDS = new Set(['/start', '/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  let text: string;
  let memberCommands: string[] | undefined;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
    const policy = parsed._nanoclawAuthorization;
    if (policy?.role === 'member' && Array.isArray(policy.allowedCommands)) {
      memberCommands = policy.allowedCommands;
    } else if (policy?.role === 'administrator') {
      memberCommands = [];
    }
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (memberCommands === undefined) {
    if (!ADMIN_COMMANDS.has(command)) return { action: 'pass' };
    return userId && hasAdminPrivilege(userId, agentGroupId) ? { action: 'pass' } : { action: 'deny', command };
  }

  if (userId && (isOwner(userId) || isGlobalAdmin(userId))) return { action: 'pass' };
  return memberCommands.includes(command) ? { action: 'pass' } : { action: 'deny', command };
}
