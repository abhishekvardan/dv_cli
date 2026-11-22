/**
 * Connect dv's MCP server to the AI apps on this machine, without the user editing a file.
 *
 * Hand-registering an MCP server means knowing where each app keeps its config, that it
 * is JSON, and — on Windows — that `npx` or `dv` cannot be launched from it directly
 * because they are `.cmd` shims. Someone who has just installed a CLI should not need
 * any of that, so this finds the apps and writes the entry for them.
 *
 * The entry always names absolute paths: this Node binary and this dv's entry script.
 * That is the only form that works regardless of the PATH an app was started with,
 * which is the usual reason a hand-written `"command": "npx"` fails with "connection
 * closed" inside an editor while working fine in a terminal.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { run } from '../workflow/git.js';

export const PACKAGE = '@abhishekvardanbotta/dv';
export const SERVER_NAME = 'dv';

export interface LaunchSpec {
  command: string;
  args: string[];
  /** True when dv is running from a temporary npx cache rather than an install. */
  ephemeral: boolean;
}

/** How an app should start this dv's MCP server. */
export function launchSpec(): LaunchSpec {
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  // Run through `npx`, the entry lives in a cache that can be cleared at any time, so
  // pointing an app at it would break later for no visible reason.
  const ephemeral = !entry || /[\\/]_npx[\\/]/.test(entry);
  if (ephemeral) {
    return process.platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', '-y', `${PACKAGE}@latest`, 'mcp'], ephemeral }
      : { command: 'npx', args: ['-y', `${PACKAGE}@latest`, 'mcp'], ephemeral };
  }
  return { command: process.execPath, args: [entry, 'mcp'], ephemeral };
}

// ── JSON config files ───────────────────────────────────────────────────────

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Never overwrite a file we cannot read: it is someone's configuration, and
    // replacing it with `{ mcpServers: { dv } }` would silently delete the rest.
    throw new Error(`${path} is not valid JSON, so it was left alone. Fix or remove it, then run this again.`);
  }
}

/** Write via a temp file and rename, keeping one backup of what was there first. */
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !existsSync(`${path}.dv-backup`)) copyFileSync(path, `${path}.dv-backup`);
  const tmp = `${path}.dv-tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

function setServer(path: string, entry: Record<string, unknown>): void {
  const config = readJson(path);
  config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: entry };
  writeJson(path, config);
}

function removeServer(path: string): boolean {
  if (!existsSync(path)) return false;
  const config = readJson(path);
  if (!config.mcpServers?.[SERVER_NAME]) return false;
  delete config.mcpServers[SERVER_NAME];
  writeJson(path, config);
  return true;
}

function hasServer(path: string): boolean {
  try {
    return Boolean(readJson(path).mcpServers?.[SERVER_NAME]);
  } catch {
    return false;
  }
}

// ── Claude Code's own CLI ───────────────────────────────────────────────────

/**
 * Find the `claude` CLI.
 *
 * Usually on PATH. When Claude Code was installed only as an editor extension it is
 * not, but the extension ships the same binary inside itself, so the extension folders
 * of VS Code and its forks are searched as well.
 */
export function findClaudeCli(): string | undefined {
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  if (lookup.status === 0) {
    const lines = lookup.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // On Windows prefer a real .exe, then the npm .cmd shim.
    const exe = lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l)) ?? lines[0];
    if (exe) return exe;
  }

  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const editors = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.antigravity-ide', '.vscodium'];
  const found: Array<{ path: string; version: string }> = [];
  for (const editor of editors) {
    const dir = join(homedir(), editor, 'extensions');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('anthropic.claude-code-')) continue;
      const path = join(dir, name, 'resources', 'native-binary', binary);
      if (existsSync(path)) found.push({ path, version: name.replace('anthropic.claude-code-', '') });
    }
  }
  // The newest extension, compared numerically so 2.1.330 sorts after 2.1.99.
  found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return found[0]?.path;
}

function claudeCli(cli: string, args: string[]): { ok: boolean; output: string } {
  // A real executable is spawned directly, which needs no quoting at all. Only an npm
  // `.cmd` shim has to go through a shell.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli)) return run(cli, args);
  const result = spawnSync(cli, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) return { ok: false, output: result.error.message };
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

// ── The apps ────────────────────────────────────────────────────────────────

export interface Client {
  id: 'claude-code' | 'claude-desktop' | 'cursor';
  label: string;
  /** Installed on this machine, as far as can be told. */
  detected(): boolean;
  installed(): boolean;
  install(spec: LaunchSpec): string;
  uninstall(): boolean;
  /** What to do after installing for the change to take effect. */
  restart: string;
}

const claudeJson = () => join(homedir(), '.claude.json');

function desktopConfig(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

const cursorConfig = () => join(homedir(), '.cursor', 'mcp.json');

export const CLIENTS: Client[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    detected: () => Boolean(findClaudeCli()) || existsSync(claudeJson()) || existsSync(join(homedir(), '.claude')),
    installed: () => hasServer(claudeJson()),
    install(spec) {
      const cli = findClaudeCli();
      if (cli) {
        // Replace rather than add: an older entry pointing at a moved install would
        // otherwise make `add` fail with "already exists".
        claudeCli(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
        const added = claudeCli(cli, ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', spec.command, ...spec.args]);
        if (added.ok) return 'added for every project (user scope)';
        // Fall through to editing the file when the CLI refuses for some reason.
      }
      setServer(claudeJson(), { type: 'stdio', command: spec.command, args: spec.args, env: {} });
      return 'added for every project (user scope)';
    },
    uninstall() {
      const cli = findClaudeCli();
      if (cli && claudeCli(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']).ok) return true;
      return removeServer(claudeJson());
    },
    restart: 'start a new Claude Code session (in an editor: reload the window)',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    detected: () => existsSync(dirname(desktopConfig())),
    installed: () => hasServer(desktopConfig()),
    install(spec) {
      setServer(desktopConfig(), { command: spec.command, args: spec.args });
      return desktopConfig();
    },
    uninstall: () => removeServer(desktopConfig()),
    restart: 'quit Claude Desktop fully and open it again',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detected: () => existsSync(join(homedir(), '.cursor')),
    installed: () => hasServer(cursorConfig()),
    install(spec) {
      setServer(cursorConfig(), { command: spec.command, args: spec.args });
      return cursorConfig();
    },
    uninstall: () => removeServer(cursorConfig()),
    restart: 'reload the Cursor window',
  },
];

/**
 * Prove the server starts the way an app will start it, before telling anyone it works.
 *
 * Spawns the exact command just written into the config and asks it for its tool list.
 * A config entry that looks right but fails to launch is the failure people cannot
 * diagnose themselves, so it is caught here instead of in their editor.
 */
export async function verifyLaunch(spec: LaunchSpec): Promise<{ ok: boolean; tools: number; error?: string }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'dv-mcp-install', version: '0' });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('did not respond within 60s')), 60_000).unref());
  try {
    await Promise.race([
      client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, stderr: 'ignore' })),
      timeout,
    ]);
    const { tools } = await Promise.race([client.listTools(), timeout]);
    return { ok: true, tools: tools.length };
  } catch (err) {
    return { ok: false, tools: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.close().catch(() => undefined);
  }
}
