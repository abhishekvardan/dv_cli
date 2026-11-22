/**
 * Working towards an answer, one command at a time.
 *
 * The difference from resolving a question to a single command is the whole point. "Which
 * repository has the most commits" is not any one dv command — it is `gh repo list`, then
 * a `gh commit list` per repository, then a comparison. No amount of better matching turns
 * that into one lookup, because the second step cannot be chosen until the first has run.
 *
 * So this is a loop: run something, read what came back, decide what to do next, stop when
 * the question is answerable. Three properties keep it honest:
 *
 *  - **Every command is shown as it runs**, with its real output. A wrong turn is visible
 *    while it happens rather than buried inside a confident summary.
 *  - **The model sees exactly what you see.** No hidden scratchpad, no separate machine
 *    format — if it misread something, you can see the thing it misread.
 *  - **It stops.** A step budget, and a rule that a repeated command ends the loop, because
 *    the characteristic failure of a small model in a loop is running the same thing
 *    forever while insisting progress is being made.
 */

import { runSelf, splitArgs } from '../cli/selfExec.js';
import { availableCommands, describeCatalog } from './catalog.js';
import { extractJson, generate } from './ollama.js';
import { planFrom, type Plan } from './planner.js';

export interface Step {
  plan: Plan;
  output: string;
  exitCode: number;
}

export interface AgentEvents {
  onThinking?: (step: number) => void;
  onRun?: (plan: Plan) => void;
  onOutput?: (text: string) => void;
  onNote?: (text: string) => void;

  /**
   * Asked before anything that changes something.
   *
   * Returning false is not an error — it is an answer, and the loop carries on with the
   * refusal recorded so the model can say what it did not do rather than pretending it did.
   */
  onConfirm?: (plan: Plan) => Promise<boolean>;
}

export interface AgentResult {
  answer: string;
  steps: Step[];
  /** True when the budget ran out before the model was satisfied. */
  exhausted: boolean;

  /** The write the user turned down, when that is why the run stopped. */
  declined?: Plan;
}

/** How many commands one question may cost. */
const MAX_STEPS = 6;

/**
 * How much of a command's output the model is shown.
 *
 * Enough to answer from, short enough that six of them still leave room for the question.
 * A repository listing is the long case, and its useful part — the names — is at the top,
 * so trimming the tail costs little.
 */
const OUTPUT_BUDGET = 1400;

const SYSTEM = `You act on a developer's request by running commands from a fixed list.

Most requests are questions — run commands, read the output, answer. Some are instructions
— run the command that carries them out.

Each turn, reply with exactly one of these:

  {"action": "run", "id": "<command id>", "params": {}, "why": "<what you expect to learn>"}
  {"action": "answer", "answer": "<the answer, in one or two sentences>"}

Rules:
- Every id must come from the list. Never invent one.
- Take parameter values from the question or from output you have already seen. Never
  invent a name, and never pass a phrase like "all" or "my repo" as a name.
- Some requests are instructions, not questions. "Redeploy the site", "commit this",
  "open an issue" ask you to DO something. For those, run the command that does it — do
  not go looking for a command that reports on it. Running the action is the answer.
- Run one command at a time. You will see its output before choosing the next.
- Answer only when the output in front of you actually contains the answer. A question
  about several things usually takes several commands: list them, then look at each.
- Do not run extra commands once you can answer, and do not stop while you cannot.
- If you cannot answer with these commands, say so in an "answer" — that is a real answer,
  not a failure.

Answer using only what the output actually said. Never state a number, name or status you
have not seen.`;

/**
 * Run the loop.
 *
 * The model is asked for one action at a time rather than a plan up front, because a plan
 * made before seeing any output is a guess — the whole reason this exists is that the
 * second step depends on the first.
 */
