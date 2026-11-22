/**
 * `dv policy`
 *
 * Read the rules, install a starting set, or ask what would happen to a command.
 * Deliberately has no `add` or `remove` verb — changing what constrains the tool is an
 * edit to a file a person opens, not an operation the tool offers to perform on itself.
 */

import { existsSync } from 'node:fs';

import { bool, parseArgs, rawArgv, type ParsedArgs } from '../cli/args.js';
import { EXIT, UsageError } from '../cli/errors.js';
import { c, info, out, success, warn } from '../cli/ui.js';
import { emit, outputOpts, wantsJson } from '../cli/output.js';
import {
  assess,
  loadPolicy,
  policyPath,
  STARTER_POLICY,
  writePolicy,
  type Assessment,
  type PolicyRule,
} from '../cli/policy.js';

export async function policyCommand(args: ParsedArgs): Promise<void> {
  const verb = args.command[1] ?? 'show';

  switch (verb) {
    case 'show':
    case 'list': {
      const policy = loadPolicy();
      if (wantsJson(args.flags)) return emit(policy, outputOpts(args.flags, 'policy'));

      if (policy.rules.length === 0) {
        info('No policy set — nothing is restricted.');
        info('');
        info(`  ${c.bold('dv policy init')}   write a starting policy`);
        return;
      }

      out(c.dim(policyPath()));
      out('');
      for (const rule of policy.rules) {
        const effect = rule.deny ? c.red('deny') : c.yellow(`require ${rule.require}`);
        out(`  ${effect.padEnd(24)} ${ruleLine(rule)}`);
        if (rule.reason) out(`  ${' '.repeat(24)} ${c.dim(rule.reason)}`);
      }
      out('');
      info(c.dim('Edit that file to change them. No flag overrides a rule.'));
      return;
    }

    case 'init': {
      const path = policyPath();
      if (existsSync(path)) {
        // Never overwritten. The existing file is the thing standing between an
        // unattended run and a bad afternoon, and replacing it with defaults because
        // someone re-ran `init` would be the worst possible time to lose it.
        throw new UsageError(
          'A policy file already exists.',
          `${path}\nEdit it directly, or delete it first to start over.`,
        );
      }
      writePolicy(STARTER_POLICY);
      success(`Wrote ${path}`);
      out('');
      for (const rule of STARTER_POLICY.rules) {
        const effect = rule.deny ? c.red('deny') : c.yellow(`require ${rule.require}`);
        out(`  ${effect.padEnd(24)} ${ruleLine(rule)}`);
      }
      out('');
      info(c.dim('These are a starting point — edit the file to suit what you actually run.'));
      return;
    }

    case 'test':
    case 'check': {
      // "Would this be allowed?" without running it. Useful before handing a command to
      // something that will run unattended, where discovering the rule at execution
      // time is discovering it too late — which only holds if the answer is the same one
      // the real run would give. It is the same answer because it comes from the same
      // function: the command is re-parsed from the raw words by the parser that parses
      // every other command, and handed to `assess`, which is what `dv` itself calls.
      const { options, command: tokens } = splitTestArgs(testTokens(args));
      if (tokens.length === 0) {
        throw new UsageError(
          'Which command?',
          'dv policy test vercel dns add example.com A @ 1.2.3.4',
        );
      }

      const tested = parseArgs(tokens);
      if (tested.command.length === 0) {
        throw new UsageError(
          'That is a list of flags, not a command.',
          `Start with the command name: dv policy test db query --file ./migration.sql`,
        );
      }

      const interactive = options.tty
        ? true
        : options.unattended
          ? false
          : Boolean(process.stdin.isTTY);

      const assessment = assess({
        command: tested.command,
        args: tested.positional,
        flags: tested.flags,
        dryRun: bool(tested.flags, 'dry-run'),
        interactive,
      });

      if (options.json || wantsJson(args.flags)) {
        emit(reportJson(assessment, tokens, interactive), outputOpts(args.flags, 'policy test'));
      } else {
        printReport(assessment, tokens, interactive);
      }

      // A blocked command is a legitimate answer to a question, not a failure of the
      // tool, but it must not exit 0: the caller asking is usually a script deciding
      // whether to run the thing, and `if dv policy test …` has to mean something.
      if (assessment.blocked) process.exitCode = EXIT.cancelled;
      return;
    }

    case 'path':
      out(policyPath());
      return;

    default:
      throw new UsageError(
        `Unknown policy command "${verb}".`,
        'dv policy show | init | test [--unattended|--tty] [--json] <command> | path',
      );
  }
}

/* ─────────────────────────── dv policy test ─────────────────────────── */

export interface TestOptions {
  /** Answer as if no terminal were attached — what an agent or a CI job would hit. */
  unattended: boolean;
  /** Answer as if one were, from a session that has none. */
  tty: boolean;
  json: boolean;
}

