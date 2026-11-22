/**
 * `dv ask "..."`
 *
 * Ask in words. dv works it out and tells you the answer.
 *
 * The screen shows one line while it works and the answer when it is done. Nothing else —
 * no command log, no captured output, no count of steps taken.
 *
 * That is a deliberate reversal of the first version, which printed every command and its
 * full output on the grounds that an answer you cannot check is a claim rather than a
 * result. The reasoning was sound and the conclusion was wrong: a wall of intermediate
 * output does not make an answer checkable, it makes the answer hard to find. The working
 * is still there for when you actually want it, behind `--verbose`, which is when
 * something looks wrong — and that is the only time anyone reads it.
 */

import { bool, str, type ParsedArgs } from '../cli/args.js';
import { CancelledError } from '../cli/errors.js';
import { c, confirm, info, out, success, warn } from '../cli/ui.js';
import { Spinner } from '../cli/spinner.js';
import { looksLikeMarkdown, renderMarkdown } from '../cli/markdown.js';
import { availableCommands } from '../ai/catalog.js';
import { runAgent, type Step } from '../ai/agent.js';
import { planFor, type Plan } from '../ai/planner.js';
import { DEFAULT_MODEL, health, requireOllama } from '../ai/ollama.js';

export async function askCommand(args: ParsedArgs): Promise<void> {
  const question = questionFrom(args);

  if (!question) {
    printHelp();
    return;
  }

  const model = str(args.flags, 'model') ?? DEFAULT_MODEL;
  const verbose = bool(args.flags, 'verbose', 'v');

  // Without a terminal there is nobody to ask, so nothing that changes anything is even
  // offered. Refusing at the prompt would be too late — the model would have spent the
  // run planning something it was never going to be allowed to do.
  const readsOnly = !process.stdin.isTTY;

  const status = await health(model);
  requireOllama(status, model);

  out('');

  const spinner = new Spinner();
  spinner.start('Understanding question…');

  // Whether a command has actually run yet. Distinguishes "still working out what to do"
  // from "adjusting after something came back", which read identically before and made the
  // first turn describe a retry that had not happened.
  let hasRun = false;

  let result;
  try {
    result = await runAgent(question, {
      readsOnly,
      model,
      events: {
        // Each phase replaces the last on the same line, so a glance shows where it is
        // rather than where it has been.
        onThinking: () => spinner.update(hasRun ? 'Deciding what to check next…' : 'Understanding question…'),
        onRun: (plan) => {
          hasRun = true;
          spinner.update(labelFor(plan));
        },
        // A rejected reply before anything has run is still the question being worked out
        // — saying "trying another way" there names a second attempt at something that
        // never had a first, which is the state this used to report on the opening turn.
        onNote: () => spinner.update(hasRun ? 'Adjusting…' : 'Understanding question…'),

        // The spinner has to come down before the prompt: a question printed into a line
        // that is being redrawn four times a second is unreadable, and the answer is typed
        // over the top of it.
        onConfirm: async (plan) => {
          spinner.stop();
          const approved = await confirmWrite(plan);
          spinner.start('Working…');
          return approved;
        },
      },
    });
  } finally {
    spinner.stop();
  }

  const evidence = lastSuccessful(result.steps);
  const rows = evidence ? dataLines(evidence.output) : [];

  // A command that states its own conclusion beats the model's paraphrase of it.
  //
  // `dv gh repo stats` ends with "college-lms has the most commits (15)" — a sentence
  // built from data it counted. The model, summarising the same table, produced
  // "abhishekvardanbotta/college-lms" on one run and dropped the number entirely on the
  // next. Between a fact and a paraphrase of a fact, take the fact.
  // A decline is a complete outcome, not a failed run: no headline, no rows, no refusal
  // explanation. The user already knows what they turned down.
  if (result.declined) {
    info(`  ${result.answer}`);
    return;
  }

  // Content only when the command says so. Deciding from the answer's shape meant a long
  // model reply turned a table into a "document" and printed rows with nothing above them.
  const isContent = evidence?.plan.command.rendersContent === true;
  const headline = isContent ? undefined : summaryFrom(evidence) ?? asHeadline(result.answer);

  if (!isContent) {
    // Always something. Falling through to bare rows when the model rambled left the run
    // looking like it had produced output but no answer.
    // "I could not determine…" under a green tick reads as an accomplished refusal. The
    // marker has to agree with the sentence.
    const conclusion = headline ?? firstSentence(result.answer);
    if (isRefusal(conclusion)) warn(conclusion);
    else success(conclusion);

    // The numbers behind it, from real output. Not a transcript — just what was measured.
    if (rows.length > 0 && !verbose) {
      out('');
      for (const line of rows.slice(0, ROWS_SHOWN)) out(`  ${c.dim(line)}`);
      if (rows.length > ROWS_SHOWN) out(`  ${c.dim(`… ${rows.length - ROWS_SHOWN} more`)}`);
    }
  } else {
    // The answer *is* the output. Asked for a file, the model returns the file — and
    // printing that as a ✓ headline and then again underneath gave fifty lines of
    // duplicate for a README. Here the real output is the whole answer: shown once.
    //
    // Rendered when it is markdown, which a README always is. Raw markdown asks you to
    // read the punctuation and picture the formatting; a terminal can just do the
    // headings and the emphasis.
    const raw = evidence!.output;
    const body = looksLikeMarkdown(raw)
      ? renderMarkdown(raw, { indent: 2 })
      : rows.map((line) => `  ${line}`);

    for (const line of body.slice(0, CONTENT_SHOWN)) out(line);
    if (body.length > CONTENT_SHOWN) {
      out('');
      info(c.dim(`  … ${body.length - CONTENT_SHOWN} more lines — ${evidence!.plan.line}`));
    }
  }

  // Without a terminal, writes were never offered — so a refusal here may not mean dv
  // cannot do it, only that there was nobody to ask. Saying so beats letting a piped run
  // report a capability gap that does not exist.
  if (readsOnly && isRefusal(headline ?? result.answer)) {
    await explainReadsOnly(question);
  }

  // A refusal is a refusal whatever was rendered alongside it. Tying this to the
  // no-output branch meant a question that gathered a table and still could not be
  // answered — the common shape — never got the hint.


  // The whole working, on request. After the answer rather than before it: even when you
  // want the detail you want the conclusion first.
  if (verbose) {
    out('');
    for (const step of result.steps) renderStep(step);
  }
}

