import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearActiveRequester, recordActiveRequester, resolveActiveRequester } from './request-authority.js';

afterEach(() => {
  clearActiveRequester('session-1');
  vi.useRealTimers();
});

describe('active request authority', () => {
  it('resolves only the exact host-recorded session, group, and message', () => {
    recordActiveRequester('session-1', 'agent-1', 'message-1', 'slack:UADMIN');

    expect(resolveActiveRequester('session-1', 'agent-1', 'message-1')).toBe('slack:UADMIN');
    expect(resolveActiveRequester('session-1', 'agent-2', 'message-1')).toBeNull();
    expect(resolveActiveRequester('session-1', 'agent-1', 'message-old')).toBeNull();
  });

  it('invalidates the previous sender when a newer request reaches the session', () => {
    recordActiveRequester('session-1', 'agent-1', 'admin-message', 'slack:UADMIN');
    recordActiveRequester('session-1', 'agent-1', 'member-message', 'slack:UMEMBER');

    expect(resolveActiveRequester('session-1', 'agent-1', 'admin-message')).toBeNull();
    expect(resolveActiveRequester('session-1', 'agent-1', 'member-message')).toBe('slack:UMEMBER');
  });

  it('fails closed after the short-lived attribution expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
    recordActiveRequester('session-1', 'agent-1', 'message-1', 'slack:UADMIN');

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);

    expect(resolveActiveRequester('session-1', 'agent-1', 'message-1')).toBeNull();
  });
});
