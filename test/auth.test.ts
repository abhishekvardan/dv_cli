import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { base64url, createPkce, createState } from '../src/auth/pkce.js';
import { pollForToken, type DeviceCodeResponse } from '../src/auth/device.js';
import { PROVIDERS } from '../src/auth/providers.js';
import { AuthError } from '../src/cli/errors.js';

describe('PKCE', () => {
  it('produces a verifier of the length RFC 7636 allows', () => {
    const { verifier } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('uses base64url with no padding', () => {
    for (const value of [createPkce().verifier, createPkce().challenge, createState()]) {
      expect(value).not.toContain('+');
      expect(value).not.toContain('/');
      expect(value).not.toContain('=');
      expect(value).toMatch(/^[A-Za-z0-9\-_]+$/);
    }
  });

  it('challenge is the S256 hash of the verifier', () => {
    const { verifier, challenge, method } = createPkce();
    expect(method).toBe('S256');
    expect(challenge).toBe(base64url(createHash('sha256').update(verifier).digest()));
  });

  it('never repeats a verifier or a state', () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => createPkce().verifier));
    const states = new Set(Array.from({ length: 50 }, () => createState()));
    expect(verifiers.size).toBe(50);
    expect(states.size).toBe(50);
  });
});

/** Queue of responses the fake token endpoint returns, one per poll. */
function stubTokenEndpoint(responses: any[]) {
  let i = 0;
  const mock = vi.fn(async () => {
    const body = responses[Math.min(i++, responses.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as any;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

const device: DeviceCodeResponse = {
  device_code: 'dc',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

const noWait = { sleep: async () => {} };

describe('device flow polling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps polling while authorization is pending', async () => {
    const mock = stubTokenEndpoint([
      { error: 'authorization_pending' },
      { error: 'authorization_pending' },
      { access_token: 'ghu_ok', scope: 'repo' },
    ]);
    const token = await pollForToken(PROVIDERS.github!, 'client', device, noWait);
    expect(token.access_token).toBe('ghu_ok');
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('increases the interval on slow_down, as RFC 8628 requires', async () => {
    // Ignoring slow_down gets the client rate-limited and the login fails with no
    // visible cause.
    stubTokenEndpoint([{ error: 'slow_down' }, { access_token: 'ok' }]);
    const intervals: number[] = [];
    await pollForToken(PROVIDERS.github!, 'client', device, {
      sleep: async (ms) => intervals.push(ms),
    });
    expect(intervals[0]).toBe(5000);
    expect(intervals[1]).toBe(10000);
  });

  it('gives up on expired_token', async () => {
    stubTokenEndpoint([{ error: 'expired_token' }]);
    await expect(pollForToken(PROVIDERS.github!, 'c', device, noWait)).rejects.toThrow(/expired/i);
  });

  it('gives up when the user declines', async () => {
    stubTokenEndpoint([{ error: 'access_denied' }]);
    await expect(pollForToken(PROVIDERS.github!, 'c', device, noWait)).rejects.toThrow(/declined/i);
  });

  it('stops once the code has outlived expires_in', async () => {
    stubTokenEndpoint([{ error: 'authorization_pending' }]);
    let clock = 0;
    await expect(
      pollForToken(
        PROVIDERS.github!,
        'c',
        { ...device, expires_in: 10 },
        { sleep: async () => { clock += 5000; }, now: () => clock },
      ),
    ).rejects.toThrow(AuthError);
  });

  it('reports an unrecognised error rather than looping on it', async () => {
    stubTokenEndpoint([{ error: 'invalid_client', error_description: 'Bad client id' }]);
    await expect(pollForToken(PROVIDERS.github!, 'c', device, noWait)).rejects.toThrow(/Bad client id/);
  });

  it('parses a form-encoded reply, which GitHub sends by default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => 'access_token=ghu_form&scope=repo&token_type=bearer',
      })) as any,
    );
    const token = await pollForToken(PROVIDERS.github!, 'c', device, noWait);
    expect(token.access_token).toBe('ghu_form');
  });
});

describe('provider definitions', () => {
  it('offers the ways in that each service actually supports', () => {
    // Device flow is best for a CLI, so it is listed first where available. Google
    // has no device flow for Gmail scopes; Vercel has no user-facing OAuth at all.
    expect(PROVIDERS.github!.methods[0]).toBe('device');
    expect(PROVIDERS.google!.methods).toEqual(['loopback']);
    expect(PROVIDERS.vercel!.methods).toEqual(['token']);
    // Atlassian Cloud documents email + API token as Basic.
    expect(PROVIDERS.atlassian!.methods[0]).toBe('basic');
  });

  it('attaches the credential the way each service requires', () => {
    // Not everything is bearer, and getting this wrong looks like a bad token.
    expect(PROVIDERS.anthropic!.authStyle).toBe('header:x-api-key');
    expect(PROVIDERS.figma!.authStyle).toBe('header:X-Figma-Token');
    expect(PROVIDERS.atlassian!.authStyle).toBe('basic');
    expect(PROVIDERS.github!.authStyle ?? 'bearer').toBe('bearer');
  });

  it('pins the API versions services refuse requests without', () => {
    expect(PROVIDERS.notion!.headers?.['Notion-Version']).toBeTruthy();
    expect(PROVIDERS.anthropic!.headers?.['anthropic-version']).toBeTruthy();
  });

  it('flags LinkedIn as needing a client secret', () => {
    // It supports neither device flow nor PKCE, so this is not a choice.
    expect(PROVIDERS.linkedin!.needsClientSecret).toBe(true);
    expect(PROVIDERS.github!.needsClientSecret).toBeFalsy();
  });

  it('asks for the scopes the commands actually need', () => {
    expect(PROVIDERS.github!.scopes).toContain('repo');
    expect(PROVIDERS.google!.scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(PROVIDERS.linkedin!.scopes).toContain('w_member_social');
  });

  it('every provider is reachable, or says how to make it reachable', () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(p.methods.length, `${p.id} lists no way to connect`).toBeGreaterThan(0);
      // A per-customer host cannot ship a default base URL. That is fine, but the
      // connector must then tell the user how to set one rather than failing blankly.
      if (!p.apiBase) {
        expect(p.setupHint, `${p.id} has no API base and no hint explaining that`).toMatch(/apiBase/);
      }
    }
  });
});

