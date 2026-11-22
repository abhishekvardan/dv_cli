/**
 * Rules the tool enforces on itself.
 *
 * The obstacle to granting an agent broader autonomy is not what it can do, it is what
 * it can do *wrong*, and an instruction to be careful is not a control — it lives in the
 * same context the agent is free to reason its way out of. A policy file is different:
 * it is read from disk on every invocation, evaluated before the command runs, and
 * nothing the caller passes on the command line can switch it off.
 *
 * That last property is the whole point, so it is worth being precise about it:
 *
 *  - There is no `--no-policy`, and `--yes` does not satisfy a rule that requires
 *    confirmation. An auto-confirm flag exists so a human can skip prompts they have
 *    already thought about; letting it also skip the rules they wrote to protect
 *    themselves from an unattended run would defeat both.
 *  - Rules are matched before any network call, so a denied command cannot half-happen.
 *  - Changing the policy means editing the file. That is deliberate friction: a human
 *    action in a text editor, not something reachable from inside a command.
 *
 * Two properties beyond that, both learned the hard way:
 *
 *  - A rule matches the *operation*, not the spelling. `db query *` covers
 *    `dv db query --file migration.sql`, where the argument arrives as a flag and the
 *    command words alone look like a bare noun.
 *  - A rule can ask what the command would actually do — `when: { sql: "write" }` fires
 *    for `delete from users` and not for `select 1` — so protecting writes does not mean
 *    blocking every read. When that question cannot be answered, the rule fires anyway:
 *    an unreadable statement is treated as a write, never waved through.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dvHome } from '../config/paths.js';
import { isReadOnly } from '../db/adapter.js';
import { CliError, EXIT } from './errors.js';

export type Requirement = 'dry-run' | 'confirm' | 'human';

export type Flags = Record<string, string | boolean | string[]>;

/**
 * Narrows a rule to what the command would actually do.
 *
 * Without this, the only honest policy for `db query` is to confirm everything, which is
 * what people turn off after the tenth blocked `select`. A rule that survives contact
 * with daily use is one that fires on the dangerous case only.
 */
export interface RuleCondition {
  /**
   * Restrict to reads or to writes, by inspecting the SQL the command would run —
   * including SQL passed as `--file`.
   */
  sql?: 'read' | 'write';
  /** Restrict to invocations carrying one of these flags, e.g. "force". */
  flag?: string | string[];
}

export interface PolicyRule {
  /** Command pattern, e.g. "vercel dns *" or "db query *". `*` matches one or more words. */
  match: string;
  /** Refuse outright. */
  deny?: boolean;
  /** Demand something before allowing it. */
  require?: Requirement;
  /** Narrow the rule to particular invocations. */
  when?: RuleCondition;
  /** Shown when the rule fires, so the refusal explains itself. */
  reason?: string;
}

export interface Policy {
  version: 1;
  rules: PolicyRule[];
}

export function policyPath(): string {
  return join(dvHome(), 'policy.json');
}

/**
 * A starting policy reflecting the ways this actually goes wrong.
 *
 * Written by `dv policy init` rather than applied by default. A tool that silently
 * imposes rules nobody chose is its own kind of surprise, and the rules only work if
 * someone read them.
 */
export const STARTER_POLICY: Policy = {
  version: 1,
  rules: [
    {
      match: 'vercel dns *',
      require: 'dry-run',
      reason: 'DNS mistakes take effect globally and outlast the fix.',
    },
    {
      match: 'vercel domain rm *',
      require: 'confirm',
      reason: 'Removing a domain takes the site off the air immediately.',
    },
    {
      match: 'gh repo delete *',
      deny: true,
      reason: 'Repository deletion cannot be undone from here.',
    },
    {
      match: 'db query *',
      when: { sql: 'write' },
      require: 'confirm',
      reason: 'Writes run with owner rights and bypass RLS. Reads are not restricted.',
    },
  ],
};

