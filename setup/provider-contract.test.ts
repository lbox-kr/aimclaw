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
    const currentThread = read('container/agent-runner/src/mcp-tools/current-thread.ts');
    const productSearch = read('container/skills/lbox-product-code-search/SKILL.md');

    expect(contract).toContain('기존 구조를 그대로 반복하지 않고');
    expect(contract).toContain('공식 보고서 문체를 요청하지 않았다면');
    expect(slackInstructions).toContain('최종 응답 전에 `/slack-formatting`을 사용한다');
    expect(slackInstructions).toContain('`response_mode`를 응답량의 기준으로 삼는다');
    expect(slack).toContain('아래 예시는 복사할 고정 양식이 아니다');
    expect(slack).toContain('응답량은 런타임이 이번 요청에 붙인 `response_mode`와 전송 전 밀도 검사가 결정한다');
    expect(slack).toContain('질문에 대한 직접 답');
    expect(slack).toContain('결론을 바꾸는 핵심 근거');
    expect(slack).toContain('같은 결론의 반복과 별도 마무리 요약');
    expect(slack).toContain('조사 깊이와 답변 길이는 별개다');
    expect(slack).toContain('평문·카드·파일 설명 중 주 형식은 하나만 선택하고');
    expect(slack).toContain('답을 받아야 하는 제한된 선택만 `ask_user_question`으로 묻는다');
    expect(slack).toContain('사용자가 접근할 수 없는 내부 경로는 제시하지 않는다');
    for (const example of [
      '### 짧은 직접 답',
      '### 상태가 섞인 짧은 답',
      '### 비교가 필요한 상세 답',
      '### 복구 상태와 실행 순서가 함께 있는 상세 답',
    ]) {
      expect(slack).toContain(example);
    }
    expect(slack).toMatch(/\| 기준\s+\| A안\s+\| B안\s+\|/);
    expect(slack).toContain('- ⚠️ 업로드 재시도율이 8%로 올랐어요');
    expect(slack).toContain('> B안은 팀마다 다른 정책');
    expect(slack).toContain('- [x] 오류를 만든 worker 배포 되돌리기');
    expect(slack).not.toContain('- ✅ **결제 webhook**');
    expect(slack).not.toContain('점검 3건 중 2건은 정상이고');
    expect(slack).not.toContain('진행 reaction');
    expect(slack).not.toContain('## Thread와 mention');
    expect(slack).not.toContain('read_current_thread');
    expect(slackInstructions).not.toContain('read_current_thread');
    expect(currentThread).toContain('같은 작성자의 아직 답변되지 않은 명시적 요청');
    expect(slack).not.toContain('최신 Slack Markdown');
    expect(slack).not.toContain('약 4,000자');
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
