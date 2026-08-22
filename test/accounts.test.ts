import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-acct-'));
  process.env.DV_HOME = home;
  vi.resetModules();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DV_HOME;
});

const store = () => import('../src/config/store.js');

describe('multiple accounts per provider', () => {
  it('keeps separate credentials under separate names', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'work-token' }, 'work');
    s.saveCredential('github', { accessToken: 'personal-token' }, 'personal');

    expect(s.getCredential('github', 'work')?.accessToken).toBe('work-token');
    expect(s.getCredential('github', 'personal')?.accessToken).toBe('personal-token');
    expect(s.listAccounts('github').names.sort()).toEqual(['personal', 'work']);
  });

  it('makes the first account active, and does not silently move it', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'a' }, 'work');
    s.saveCredential('github', { accessToken: 'b' }, 'personal');
    expect(s.listAccounts('github').active).toBe('work');
    expect(s.getCredential('github')?.accessToken).toBe('a');
  });

  it('switches the active account', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'a' }, 'work');
    s.saveCredential('github', { accessToken: 'b' }, 'personal');
    s.setActiveAccount('github', 'personal');
    expect(s.getCredential('github')?.accessToken).toBe('b');
  });

  it('honours a one-off override without changing the active account', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'a' }, 'work');
    s.saveCredential('github', { accessToken: 'b' }, 'personal');

    s.setAccountOverride('personal');
    expect(s.getCredential('github')?.accessToken).toBe('b');
    s.setAccountOverride(undefined);
    // The override is for one invocation; it must not persist.
    expect(s.listAccounts('github').active).toBe('work');
  });

  it('refuses an account that does not exist rather than falling back', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'a' }, 'work');
    s.setAccountOverride('nope');
    // Silently using a different account than the one asked for is how you push to
    // the wrong repository.
    expect(() => s.getCredential('github')).toThrow(/No "nope" account/);
    s.setAccountOverride(undefined);
  });

  it('keeps providers independent', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'gh' }, 'work');
    s.saveCredential('vercel', { accessToken: 'vc' }, 'personal');
    expect(s.getCredential('github')?.accessToken).toBe('gh');
    expect(s.getCredential('vercel')?.accessToken).toBe('vc');
  });

  it('removes one account and promotes another', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'a' }, 'work');
    s.saveCredential('github', { accessToken: 'b' }, 'personal');
    expect(s.deleteCredential('github', 'work')).toBe(true);
    // Leaving `active` pointing at a deleted account would report "not connected"
    // while a perfectly good credential sat in the file.
    expect(s.listAccounts('github').active).toBe('personal');
    expect(s.getCredential('github')?.accessToken).toBe('b');
  });

  it('removes the provider entirely when no account is named', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'a' }, 'work');
    s.saveCredential('github', { accessToken: 'b' }, 'personal');
    expect(s.deleteCredential('github')).toBe(true);
    expect(s.listAccounts('github').names).toEqual([]);
  });

  it('renames an account, following the active pointer', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'a' }, 'default');
    s.renameAccount('github', 'default', 'octocat');
    expect(s.listAccounts('github').names).toEqual(['octocat']);
    expect(s.listAccounts('github').active).toBe('octocat');
  });
});

describe('migration from the single-account format', () => {
  it('keeps an existing login working', async () => {
    // What v1 wrote. A user upgrading must not be logged out.
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'credentials.json'),
      JSON.stringify({
        version: 1,
        providers: {
          github: { accessToken: 'old-token', account: 'octocat', method: 'token' },
          vercel: { accessToken: 'v-token' },
        },
      }),
    );

    const s = await store();
    expect(s.getCredential('github')?.accessToken).toBe('old-token');
    // The recorded identity becomes the account name, so it is immediately switchable.
    expect(s.listAccounts('github').names).toEqual(['octocat']);
    // With no identity recorded, it still lands somewhere rather than being dropped.
    expect(s.listAccounts('vercel').names).toEqual(['default']);
  });

  it('can add a second account to a migrated provider', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'credentials.json'),
      JSON.stringify({ version: 1, providers: { github: { accessToken: 'old', account: 'work' } } }),
    );
    const s = await store();
    s.saveCredential('github', { accessToken: 'new' }, 'personal');
    expect(s.listAccounts('github').names.sort()).toEqual(['personal', 'work']);
    expect(s.getCredential('github')?.accessToken).toBe('old');
  });
});