/**
 * Whether the answer is the conclusion step admitting it could not answer.
 *
 * Matched on the opening the prompt asks for, rather than by searching for negation —
 * "no issues found" is an answer, and treating every sentence containing "not" as a
 * failure would fire this on half the successful runs.
 */
function isRefusal(answer: string): boolean {
  return /^\s*I could not determine/i.test(answer);
}

/**
 * Ask before changing anything.
 *
 * Shows the exact command, then what it will do in plain words. "Run this?" on its own
 * asks you to decode a command line under time pressure; naming the effect is what makes
 * the answer considered rather than reflexive.
 *
 * A high-danger command is worded so that agreeing to replace production does not look
 * like agreeing to open an issue.
 */
async function confirmWrite(plan: Plan): Promise<boolean> {
  const high = plan.command.danger === 'high';

  out('');
  out(`  ${high ? c.yellow('This changes what is live:') : c.dim('This changes something:')}`);
  out(`  ${c.bold(plan.line)}`);
  if (plan.command.effect) out(`  ${c.dim(`It will ${plan.command.effect}.`)}`);
  out('');

  // `false` for the default, always. A model chose this command, so the decision has to be
  // an active one — and `--yes` is deliberately not consulted here, because it was written
  // for commands you typed yourself.
  const approved = await confirm(high ? '  Go ahead?' : '  Run it?', false);
  out('');
  return approved;
}

/**
 * Say when the limit was the terminal rather than the tool.
 *
 * Re-plans once with writes allowed, purely to find out whether one would have matched.
 * Only reached on a run that already failed, so the extra call costs nothing anybody was
 * waiting on.
 */
