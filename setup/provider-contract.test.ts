import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Provider is a DB property of a group, set only via
 * `ncl groups config update --provider`. The group-creation contract that a
 * fork's coding agent and its skills depend on must carry zero provider
 * vocabulary — no `--provider` flag passed to, parsed by, or threaded through
 * any creation path. These guards go red if that flag creeps back in.
 *
 * (Prose references to the ncl surface in comments are fine — we assert the
 * absence of the `'--provider'` arg *literal*, not the substring.)
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

const CREATION_FILES = [
  'scripts/init-first-agent.ts',
  'scripts/init-cli-agent.ts',
  'setup/register.ts',
  'setup/cli-agent.ts',
  'setup/channels/telegram.ts',
  'setup/channels/discord.ts',
  'setup/channels/slack.ts',
  'setup/channels/whatsapp.ts',
  'setup/channels/signal.ts',
  'setup/channels/imessage.ts',
  'setup/channels/teams.ts',
];

describe('creation is provider-agnostic', () => {
  for (const file of CREATION_FILES) {
    it(`${file} passes/parses no --provider flag`, () => {
      const src = read(file);
      expect(src).not.toContain("'--provider'");
      expect(src).not.toMatch(/case '--provider'/);
    });
  }
});

describe('setup carries the picked provider to creation via a setup-run env var', () => {
  it('picked-provider stashes/reads the pick in the NANOCLAW_PICKED_PROVIDER env var', () => {
    const src = read('setup/lib/picked-provider.ts');
    expect(src).toContain('NANOCLAW_PICKED_PROVIDER');
    // The pick is set into process.env so child creation scripts inherit it —
    // an in-process module global can't cross the process boundary.
    expect(src).toMatch(/process\.env\[/);
  });

  // The creation scripts run as child processes, inherit the env var, and apply
  // it to the group's runtime config — container_configs.provider, the source of
  // truth materialized into container.json (agent_provider is deprecated) — before
  // the welcome wakes the container. No `--provider` flag in the contract (above).
  for (const file of ['scripts/init-first-agent.ts', 'scripts/init-cli-agent.ts']) {
    it(`${file} applies the env-carried provider to container_configs.provider`, () => {
      const src = read(file);
      expect(src).toContain('NANOCLAW_PICKED_PROVIDER');
      expect(src).toMatch(/updateContainerConfigScalars\([^)]*provider:\s*pickedProvider/);
    });
  }
});

describe('AimClaw keeps one team identity and voice', () => {
  it('defines 에이미, AIM, and the default honorific style in the tracked runtime contract', () => {
    const contract = read('container/CLAUDE.md');
    const identity = contract.split('## Workspace and memory')[0];
    expect(contract).toContain('# 에이미');
    expect(contract).toContain('LBox AIM 스쿼드');
    expect(contract).toContain('기본 높임법은 친근한 해요체다');
    expect(contract).toContain('반말 허용으로 추정하지 않는다');
    expect(contract).not.toContain('NanoClaw');
    expect(identity).not.toContain('개인 봇');
    expect(identity).not.toContain('전용 에이전트');
    expect(identity).not.toContain('팀 공용 봇');
  });

  it('injects the tracked contract directly instead of relying on an external CLAUDE.md import', () => {
    const runner = read('container/agent-runner/src/index.ts');
    const prompt = read('container/agent-runner/src/destinations.ts');
    const composer = read('src/claude-md-compose.ts');

    expect(runner).toContain("fs.readFileSync(SHARED_INSTRUCTIONS_PATH, 'utf-8')");
    expect(runner).toContain('buildSystemPromptAddendum(config.assistantName || undefined, sharedInstructions)');
    expect(prompt).not.toContain("'# You are '");
    expect(prompt).toContain('에이전트 이름은 **${assistantName}**다.');
    expect(composer).not.toContain("imports.push('@./.claude-shared.md')");
  });

  it('keeps onboarding out of ordinary identity questions', () => {
    const welcome = read('container/skills/welcome/SKILL.md');
    expect(welcome).toContain('명시적인 환영 요청을 받았을 때만 사용한다');
    expect(welcome).toContain('질문이나 작업을 이미 요청했다면 환영 절차를 실행하지 않고');
  });

  it('keeps response-style responsibilities in their owning prompt layer', () => {
    const contract = read('container/CLAUDE.md');
    const slack = read('container/skills/slack-formatting/SKILL.md');
    const slackInstructions = read('container/skills/slack-formatting/instructions.md');
    const productSearch = read('container/skills/lbox-product-code-search/SKILL.md');

    expect(contract).toContain('기존 구조를 그대로 반복하지 않고');
    expect(contract).toContain('공식 보고서 문체를 요청하지 않았다면');
    expect(slackInstructions).toContain('최종 응답 전에 `/slack-formatting`을 사용한다');
    expect(slack).toContain('공통 높임법 규칙을 유지하면서');
    expect(slack).toContain('공통 상태는 상위에서 한 번');
    expect(slack).toContain('상태를 비교하는 목록에서는 항목마다');
    expect(productSearch).toContain('commit에 고정된 짧은 코드 링크');
    expect(slackInstructions).not.toContain('명사형 종결');
    expect(slack).not.toContain('commit에 고정된');
    expect(productSearch).not.toContain('공통 상태');
  });

  for (const file of ['scripts/init-first-agent.ts', 'scripts/init-cli-agent.ts']) {
    it(`${file} does not seed a personal NanoClaw identity`, () => {
      expect(read(file)).not.toContain('personal NanoClaw agent');
    });
  }
});

describe('codex installs from a hard-wired self-contained script', () => {
  // The provider picker no longer enumerates a remote manifest branch (an
  // unaudited control surface). Codex is offered in trunk and installed by its
  // own setup/add-<name>.sh, exactly like a channel adapter.
  it('setup/add-codex.sh exists', () => {
    expect(fs.existsSync(path.join(repoRoot, 'setup/add-codex.sh'))).toBe(true);
  });

  it('setup/auto.ts installs the picked provider by running setup/add-<name>.sh', () => {
    const src = read('setup/auto.ts');
    expect(src).toContain('setup/add-${agentProvider}.sh');
    // The removed branch-enumeration machinery must not creep back in.
    expect(src).not.toContain('listBranchProviderManifests');
    expect(src).not.toContain('installProviderFromBranch');
  });
});
