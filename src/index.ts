#!/usr/bin/env node
/**
 * dv — one CLI for the services DevOS integrates with.
 *
 * Dispatch only. Each command group lives in commands/, the API clients in api/, and
 * anything to do with credentials in auth/ and config/.
 */

import { bool, parseArgs } from './cli/args.js';
import { CliError, EXIT } from './cli/errors.js';
import { c, fail, info, setQuiet } from './cli/ui.js';
import { printHelp, VERSION } from './commands/help.js';
import { authCommand } from './commands/auth.js';
import { configCommand } from './commands/config.js';
import { ghCommand } from './commands/gh.js';
import { calendarCommand, gmailCommand } from './commands/gmail.js';
import { linkedinCommand } from './commands/misc.js';
import { vercelCommand } from './commands/vercel.js';
import { shipCommand } from './commands/ship.js';
import { connectCommand } from './commands/connect.js';
import { apiCommand } from './commands/api.js';

type Handler = (args: ReturnType<typeof parseArgs>) => Promise<void>;

const COMMANDS: Record<string, Handler> = {
  auth: authCommand,
  config: configCommand,
  gh: ghCommand,
  github: ghCommand,
  gmail: gmailCommand,
  mail: gmailCommand,
  cal: calendarCommand,
  calendar: calendarCommand,
  li: linkedinCommand,
  linkedin: linkedinCommand,
  vercel: vercelCommand,
  // The generic pair: `connect` defines a service, `api` calls it. Between them any
  // HTTP API is reachable without this CLI needing to know about it in advance.
  connect: connectCommand,
  connectors: connectCommand,
  api: apiCommand,
  // Cross-service workflows: the part no single provider's CLI can do.
  ship: shipCommand,
  deploy: shipCommand,
  // `dv status` is the first thing anyone runs, so it gets a top-level name
  // rather than only existing under `auth`.
  status: (args) => authCommand({ ...args, command: ['auth', 'status'] }),
};

/**
 * End the process with a code.
 *
 * Deliberately NOT `process.exit()`. Calling that while fetch still holds a socket
 * trips a libuv assertion on Windows — `!(handle->flags & UV_HANDLE_CLOSING)` — which
 * aborts the process and replaces the intended exit code with 127. A CLI whose exit
 * code is unreliable after a network call is unusable in a script.
 *
 * Setting `exitCode` lets Node close its handles and exit on its own, which takes a
 * few hundred milliseconds. The unref'd timer is a backstop: it cannot keep the loop
 * alive by itself, so it only ever fires if something else is holding the process
 * open — a lingering keep-alive socket — where a forced exit beats hanging.
 */
function finish(code: number): void {
  process.exitCode = code;
  const backstop = setTimeout(() => process.exit(code), 3000);
  backstop.unref();
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  setQuiet(bool(args.flags, 'quiet', 'q'));

  if (bool(args.flags, 'version') || args.command[0] === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  const name = args.command[0];

  // Bare `dv`, or `dv --help`, prints the overview. `dv gh --help` falls
  // through to the command, which explains its own subcommands.
  if (!name || (bool(args.flags, 'help', 'h') && !name)) {
    printHelp();
    return EXIT.ok;
  }

  const handler = COMMANDS[name.toLowerCase()];
  if (!handler) {
    fail(`Unknown command "${name}".`);
    info('');
    info(`Run ${c.bold('dv --help')} to see what is available.`);
    return EXIT.usage;
  }

  await handler(args);
  return EXIT.ok;
}

main(process.argv.slice(2))
  .then(finish)
  .catch((err: unknown) => {
    if (err instanceof CliError) {
      fail(err.message);
      // The hint is the actionable half — a command to run, or what to check.
      if (err.hint) {
        for (const line of err.hint.split('\n')) info(`  ${c.dim(line)}`);
      }
      finish(err.code);
      return;
    }

    // Network failures are common enough to deserve a real sentence rather than
    // "fetch failed", which tells the user nothing about what to do.
    const message = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
      fail('Could not reach the network.');
      info(`  ${c.dim('Check your connection or proxy, then try again.')}`);
      finish(EXIT.failure);
      return;
    }

    fail(message);
    if (process.env.DV_DEBUG && err instanceof Error && err.stack) {
      process.stderr.write(`\n${err.stack}\n`);
    } else {
      info(`  ${c.dim('Set DV_DEBUG=1 for a stack trace.')}`);
    }
    finish(EXIT.failure);
  });