export async function runAgent(
  question: string,
  options: { readsOnly?: boolean; model?: string; events?: AgentEvents } = {},
): Promise<AgentResult> {
  const commands = availableCommands(options);
  const catalog = describeCatalog(commands);
  const events = options.events ?? {};

  const steps: Step[] = [];
  const ran = new Set<string>();
  let repeats = 0;

  // Turns that produced nothing — a rejected command, a missing value, a repeat.
  //
  // Counted separately from repeats and reset whenever something actually runs, because
  // the two mean different things: flailing *before* any data is honest searching, and
  // flailing *after* it means the model has what it needs and cannot tell.
  let unproductive = 0;

  /**
   * Whether to stop flailing.
   *
   * Once a command has succeeded, the data is in hand and further invalid turns are the
   * model failing to recognise that rather than searching for more. One is tolerated as a
   * stumble; a second means answer from what is there. Before anything has succeeded there
   * is nothing to answer from, so it keeps trying until the step budget runs out.
   */
  const shouldStop = () => steps.some((step) => step.exitCode === 0) && unproductive > 1;

  for (let n = 0; n < MAX_STEPS; n++) {
    events.onThinking?.(n + 1);

    const raw = await generate({
      system: SYSTEM,
      prompt: buildPrompt(question, catalog, steps),
      json: true,
      model: options.model,
      // Climbs slightly as the loop goes on. A model that has repeated itself twice needs
      // to be nudged off the answer it keeps giving.
      temperature: 0.1 + n * 0.1,
    });

    let decision: Record<string, unknown>;
    try {
      decision = extractJson(raw) as Record<string, unknown>;
    } catch {
      // An unreadable turn is not fatal — the next one usually parses.
      events.onNote?.('could not read that reply, trying again');
      continue;
    }

    if (decision.action === 'answer' || typeof decision.answer === 'string') {
      const answer = String(decision.answer ?? '').trim();
      if (answer) return { answer, steps, exhausted: false };
      events.onNote?.('empty answer, trying again');
      continue;
    }

    let plan: Plan;
    try {
      plan = planFrom(decision, commands, !options.readsOnly);
    } catch (err) {
      // Fed back rather than thrown. Telling the model what was wrong with its choice is
      // the cheapest way to get a better one, and a rejected command has cost nothing.
      const why = err instanceof Error ? err.message : String(err);
      steps.push({
        plan: rejectedPlan(decision),
        // The valid ids come back with the rejection. A model that answered with a list
        // position rather than an id cannot fix that from "1 is invalid" alone.
        output: `rejected: ${why}. Use one of these exact ids: ${commands.map((command) => command.id).join(', ')}`,
        exitCode: 1,
      });
      // Not surfaced. The model is told what was wrong and usually recovers on the next
      // turn; showing the reader a raw rejection is noise about a step that never ran.
      unproductive++;
      if (shouldStop()) break;
      events.onNote?.('retrying');
      continue;
    }

    if (plan.missing.length > 0) {
      steps.push({
        plan,
        output: `not run: needs ${plan.missing.join(', ')}, which you must take from the question or from earlier output`,
        exitCode: 1,
      });
      unproductive++;
      if (shouldStop()) break;
      continue;
    }

    // A repeat teaches the model nothing it does not already have, so it is fed back as an
    // observation rather than run. Ending the loop here was worse: it abandoned on the
    // second turn a question that genuinely needed four.
    if (ran.has(plan.line)) {
      repeats++;

      // A repeat after something already worked means the model has its data and is
      // stalling rather than searching — so conclude instead of spending another two
      // turns on it. When nothing has succeeded yet a nudge is still worth one attempt,
      // because there the repeat is the model casting about rather than dithering.
      const gotSomething = steps.some((step) => step.exitCode === 0);
      if (gotSomething || repeats > 1) {
        events.onNote?.(gotSomething ? 'it already has the answer' : 'going in circles');
        return { ...(await concludeFrom(question, steps, options.model)), steps, exhausted: !gotSomething };
      }
      steps.push({
        plan,
        output: 'already run — its output is above. Run something different, or answer.',
        exitCode: 1,
      });
      unproductive++;
      if (shouldStop()) break;
      events.onNote?.('already ran that — asking for a different step');
      continue;
    }
    ran.add(plan.line);

    // Confirmed here rather than up front, because until this moment nobody — including
    // the model — knew which command it would be. A blanket "allow writes?" asked before
    // the run is consent given without the information that makes it meaningful.
    if (plan.command.mutates) {
      const approved = (await events.onConfirm?.(plan)) ?? false;
      if (!approved) {
        // Declining ends the run. Carrying on to hunt for a read that might satisfy the
        // request treats "no" as an obstacle rather than an answer — and it produced
        // exactly the circling the loop is supposed to avoid, finishing on a refusal when
        // the user had already said what they wanted.
        return { answer: 'Cancelled. Nothing was changed.', steps, exhausted: false, declined: plan };
      }
    }

    events.onRun?.(plan);

    // `--yes` because the user was already asked, by name, with the effect spelled out.
    // Without it the child command prompts a second time into a subprocess that has no
    // terminal, answers itself "no", prints "Not redeployed" and exits 0 — so an approved
    // write silently did nothing and the loop read the refusal as a successful run.
    const line = plan.command.mutates ? `${plan.line} --yes` : plan.line;
    const { output, exitCode } = await capture(line);
    events.onOutput?.(output);

    steps.push({ plan, output, exitCode });
    if (exitCode === 0) unproductive = 0;
  }

  // Out of budget. Answering from what was gathered beats reporting nothing, provided it
  // is clear the loop was cut short.
  return { ...(await concludeFrom(question, steps, options.model)), steps, exhausted: true };
}

