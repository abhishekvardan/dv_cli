import { describe, expect, it } from 'vitest';

import { bool, num, parseArgs, require as requireFlag, str } from '../src/cli/args.js';
import { UsageError } from '../src/cli/errors.js';

describe('parseArgs', () => {
  it('separates the command path from flags', () => {
    const a = parseArgs(['gh', 'issues', 'owner/repo', '--state', 'closed']);
    expect(a.command).toEqual(['gh', 'issues', 'owner/repo']);
    expect(a.flags.state).toBe('closed');
  });

  it('accepts --flag=value', () => {
    expect(parseArgs(['--limit=50']).flags.limit).toBe('50');
  });

  it('treats a trailing flag as a boolean', () => {
    expect(parseArgs(['gh', 'repos', '--json']).flags.json).toBe(true);
  });

  it('does not swallow the next flag as a value', () => {
    const a = parseArgs(['--json', '--limit', '5']);
    expect(a.flags.json).toBe(true);
    expect(a.flags.limit).toBe('5');
  });

  it('reads --no-x as false', () => {
    expect(parseArgs(['--no-color']).flags.color).toBe(false);
  });

  it('collects a repeated flag into an array', () => {
    expect(parseArgs(['--label', 'bug', '--label', 'p1']).flags.label).toEqual(['bug', 'p1']);
  });

  it('bundles short booleans but lets a lone short flag take a value', () => {
    expect(parseArgs(['-qy']).flags).toEqual({ q: true, y: true });
    expect(parseArgs(['-n', '5']).flags.n).toBe('5');
  });

  it('stops parsing at --', () => {
    const a = parseArgs(['gh', 'clone', '--', '--not-a-flag']);
    expect(a.positional).toContain('--not-a-flag');
    expect(a.flags['not-a-flag']).toBeUndefined();
  });

  it('keeps positionals after a flag out of the command path', () => {
    // Otherwise `dv gh read --ref main src/x.ts` would treat src/x.ts as a command.
    const a = parseArgs(['gh', 'read', '--ref', 'main', 'src/x.ts']);
    expect(a.command).toEqual(['gh', 'read']);
    expect(a.positional).toEqual(['src/x.ts']);
  });

  it('handles an empty argv', () => {
    expect(parseArgs([])).toEqual({ command: [], positional: [], flags: {} });
  });
});

describe('flag readers', () => {
  it('str takes the last value of a repeated flag', () => {
    expect(str(parseArgs(['--state', 'open', '--state', 'closed']).flags, 'state')).toBe('closed');
  });

  it('str accepts aliases in order', () => {
    expect(str(parseArgs(['-r', 'x']).flags, 'repo', 'r')).toBe('x');
  });

  it('str rejects a value-taking flag given with no value', () => {
    // --title with nothing after it is a mistake, not the string "true".
    expect(() => str(parseArgs(['--title']).flags, 'title')).toThrow(UsageError);
  });

  it('require fails with a usable message', () => {
    expect(() => requireFlag(parseArgs([]).flags, 'title')).toThrow(/--title is required/);
  });

  it('bool reads --flag=false as false', () => {
    expect(bool(parseArgs(['--json=false']).flags, 'json')).toBe(false);
    expect(bool(parseArgs(['--json=true']).flags, 'json')).toBe(true);
    expect(bool(parseArgs(['--json']).flags, 'json')).toBe(true);
    expect(bool(parseArgs([]).flags, 'json')).toBe(false);
  });

  it('num falls back and rejects nonsense', () => {
    expect(num(parseArgs([]).flags, 'limit', 30)).toBe(30);
    expect(num(parseArgs(['--limit', '7']).flags, 'limit', 30)).toBe(7);
    expect(() => num(parseArgs(['--limit', 'lots']).flags, 'limit', 30)).toThrow(UsageError);
  });
});
