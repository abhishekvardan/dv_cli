#!/usr/bin/env node
/**
 * dv — one CLI for the services DevOS integrates with.
 *
 * Dispatch only. Each command group lives in commands/, the API clients in api/, and
 * anything to do with credentials in auth/ and config/.
 */

import { bool, negated, num, parseArgs, setRawArgv, str, type ParsedArgs } from './cli/args.js';
import { setAccountOverride } from './config/store.js';
import { setDryRun } from './cli/interactive.js';
import { setRetryAttempts } from './cli/output.js';
import { CliError, DryRunError, EXIT } from './cli/errors.js';
import { c, fail, info, setQuiet } from './cli/ui.js';
import { printHelp, VERSION } from './commands/help.js';
import { authCommand } from './commands/auth.js';
import { configCommand } from './commands/config.js';
import { ghCommand } from './commands/gh.js';
import { calendarCommand, gmailCommand } from './commands/gmail.js';
import { laterCommand, linkedinCommand } from './commands/misc.js';
import { youtubeCommand } from './commands/youtube.js';
import { vercelCommand } from './commands/vercel.js';
import { shipCommand } from './commands/ship.js';
import { dbCommand } from './commands/db.js';
import { gitCommand } from './commands/git.js';
import { snapshotsCommand } from './commands/snapshots.js';
import { doctorCommand } from './commands/doctor.js';
import { connectCommand } from './commands/connect.js';
import { apiCommand } from './commands/api.js';
import { journalCommand, undoCommand } from './commands/journal.js';
import { policyCommand } from './commands/policy.js';
import { watchCommand } from './commands/watch.js';
import { skillCommand } from './commands/skill.js';
import { aiCommand, askCommand } from './commands/ask.js';
import { assess, recordDryRun } from './cli/policy.js';
import { setRequireRealConfirm } from './cli/interactive.js';

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
  yt: youtubeCommand,
  youtube: youtubeCommand,
  vercel: vercelCommand,
  // The generic pair: `connect` defines a service, `api` calls it. Between them any
  // HTTP API is reachable without this CLI needing to know about it in advance.
  connect: connectCommand,
  // The naming rule: a group is provider-named when it wraps one service's own API
  // surface (`gh`, `vercel`), and capability-named when several providers sit behind one
  // interface (`db`). `deploy` is deliberately the pipeline rather than an alias for
  // `vercel` — it is the capability, and it already spans git, GitHub and Vercel.
  // `dv repo list` means `dv gh repo list` — the noun has to be re-inserted, or the
  // dispatcher reads "list" as the noun and finds nothing.
  repo: (args) => ghCommand({ ...args, command: ['gh', 'repo', ...args.command.slice(1)] }),
  connectors: connectCommand,
  api: apiCommand,
  // Cross-service workflows: the part no single provider's CLI can do.
  git: gitCommand,
  snapshots: snapshotsCommand,
  doctor: doctorCommand,
  db: dbCommand,
  sql: dbCommand,
  ship: shipCommand,
  deploy: shipCommand,
  // The three that make handing this to something unattended reasonable: a record of
  // every write with one-command reversal, rules the tool applies to itself, and a way
  // to wait for a change rather than poll for one.
  journal: journalCommand,
  history: journalCommand,
  undo: undoCommand,
  later: laterCommand,
  policy: policyCommand,
  watch: watchCommand,
  // Ships with the package, so an assistant can be taught to use this CLI properly
  // without fetching anything.
  skill: skillCommand,
  // The same commands as typed tools for an MCP client such as Claude Code. Each call
  // re-runs dv as a child, so policy and the journal apply exactly as they do here.
  // Loaded on demand: the MCP SDK is the only runtime dependency, and every other
  // command should start without paying for it.
  mcp: async (args) => (await import('./commands/mcp.js')).mcpCommand(args),
  // Ask in words. Runs against a local model, and can only reach commands you could
  // have typed yourself — see src/ai/catalog.ts for why that constraint is the design.
  ask: askCommand,
  ai: aiCommand,
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
  // Kept verbatim so `dv policy test <command>` can re-parse the command it was handed
  // exactly as this function parsed this one.
  setRawArgv(argv);
  const args = parseArgs(argv);
  setQuiet(bool(args.flags, 'quiet', 'q'));

  // `--as work` picks which account a command runs under, for every provider it
  // touches. Set once here rather than passed through every API call.
  setAccountOverride(str(args.flags, 'as', 'account'));
  setDryRun(bool(args.flags, 'dry-run'));
  // Retry policy is global: a caller who wants a command to fail fast wants that
  // for the whole invocation, not per request.
  setRetryAttempts(negated(args.flags, 'retry') ? 1 : num(args.flags, 'retries', 3));

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

  // Policy runs before the handler, so a denied command never reaches a network call and
  // cannot half-happen. `policy` itself is exempt — a rule that made the rules
  // unreadable would be impossible to diagnose.
  if (name.toLowerCase() !== 'policy') {
    const blocked = applyPolicy(args, bool(args.flags, 'dry-run'));
    if (blocked !== EXIT.ok) return blocked;
  }

  // A dry run is only evidence for the rule that demanded it if it is remembered.
  //
  // Recorded on both exits, because a dry run normally *does* throw: `DryRunError` is
  // how a command reports that it stopped where the write would have been, so treating
  // it as a failure would mean the receipt is never written and the rule can never be
  // satisfied. Any other error is a genuine failure, and leaves no receipt — nothing was
  // reviewed if the command never reached the plan.
  const isDry = bool(args.flags, 'dry-run');
  try {
    await handler(args);
  } catch (err) {
    if (isDry && err instanceof DryRunError) recordDryRun(args.command);
    throw err;
  }
  if (isDry) recordDryRun(args.command);

  return EXIT.ok;
}

