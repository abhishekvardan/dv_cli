/**
 * `dv mcp` — dv as a Model Context Protocol server, over stdio.
 *
 * Lets Claude Code (or any MCP client) call dv's commands as typed tools rather than
 * composing shell lines from the skill. Register it with:
 *
 *     claude mcp add dv -- dv mcp
 *
 * or install the Claude Code plugin, which does that and adds the skill.
 *
 * Every tool call runs dv as a child process (cli/selfExec.ts). That is what keeps the
 * guarantees intact: policy is assessed before the handler, every write is journaled,
 * and the exit code means what the contract says. The server itself never touches a
 * provider API.
 *
 * Nothing here may write to stdout. stdout is the protocol channel; a stray line from
 * `out()` would be read by the client as a malformed message.
 */

import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { bool, str, type ParsedArgs } from '../cli/args.js';
import { CancelledError, CliError, EXIT, UsageError } from '../cli/errors.js';
import { wantsJson } from '../cli/output.js';
import { runSelf, type SelfExecResult } from '../cli/selfExec.js';
import { c, confirm, fail, info, json, out, success, warn } from '../cli/ui.js';
import { CLIENTS, PACKAGE, launchSpec, verifyLaunch, type Client } from '../mcp/install.js';
import { startAddAccount } from '../mcp/accounts.js';
import { VERSION } from './help.js';
import { bundledSkill } from './skill.js';
import {
  EXIT_NAMES,
  allCommands,
  buildArgv,
  describe,
  emitsJson,
  inputKey,
  toolName,
  type McpCommand,
} from '../mcp/tools.js';

export const AUTHOR = 'Abhishek Vardan Botta';

/** Enough for a long table, short of flooding a model's context with one call. */
const OUTPUT_BUDGET = 60_000;

/** Ordinary commands. Long-running ones get longer — see `timeoutFor`. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const LONG_TIMEOUT_MS = 35 * 60_000;
const LONG_RUNNING = new Set(['ship', 'watch deployments', 'vercel deploy create', 'vercel deploy wait']);

const INSTRUCTIONS = [
  `dv ${VERSION} by ${AUTHOR} — GitHub, Vercel, Supabase/Postgres, git, Gmail, Calendar and LinkedIn through one CLI with its own OAuth logins.`,
  'Every write is journaled (journal tool) and reversible where the provider allows (undo tool). The user can set policy rules dv enforces on itself; a blocked call is a decision, not an obstacle to route around.',
  'Write tools preview first: without confirm=true they exit 6 and change nothing. Show the preview, then repeat with confirm=true once the user agrees.',
  'Exit 3 means a connection is missing or expired: call auth_add for that provider, which opens a sign-in window for the user. Never ask for a token in the chat.',
  'Several accounts per service are supported: auth_accounts lists them, and every tool takes an account input to act as one of them.',
  'For anything without a dedicated tool, use run with the argv after `dv`; the help tool lists every command.',
].join('\n');

function truncate(text: string): string {
  if (text.length <= OUTPUT_BUDGET) return text;
  return `${text.slice(0, OUTPUT_BUDGET)}\n… (${text.length - OUTPUT_BUDGET} more characters; narrow the query or use --fields)`;
}

/** Turn a child run into an MCP result. */
export function toResult(argv: string[], run: SelfExecResult) {
  const name = EXIT_NAMES[run.exitCode] ?? 'error';
  const header = run.timedOut
    ? `$ dv ${argv.join(' ')}\nexit ${run.exitCode} (timed out — the command was stopped)`
    : `$ dv ${argv.join(' ')}\nexit ${run.exitCode} (${name})`;

  const content: Array<{ type: 'text'; text: string }> = [
    { type: 'text', text: `${header}\n\n${truncate(run.stdout.trimEnd()) || '(no output)'}` },
  ];
  // dv explains itself on stderr — "not connected", "needs a scope", the policy rule that
  // blocked a call. That is often the most useful part of a failure.
  const stderr = run.stderr.trim();
  // Leading newline: some clients join content blocks with nothing between them.
  if (stderr) content.push({ type: 'text', text: `\nstderr:\n${truncate(stderr)}` });

  return { content, isError: run.exitCode !== 0 };
}

