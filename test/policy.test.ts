/**
 * The policy layer only earns its place if it cannot be talked out of a rule, so most of
 * what is tested here is the bypasses that must not work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assess,
  evaluate,
  hasArgumentFlags,
  hasRecentDryRun,
  loadPolicy,
  matchesPattern,
  recordDryRun,
  resolveSubject,
  STARTER_POLICY,
  writePolicy,
  type Policy,
} from '../src/cli/policy.js';
import { splitTestArgs } from '../src/commands/policy.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-policy-'));
  process.env.DV_HOME = home;
});

afterEach(() => {
  delete process.env.DV_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('matching a command against a rule', () => {
  it('matches an exact command', () => {
    expect(matchesPattern('vercel env rm', ['vercel', 'env', 'rm'])).toBe(true);
  });

  it('is case-insensitive on both sides', () => {
    expect(matchesPattern('Vercel DNS add', ['vercel', 'dns', 'ADD'])).toBe(true);
  });

  it('requires a trailing wildcard to actually match something', () => {
    // "vercel dns *" is about the operations under dns, not the bare noun, which only
    // prints usage. A rule that fired on the help text would train people to ignore it.
    expect(matchesPattern('vercel dns *', ['vercel', 'dns', 'add'])).toBe(true);
    expect(matchesPattern('vercel dns *', ['vercel', 'dns'])).toBe(false);
  });

  it('does not match a longer command without a wildcard', () => {
    expect(matchesPattern('vercel env', ['vercel', 'env', 'rm'])).toBe(false);
  });

  it('does not match a different command that shares a prefix', () => {
    expect(matchesPattern('gh repo delete *', ['gh', 'repo', 'list'])).toBe(false);
  });

  it('counts an argument given as a flag, so a rule cannot be dodged by using --file', () => {
    // `dv db query --file migration.sql` has no words after "query": reading that as the
    // bare noun let a whole migration past a rule written to catch exactly it.
    expect(matchesPattern('db query *', ['db', 'query'], true)).toBe(true);
    expect(matchesPattern('db query *', ['db', 'query'], false)).toBe(false);
  });

  it('does not treat output flags as arguments', () => {
    // `dv vercel dns --help` prints usage. A rule that fired on it would be noise.
    expect(hasArgumentFlags({ help: true, json: true, quiet: true })).toBe(false);
    expect(hasArgumentFlags({ file: './migration.sql' })).toBe(true);
    // `--no-verify` parses to false, which is the flag being switched off, not an argument.
    expect(hasArgumentFlags({ verify: false })).toBe(false);
  });
});

describe('evaluating rules', () => {
  const denyRepoDelete: Policy = {
    version: 1,
    rules: [{ match: 'gh repo delete *', deny: true, reason: 'not reversible' }],
  };

  it('blocks a denied command', () => {
    const decisions = evaluate(denyRepoDelete, {
      command: ['gh', 'repo', 'delete', 'old-thing'],
      dryRun: false,
      interactive: true,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.blocked).toBeTruthy();
  });

  it('leaves unrelated commands alone', () => {
    const decisions = evaluate(denyRepoDelete, {
      command: ['gh', 'repo', 'list'],
      dryRun: false,
      interactive: true,
    });
    expect(decisions).toEqual([]);
  });

  it('considers every matching rule, so a deny cannot be shadowed by an earlier match', () => {
    const policy: Policy = {
      version: 1,
      rules: [
        { match: 'vercel dns *', require: 'confirm' },
        { match: 'vercel dns rm *', deny: true },
      ],
    };
    const decisions = evaluate(policy, {
      command: ['vercel', 'dns', 'rm', 'example.com', 'rec_1'],
      dryRun: false,
      interactive: true,
    });
    expect(decisions.some((d) => d.blocked)).toBe(true);
  });

  describe('require: confirm', () => {
    const policy: Policy = { version: 1, rules: [{ match: 'db query *', require: 'confirm' }] };

    it('asks for a real confirmation when a terminal is present', () => {
      const decisions = evaluate(policy, {
        command: ['db', 'query', 'drop table users'],
        dryRun: false,
        interactive: true,
      });
      expect(decisions[0]!.forceConfirm).toBe(true);
      expect(decisions[0]!.blocked).toBeUndefined();
    });

    it('blocks entirely when nothing can be asked', () => {
      // The unattended case is the whole reason the rule exists. Proceeding because
      // there is nobody to object would invert its meaning.
      const decisions = evaluate(policy, {
        command: ['db', 'query', 'drop table users'],
        dryRun: false,
        interactive: false,
      });
      expect(decisions[0]!.blocked).toBeTruthy();
    });
  });

  describe('require: dry-run', () => {
    const policy: Policy = { version: 1, rules: [{ match: 'vercel dns *', require: 'dry-run' }] };
    const command = ['vercel', 'dns', 'add', 'example.com', 'A', '@', '1.2.3.4'];

    it('blocks when no dry run has happened', () => {
      const decisions = evaluate(policy, { command, dryRun: false, interactive: true });
      expect(decisions[0]!.blocked).toContain('dry run');
    });

    it('allows the dry run itself', () => {
      const decisions = evaluate(policy, { command, dryRun: true, interactive: true });
      expect(decisions).toEqual([]);
    });

    it('allows the real run once a dry run has been recorded', () => {
      recordDryRun(command);
      const decisions = evaluate(policy, { command, dryRun: false, interactive: true });
      expect(decisions).toEqual([]);
    });

    it('does not accept a dry run of a different command', () => {
      // Checking one record and then changing another is exactly the mistake the rule
      // is meant to catch, so the receipt is tied to the precise arguments.
      recordDryRun(['vercel', 'dns', 'add', 'example.com', 'A', '@', '9.9.9.9']);
      const decisions = evaluate(policy, { command, dryRun: false, interactive: true });
      expect(decisions[0]!.blocked).toBeTruthy();
    });
  });

  it('blocks require: human when there is no terminal', () => {
    const policy: Policy = { version: 1, rules: [{ match: 'ship *', require: 'human' }] };
    expect(
      evaluate(policy, { command: ['ship', 'now'], dryRun: false, interactive: false })[0]!.blocked,
    ).toBeTruthy();
    expect(
      evaluate(policy, { command: ['ship', 'now'], dryRun: false, interactive: true }),
    ).toEqual([]);
  });
});

describe('loading the policy file', () => {
  it('treats a missing file as no rules', () => {
    expect(loadPolicy().rules).toEqual([]);
  });

  it('round-trips what was written', () => {
    writePolicy(STARTER_POLICY);
    expect(loadPolicy().rules).toEqual(STARTER_POLICY.rules);
  });

  it('refuses to run on malformed JSON rather than silently dropping every rule', () => {
    // The dangerous failure mode: a typo in the file quietly removing all protection at
    // the exact moment someone believes they are protected.
    writeFileSync(join(home, 'policy.json'), '{ "version": 1, "rules": [ }');
    expect(() => loadPolicy()).toThrow(/policy file/i);
  });
});

describe('dry-run receipts', () => {
  it('expire, so an old plan is not evidence of a current one', () => {
    const command = ['vercel', 'dns', 'add', 'example.com'];
    recordDryRun(command);
    expect(hasRecentDryRun(command)).toBe(true);

    // Rewrite the receipt as if it were recorded well outside the window.
    const path = join(home, 'dry-run-receipts.json');
    writeFileSync(path, JSON.stringify({ [command.join(' ')]: Date.now() - 60 * 60 * 1000 }));
    expect(hasRecentDryRun(command)).toBe(false);
  });
});
