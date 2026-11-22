import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-acct-'));
  process.env.DV_HOME = home;
  for (const key of Object.keys(process.env)) if (/^DV_\w+_CLIENT_(ID|SECRET)$/.test(key)) delete process.env[key];
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DV_HOME;
  delete process.env.DV_GITHUB_CLIENT_ID;
  rmSync(home, { recursive: true, force: true });
});

describe('planAddAccount', () => {
  it('uses a pasted token, and opens a pre-filled token page, when there is no OAuth app', async () => {
    const { planAddAccount } = await import('../src/mcp/accounts.js');
    const plan = planAddAccount('github', 'work');
    expect(plan.argv).toEqual(['auth', 'login', 'github', '--method', 'token', '--as', 'work']);
    expect(plan.browser).toBe(false);
    expect(plan.tokenPage).toContain('github.com/settings/tokens/new');
    expect(plan.tokenPage).toContain('scopes=repo');
  });

  it('uses the browser when an OAuth app is configured', async () => {
    process.env.DV_GITHUB_CLIENT_ID = 'Iv1.test';
    const { planAddAccount } = await import('../src/mcp/accounts.js');
    const plan = planAddAccount('github');
    expect(plan.argv).toEqual(['auth', 'login', 'github']);
    expect(plan.browser).toBe(true);
    expect(plan.tokenPage).toBeUndefined();
  });

  it('vercel is always a token', async () => {
    const { planAddAccount } = await import('../src/mcp/accounts.js');
    const plan = planAddAccount('vercel');
    expect(plan.argv).toEqual(['auth', 'login', 'vercel', '--method', 'token']);
    expect(plan.tokenPage).toBe('https://vercel.com/account/tokens');
  });

  it('rejects an unknown service', async () => {
    const { planAddAccount } = await import('../src/mcp/accounts.js');
    expect(() => planAddAccount('myspace')).toThrow(/Unknown provider/);
  });
});
