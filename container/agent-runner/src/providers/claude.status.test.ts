import { describe, expect, it } from 'bun:test';

import { getClaudeWorkingStatus } from './claude.js';

function state() {
  return { toolUseIds: new Set<string>(), taskToolUseIds: new Map<string, string | undefined>() };
}

describe('Claude deep-reasoner working status', () => {
  it('announces a deep-reasoner Task before the subagent starts', () => {
    const current = state();
    expect(
      getClaudeWorkingStatus(
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Task',
                input: { subagent_type: 'deep-reasoner', prompt: 'private reasoning prompt' },
              },
            ],
          },
        },
        current,
      ),
    ).toBe('조금 더 깊이 고민하고 있어요');
    expect(current.toolUseIds.has('tool-1')).toBe(true);
  });

  it('switches to result synthesis when the deep-reasoner tool returns', () => {
    const current = state();
    current.toolUseIds.add('tool-1');
    expect(
      getClaudeWorkingStatus({ type: 'user', parent_tool_use_id: 'tool-1', message: { content: [] } }, current),
    ).toBe('고민한 내용을 정리하고 있어요');
    expect(current.toolUseIds.size).toBe(0);
  });

  it('tracks background task lifecycle without exposing descriptions', () => {
    const current = state();
    expect(
      getClaudeWorkingStatus(
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
    ).toBe('조금 더 깊이 고민하고 있어요');
    expect(
      getClaudeWorkingStatus(
        { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'completed' } },
        current,
      ),
    ).toBe('고민한 내용을 정리하고 있어요');
  });

  it('ignores ordinary Task calls', () => {
    expect(
      getClaudeWorkingStatus(
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'Task', input: { subagent_type: 'general-purpose' } },
            ],
          },
        },
        state(),
      ),
    ).toBeNull();
  });
});
