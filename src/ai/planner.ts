/**
 * Turning a question into a command.
 *
 * The model's only job is to choose an id from the catalogue and fill in named arguments.
 * Everything it returns is validated against that catalogue before anything runs, so a
 * hallucinated command or an invented flag is a rejected plan rather than an executed one.
 *
 * That validation is not belt-and-braces — it is the design. A 3B model asked to write a
 * shell command will occasionally write a plausible one that does not exist, and
 * occasionally one that exists and does something else. Constraining it to a choice makes
 * both failures visible instead of dangerous.
 */

import { CliError, EXIT } from '../cli/errors.js';
import {
  availableCommands,
  describeCatalog,
  findCommand,
  type AiCommand,
} from './catalog.js';
import { extractJson, generate } from './ollama.js';

export interface Plan {
  command: AiCommand;
  /** Positional arguments, in the order the command expects. */
  args: string[];
  /** Flags, as `--name value`. */
  flags: Record<string, string>;
  /** The model's one-line reason. Shown so a wrong choice is obvious before it runs. */
  reason: string;
  /** The full command line, for display and for the confirmation. */
  line: string;
  /** Required parameters the question did not supply. Asked for before running. */
  missing: string[];
}

const SYSTEM = `You match a developer's question to commands from a fixed list.

Return up to three candidates, best first. Returning two or three is normal and useful —
several commands often touch the same subject, and the person asking can tell them apart
far better than you can. Return one only when nothing else is close.

Rules:
- Every id must come from the list. Never invent one.
- Fill only the parameters that command lists, using values from the question.
- Never put a parameter's own name as its value, and never copy words from this template.
- If the question supplies no value for a required parameter, still return the command —
  it will be asked for.

Reply with JSON only:
{"candidates": [{"id": "<from the list>", "params": {}, "reason": "<why, in your words>"}]}

Worked example. Given the list entries:
  - git log (limit?): Commits in the folder you are standing in.
  - gh commit list (repo): Commits on a named repository on GitHub.
and the question "latest commit in college-lms on github", a good reply is:
  {"candidates": [
    {"id": "gh commit list", "params": {"repo": "college-lms"}, "reason": "commits on that GitHub repo"},
    {"id": "git log", "params": {"limit": "1"}, "reason": "if you meant this folder"}
  ]}

If genuinely nothing in the list answers the question, return an empty list:
  {"candidates": []}
For "which of my repos has the most commits" that is the right answer, because no command
ranks repositories.`;

/**
 * Ask the model which command answers the question.
 *
 * Retries on a rejected plan, feeding the reason back — a small model very often recovers
 * on a second attempt when told what was wrong with the first, and the failure mode is
 * almost always a bad *sample* rather than a bad prompt.
 */
export async function planFor(
  question: string,
  options: { readsOnly?: boolean; attempts?: number } = {},
): Promise<Plan[]> {
  const commands = availableCommands(options);
  const catalog = describeCatalog(commands);
  const attempts = options.attempts ?? 3;

  let lastProblem = '';

  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = [
      `Commands:\n${catalog}`,
      `Question: ${question}`,
      if_(lastProblem, `Your previous answer was rejected: ${lastProblem}. Try again.`),
      'Reply with the JSON now.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const raw = await generate({
      system: SYSTEM,
      prompt,
      json: true,
      // Nudged up on a retry so the model does not simply reproduce the rejected answer.
      temperature: 0.1 + attempt * 0.2,
    });

    try {
      const plans = validateAll(extractJson(raw), commands, !options.readsOnly);
      if (plans.length > 0) return plans;
      lastProblem = 'no command was returned';
    } catch (err) {
      if (err instanceof CliError) throw err;
      lastProblem = err instanceof Error ? err.message : String(err);
    }
  }

  throw new CliError(
    'Nothing in dv answers that.',
    EXIT.notFound,
    'Try naming the service and the thing — "commits in college-lms on github", '
      + '"vercel deploys", "rows in students".',
  );
}

/**
 * Validate a shortlist, keeping whatever survives.
 *
 * One bad candidate does not sink the reply. A small model will often get its first pick
 * wrong and its second right, and discarding the whole answer over the first would throw
 * away the useful half.
 */
function validateAll(raw: unknown, commands: AiCommand[], allowWrites: boolean): Plan[] {
  if (raw === null || typeof raw !== 'object') throw new Error('not an object');

  const body = raw as Record<string, unknown>;
  const list = Array.isArray(body.candidates)
    ? body.candidates
    // Tolerated because the model sometimes answers in the older single-object shape,
    // and rejecting a correct answer over its wrapper would be pedantry.
    : body.id
      ? [body]
      : [];

  const plans: Plan[] = [];
  const seen = new Set<string>();

  for (const candidate of list.slice(0, 3)) {
    try {
      const plan = validate(candidate, commands, allowWrites);
      if (seen.has(plan.line)) continue;
      seen.add(plan.line);
      plans.push(plan);
    } catch {
      // Skip this one and keep the rest.
    }
  }
  return plans;
}

function if_(condition: string, text: string): string {
  return condition ? text : '';
}

