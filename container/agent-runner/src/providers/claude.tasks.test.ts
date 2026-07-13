import { describe, expect, it } from 'bun:test';

import { getClaudeTaskUpdates } from './claude.js';

function state() {
  return { tasks: new Map<string, string>(), taskAliases: new Map<string, string>() };
}

describe('Claude meaningful task updates', () => {
  it('starts and completes a delegated deep review without exposing its prompt', () => {
    const current = state();
    const started = getClaudeTaskUpdates(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Task',
              input: { subagent_type: 'deep-reasoner', prompt: '민감한 내부 프롬프트' },
            },
          ],
        },
      },
      current,
    );
    expect(started).toEqual([{ id: 'tool-1', title: '조금 더 깊이 검토하기', status: 'in_progress' }]);
    expect(JSON.stringify(started)).not.toContain('민감한');

    expect(
      getClaudeTaskUpdates(
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '내부 결과' }] },
        },
        current,
      ),
    ).toEqual([{ id: 'tool-1', title: '조금 더 깊이 검토하기', status: 'complete' }]);
  });

  it('shows web and build work immediately but ignores short internal reads', () => {
    const current = state();
    expect(
      getClaudeTaskUpdates(
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'web-1', name: 'WebSearch', input: { query: 'private query' } },
              { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/private/path' } },
              { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pnpm run build' } },
            ],
          },
        },
        current,
      ),
    ).toEqual([
      { id: 'web-1', title: '관련 자료 찾기', status: 'in_progress' },
      { id: 'bash-1', title: '빌드 확인하기', status: 'in_progress' },
    ]);
  });

  it('promotes only a top-level tool that remains active for four seconds', () => {
    const current = state();
    expect(
      getClaudeTaskUpdates(
        {
          type: 'tool_progress',
          tool_use_id: 'read-1',
          tool_name: 'Read',
          parent_tool_use_id: null,
          elapsed_time_seconds: 3,
        },
        current,
      ),
    ).toEqual([]);
    expect(
      getClaudeTaskUpdates(
        {
          type: 'tool_progress',
          tool_use_id: 'read-1',
          tool_name: 'Read',
          parent_tool_use_id: null,
          elapsed_time_seconds: 4,
        },
        current,
      ),
    ).toEqual([{ id: 'read-1', title: '자료 살펴보기', status: 'in_progress' }]);
    expect(
      getClaudeTaskUpdates(
        {
          type: 'tool_progress',
          tool_use_id: 'nested-1',
          tool_name: 'Read',
          parent_tool_use_id: 'tool-1',
          elapsed_time_seconds: 10,
        },
        current,
      ),
    ).toEqual([]);
  });

  it('closes any remaining cards when the provider turn completes', () => {
    const current = state();
    current.tasks.set('tool-1', '외부 서비스 확인하기');
    expect(getClaudeTaskUpdates({ type: 'result', is_error: false }, current)).toEqual([
      { id: 'tool-1', title: '외부 서비스 확인하기', status: 'complete' },
    ]);
    expect(current.tasks.size).toBe(0);
  });
});
