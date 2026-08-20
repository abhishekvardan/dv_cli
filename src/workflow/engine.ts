/**
 * The workflow runner.
 *
 * A workflow is an ordered list of steps that share one context object. The engine
 * owns everything that is the same for every workflow — progress rendering, timing,
 * skip handling, failing at the right step with the right message — so a workflow
 * definition is just what it actually does.
 *
 * The point of the CLI is here rather than in the per-provider commands: anyone can
 * call the GitHub API, but "push, open a PR, wait for CI, wait for the deployment,
 * check it is actually serving" spans four services and is where the real work is.
 */

import { c, info, out } from '../cli/ui.js';
import { CliError, EXIT } from '../cli/errors.js';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepOutcome {
  /** Shown next to the step name, e.g. a PR number or a URL. */
  detail?: string;
}

export interface Step<C> {
  name: string;
  /**
   * Return a reason to skip, or false to run.
   *
   * A skipped step says why. "Tests skipped" with no reason leaves you wondering
   * whether it was your flag or a missing script.
   */
  skip?: (ctx: C) => Promise<string | false> | string | false;
  run: (ctx: C) => Promise<StepOutcome | string | void>;
  /** A failure here is reported but does not stop the workflow. */
  optional?: boolean;
}

interface StepState {
  name: string;
  status: StepStatus;
  detail?: string;
  ms?: number;
}

const MARK: Record<StepStatus, string> = {
  pending: ' ',
  running: '>',
  done: 'ok',
  failed: 'x',
  skipped: '-',
};

function paint(state: StepState): string {
  const mark =
    state.status === 'done'
      ? c.green(MARK.done)
      : state.status === 'failed'
        ? c.red(MARK.failed)
        : state.status === 'running'
          ? c.cyan(MARK.running)
          : state.status === 'skipped'
            ? c.gray(MARK.skipped)
            : c.gray(MARK.pending);

  const name =
    state.status === 'pending'
      ? c.gray(state.name)
      : state.status === 'skipped'
        ? c.gray(state.name)
        : state.status === 'running'
          ? c.bold(state.name)
          : state.name;

  // Collapsed to one line: a multi-line failure (a git error, a build log) would
  // otherwise desync the cursor arithmetic and shred the whole display on redraw.
  const flat = state.detail?.replace(/\s+/g, ' ').trim();
  const clipped = flat && flat.length > 68 ? `${flat.slice(0, 67)}…` : flat;
  const detail = clipped ? `  ${c.dim(clipped)}` : '';
  // Only worth showing when it is long enough to explain a wait.
  const time = state.ms && state.ms > 1500 ? c.dim(`  ${(state.ms / 1000).toFixed(1)}s`) : '';
  return `  ${mark.padEnd(2)} ${name}${detail}${time}`;
}

export interface WorkflowResult<C> {
  ctx: C;
  ok: boolean;
  steps: StepState[];
}

export interface RunOptions {
  title: string;
  /** Print what would run and stop. */
  dryRun?: boolean;
}

/**
 * Run the steps in order, stopping at the first hard failure.
 *
 * Rendering redraws the whole list in place on a terminal, and prints one line per
 * step everywhere else — a progress display that repaints itself is unreadable in a
 * CI log, which is exactly where a deploy workflow ends up.
 */
export async function runWorkflow<C>(
  steps: Step<C>[],
  ctx: C,
  options: RunOptions,
): Promise<WorkflowResult<C>> {
  const live = process.stderr.isTTY === true;
  const states: StepState[] = steps.map((s) => ({ name: s.name, status: 'pending' }));

  info('');
  info(c.bold(options.title));
  info(c.dim('─'.repeat(Math.max(options.title.length, 28))));
  info('');

  if (options.dryRun) {
    for (const state of states) info(`  ${c.gray('-')}  ${state.name}`);
    info('');
    info(c.dim('  Dry run — nothing was executed.'));
    return { ctx, ok: true, steps: states };
  }

  let drawn = 0;
  const draw = () => {
    if (!live) return;
    if (drawn > 0) process.stderr.write(`\u001b[${drawn}A`);
    for (const state of states) {
      process.stderr.write(`\u001b[2K\r${paint(state)}\n`);
    }
    drawn = states.length;
  };

  draw();

  let failure: { step: string; error: Error } | null = null;

  for (const [i, step] of steps.entries()) {
    const state = states[i]!;

    // Everything after a hard failure is left pending rather than marked skipped —
    // they were never considered, which is a different thing from being skipped.
    if (failure) break;

    const reason = step.skip ? await step.skip(ctx) : false;
    if (reason) {
      state.status = 'skipped';
      state.detail = reason;
      if (live) draw();
      else info(paint(state));
      continue;
    }

    state.status = 'running';
    if (live) draw();

    const started = Date.now();
    try {
      const outcome = await step.run(ctx);
      state.ms = Date.now() - started;
      state.status = 'done';
      state.detail = typeof outcome === 'string' ? outcome : outcome?.detail;
    } catch (err) {
      state.ms = Date.now() - started;
      state.status = 'failed';
      const error = err instanceof Error ? err : new Error(String(err));
      state.detail = error.message;
      if (!step.optional) failure = { step: step.name, error };
    }

    if (live) draw();
    else info(paint(state));
  }

  info('');

  if (failure) {
    // The step name is the useful part — "the workflow failed" is not actionable.
    throw new CliError(
      `${failure.step} failed: ${failure.error.message}`,
      failure.error instanceof CliError ? failure.error.code : EXIT.failure,
      failure.error instanceof CliError ? failure.error.hint : undefined,
    );
  }

  return { ctx, ok: true, steps: states };
}

/** A short summary block at the end of a workflow. */
export function summary(rows: Array<[string, string]>): void {
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) out(`${c.dim(key.padEnd(width))}  ${value}`);
}