/** Check a model's answer against the catalogue, and build the command line. */
function validate(raw: unknown, commands: AiCommand[], allowWrites: boolean): Plan {
  if (raw === null || typeof raw !== 'object') throw new Error('not an object');

  const body = raw as Record<string, unknown>;
  const id = String(body.id ?? '').trim().toLowerCase();

  if (!id || id === 'none') {
    throw new CliError(
      'No dv command answers that.',
      EXIT.notFound,
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason
        : 'Try naming a service — GitHub, Vercel, the database.',
    );
  }

  const command = findCommand(id);
  if (!command) throw new Error(`"${id}" is not one of the listed commands`);

  // A write can be reached only when the caller asked for that. Without this the model
  // could route a read question to a mutating command and be obeyed.
  if (command.mutates && !allowWrites) {
    throw new Error(`"${id}" changes things and writes are not enabled`);
  }
  if (!commands.some((c) => c.id === command.id)) {
    throw new Error(`"${id}" is not available`);
  }

  const supplied = (body.params ?? {}) as Record<string, unknown>;
  const args: string[] = [];
  const flags: Record<string, string> = {};
  const missing: string[] = [];

  for (const param of command.params ?? []) {
    const value = supplied[param.name];
    let text = value == null ? '' : String(value).trim();

    // A small model routinely answers with the parameter's own name — `{"table":
    // "table"}` — which produces a command that runs and looks at the wrong thing.
    // Treated as absent, so the required check below asks for a real one.
    if (text.toLowerCase() === param.name.toLowerCase()) text = '';

    // The same failure wearing a placeholder: the model copies the angle brackets or the
    // description straight out of the template.
    if (/^<.*>$/.test(text) || text.toLowerCase() === param.describe.toLowerCase()) text = '';

    // A name the model assembled out of the question rather than found in it —
    // `{"repo": "my repo on github"}` from "latest commit in my github", or `"all"` from
    // "which repo has the most commits". Both produce a command that runs and reports on
    // something that does not exist, which reads exactly like a real answer.
    if (text && !looksLikeName(param.name, text)) text = '';

    const resolved = text || param.fallback || '';

    if (!resolved) {
      // Recorded rather than thrown. With a shortlist, a candidate missing a value is
      // still worth offering — the person picking it knows the repository name even when
      // the question did not spell it out.
      if (param.required) missing.push(param.name);
      continue;
    }

    // Anything with a shell metacharacter is refused rather than escaped. This value came
    // from a language model, and the only safe answer to "looks like a shell injection"
    // is not to run it.
    if (/[;&|`$><\n\r]/.test(resolved)) {
      throw new Error(`the value for ${param.name} contains characters that are not allowed`);
    }

    // Declaration order is argument order, so `gh file read <repo> <path>` arrives the
    // way dv expects rather than as a repo and a stray --path.
    if (param.positional) args.push(resolved);
    else flags[param.name] = resolved;
  }

  const parts = [
    ...command.id.split(' '),
    // Quoted like the flags are. Without this a repository called "my app" becomes two
    // arguments, and the command runs against something that does not exist.
    ...args.map(quote),
    ...Object.entries(flags).flatMap(([name, value]) =>
      value === 'true' ? [`--${name}`] : [`--${name}`, quote(value)],
    ),
  ];

  return {
    command,
    args,
    flags,
    missing,
    reason: cleanReason(body.reason),
    line: `dv ${parts.join(' ')}`,
  };
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * The model's stated reason, or nothing.
 *
 * A 3B model will sometimes copy the placeholder out of the prompt rather than write a
 * reason. Printing "one short sentence" under the command is worse than printing nothing
 * — it looks like the tool is broken, and it crowds out the line that matters.
 */
function cleanReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';

  const placeholders = [
    'one short sentence',
    'why, in your own words',
    'a short sentence',
    'reason',
  ];
  if (placeholders.includes(text.toLowerCase().replace(/^<|>$/g, ''))) return '';
  return text;
}

/**
 * Validate one action from the agent loop.
 *
 * The same check the shortlist uses, exposed under a name that says what the caller is
 * doing. Both paths must go through it — a second validator would be a second place for a
 * hallucinated command to slip past.
 */
export function planFrom(
  decision: unknown,
  commands: AiCommand[],
  allowWrites: boolean,
): Plan {
  return validate(decision, commands, allowWrites);
}

/// Exposed for tests.
///
/// [validate] is where every refusal happens, so it is the part worth testing directly —
/// reaching it through a live model would make the suite slow and non-deterministic for
/// no gain.
export const __testing = { validate };

/**
 * Names that identify a thing, as opposed to phrases describing one.
 *
 * Applied only to parameters that name something real — a repository, a project, a table.
 * A commit message or an issue title is prose and must not be held to this.
 */
const NAME_PARAMS = new Set(['repo', 'project', 'table', 'domain', 'id', 'path']);

/**
 * Words a model reaches for when it has not actually found a name.
 *
 * Each of these is a perfectly valid identifier in principle, which is why they have to be
 * listed rather than detected — nothing about the string "all" says it was invented.
 */
const NOT_A_NAME = new Set([
  'all', 'any', 'my', 'mine', 'me', 'this', 'that', 'it', 'the',
  'repo', 'repos', 'repository', 'project', 'projects', 'table', 'tables',
  'everything', 'latest', 'current', 'default', 'unknown', 'none', 'n/a',
]);

function looksLikeName(param: string, value: string): boolean {
  if (!NAME_PARAMS.has(param)) return true;

  // A real repository, project or table name has no spaces. A phrase does.
  if (!/^[A-Za-z0-9._\/@-]+$/.test(value)) return false;
  return !NOT_A_NAME.has(value.toLowerCase());
}
