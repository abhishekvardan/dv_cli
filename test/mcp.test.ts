import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AI_COMMANDS } from '../src/ai/catalog.js';
import { allCommands, buildArgv, describe as describeTool, toolName, type McpCommand } from '../src/mcp/tools.js';
import { inputShape, toResult } from '../src/commands/mcp.js';

describe('mcp tool catalogue', () => {
  it('covers every ask-catalogue command once, with valid unique names', () => {
    const commands = allCommands();
    const names = commands.map(toolName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9_]{1,64}$/);
    for (const command of AI_COMMANDS) expect(commands.some((c) => c.id === command.id)).toBe(true);
    expect(names).toContain('gmail_send');
    expect(names).toContain('ship');
  });

  it('marks writes in the description and offers confirm only on them', () => {
    for (const command of allCommands()) {
      const shape = inputShape(command);
      expect('confirm' in shape).toBe(Boolean(command.mutates));
      if (command.mutates) expect(describeTool(command)).toContain('WRITE');
    }
  });
});

describe('buildArgv', () => {
  const prCreate = allCommands().find((c) => c.id === 'gh pr create')!;

  it('puts positionals in order, then flags, then --json', () => {
    const fileRead = allCommands().find((c) => c.id === 'gh file read')!;
    expect(buildArgv(fileRead, { repo: 'dv', path: 'README.md' })).toEqual(['gh', 'file', 'read', 'dv', 'README.md']);
    expect(buildArgv(prCreate, { repo: 'dv', head: 'x', title: 'Add x' })).toEqual([
      'gh', 'pr', 'create', 'dv', '--head', 'x', '--title', 'Add x', '--json',
    ]);
  });

  it('only adds --yes to a write when confirm is true', () => {
    expect(buildArgv(prCreate, { repo: 'dv', head: 'x', title: 't' })).not.toContain('--yes');
    expect(buildArgv(prCreate, { repo: 'dv', head: 'x', title: 't', confirm: true })).toContain('--yes');
    const read = allCommands().find((c) => c.id === 'gh repo list')!;
    expect(buildArgv(read, { confirm: true } as never)).not.toContain('--yes');
  });

  it('uses short flags for one-letter names and bare flags for booleans', () => {
    const save = allCommands().find((c) => c.id === 'git save')!;
    expect(buildArgv(save, { m: 'msg' })).toEqual(['git', 'save', '-m', 'msg', '--json']);
    const logs = allCommands().find((c) => c.id === 'vercel deploy logs')!;
    expect(buildArgv(logs, { id: 'dpl_1' })).toEqual(['vercel', 'deploy', 'logs', 'dpl_1', '--build', '--json']);
    const post: McpCommand = allCommands().find((c) => c.id === 'li post')!;
    expect(buildArgv(post, { text: 'hi', connections: false })).toEqual(['li', 'post', '--text', 'hi']);
    expect(buildArgv(post, { text: 'hi', connections: true })).toContain('--connections');
  });

  it('passes dry run and account through', () => {
    const redeploy = allCommands().find((c) => c.id === 'vercel deploy redeploy')!;
    expect(buildArgv(redeploy, { project: 'app', dry_run: true, account: 'work' })).toEqual([
      'vercel', 'deploy', 'redeploy', 'app', '--json', '--dry-run', '--as', 'work',
    ]);
  });
});

describe('toResult', () => {
  it('flags any non-zero exit as an error and names it', () => {
    const cancelled = toResult(['x'], { stdout: 'preview', stderr: 'Not sent.', exitCode: 6, timedOut: false });
    expect(cancelled.isError).toBe(true);
    expect(cancelled.content[0]!.text).toContain('NOTHING HAPPENED');
    expect(cancelled.content[1]!.text).toContain('Not sent.');
    expect(toResult(['x'], { stdout: '[]', stderr: '', exitCode: 0, timedOut: false }).isError).toBe(false);
  });
});

// End to end over real stdio, against the built CLI. Skipped until `npm run build` has run.
const entry = resolve(__dirname, '..', 'dist', 'index.js');
describe.runIf(existsSync(entry))('dv mcp over stdio', () => {
  let home: string;
  let client: import('@modelcontextprotocol/sdk/client/index.js').Client;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dv-mcp-'));
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    client = new Client({ name: 'dv-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry, 'mcp'],
        env: { ...(process.env as Record<string, string>), DV_HOME: home },
        stderr: 'ignore',
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('lists the tools with hints, and the skill resource', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('gh_repo_list')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('vercel_deploy_redeploy')?.annotations?.destructiveHint).toBe(true);
    expect(byName.has('run')).toBe(true);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('dv://skill');
  });

  it('runs a command and returns its output', async () => {
    const result = (await client.callTool({ name: 'help', arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('exit 0');
    expect(result.content[0]!.text).toContain('dv gh repo list');
  }, 30_000);
});