/** What a write would do, without running it. Reported as exit 6: nothing happened. */
export function previewResult(command: McpCommand, argv: string[]) {
  const shown = argv.filter((a) => a !== '--yes');
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `$ dv ${shown.join(' ')}\nexit 6 (${EXIT_NAMES[6]})\n\n`
          + `PREVIEW — not run. This would ${command.effect ?? 'make a change'}.\n`
          + 'Show this to the user. Call again with the same inputs plus confirm=true once they agree.',
      },
    ],
    isError: true,
  };
}

function timeoutFor(id: string): number {
  return LONG_RUNNING.has(id) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/** The input schema for one command, as a zod raw shape. */
export function inputShape(command: McpCommand): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const param of command.params ?? []) {
    const base =
      param.kind === 'number' ? z.number() : param.kind === 'boolean' ? z.boolean() : z.string();
    const described = base.describe(param.describe);
    shape[inputKey(param)] = param.required ? described : described.optional();
  }

  if (command.mutates) {
    shape.confirm = z
      .boolean()
      .optional()
      .describe('true only after the user has seen the preview and agreed');
  }
  if (emitsJson(command)) {
    shape.fields = z
      .string()
      .optional()
      .describe('comma-separated fields to keep, e.g. "name,private,pushed_at" — use on list commands to keep output small');
  }
  shape.dry_run = z.boolean().optional().describe('show what would happen without doing it');
  shape.account = z.string().optional().describe('which saved account to act as (dv --as)');
  shape.cwd = z
    .string()
    .optional()
    .describe(command.local ? 'project directory to run in (default: where the server started)' : 'directory to run in');
  return shape;
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'dv', title: `dv — by ${AUTHOR}`, version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  for (const command of allCommands()) {
    server.registerTool(
      toolName(command),
      {
        title: `dv ${command.id}`,
        description: describe(command),
        inputSchema: inputShape(command),
        annotations: {
          title: `dv ${command.id}`,
          readOnlyHint: !command.mutates,
          destructiveHint: command.danger === 'high',
          idempotentHint: !command.mutates,
          openWorldHint: true,
        },
      },
      async (input: Record<string, unknown>) => {
        const argv = buildArgv(command, input);
        // The preview is guaranteed here rather than left to each command. Not every dv
        // write asks before acting — `gh issue create` does not — so relying on the
        // command's own prompt would let a first call make the change the description
        // promises it will only preview.
        if (command.mutates && input.confirm !== true && input.dry_run !== true) {
          return previewResult(command, argv);
        }
        const run = await runSelf(argv, {
          cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
          timeoutMs: timeoutFor(command.id),
        });
        return toResult(argv, run);
      },
    );
  }

  // The escape hatch. Anything dv can do is reachable, still through policy and the
  // journal, but a client cannot tell reads from writes here, so it is marked as a write.
  server.registerTool(
    'run',
    {
      title: 'dv (any command)',
      description:
        'Run any dv command not covered by a dedicated tool. Pass the words after `dv` as argv, '
        + 'e.g. ["vercel","env","add","my-app","--key","X","--value","y"]. Add "--json" for structured output; '
        + 'writes need "--yes" and should only be sent after the user agrees. Use the help tool to see every command.',
      inputSchema: {
        argv: z.array(z.string()).min(1).describe('arguments after `dv`'),
        cwd: z.string().optional().describe('directory to run in'),
      },
      annotations: { title: 'dv (any command)', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ argv, cwd }) => {
      const run = await runSelf(argv, { cwd, timeoutMs: timeoutFor(argv.join(' ')) });
      return toResult(argv, run);
    },
  );

  // Adding an account. Takes no token on purpose: anything a tool receives is part of the
  // conversation. It opens a terminal window on the user's screen running the ordinary
  // sign-in, where a token is typed with echo off or a browser sign-in happens.
  server.registerTool(
    'auth_add',
    {
      title: 'dv: add an account',
      description:
        'Add another account for a service (a second GitHub or Vercel account, a Google account, …) or reconnect an expired one. '
        + 'Opens a sign-in window on the user\'s screen; they paste a token there or approve in the browser. '
        + 'Never ask the user to paste a token into the chat. Afterwards call auth_accounts to confirm it was added.',
      inputSchema: {
        provider: z.string().describe('the service: github, vercel, google, linkedin, supabase, …'),
        nickname: z.string().optional().describe('optional name to save it under, e.g. "work"; defaults to the account\'s own username'),
      },
      annotations: { title: 'dv: add an account', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ provider, nickname }) => {
      let result: ReturnType<typeof startAddAccount>;
      try {
        result = startAddAccount(provider.toLowerCase(), nickname);
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
      const { plan, opened } = result;
      const command = `dv ${plan.argv.join(' ')}`;
      if (!opened) {
        return {
          content: [{ type: 'text', text: `Could not open a terminal window. Ask the user to run this in their own terminal:\n\n  ${command}` }],
          isError: true,
        };
      }
      const steps = plan.browser
        ? 'A terminal window opened and will open the browser. The user approves access there; the window says when it is done.'
        : `A terminal window opened, and the page to create a token${plan.tokenPage ? ` (${plan.tokenPage})` : ''}. `
          + 'The user creates a token, pastes it into the terminal window (it stays hidden), and presses Enter.';
      return {
        content: [{
          type: 'text',
          text: `Opened: ${command}\n\n${steps}\n\nTell the user what to do, wait for them to say it is done, then call auth_accounts to confirm. `
            + 'If the new account should be the default, use auth_switch; otherwise pass it as the account input on any tool.',
        }],
      };
    },
  );

  server.registerTool(
    'help',
    {
      title: 'dv help',
      description: 'Every dv command with a one-line description, and the common flags.',
      inputSchema: {},
      annotations: { title: 'dv help', readOnlyHint: true, openWorldHint: false },
    },
    async () => toResult(['--help'], await runSelf(['--help'])),
  );

  server.registerResource(
    'skill',
    'dv://skill',
    {
      title: 'How to use dv well',
      description: 'The dv skill: exit codes, --json, policy, the journal, and what not to do.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readFileSync(bundledSkill(), 'utf8') }],
    }),
  );

  return server;
}