export function loadPolicy(): Policy {
  const path = policyPath();
  if (!existsSync(path)) return { version: 1, rules: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Policy;
    if (!Array.isArray(parsed.rules)) return { version: 1, rules: [] };
    return parsed;
  } catch (err) {
    // A malformed policy is a hard stop, never an empty one. Falling back to "no rules"
    // would let a stray comma quietly disable every protection the file exists to give.
    throw new CliError(
      `Could not read the policy file: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.failure,
      `${path}\nFix the JSON, or delete the file to run without policy.`,
    );
  }
}

export function writePolicy(policy: Policy): string {
  const home = dvHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = policyPath();
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * Flags that say how a command should run rather than what it should do.
 *
 * They are excluded when asking "did this invocation carry any arguments", so
 * `dv vercel dns --help` still does not match `vercel dns *` — printing usage is not
 * the operation the rule is about.
 */
const META_FLAGS = new Set([
  'help', 'h', 'json', 'quiet', 'q', 'verbose', 'dry-run', 'yes', 'y', 'as', 'account',
  'retries', 'retry', 'fields', 'reveal', 'snapshot', 'diff', 'color', 'no-color', 'limit', 'n',
]);

/** Whether any flag carries an argument to the operation, as opposed to steering output. */
export function hasArgumentFlags(flags: Flags | undefined): boolean {
  if (!flags) return false;
  return Object.keys(flags).some((f) => !META_FLAGS.has(f) && flags[f] !== false);
}

/**
 * Does a pattern cover this command?
 *
 * `*` stands for one or more arguments, so "vercel dns *" matches "vercel dns add" but
 * not a bare "vercel dns".
 *
 * An argument counts whether it was typed as a word or handed over as a flag: the words
 * of `dv db query --file migration.sql` stop at "query", and reading that as the bare
 * noun would let the same operation through the same rule by spelling it differently.
 * That gap is why a migration ran unreviewed, so the wildcard is satisfied by any flag
 * that is not merely about output.
 */
export function matchesPattern(
  pattern: string,
  command: string[],
  hasFlagArguments = false,
): boolean {
  const words = pattern.trim().split(/\s+/).filter(Boolean);
  const target = command.map((w) => w.toLowerCase());

  let ci = 0;
  for (let pi = 0; pi < words.length; pi++) {
    const word = words[pi]!;
    if (word === '*') {
      // A trailing wildcard takes everything remaining, provided there is something —
      // in the words, or in a flag standing in for them.
      if (pi === words.length - 1) return ci < target.length || hasFlagArguments;
      ci++;
      continue;
    }
    if (target[ci] !== word.toLowerCase()) return false;
    ci++;
  }
  return ci === target.length;
}

export interface PolicyContext {
  /** The command path, e.g. ["db", "query"]. */
  command: string[];
  /** Positional arguments parsed after the first flag, which belong to the command. */
  args?: string[];
  flags?: Flags;
  dryRun: boolean;
  /** Whether a human is actually present to answer a prompt. */
  interactive: boolean;
  /**
   * What the command would actually do. Resolved from the command when omitted, so a
   * caller cannot accidentally evaluate against facts the real run would not have.
   */
  subject?: CommandSubject;
}

export interface PolicyDecision {
  rule: PolicyRule;
  /** Set when the command must not proceed at all. */
  blocked?: string;
  /** Set when it may proceed but must genuinely prompt, `--yes` notwithstanding. */
  forceConfirm?: boolean;
}

/**
 * Evaluate the policy against a command.
 *
 * Every matching rule is considered rather than only the first: rules are protections,
 * and letting an earlier permissive match shadow a later `deny` would make the file's
 * meaning depend on its ordering in a way nobody would predict.
 */
export function evaluate(policy: Policy, ctx: PolicyContext): PolicyDecision[] {
  const decisions: PolicyDecision[] = [];
  const target = [...ctx.command, ...(ctx.args ?? [])];
  const flagArgs = hasArgumentFlags(ctx.flags);

  // Resolved at most once, and only if a rule actually asks: working out the subject can
  // mean reading a file off disk, which is not worth doing for a policy that never asks.
  let subject: CommandSubject | undefined = ctx.subject;
  const subjectOf = (): CommandSubject => (subject ??= resolveSubject(ctx));

  for (const rule of policy.rules) {
    if (!matchesPattern(rule.match, target, flagArgs)) continue;
    if (!conditionHolds(rule.when, ctx, subjectOf)) continue;

    if (rule.deny) {
      decisions.push({ rule, blocked: 'This command is denied by policy.' });
      continue;
    }

    if (rule.require === 'dry-run' && !ctx.dryRun && !hasRecentDryRun(ctx.command)) {
      decisions.push({ rule, blocked: 'Policy requires a dry run of this exact command first.' });
      continue;
    }

    if (rule.require === 'human' && !ctx.interactive) {
      decisions.push({ rule, blocked: 'Policy requires a human at the terminal.' });
      continue;
    }

    if (rule.require === 'confirm') {
      if (!ctx.interactive) {
        decisions.push({
          rule,
          blocked: 'Policy requires confirmation, and there is no terminal to ask.',
        });
        continue;
      }
      decisions.push({ rule, forceConfirm: true });
    }
  }

  return decisions;
}

/**
 * Does a rule's `when` clause hold for this invocation?
 *
 * The bias is towards firing. A condition narrows a rule, and a condition that cannot be
 * evaluated — SQL in a file that could not be read, say — must not be the thing that
 * quietly widens the gap the rule was written to close.
 */
function conditionHolds(
  when: RuleCondition | undefined,
  ctx: PolicyContext,
  subjectOf: () => CommandSubject,
): boolean {
  if (!when) return true;

  if (when.flag) {
    const names = Array.isArray(when.flag) ? when.flag : [when.flag];
    const flags = ctx.flags ?? {};
    const present = names.some((name) => flags[name] !== undefined && flags[name] !== false);
    if (!present) return false;
  }

  if (when.sql) {
    const { sql } = subjectOf();
    if (sql === 'none') return false;
    // "unknown" means the command runs SQL nobody here could read. That is a write as far
    // as a rule is concerned.
    if (when.sql === 'write') return sql === 'write' || sql === 'unknown';
    return sql === 'read';
  }

  return true;
}

/* ──────────────────── what the command would actually do ──────────────────── */

/**
 * Facts about an invocation that rules can ask about, and that `dv policy test` reports.
 *
 * Kept next to the rules rather than inside each command because both the enforcement
 * path and the "what would happen" path must derive them the same way. They used to
 * differ, and a test that answered "Allowed" for a command that was then refused is
 * worse than having no test at all — it is a green light with no engine behind it.
 */
export interface CommandSubject {
  /**
   * Whether this command runs SQL, and of what kind. "none" for commands that run no
   * SQL, "unknown" when it runs SQL that could not be read here.
   */
  sql: 'read' | 'write' | 'none' | 'unknown';
  /** The statement itself, when it could be read. */
  statement?: string;
  /** Where it came from, for the report: "--file migration.sql" or "the command line". */
  statementSource?: string;
  /** Why the kind is unknown, when it is. */
  note?: string;
}

/** The `dv db` verbs that run arbitrary SQL. Mirrors the shape `dv db` dispatches on. */
const SQL_VERBS = new Set(['query', 'sql', 'run']);

export function resolveSubject(ctx: PolicyContext): CommandSubject {
  const [name, verb] = ctx.command;
  if (name?.toLowerCase() !== 'db' || !verb || !SQL_VERBS.has(verb.toLowerCase())) {
    return { sql: 'none' };
  }

  // Exactly how `dv db query` assembles its statement: the words after the verb plus any
  // positionals, unless --file was given, in which case the file is the statement.
  const flags = ctx.flags ?? {};
  const fileFlag = flags.file ?? flags.f;
  const file = typeof fileFlag === 'string' ? fileFlag : undefined;

  if (fileFlag !== undefined && !file) {
    return { sql: 'unknown', note: '--file was given without a readable value.' };
  }

  let statement: string;
  let statementSource: string;
  if (file) {
    statementSource = `--file ${file}`;
    try {
      statement = readFileSync(file, 'utf8');
    } catch (err) {
      return {
        sql: 'unknown',
        statementSource,
        note: `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    statement = [...ctx.command.slice(2), ...(ctx.args ?? [])].join(' ');
    statementSource = 'the command line';
    if (!statement.trim()) return { sql: 'none' };
  }

  return { sql: isReadOnly(statement) ? 'read' : 'write', statement, statementSource };
}

/* ─────────────────────────── the whole picture ─────────────────────────── */

/**
 * A confirmation the command asks for by itself, policy aside.
 *
 * `dv db query` prompts before a write whether or not a rule says so, and an unattended
 * run of one is refused. Leaving these out of `dv policy test` is what made it disagree
 * with reality: the rules allowed the command, the command then declined to run it, and
 * the report had said "Allowed".
 */
export interface IntrinsicPrompt {
  question: string;
  why: string;
  /** Whether `--yes` answers it — true for an ordinary prompt, false under a policy rule. */
  satisfiedByYes: boolean;
}

export interface Assessment {
  /** The words this was evaluated against, for display. */
  command: string[];
  decisions: PolicyDecision[];
  prompts: IntrinsicPrompt[];
  subject: CommandSubject;
  /** Nothing will happen: a rule refuses, or a confirmation cannot be answered. */
  blocked: boolean;
  /** It can proceed, but a person has to say so first. */
  needsConfirmation: boolean;
}

export interface AssessInput {
  command: string[];
  args?: string[];
  flags?: Flags;
  dryRun: boolean;
  interactive: boolean;
}

/**
 * Everything standing between this invocation and the thing it would do.
 *
 * The single place both `dv policy test` and the enforcement path in `dv` itself get
 * their answer from, so the two cannot drift apart again.
 */
export function assess(input: AssessInput): Assessment {
  const ctx: PolicyContext = {
    command: input.command,
    args: input.args,
    flags: input.flags,
    dryRun: input.dryRun,
    interactive: input.interactive,
  };

  const decisions = evaluate(loadPolicy(), ctx);
  const subject = ctx.subject ?? resolveSubject(ctx);
  const forceConfirm = decisions.some((d) => d.forceConfirm);
  const assumeYes = ctx.flags?.yes === true || ctx.flags?.y === true;

  const prompts: IntrinsicPrompt[] = [];
  if (subject.sql === 'write' || subject.sql === 'unknown') {
    prompts.push({
      question: 'Run it?',
      why:
        subject.sql === 'write'
          ? 'The statement modifies the database.'
          : `The statement could not be read, so it is treated as a write. ${subject.note ?? ''}`.trim(),
      satisfiedByYes: !forceConfirm,
    });
  }

  // A prompt nobody can answer stops the command just as firmly as a rule does. Under
  // --dry-run nothing is written either way, so it is not counted as blocked.
  const unanswerable =
    !input.dryRun &&
    prompts.some((p) => (p.satisfiedByYes ? !assumeYes && !input.interactive : !input.interactive));

  return {
    command: [...input.command, ...(input.args ?? [])],
    decisions,
    prompts,
    subject,
    blocked: decisions.some((d) => d.blocked) || unanswerable,
    needsConfirmation: forceConfirm || prompts.length > 0,
  };
}

/* ─────────────────────── dry-run receipts ─────────────────────── */

/**
 * "Requires a dry run first" only means something if the earlier dry run is remembered.
 *
 * A receipt is recorded when a command runs under `--dry-run`, and it satisfies the rule
 * for a short window afterwards. The window is deliberately short: the point of the rule
 * is that you looked at the plan *just now*, and a receipt from last Tuesday is not
 * evidence of that.
 */
const RECEIPT_TTL_MS = 30 * 60 * 1000;

function receiptsPath(): string {
  return join(dvHome(), 'dry-run-receipts.json');
}

function signature(command: string[]): string {
  return command.map((w) => w.toLowerCase()).join(' ');
}

function readReceipts(): Record<string, number> {
  const path = receiptsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export function recordDryRun(command: string[]): void {
  const home = dvHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });

  const now = Date.now();
  const receipts = readReceipts();
  // Expired entries are dropped while writing, so the file cannot grow without bound.
  for (const [key, at] of Object.entries(receipts)) {
    if (now - at > RECEIPT_TTL_MS) delete receipts[key];
  }
  receipts[signature(command)] = now;
  writeFileSync(receiptsPath(), JSON.stringify(receipts), { mode: 0o600 });
}

export function hasRecentDryRun(command: string[]): boolean {
  const at = readReceipts()[signature(command)];
  return typeof at === 'number' && Date.now() - at <= RECEIPT_TTL_MS;
}
