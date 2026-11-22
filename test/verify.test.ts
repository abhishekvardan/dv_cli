/**
 * The verification runner decides whether a deployment gets rolled back, so a wrong
 * answer here is worse than no check at all — a false failure reverts a healthy build.
 * These tests use shell commands with known exit codes rather than network calls.
 */

import { describe, expect, it } from 'vitest';

import { verify } from '../src/workflow/verify.js';

// `node -e` is the one interpreter guaranteed to be present and to behave identically
// under cmd.exe and bash, which matters because this module deliberately picks between
// them depending on the platform.
const succeed = 'node -e "process.exit(0)"';
const failWith = (code: number) => `node -e "process.exit(${code})"`;

describe('running a check', () => {
  it('passes on exit 0', async () => {
    const result = await verify({ command: succeed, url: 'https://example.com', attempts: 1 });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
  });

  it('fails on a non-zero exit and keeps the code', async () => {
    const result = await verify({ command: failWith(22), url: 'https://example.com', attempts: 1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(22);
  });

  it('substitutes {url} so the check targets the deployment just made', async () => {
    // The important half: without substitution a check would hit whatever the domain
    // currently points at, and could pass while testing the previous build.
    const result = await verify({
      command: 'node -e "console.log(process.argv[1])" {url}',
      url: 'https://dv-probe.example',
      attempts: 1,
    });
    expect(result.stdout).toContain('https://dv-probe.example');
  });

  it('captures output, which is the reason to run the check here at all', async () => {
    const result = await verify({
      command: 'node -e "console.log(\'body text\'); process.exit(1)"',
      url: 'x',
      attempts: 1,
    });
    expect(result.stdout).toContain('body text');
  });

  it('captures stderr as well as stdout', async () => {
    const result = await verify({
      command: 'node -e "console.error(\'boom\'); process.exit(1)"',
      url: 'x',
      attempts: 1,
    });
    expect(result.stderr).toContain('boom');
  });
});

describe('retrying', () => {
  it('stops as soon as a check passes', async () => {
    const started = Date.now();
    await verify({ command: succeed, url: 'x', attempts: 5, intervalMs: 1000 });
    // Five attempts a second apart would take four seconds; passing first means none of
    // that waiting happens.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('retries a failing check the requested number of times', async () => {
    const started = Date.now();
    const result = await verify({ command: failWith(1), url: 'x', attempts: 3, intervalMs: 250 });
    expect(result.ok).toBe(false);
    // Two gaps between three attempts.
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });

  it('treats attempts below one as a single attempt', async () => {
    const result = await verify({ command: succeed, url: 'x', attempts: 0 });
    expect(result.ok).toBe(true);
  });
});

describe('timeouts', () => {
  it('kills a hanging check rather than waiting for it', async () => {
    const started = Date.now();
    const result = await verify({
      // Holds the event loop open well past the timeout.
      command: 'node -e "setTimeout(()=>{}, 30000)"',
      url: 'x',
      attempts: 1,
      timeoutMs: 1500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    // The check is what must be killed, not merely abandoned: a shell left running
    // would keep the CLI alive long after it reported.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

describe('a check that cannot start', () => {
  it('reports a failure instead of hanging', async () => {
    const result = await verify({
      command: 'dv-no-such-binary-anywhere --please',
      url: 'x',
      attempts: 1,
    });
    expect(result.ok).toBe(false);
  });
});
