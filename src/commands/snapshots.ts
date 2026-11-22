/**
 * `dv snapshots` — managing saved reads.
 */

import { UsageError } from '../cli/errors.js';
import { bool, type ParsedArgs } from '../cli/args.js';
import { c, info, json, out, relative, success, table } from '../cli/ui.js';
import { deleteSnapshot, listSnapshots, readSnapshot } from '../cli/snapshot.js';

export async function snapshotsCommand(args: ParsedArgs): Promise<void> {
  const sub = args.command[1] ?? 'list';
  const name = args.command[2] ?? args.positional[0];

  switch (sub) {
    case 'list': {
      const all = listSnapshots();
      if (bool(args.flags, 'json')) return json(all.map((s) => ({ ...s, data: undefined })));
      if (all.length === 0) {
        return info('No snapshots yet. Add --snapshot <name> to any command that returns JSON.');
      }
      table(all, [
        { header: 'name', value: (s) => c.bold(s.name), max: 24 },
        { header: 'taken', value: (s) => relative(s.takenAt) },
        { header: 'from', value: (s) => c.dim(s.command || '—'), max: 44 },
      ]);
      return;
    }

    case 'show': {
      if (!name) throw new UsageError('Which snapshot?', 'dv snapshots show env-known-good');
      json(readSnapshot(name));
      return;
    }

    case 'rm': {
      if (!name) throw new UsageError('Which snapshot?', 'dv snapshots rm env-known-good');
      if (deleteSnapshot(name)) success(`Removed "${name}".`);
      else info(`No snapshot called "${name}".`);
      return;
    }

    default:
      throw new UsageError(`Unknown snapshots command "${sub}".`, 'Try: list, show, rm');
  }
}