/**
 * `dv mcp`            run the server (what an app launches)
 * `dv mcp install`    connect it to Claude Code, Claude Desktop and Cursor
 * `dv mcp uninstall`  disconnect it
 * `dv mcp status`     where it is connected
 */
export async function mcpCommand(args: ParsedArgs): Promise<void> {
  const verb = args.command[1];
  if (!verb || verb === 'serve') return serve();
  if (verb === 'install' || verb === 'setup') return install(args);
  if (verb === 'uninstall' || verb === 'remove') return uninstall(args);
  if (verb === 'status') return status(args);
  throw new UsageError(`Unknown mcp command "${verb}".`, 'dv mcp install | uninstall | status\ndv mcp            (run the server)');
}

/** Which apps a command applies to: `--client cursor,claude-code`, or every one found. */
function chooseClients(args: ParsedArgs): Client[] {
  const wanted = str(args.flags, 'client');
  if (!wanted) return CLIENTS.filter((client) => client.detected());
  const ids = wanted.split(',').map((s) => s.trim().toLowerCase());
  const unknown = ids.filter((id) => !CLIENTS.some((client) => client.id === id));
  if (unknown.length) {
    throw new UsageError(`Unknown app: ${unknown.join(', ')}`, `Choose from: ${CLIENTS.map((client) => client.id).join(', ')}`);
  }
  return CLIENTS.filter((client) => ids.includes(client.id));
}

