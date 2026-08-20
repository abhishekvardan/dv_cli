import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-store-'));
  process.env.DV_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DV_HOME;
});

/** Imported per test so each one reads the DV_HOME set above. */
async function store() {
  return import('../src/config/store.js');
}

describe('credential store', () => {
  it('round-trips a credential', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'ghp_abc', account: 'octocat', method: 'device' });
    expect(s.getCredential('github')?.accessToken).toBe('ghp_abc');
    expect(s.getCredential('github')?.account).toBe('octocat');
  });

  it('merges a patch instead of replacing the credential', async () => {
    const s = await store();
    s.saveCredential('google', { accessToken: 'a', refreshToken: 'r' });
    s.saveCredential('google', { accessToken: 'b' });
    const cred = s.getCredential('google');
    // Losing the refresh token here would silently turn a renewable login into a
    // one-hour one.
    expect(cred?.accessToken).toBe('b');
    expect(cred?.refreshToken).toBe('r');
  });

  it('does not disturb other providers when one is written', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'gh' });
    s.saveCredential('google', { accessToken: 'go' });
    s.saveCredential('github', { accessToken: 'gh2' });
    expect(s.getCredential('google')?.accessToken).toBe('go');
  });

  it('deletes only the named provider', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'gh' });
    s.saveCredential('vercel', { accessToken: 'v' });
    expect(s.deleteCredential('github')).toBe(true);
    expect(s.getCredential('github')).toBeUndefined();
    expect(s.getCredential('vercel')?.accessToken).toBe('v');
  });

  it('reports a missing provider rather than throwing', async () => {
    const s = await store();
    expect(s.deleteCredential('nope')).toBe(false);
    expect(s.getCredential('nope')).toBeUndefined();
  });

  it('writes the credentials file owner-only', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'ghp_secret' });
    const mode = statSync(s.credentialsPath()).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows does not model POSIX bits; the check is skipped rather than faked.
      expect(existsSync(s.credentialsPath())).toBe(true);
    } else {
      expect(mode & 0o077).toBe(0);
      expect(mode).toBe(0o600);
    }
  });

  it('leaves no temp file behind', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'x' });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(home).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('explains a corrupt file instead of crashing', async () => {
    const s = await store();
    writeFileSync(s.credentialsPath(), '{ not json');
    expect(() => s.listCredentials()).toThrow(/not valid JSON/);
  });

  it('never prints a whole secret', async () => {
    const s = await store();
    const masked = s.mask('ghp_1234567890abcdef');
    expect(masked).not.toContain('567890abc');
    expect(masked.startsWith('ghp_')).toBe(true);
    expect(masked.endsWith('cdef')).toBe(true);
    expect(s.mask(undefined)).toBe('—');
    // A short value is masked entirely rather than half-revealed.
    expect(s.mask('abc')).toBe('•••');
  });

  it('prefers an env var over the stored client id', async () => {
    const s = await store();
    s.setOAuthApp('github', { clientId: 'from-file' });
    process.env.DV_GITHUB_CLIENT_ID = 'from-env';
    try {
      expect(s.getOAuthApp('github').clientId).toBe('from-env');
    } finally {
      delete process.env.DV_GITHUB_CLIENT_ID;
    }
    expect(s.getOAuthApp('github').clientId).toBe('from-file');
  });

  it('keeps config and credentials in separate files', async () => {
    const s = await store();
    s.saveCredential('github', { accessToken: 'tok' });
    s.setOAuthApp('github', { clientId: 'id' });
    // A client id is not a secret; a token is. They should not share a file.
    expect(readFileSync(s.configPath(), 'utf8')).not.toContain('tok');
    expect(readFileSync(s.credentialsPath(), 'utf8')).not.toContain('"clientId"');
  });
});
