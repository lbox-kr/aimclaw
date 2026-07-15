import { describe, expect, it } from 'vitest';

import { lookup } from '../cli/registry.js';
import './index.js';

describe('LBox GitHub custom registration', () => {
  it('registers bounded host GitHub commands through the team custom barrel', () => {
    for (const name of [
      'github-pr-list',
      'github-pr-view',
      'github-pr-checks',
      'github-issue-list',
      'github-issue-view',
      'github-issue-create',
      'github-pr-comment',
      'github-issue-comment',
    ]) {
      expect(lookup(name)).toMatchObject({ name, access: 'approval' });
    }
    expect(lookup('github-api')).toBeUndefined();
  });
});