/**
 * The words that came after `dv policy test`, exactly as typed.
 *
 * Taken from the raw argv rather than the parsed form because the parsed form has already
 * swallowed the tested command's flags into the outer command's: `dv policy test db query
 * --file x.sql` parses as the command ["policy","test","db","query"] with a `file` flag
 * belonging to `policy`. Testing that would be testing a command nobody ran, and the
 * answer differed from the real one for precisely that reason.
 */
function testTokens(args: ParsedArgs): string[] {
  const raw = rawArgv();
  const lower = raw.map((t) => t.toLowerCase());
  const group = (args.command[0] ?? 'policy').toLowerCase();
  const verb = (args.command[1] ?? 'test').toLowerCase();

  const start = lower.indexOf(group);
  const at = start === -1 ? -1 : lower.indexOf(verb, start + 1);
  if (at !== -1) return raw.slice(at + 1);

  // Called without the process argv — from a test, or embedded. The words are still
  // right; only flags typed for the inner command are lost.
  return [...args.command.slice(2), ...args.positional];
}

/**
 * Split `dv policy test`'s own options from the command under test.
 *
 * Only leading flags belong to `policy test`. Everything from the first non-flag word
 * onwards is the command being asked about, flags and all — otherwise `--json` would be
 * ambiguous between the two, and a tested command could never carry a flag of its own.
 */
export function splitTestArgs(tokens: string[]): { options: TestOptions; command: string[] } {
  const options: TestOptions = { unattended: false, tty: false, json: false };

  let i = 0;
  for (; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith('-')) break;
    if (token === '--unattended' || token === '--no-tty') options.unattended = true;
    else if (token === '--tty' || token === '--interactive') options.tty = true;
    else if (token === '--json') options.json = true;
    else break;
  }

  return { options, command: tokens.slice(i) };
}

function ruleLine(rule: PolicyRule): string {
  const when = rule.when
    ? ` ${c.dim(`when ${rule.when.sql ? `sql is a ${rule.when.sql}` : ''}${rule.when.flag ? `--${[rule.when.flag].flat().join(' or --')} given` : ''}`)}`
    : '';
  return `${c.bold(rule.match)}${when}`;
}

function printReport(assessment: Assessment, tokens: string[], interactive: boolean): void {
  out(`${c.dim('command  ')} dv ${tokens.join(' ')}`);
  out(`${c.dim('terminal ')} ${interactive ? 'a person can answer a prompt' : 'unattended'}`);

  const { subject } = assessment;
  if (subject.sql !== 'none') {
    const kind =
      subject.sql === 'write'
        ? c.yellow('a write')
        : subject.sql === 'read'
          ? c.green('a read')
          : c.yellow('unreadable — treated as a write');
    out(`${c.dim('sql      ')} ${kind}${subject.statementSource ? c.dim(` from ${subject.statementSource}`) : ''}`);
    if (subject.note) out(`${' '.repeat(10)}${c.dim(subject.note)}`);
  }
  out('');

  for (const d of assessment.decisions) {
    if (d.blocked) out(`  ${c.red('blocked')}  ${d.blocked}`);
    else if (d.forceConfirm) out(`  ${c.yellow('confirm')}  Must be confirmed at the terminal.`);
    out(`  ${c.dim(`rule: ${ruleLine(d.rule)}${d.rule.reason ? ` — ${d.rule.reason}` : ''}`)}`);
  }

  // The half that used to be missing. A command that asks its own question is not
  // "allowed" in any sense the caller cares about if there is nobody to answer it.
  for (const p of assessment.prompts) {
    out(`  ${c.yellow('asks')}     ${p.question}  ${c.dim(p.why)}`);
    out(`  ${c.dim(p.satisfiedByYes ? '  --yes answers it' : '  --yes does not answer it: a rule requires a real confirmation')}`);
  }

  if (assessment.decisions.length > 0 || assessment.prompts.length > 0) out('');

  if (assessment.blocked) warn('It would not run.');
  else if (assessment.needsConfirmation) success('It would run, once confirmed.');
  else success('It would run — nothing stands in the way.');
}

/**
 * The machine-readable answer.
 *
 * Deliberately without the statement itself: a migration file is exactly the kind of
 * thing that carries a password in a connection string, and this output goes into logs.
 */
function reportJson(assessment: Assessment, tokens: string[], interactive: boolean) {
  return {
    command: `dv ${tokens.join(' ')}`,
    interactive,
    wouldRun: !assessment.blocked,
    needsConfirmation: assessment.needsConfirmation,
    sql: assessment.subject.sql,
    sqlFrom: assessment.subject.statementSource ?? null,
    rules: assessment.decisions.map((d) => ({
      match: d.rule.match,
      effect: d.blocked ? 'blocked' : d.forceConfirm ? 'confirm' : 'allowed',
      detail: d.blocked ?? null,
      reason: d.rule.reason ?? null,
      when: d.rule.when ?? null,
    })),
    prompts: assessment.prompts.map((p) => ({
      question: p.question,
      why: p.why,
      satisfiedByYes: p.satisfiedByYes,
    })),
  };
}
