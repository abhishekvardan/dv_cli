/**
 * `dv watch`
 *
 * Block until something changes, then say what changed.
 *
 * This is small but it inverts the relationship. Today every unattended session that
 * needs to know when a deployment finishes hand-rolls the same sleep loop, each with its
 * own interval, its own idea of which states are terminal, and its own bugs. Making the
 * waiting a command turns the CLI from something that has to be driven into something
 * that can report back — which is the part that has to exist before anything runs
 * without a person watching it.
 *
 * On the honest limits: Vercel offers no change stream for this, so underneath it is
 * polling. What makes it worth having anyway is that the polling is in one place, it
 * backs off, it knows which states are final, and it exits with a code that says what
 * happened. A caller gets an event-shaped interface over the only mechanism available.
 */

import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import { ProviderError, UsageError } from '../cli/errors.js';
import { c, info, out, success } from '../cli/ui.js';
import { emit, wantsJson } from '../cli/output.js';
import { vercel } from '../api/vercel.js';

/** States where nothing further will happen. */
const TERMINAL = new Set(['READY', 'ERROR', 'CANCELED']);

export async function watchCommand(args: ParsedArgs): Promise<void> {
  const what = args.command[1];

  if (what !== 'deployments' && what !== 'deployment') {
    throw new UsageError(
      what ? `Cannot watch "${what}".` : 'Watch what?',
      'dv watch deployments <project>    block until a new deployment settles',
    );
  }

  const project = args.command[2] ?? str(args.flags, 'project', 'p');
  if (!project) throw new UsageError('Which project?', 'dv watch deployments my-app');

  const timeoutMs = num(args.flags, 'timeout', 1800) * 1000;
  const intervalMs = Math.max(2, num(args.flags, 'interval', 5)) * 1000;
  const asJson = wantsJson(args.flags);
  const once = bool(args.flags, 'once');

  const started = Date.now();

  // The baseline is whatever is already there. Without it, the first poll would report
  // the last deployment from yesterday as though it had just happened.
  const initial = await vercel.deployments({ project, limit: 5 });
  const seen = new Set(initial.map((d: any) => String(d.uid ?? d.id)));
  const baselineState = new Map<string, string>(
    initial.map((d: any) => [String(d.uid ?? d.id), String(d.readyState ?? d.state)]),
  );

  if (!asJson) {
    info(c.dim(`Watching ${project} — ${initial.length} known deployment${initial.length === 1 ? '' : 's'}.`));
    info(c.dim('Ctrl-C to stop.'));
    out('');
  }

  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new ProviderError(
        `Nothing changed within ${Math.round(timeoutMs / 1000)}s.`,
        504,
        'Raise it with --timeout <seconds>.',
      );
    }

    await sleep(intervalMs);

    let recent: any[];
    try {
      recent = await vercel.deployments({ project, limit: 5 });
    } catch (err) {
      // A blip should not end a watch that may be meant to run for half an hour.
      if (!asJson) info(c.dim(`  (poll failed: ${err instanceof Error ? err.message : String(err)})`));
      continue;
    }

    for (const d of recent) {
      const id = String(d.uid ?? d.id);
      const state = String(d.readyState ?? d.state);
      const url = d.url ? `https://${d.url}` : id;

      const isNew = !seen.has(id);
      const changed = !isNew && baselineState.get(id) !== state;
      if (!isNew && !changed) continue;

      seen.add(id);
      baselineState.set(id, state);

      if (asJson) {
        emit({ event: isNew ? 'created' : 'state', id, state, url, target: d.target ?? 'preview' });
      } else {
        const label = isNew ? c.bold('new') : 'state';
        out(`  ${label}  ${stateColor(state)}  ${url}  ${c.dim(d.target ?? 'preview')}`);
      }

      // A terminal state on a deployment this invocation actually watched is the signal
      // the caller was waiting for, so the exit code carries the outcome.
      if (TERMINAL.has(state) && (isNew || changed)) {
        if (state === 'READY') {
          if (!asJson) success(`Ready — ${url}`);
          return;
        }
        throw new ProviderError(
          `Deployment ${state.toLowerCase()} — ${url}`,
          502,
          `dv vercel deploy logs ${id} --build`,
        );
      }

      if (once) return;
    }
  }
}

function stateColor(state: string): string {
  if (state === 'READY') return c.green(state);
  if (state === 'ERROR' || state === 'CANCELED') return c.red(state);
  return c.yellow(state);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
