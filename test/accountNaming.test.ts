import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-name-'));
  process.env.DV_HOME = home;
  vi.resetModules();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DV_HOME;
  vi.unstubAllGlobals();
});

/** A GitHub /user response for a given login. */
function stubGitHubUser(login: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'x-oauth-scopes' ? 'repo' : null) },
      json: async () => ({ login }),
    })) as any,
  );
}

describe('choosing which account a credential belongs to', () => {
  it('names the account after whoever the token belongs to', async () => {
    stubGitHubUser('octocat');
    const { accountNameFor } = await import('../src/commands/auth.js');
    expect((await accountNameFor('github', 'ghp_x', undefined)).name).toBe('octocat');
  });

  it('gives two different tokens two different accounts', async () => {
    // The bug this replaces: the name was resolved from whichever account was already
    // active, so a second token silently overwrote the first.
    stubGitHubUser('work-user');
    const { accountNameFor } = await import('../src/commands/auth.js');
    const first = await accountNameFor('github', 'ghp_a', undefined);

    stubGitHubUser('personal-user');
    const second = await accountNameFor('github', 'ghp_b', undefined);

    expect(first.name).toBe('work-user');
    expect(second.name).toBe('personal-user');
    expect(first.name).not.toBe(second.name);
  });

  it('lets --as override the provider name', async () => {
    stubGitHubUser('octocat');
    const { accountNameFor } = await import('../src/commands/auth.js');
    // A nickname, for when the provider's name for you is not the one you think in.
    const chosen = await accountNameFor('github', 'ghp_x', 'work');
    expect(chosen.name).toBe('work');
  });

  it('does not call the API when --as is given', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { accountNameFor } = await import('../src/commands/auth.js');
    await accountNameFor('github', 'ghp_x', 'work');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to default when the token cannot be identified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({ message: 'Bad credentials' }),
      })) as any,
    );
    const { accountNameFor } = await import('../src/commands/auth.js');
    // A rejected token still has to land somewhere so the failure can be reported.
    expect((await accountNameFor('github', 'ghp_bad', undefined)).name).toBe('default');
  });
});
