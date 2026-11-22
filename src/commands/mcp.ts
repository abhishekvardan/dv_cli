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

import type { ParsedArgs } from '../cli/args.js';
import { runSelf, type SelfExecResult } from '../cli/selfExec.js';
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
  'Exit 3 means a connection is missing: tell the user to run `dv auth login <provider>` in their terminal (it opens a browser).',
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
  if (stderr) content.push({ type: 'text', text: `stderr:\n${truncate(stderr)}` });

  return { content, isError: run.exitCode !== 0 };
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

export async function mcpCommand(_args: ParsedArgs): Promise<void> {
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
