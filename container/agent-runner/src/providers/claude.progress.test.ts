import { describe, expect, it } from 'bun:test';

import { getClaudeProgressUpdates } from './claude.js';

function state() {
  return {
    tasks: new Map<string, string>(),
    pendingTasks: new Map<string, string>(),
    taskAliases: new Map<string, string>(),
    deepToolIds: new Set<string>(),
    deepTasks: new Map<string, string | undefined>(),
  };
}

describe('Claude user-facing progress', () => {
  it('announces a delegated deep review without exposing its prompt', () => {
    const update = getClaudeProgressUpdates(
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
      state(),
    );

    expect(update).toEqual({ status: '조금 더 깊이 고민하고 있어요', tasks: [] });
    expect(JSON.stringify(update)).not.toContain('민감한');
  });

  it('completes the task and switches to result synthesis when the tool returns', () => {
    const current = state();
    current.deepToolIds.add('tool-1');

    expect(
      getClaudeProgressUpdates(
        {
          type: 'user',
          parent_tool_use_id: 'tool-1',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '내부 결과' }] },
        },
        current,
      ),
    ).toEqual({ status: '고민한 내용을 정리하고 있어요', tasks: [] });
  });

  it('tracks background task lifecycle without exposing descriptions', () => {
    const current = state();
    expect(
      getClaudeProgressUpdates(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-1',
          tool_use_id: 'tool-1',
          subagent_type: 'deep-reasoner',
          description: 'private task description',
        },
        current,
      ),
    ).toEqual({ status: '조금 더 깊이 고민하고 있어요', tasks: [] });
    expect(
      getClaudeProgressUpdates(
        { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'completed' } },
        current,
      ),
    ).toEqual({ status: '고민한 내용을 정리하고 있어요', tasks: [] });
  });

  it('keeps ordinary delegation out of user-facing task cards', () => {
    expect(
      getClaudeProgressUpdates(
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: { subagent_type: 'general-purpose' } }],
          },
        },
        state(),
      ),
    ).toEqual({ status: null, tasks: [] });
  });

  it('defers meaningful web and build cards until the work is long-running', () => {
    const current = state();
    const initial = getClaudeProgressUpdates(
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
    );
    expect(initial.tasks).toEqual([]);
    expect([...current.pendingTasks]).toEqual([
      ['web-1', '관련 자료 찾기'],
      ['bash-1', '빌드 확인하기'],
    ]);

    expect(
      getClaudeProgressUpdates(
        {
          type: 'tool_progress',
          tool_use_id: 'bash-1',
          tool_name: 'Bash',
          parent_tool_use_id: null,
          elapsed_time_seconds: 9,
        },
        current,
      ).tasks,
    ).toEqual([]);
    expect(
      getClaudeProgressUpdates(
        {
          type: 'tool_progress',
          tool_use_id: 'bash-1',
          tool_name: 'Bash',
          parent_tool_use_id: null,
          elapsed_time_seconds: 10,
        },
        current,
      ).tasks,
    ).toEqual([{ id: 'bash-1', title: '빌드 확인하기', status: 'in_progress' }]);
  });

  it('keeps internal reads and nested tools out of task cards even when they are slow', () => {
    const current = state();
    expect(
      getClaudeProgressUpdates(
        {
          type: 'tool_progress',
          tool_use_id: 'read-1',
          tool_name: 'Read',
          parent_tool_use_id: null,
          elapsed_time_seconds: 10,
        },
        current,
      ).tasks,
    ).toEqual([]);
    expect(
      getClaudeProgressUpdates(
        {
          type: 'tool_progress',
          tool_use_id: 'nested-1',
          tool_name: 'Read',
          parent_tool_use_id: 'tool-1',
          elapsed_time_seconds: 10,
        },
        current,
      ).tasks,
    ).toEqual([]);
  });

  it('closes any remaining cards when the provider turn completes', () => {
    const current = state();
    current.tasks.set('tool-1', '외부 서비스 확인하기');
    expect(getClaudeProgressUpdates({ type: 'result', is_error: false }, current).tasks).toEqual([
      { id: 'tool-1', title: '외부 서비스 확인하기', status: 'complete' },
    ]);
    expect(current.tasks.size).toBe(0);
  });
});
