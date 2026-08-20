import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-scopes-'));
  process.env.DV_HOME = home;
  vi.resetModules();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DV_HOME;
  vi.unstubAllGlobals();
});

/** GitHub reports a classic token's scopes only in this header. */
function stubUser(scopeHeader: string | null, login = 'octocat') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'x-oauth-scopes' ? scopeHeader : null) },
      json: async () => ({ login }),
    })) as any,
  );
}

describe('reading a personal access token', () => {
  it('reads the scopes out of the X-OAuth-Scopes header', async () => {
    stubUser('repo, read:org, workflow');
    const { github } = await import('../src/api/github.js');
    const result = await github.whoamiWithScopes('ghp_x');
    expect(result.login).toBe('octocat');
    expect(result.scopes).toEqual(['repo', 'read:org', 'workflow']);
  });

  it('returns an empty list for a fine-grained token, which sends no header', async () => {
    // Empty must mean "cannot tell", never "no access" — fine-grained tokens use a
    // different permission model entirely.
    stubUser(null);
    const { github } = await import('../src/api/github.js');
    expect((await github.whoamiWithScopes('github_pat_x')).scopes).toEqual([]);
  });

  it('ignores whitespace and a trailing comma in the header', async () => {
    stubUser(' repo ,  gist , ');
    const { github } = await import('../src/api/github.js');
    expect((await github.whoamiWithScopes('ghp_x')).scopes).toEqual(['repo', 'gist']);
  });

  it('says the token was rejected rather than surfacing a bare 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({ message: 'Bad credentials' }),
      })) as any,
    );
    const { github } = await import('../src/api/github.js');
    await expect(github.whoamiWithScopes('ghp_bad')).rejects.toThrow(/rejected the token/i);
  });

  it('recorded scopes drive the missing-scope check', async () => {
    const store = await import('../src/config/store.js');
    const { missingScopes } = await import('../src/auth/tokens.js');

    // What `dv auth token github` now stores.
    store.saveCredential('github', { accessToken: 'ghp_x', scope: 'repo read:user' });
    expect(missingScopes('github', ['repo'])).toEqual([]);
    expect(missingScopes('github', ['workflow'])).toEqual(['workflow']);
  });
});
