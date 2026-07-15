import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(path.join(process.cwd(), 'scripts/team/install-repo-sync.sh'), 'utf8');

describe('repository sync GitHub authentication', () => {
  it('proves host keychain auth without inherited GitHub tokens', () => {
    for (const variable of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      expect(script).toContain(`-u ${variable}`);
    }
    expect(script).toContain('for key in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy');
    expect(script).toContain('*onecli*|*host.docker.internal*|*:10255*');
    expect(script).toContain('without_github_auth_env "$GH_BIN" auth status');
    expect(script).toContain('without_github_auth_env "$GH_BIN" auth setup-git');
    expect(script).toContain('without_github_auth_env "$REPO_ROOT/scripts/team/sync-repos.sh"');
  });
});
