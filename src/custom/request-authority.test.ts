import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordActiveRequester, resolveActiveRequester } from './request-authority.js';

afterEach(() => vi.useRealTimers());

describe('active request authority', () => {
  it('resolves only the exact host-recorded session and message', () => {
    recordActiveRequester('session-exact', 'message-1', 'slack:UADMIN');

    expect(resolveActiveRequester('session-exact', 'message-1')).toBe('slack:UADMIN');
    expect(resolveActiveRequester('session-other', 'message-1')).toBeNull();
    expect(resolveActiveRequester('session-exact', 'message-old')).toBeNull();
  });

  it('invalidates the previous sender when a newer request reaches the session', () => {
    recordActiveRequester('session-newest', 'admin-message', 'slack:UADMIN');
    recordActiveRequester('session-newest', 'member-message', 'slack:UMEMBER');

    expect(resolveActiveRequester('session-newest', 'admin-message')).toBeNull();
    expect(resolveActiveRequester('session-newest', 'member-message')).toBe('slack:UMEMBER');
  });

  it('fails closed after the short-lived attribution expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
    recordActiveRequester('session-expiry', 'message-1', 'slack:UADMIN');

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);

    expect(resolveActiveRequester('session-expiry', 'message-1')).toBeNull();
  });
});