/** One last pass: answer from whatever was collected. */
async function concludeFrom(
  question: string,
  steps: Step[],
  model?: string,
): Promise<{ answer: string }> {
  if (steps.length === 0) return { answer: 'I could not work out how to answer that.' };

  const raw = await generate({
    system:
      'Answer the question using ONLY the command output below.\n\n' +
      'First check whether the output actually contains what was asked. A list of ' +
      'repositories does not say how many commits each has. A list of deployments does ' +
      'not say why one failed. Recognising that gap is the job.\n\n' +
      'If the answer is not in the output, reply in exactly this form:\n' +
      '  I could not determine <what was asked>. The output shows <what it does show>, ' +
      'but not <what is missing>.\n\n' +
      'Otherwise answer in one or two sentences, quoting the value you found. Never state ' +
      'a number, name, date or status that does not appear above.',
    prompt: `${transcript(steps)}\n\nQuestion: ${question}\n\nAnswer:`,
    model,
    temperature: 0.2,
  });

  return { answer: raw.trim() || 'I gathered the output above but could not summarise it.' };
}

function buildPrompt(question: string, catalog: string, steps: Step[]): string {
  const parts = [`Commands:\n${catalog}`, `Question: ${question}`];

  if (steps.length > 0) {
    parts.push(`Commands already run, and what they printed:\n${transcript(steps)}`);
    parts.push(
      // Imperative, never interrogative. An earlier version opened with "Does that output
      // contain what was asked?" and the model dutifully replied "No, it only lists
      // repositories" — answering the prompt instead of acting on it.
      'If the output above answers the question, reply with the answer.\n'
        + 'If it does not, do NOT say so — run the next command instead. Output that only '
        + 'names things you need details about means your next step is the command that '
        + 'gets those details, for one of those names.\n'
        + 'Never re-run a command listed above.',
    );
  } else {
    parts.push('Decide the first action.');
  }
  return parts.join('\n\n');
}

function transcript(steps: Step[]): string {
  return steps
    .map((step) => `$ ${step.plan.line}\n${trim(step.output)}`)
    .join('\n\n');
}

function trim(text: string): string {
  const clean = text.trim();
  if (clean.length <= OUTPUT_BUDGET) return clean || '(no output)';
  return `${clean.slice(0, OUTPUT_BUDGET)}\n… (${clean.length - OUTPUT_BUDGET} more characters)`;
}

/** A stand-in so a rejected choice still appears in the transcript. */
function rejectedPlan(decision: Record<string, unknown>): Plan {
  return {
    command: { id: String(decision.id ?? '?'), purpose: '' },
    args: [],
    flags: {},
    missing: [],
    reason: '',
    line: `dv ${String(decision.id ?? '?')}`,
  };
}

/**
 * Run a command and capture what it printed.
 *
 * Colour is disabled rather than stripped afterwards, so the text the model reads is the
 * text you read — escape codes would otherwise eat a chunk of the output budget and give
 * a small model something meaningless to pattern-match on.
 */
async function capture(line: string): Promise<{ output: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await runSelf(splitArgs(line).slice(1));
  // stderr is still included, because dv puts its explanations there — "not connected",
  // "needs a scope" — and those are exactly what the next step has to react to. It
  // belongs after the data rather than spliced into it.
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
  return { output, exitCode };
}

export { splitArgs };
