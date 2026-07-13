type ExecutionPolicy = {
  userId: string | null;
  role: 'administrator' | 'member' | 'system';
  allowedTools: string[];
  skillTools: Record<string, string[]>;
};

type AuthorizationMessage = {
  kind: string;
  channel_type: string | null;
  trigger: number;
  content: string;
};

const memberPolicy: ExecutionPolicy = { userId: null, role: 'member', allowedTools: [], skillTools: {} };
let currentPolicy = memberPolicy;
const selectedTools = new Set<string>();

function matches(pattern: string, tool: string): boolean {
  if (!pattern.includes('*')) return pattern === tool;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(tool);
}

function readPolicy(content: string): ExecutionPolicy | null {
  try {
    const value = (JSON.parse(content) as { _nanoclawAuthorization?: unknown })._nanoclawAuthorization;
    if (!value || typeof value !== 'object') return null;
    const policy = value as Partial<ExecutionPolicy>;
    if (policy.role !== 'administrator' && policy.role !== 'member') return null;
    if (!Array.isArray(policy.allowedTools) || !policy.skillTools || typeof policy.skillTools !== 'object') return null;
    if (policy.allowedTools.some((tool) => typeof tool !== 'string')) return null;
    for (const tools of Object.values(policy.skillTools)) {
      if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) return null;
    }
    return {
      userId: typeof policy.userId === 'string' ? policy.userId : null,
      role: policy.role,
      allowedTools: policy.allowedTools,
      skillTools: policy.skillTools,
    };
  } catch {
    return null;
  }
}

/** One runner serves one session, so one mutable policy follows its active query. */
export function setExecutionPolicyForMessages(messages: AuthorizationMessage[]): void {
  const triggering = messages.filter((message) => message.trigger === 1);
  const message = triggering.at(-1) ?? messages.at(-1);
  const trustedSystem = message?.kind === 'task' || message?.kind === 'system' || message?.channel_type === 'agent';
  currentPolicy =
    (message && readPolicy(message.content)) ?? (trustedSystem ? { ...memberPolicy, role: 'system' } : memberPolicy);
  selectedTools.clear();
}

/** Final enforcement point called by Claude's PreToolUse hook. */
export function authorizeTool(tool: string, input: Record<string, unknown>): { allowed: boolean; reason?: string } {
  if (currentPolicy.role !== 'member') return { allowed: true };

  if (tool === 'Skill') {
    const raw = typeof input.skill === 'string' ? input.skill : typeof input.name === 'string' ? input.name : '';
    const skill = raw.trim().replace(/^\//, '').toLowerCase();
    const tools = currentPolicy.skillTools[skill];
    if (!tools?.includes('Skill')) {
      return { allowed: false, reason: `일반 사용자에게 허용되지 않은 스킬입니다: ${skill || '(알 수 없음)'}` };
    }
    for (const name of tools) selectedTools.add(name);
    return { allowed: true };
  }

  if ([...currentPolicy.allowedTools, ...selectedTools].some((pattern) => matches(pattern, tool))) {
    return { allowed: true };
  }
  return { allowed: false, reason: `일반 사용자에게 허용되지 않은 도구입니다: ${tool}` };
}