describe('token expiry and refresh', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dv-tok-'));
    process.env.DV_HOME = home;
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.DV_HOME;
    vi.unstubAllGlobals();
  });

  it('treats a token inside the renewal window as needing renewal', async () => {
    const { isExpired, REFRESH_SKEW_MS } = await import('../src/auth/tokens.js');
    const soon = new Date(Date.now() + REFRESH_SKEW_MS / 2).toISOString();
    // Renewing early matters: a request starting with seconds left can still land
    // after the token dies.
    expect(isExpired({ expiresAt: soon })).toBe(true);
    expect(isExpired({ expiresAt: soon }, 0)).toBe(false);
  });

  it('treats a token with no expiry as valid', async () => {
    const { isExpired } = await import('../src/auth/tokens.js');
    expect(isExpired({ accessToken: 'ghp_pat' })).toBe(false);
  });

  it('ignores an unparseable expiry rather than forcing a refresh loop', async () => {
    const { isExpired } = await import('../src/auth/tokens.js');
    expect(isExpired({ expiresAt: 'not a date' })).toBe(false);
  });

  it('asks the user to log in when there is no credential', async () => {
    const { accessToken } = await import('../src/auth/tokens.js');
    await expect(accessToken('github')).rejects.toThrow(/not connected/);
  });

  it('names the token command for a provider with no OAuth flow', async () => {
    const { accessToken } = await import('../src/auth/tokens.js');
    // The message says what is wrong; the hint says what to do about it.
    const err = await accessToken('vercel').then(
      () => null,
      (e) => e as AuthError,
    );
    expect(err?.message).toMatch(/not connected/);
    expect(err?.hint).toMatch(/auth token vercel/);
  });

  it('returns a live token without calling the network', async () => {
    const s = await import('../src/config/store.js');
    const { accessToken } = await import('../src/auth/tokens.js');
    s.saveCredential('github', {
      accessToken: 'ghp_live',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await accessToken('github')).toBe('ghp_live');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an expired token that cannot be renewed', async () => {
    const s = await import('../src/config/store.js');
    const { accessToken } = await import('../src/auth/tokens.js');
    s.saveCredential('google', {
      accessToken: 'stale',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // No refresh token means no silent recovery — saying so beats a 401 later.
    await expect(accessToken('google')).rejects.toThrow(/no refresh token/i);
  });

  it('renews an expired token and stores the new one', async () => {
    const s = await import('../src/config/store.js');
    s.setOAuthApp('google', { clientId: 'cid' });
    s.saveCredential('google', {
      accessToken: 'old',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'fresh', expires_in: 3600 }),
      })) as any,
    );

    const { accessToken } = await import('../src/auth/tokens.js');
    expect(await accessToken('google')).toBe('fresh');
    const stored = s.getCredential('google');
    // The refresh token is usually omitted on renewal; the old one must survive.
    expect(stored?.refreshToken).toBe('rt');
    expect(new Date(stored!.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('shares one request between concurrent refreshes', async () => {
    const s = await import('../src/config/store.js');
    s.setOAuthApp('google', { clientId: 'cid' });
    s.saveCredential('google', {
      accessToken: 'old',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'fresh', expires_in: 3600 }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);

    const { accessToken } = await import('../src/auth/tokens.js');
    const [a, b, c] = await Promise.all([
      accessToken('google'),
      accessToken('google'),
      accessToken('google'),
    ]);
    expect([a, b, c]).toEqual(['fresh', 'fresh', 'fresh']);
    // Three parallel refreshes would each spend the refresh token, and providers
    // may invalidate the older ones.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tells the user to log in again when the refresh token is dead', async () => {
    const s = await import('../src/config/store.js');
    s.setOAuthApp('google', { clientId: 'cid' });
    s.saveCredential('google', {
      accessToken: 'old',
      refreshToken: 'revoked',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'Token has been revoked.' }),
      })) as any,
    );
    const { accessToken } = await import('../src/auth/tokens.js');
    await expect(accessToken('google')).rejects.toThrow(/revoked/i);
  });

  it('reports missing scopes, and stays quiet when none were recorded', async () => {
    const s = await import('../src/config/store.js');
    const { missingScopes } = await import('../src/auth/tokens.js');

    s.saveCredential('linkedin', { accessToken: 't', scope: 'openid,profile,email' });
    expect(missingScopes('linkedin', ['w_member_social'])).toEqual(['w_member_social']);
    expect(missingScopes('linkedin', ['openid'])).toEqual([]);

    // No recorded scope means we cannot judge — inventing a problem would block a
    // command that would have worked.
    s.saveCredential('github', { accessToken: 't' });
    expect(missingScopes('github', ['repo'])).toEqual([]);
  });
});