async function explainReadsOnly(question: string): Promise<void> {
  try {
    const candidates = await planFor(question, { attempts: 1 });
    const write = candidates.find((candidate) => candidate.command.mutates);
    if (!write) return;

    out('');
    info('  dv can do that, but it changes something and there is no terminal to ask:');
    info(`  ${c.bold(write.line)}`);
    out('');
    info(c.dim('  Run dv ask from a terminal and it will confirm before doing it.'));
  } catch {
    // A courtesy on an already-failed run; never turn a clean refusal into an error.
  }
}

/**
 * The first sentence of a rambling answer.
 *
 * A fallback for when the model returns a paragraph where a conclusion belongs. Better a
 * truncated sentence above the evidence than no answer at all, which is what showing the
 * rows alone amounted to.
 */
function firstSentence(answer: string): string {
  const text = answer.trim().split('\n')[0] ?? answer.trim();
  const stop = text.indexOf('. ');
  const sentence = stop > 20 ? text.slice(0, stop + 1) : text;
  return sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence;
}

/** Supporting rows under a headline — a glance, not a document. */
const ROWS_SHOWN = 8;

/** Lines when the output *is* the answer, as a file's contents are. */
const CONTENT_SHOWN = 40;

/**
 * The model's answer, if it is actually a headline.
 *
 * Returns nothing for anything long or multi-line, because that is not a conclusion — it
 * is the model handing back the content it was shown. The real output says the same thing
 * without a paraphrase in the way.
 */
function asHeadline(answer: string): string | undefined {
  const text = answer.trim();
  if (!text) return undefined;
  if (text.includes('\n')) return undefined;
  if (text.length > 220) return undefined;
  return text;
}

/** The last command that actually worked — the one holding the evidence. */
function lastSuccessful(steps: Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step && step.exitCode === 0 && step.output.trim()) return step;
  }
  return undefined;
}

/**
 * A conclusion the command drew itself.
 *
 * dv marks these with a tick, and where one exists it is worth more than anything a model
 * can say about the same data — it was computed rather than read.
 */
function summaryFrom(step: Step | undefined): string | undefined {
  if (!step) return undefined;

  for (const line of step.output.split('\n')) {
    const text = line.trim();
    if (text.startsWith('✓') && text.length > 3) return text.slice(1).trim();
  }
  return undefined;
}

/**
 * The rows of a command's output, without its own chrome.
 *
 * Drops the tick line — already used as the headline — and anything ending in an ellipsis,
 * which is a progress message rather than a result.
 */
function dataLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const text = line.trim();
      if (!text) return false;
      if (text.startsWith('✓') || text.startsWith('✗') || text.startsWith('!')) return false;
      if (text.endsWith('…')) return false;
      return true;
    });
}

/**
 * What to say while a command runs.
 *
 * Named after the thing being fetched, using the arguments the command was actually given.
 * "Reading README.md…" is what a person would say they were doing; "Checking GitHub…" is
 * a category, and `dv gh file read college-lms README.md` is a command line. The status
 * line is neither of those — it is a sentence about the current moment, so it should read
 * like one.
 */
function labelFor(plan: Plan): string {
  const [first, second] = plan.args;
  const id = plan.command.id;

  switch (id) {
    case 'doctor':
      return 'Checking everything…';
    case 'auth status':
      return 'Checking connections…';
    case 'journal':
      return 'Reading the journal…';

    case 'gh repo list':
      return 'Listing repositories…';
    case 'gh repo stats':
      return 'Counting commits…';
    case 'gh repo view':
      return first ? `Looking at ${first}…` : 'Looking at the repository…';
    case 'gh file read':
      return second ? `Reading ${second}…` : 'Reading the file…';
    case 'gh file ls':
      return first ? `Listing files in ${first}…` : 'Listing files…';
    case 'gh issue list':
      return 'Checking issues…';
    case 'gh pr list':
      return 'Checking pull requests…';
    case 'gh run list':
      return 'Checking CI…';
    case 'gh commit list':
      return first ? `Reading commits in ${first}…` : 'Reading commits…';

    case 'vercel project list':
      return 'Listing projects…';
    case 'vercel deploy list':
      return 'Checking deployments…';
    case 'vercel deploy logs':
      return 'Fetching the build log…';
    case 'vercel env list':
    case 'vercel env diff':
      return 'Checking environment variables…';
    case 'vercel domain list':
      return 'Checking domains…';
    case 'vercel dns list':
      return first ? `Checking DNS for ${first}…` : 'Checking DNS…';

    case 'db tables':
      return 'Listing tables…';
    case 'db describe':
      return first ? `Describing ${first}…` : 'Describing the table…';
    case 'db count':
      return first ? `Counting rows in ${first}…` : 'Counting rows…';
    case 'db projects':
      return 'Listing databases…';

    case 'git status':
      return 'Checking this folder…';
    case 'git log':
      return 'Reading recent commits…';
    case 'git diff':
      return 'Checking what changed…';

    default:
      // A command added to the catalogue without a label here still gets something honest
      // rather than a stale phrase from a neighbouring case.
      return `Running ${id}…`;
  }
}

