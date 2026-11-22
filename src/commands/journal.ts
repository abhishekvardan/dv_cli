/**
 * `dv journal` and `dv undo`
 *
 * What was changed, and how to change it back.
 */

import { bool, str, type ParsedArgs } from '../cli/args.js';
import { CancelledError, UsageError } from '../cli/errors.js';
import { c, confirm, info, out, relative, success, warn } from '../cli/ui.js';
import { emit, outputOpts, wantsJson } from '../cli/output.js';
import { findEntry, markReverted, readJournal, runUndo } from '../cli/journal.js';
import '../cli/undoHandlers.js';

export async function journalCommand(args: ParsedArgs): Promise<void> {
  const limit = Number(str(args.flags, 'limit', 'n') ?? 20) || 20;
  const entries = readJournal(limit);

  if (wantsJson(args.flags)) return emit(entries, outputOpts(args.flags, 'journal'));

  if (entries.length === 0) {
    info('Nothing recorded yet.');
    info(c.dim('  Writes are journalled as they happen; reads are not.'));
    return;
  }

  for (const entry of entries) {
    // The id leads the line because using it is the point of reading this at all.
    const state = entry.revertedAt
      ? c.dim('reverted')
      : entry.undo
        ? c.green('undoable')
        : c.dim('permanent');

    out(`${c.bold(entry.id)}  ${state}  ${c.dim(relative(entry.at))}`);
    out(`  ${entry.summary}`);
    out(`  ${c.dim(`${entry.provider}${entry.account ? ` · ${entry.account}` : ''} · ${entry.command}`)}`);
    if (!entry.undo && entry.irreversible) out(`  ${c.dim(`cannot undo: ${entry.irreversible}`)}`);
    out('');
  }

  const undoable = entries.filter((e) => e.undo && !e.revertedAt).length;
  if (undoable > 0) info(c.dim(`${undoable} of these can be reverted — dv undo <id>`));
}

export async function undoCommand(args: ParsedArgs): Promise<void> {
  const id = args.command[1];
  if (!id) {
    throw new UsageError('Which entry?', 'dv undo j_abc123\ndv journal   to list them');
  }

  const entry = findEntry(id);

  if (entry.revertedAt) {
    // Re-running an undo would be a second, different write — removing something that
    // was already restored, for instance — so it stops here.
    warn(`${entry.id} was already reverted ${relative(entry.revertedAt)}.`);
    return;
  }

  out(`${c.dim('entry   ')} ${entry.id}  ${c.dim(relative(entry.at))}`);
  out(`${c.dim('did     ')} ${entry.summary}`);
  out(`${c.dim('will do ')} ${entry.undo ? entry.undo.describe : c.red('nothing — not reversible')}`);
  out('');

  // `runUndo` raises a clear error for an entry with no plan; the confirm is skipped so
  // the user is not asked to approve something that cannot happen.
  if (entry.undo) {
    const ok = await confirm('Revert it?', bool(args.flags, 'yes', 'y'));
    if (!ok) throw new CancelledError('Nothing was reverted.');
  }

  await runUndo(entry);
  markReverted(entry.id, 'dv undo');
  success(`Reverted ${entry.id}.`);
}