async function install(args: ParsedArgs): Promise<void> {
  const clients = chooseClients(args);
  if (clients.length === 0) {
    throw new CliError(
      'No supported AI app found on this computer.',
      EXIT.notFound,
      'Install Claude Code (https://claude.com/claude-code), Claude Desktop or Cursor, then run: dv mcp install',
    );
  }

  const spec = launchSpec();
  out(c.bold('Connect dv to your AI apps'));
  out('');
  for (const client of clients) out(`  ${c.green('•')} ${client.label}${client.installed() ? c.dim('  (already connected — will refresh)') : ''}`);
  out('');
  out(c.dim(`  Each app will start dv with: ${[spec.command, ...spec.args].join(' ')}`));
  if (spec.ephemeral) {
    out('');
    warn(`dv is running through npx. For a faster, more reliable setup install it first: npm install -g ${PACKAGE}`);
  }
  out('');

  const ok = await confirm('Connect dv to these apps?', bool(args.flags, 'yes', 'y'));
  if (!ok) throw new CancelledError('Nothing was changed.');

  // Check the server starts before touching anything, so a broken install never ends up
  // registered in an app where it would only show up as "failed".
  const check = await verifyLaunch(spec);
  if (!check.ok) {
    throw new CliError(
      `The dv MCP server did not start: ${check.error}`,
      EXIT.failure,
      `Nothing was changed. Try reinstalling: npm install -g ${PACKAGE}`,
    );
  }

  const restarts: string[] = [];
  for (const client of clients) {
    try {
      const where = client.install(spec);
      success(`${client.label}: connected ${c.dim(`— ${where}`)}`);
      restarts.push(`  ${client.label}: ${client.restart}`);
    } catch (err) {
      fail(`${client.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  out('');
  out(`${c.green('✓')} The server starts and offers ${check.tools} tools.`);
  out('');
  out(c.bold('Last step'));
  for (const line of restarts) out(line);
  out('');
  out(`Then ask: ${c.bold('"check my dv setup"')}`);
  out('');
  out(c.dim('Not signed in to a service yet? dv auth login github   (also: vercel, google, linkedin)'));
}

async function uninstall(args: ParsedArgs): Promise<void> {
  const clients = chooseClients(args).filter((client) => client.installed() || client.id === 'claude-code');
  const ok = await confirm('Disconnect dv from your AI apps?', bool(args.flags, 'yes', 'y'));
  if (!ok) throw new CancelledError('Nothing was changed.');
  let removed = 0;
  for (const client of clients) {
    if (client.uninstall()) {
      removed += 1;
      success(`${client.label}: disconnected`);
    }
  }
  if (removed === 0) info('dv was not connected to any app.');
}

async function status(args: ParsedArgs): Promise<void> {
  const rows = CLIENTS.map((client) => ({
    app: client.label,
    id: client.id,
    found: client.detected(),
    connected: client.installed(),
  }));
  if (wantsJson(args.flags)) return json(rows);
  for (const row of rows) {
    const state = !row.found ? c.dim('not installed') : row.connected ? c.green('connected') : c.yellow('not connected');
    out(`  ${row.app.padEnd(15)} ${state}`);
  }
  if (rows.some((row) => row.found && !row.connected)) {
    out('');
    info(`Connect it with: ${c.bold('dv mcp install')}`);
  }
}

async function serve(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // The dispatcher ends the process once a handler returns, so this one must not return
  // until the client has gone. A closed stdin is the client going away.
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
    process.stdin.once('close', () => resolve());
  });

  await server.connect(transport);
  process.stderr.write(`dv ${VERSION} MCP server ready on stdio\n`);
  await closed;
  await server.close().catch(() => undefined);
}