/** One command and what it printed, for `--verbose`. */
function renderStep(step: Step): void {
  out(`  ${c.dim(`$ ${step.plan.line}`)}`);
  for (const line of step.output.trimEnd().split('\n')) {
    if (line.trim()) out(`  ${c.dim(c.gray(line))}`);
  }
  out('');
}

/**
 * Recover the question, wherever the parser put it.
 *
 * dv's argument parser gives any `--flag` the next non-dash token as its value, which is
 * right for `--project my-app` and wrong here: `dv ask --plan "is anything broken"`
 * assigns the whole question to `--plan` and leaves nothing to ask about.
 *
 * Rather than special-case the parser — every other command depends on that behaviour —
 * this takes the question back from whichever boolean flag swallowed it. The flag is
 * still set, because presence is what makes it true, so both halves survive.
 */
function questionFrom(args: ParsedArgs): string {
  const words = [...args.command.slice(1), ...args.positional];

  // A boolean flag holding a sentence is a swallowed question, not a value. `--model`
  // is excluded: it genuinely takes one.
  for (const name of ['plan', 'dry-run', 'write', 'w']) {
    const value = args.flags[name];
    if (typeof value === 'string' && value.trim()) words.push(value);
  }

  return words.join(' ').trim();
}

function printHelp(): void {
  out('');
  out(`  ${c.bold('dv ask')} — ask in words, get the command run.`);
  out('');
  out(`  ${c.dim('dv ask "is anything broken"')}`);
  out(`  ${c.dim('dv ask "which repo has the most commits"')}`);
  out(`  ${c.dim('dv ask "why did the last deploy fail"')}`);
  out(`  ${c.dim('dv ask "how many rows in students"')}`);
  out('');
  out(`  ${c.dim('--verbose  show the commands it ran and what they printed')}`);
  out(`  ${c.dim('--model    which local model to use')}`);
  out('');
  out(`  ${c.dim(`It runs commands until it can answer. Anything that changes something asks first.`)}`);
  out('');
  info(c.dim('  Runs locally through Ollama. Your question never leaves the machine.'));
}

/**
 * `dv ai` — is the local model set up?
 *
 * Separate from `dv doctor` because it is about a piece of optional local infrastructure
 * rather than about your accounts, and because "why is ask not working" deserves a direct
 * answer rather than a line buried in a longer report.
 */
export async function aiCommand(args: ParsedArgs): Promise<void> {
  const model = str(args.flags, 'model') ?? DEFAULT_MODEL;
  const status = await health(model);

  out('');
  out(`  ${c.dim('host  ')} ${process.env.OLLAMA_HOST ?? 'http://localhost:11434'}`);
  out(`  ${c.dim('model ')} ${model}`);
  out('');

  if (!status.reachable) {
    out(`  ${c.red('✗')} Not running.`);
    out('');
    info(c.dim('  Install from https://ollama.com, then: ollama serve'));
    process.exitCode = 1;
    return;
  }

  out(`  ${c.green('✓')} Ollama is running.`);

  if (!status.hasModel) {
    out(`  ${c.red('✗')} "${model}" is not pulled.`);
    out('');
    info(c.dim(`  ollama pull ${model}`));
    if (status.models.length) info(c.dim(`  You have: ${status.models.join(', ')}`));
    process.exitCode = 1;
    return;
  }

  out(`  ${c.green('✓')} "${model}" is ready.`);
  out('');
  success('dv ask is available.');
  info(c.dim('  dv ask "is anything broken"'));
}