/**
 * Enforce the policy file, before anything happens.
 *
 * Returns a non-zero exit code when the command must not run. Nothing on the command
 * line reaches this decision: the flags are not consulted beyond `--dry-run`, which a
 * rule can demand but never waive.
 */
function applyPolicy(args: ParsedArgs, dryRun: boolean): number {
  const command = args.command;
  const { decisions } = assess({
    command,
    args: args.positional,
    flags: args.flags,
    dryRun,
    interactive: Boolean(process.stdin.isTTY),
  });
  if (decisions.length === 0) return EXIT.ok;

  const blocking = decisions.filter((d) => d.blocked);
  if (blocking.length > 0) {
    const first = blocking[0]!;
    fail(first.blocked!);
    info(`  ${c.dim(`rule: ${first.rule.match}`)}`);
    if (first.rule.reason) info(`  ${c.dim(first.rule.reason)}`);
    info('');
    if (first.rule.require === 'dry-run') {
      info(`  ${c.dim(`Run it once with --dry-run, then again for real:`)}`);
      info(`  ${c.dim(`dv ${command.join(' ')} --dry-run`)}`);
    } else {
      info(`  ${c.dim(`Policy lives in your policy file — dv policy path`)}`);
    }
    return EXIT.usage;
  }

  // Nothing blocked, but a rule wants this looked at by a person. `--yes` stops working
  // for the rest of this invocation.
  if (decisions.some((d) => d.forceConfirm)) {
    setRequireRealConfirm(true);
    const rule = decisions.find((d) => d.forceConfirm)!.rule;
    info(`${c.yellow('policy')} ${c.dim(`${rule.match} — confirmation required${rule.reason ? `: ${rule.reason}` : ''}`)}`);
  }
  return EXIT.ok;
}

main(process.argv.slice(2))
  .then(finish)
  .catch((err: unknown) => {
    if (err instanceof DryRunError) {
      // Not a failure: the command did what was asked and stopped.
      info(c.dim(`  ${err.message}`));
      finish(EXIT.ok);
      return;
    }
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
