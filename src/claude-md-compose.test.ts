import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-claude-md-compose-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-claude-md-compose-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { composeGroupClaudeMd, migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function seed(ag: AgentGroup): void {
  createAgentGroup(ag);
  ensureContainerConfig(ag.id);
}

function writePersona(folder: string, text: string): void {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PERSONA_PREPEND_FILE), text);
}

function importsOf(folder: string): string[] {
  const md = fs.readFileSync(path.join(GROUPS_DIR, folder, 'CLAUDE.md'), 'utf-8');
  return md.split('\n').filter((line) => line.startsWith('@'));
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('composeGroupClaudeMd persona prepend', () => {
  it('imports the persona fragment FIRST, before the shared base', () => {
    const ag = group('ag-persona', 'persona-group');
    seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-fragments/persona.md');
    expect(imports[1]).toBe('@./.claude-shared.md');
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'), 'utf-8')).toBe(
      'You are an SDR agent.',
    );
  });

  it('keeps the persona across a second compose (not pruned)', () => {
    const ag = group('ag-persona-2', 'persona-group-2');
    seed(ag);
    writePersona(ag.folder, 'persona body');

    composeGroupClaudeMd(ag);
    composeGroupClaudeMd(ag);

    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(true);
    expect(importsOf(ag.folder)[0]).toBe('@./.claude-fragments/persona.md');
  });

  it('is inert when no persona file is present (non-template groups)', () => {
    const ag = group('ag-no-persona', 'no-persona-group');
    seed(ag);

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-shared.md');
    expect(imports).not.toContain('@./.claude-fragments/persona.md');
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(false);
  });
});

describe('composeGroupClaudeMd scheduling instructions (ncl tasks reach-in)', () => {
  // Red-on-delete guard for the `scheduling`/`cli` exclusion at the
  // module-fragment loop: the agent is taught `ncl tasks` iff it has ncl.
  it('imports module-scheduling.md at the default cli_scope', () => {
    const ag = group('ag-sched', 'sched-group');
    seed(ag);

    composeGroupClaudeMd(ag);

    expect(importsOf(ag.folder)).toContain('@./.claude-fragments/module-scheduling.md');
  });

  it('excludes module-scheduling.md (and module-cli.md) when cli_scope is disabled', () => {
    const ag = group('ag-sched-off', 'sched-group-off');
    seed(ag);
    updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports).not.toContain('@./.claude-fragments/module-scheduling.md');
    expect(imports).not.toContain('@./.claude-fragments/module-cli.md');
  });
});

describe('AimClaw identity invariants', () => {
  it('does not teach the runtime to create persistent agent identities', () => {
    const ag = group('ag-single-identity', 'single-identity');
    seed(ag);

    composeGroupClaudeMd(ag);

    expect(importsOf(ag.folder)).not.toContain('@./.claude-fragments/module-agents.md');
  });

  it.each([
    'When the user first reaches out, introduce yourself briefly and invite them to chat. Keep replies concise.',
    'When the user first reaches out (or you receive a system welcome prompt), introduce yourself briefly and invite them to chat. Keep replies concise.',
  ])('removes the retired personal-agent seed while preserving team memory', (welcome) => {
    const dir = path.join(GROUPS_DIR, 'legacy-personal-seed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'CLAUDE.local.md'),
      `# 에이미\n\nYou are 에이미, a personal NanoClaw agent for 정현수. ${welcome}\n\n## 팀 메모리\n\n- AIM 주간 회의는 월요일이다.\n`,
    );

    migrateGroupsToClaudeLocal();

    expect(fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf-8')).toBe(
      '## 팀 메모리\n\n- AIM 주간 회의는 월요일이다.\n',
    );
  });
});

describe('composeGroupClaudeMd skill instructions', () => {
  it('imports instructions only from explicitly enabled skills and prunes stale fragments', () => {
    const ag = group('ag-skills', 'skills-group');
    seed(ag);

    composeGroupClaudeMd(ag);
    expect(importsOf(ag.folder)).toContain('@./.claude-fragments/skill-slack-formatting.md');

    updateContainerConfigJson(ag.id, 'skills', ['onecli-gateway']);
    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports).toContain('@./.claude-fragments/skill-onecli-gateway.md');
    expect(imports).not.toContain('@./.claude-fragments/skill-slack-formatting.md');
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'skill-slack-formatting.md'))).toBe(
      false,
    );
  });
});
