import { describe, expect, it } from 'vitest';

import { lookup } from '../cli/registry.js';
import './index.js';

describe('LBox AWS custom registration', () => {
  it('registers the deploy command through the team custom barrel', () => {
    expect(lookup('lbox-aws-deploy-static-file')).toMatchObject({
      name: 'lbox-aws-deploy-static-file',
      access: 'open',
    });
  });
});
