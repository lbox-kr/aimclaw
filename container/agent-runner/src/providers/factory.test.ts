import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('uses Haiku by default while preserving an explicit Claude model', () => {
    const defaultProvider = createProvider('claude') as unknown as { model?: string };
    const configuredProvider = createProvider('claude', {
      model: 'claude-opus-4-8',
    }) as unknown as { model?: string };

    expect(defaultProvider.model).toBe('claude-haiku-4-5-20251001');
    expect(configuredProvider.model).toBe('claude-opus-4-8');
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });
});
