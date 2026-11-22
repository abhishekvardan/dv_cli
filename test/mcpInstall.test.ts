import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLIENTS, launchSpec } from '../src/mcp/install.js';

const cursor = CLIENTS.find((c) => c.id === 'cursor')!;
let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, argv1: process.argv[1] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-install-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  process.argv[1] = saved.argv1!;
  rmSync(home, { recursive: true, force: true });
});

describe('launchSpec', () => {
  it('points at this node and this entry script by absolute path', () => {
    process.argv[1] = join(home, 'lib', 'dv', 'dist', 'index.js');
    const spec = launchSpec();
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([process.argv[1], 'mcp']);
    expect(spec.ephemeral).toBe(false);
  });

  it('falls back to npx when running from the npx cache', () => {
    process.argv[1] = join(home, 'npm-cache', '_npx', 'abc', 'node_modules', 'dv', 'dist', 'index.js');
    const spec = launchSpec();
    expect(spec.ephemeral).toBe(true);
    expect(spec.args).toContain('mcp');
  });
});

describe('editing an app config', () => {
  const spec = { command: 'node', args: ['/x/index.js', 'mcp'], ephemeral: false };

  it('detects the app and adds dv, keeping everything else', () => {
    expect(cursor.detected()).toBe(false);
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '﻿{"mcpServers":{"other":{"command":"x"}},"keep":1}');
    expect(cursor.detected()).toBe(true);

    cursor.install(spec);
    const written = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.keep).toBe(1);
    expect(written.mcpServers.other).toEqual({ command: 'x' });
    expect(written.mcpServers.dv).toEqual({ command: 'node', args: ['/x/index.js', 'mcp'] });
    expect(cursor.installed()).toBe(true);
    expect(existsSync(join(home, '.cursor', 'mcp.json.dv-backup'))).toBe(true);

    expect(cursor.uninstall()).toBe(true);
    const after = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(after.mcpServers).toEqual({ other: { command: 'x' } });
  });

  it('refuses to overwrite a config it cannot parse', () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ not json');
    expect(() => cursor.install(spec)).toThrow(/not valid JSON/);
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('{ not json');
  });
});
