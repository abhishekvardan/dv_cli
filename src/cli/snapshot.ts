/**
 * Saving a read for later comparison.
 *
 * The question this answers is "what changed since it was working" — configuration
 * drift, an env var someone edited by hand, a project setting that moved. Re-fetching
 * tells you what is true now; it cannot tell you what is different, and holding the
 * previous output in your head across a week does not work.
 *
 * Snapshots live under `~/.dv/snapshots/` as plain JSON, so they can be committed,
 * diffed with other tools, or deleted without ceremony.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dvHome } from '../config/paths.js';
import { CliError, EXIT } from './errors.js';
import { redact } from './output.js';

function snapshotDir(): string {
  const dir = join(dvHome(), 'snapshots');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Names are used as filenames, so they cannot contain path separators. */
function pathFor(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new CliError(
      `"${name}" is not a usable snapshot name.`,
      EXIT.usage,
      'Letters, digits, dot, dash and underscore only.',
    );
  }
  return join(snapshotDir(), `${name}.json`);
}

export interface Snapshot {
  name: string;
  takenAt: string;
  command: string;
  data: unknown;
}

/**
 * Save a payload under a name.
 *
 * Redacted before writing. A snapshot is a file that outlives the terminal session and
 * may well end up in a repository, so storing a live token in one is worse than
 * printing it once.
 */
export function saveSnapshot(name: string, data: unknown, command: string): string {
  const snapshot: Snapshot = {
    name,
    takenAt: new Date().toISOString(),
    command,
    data: redact(data),
  };
  const path = pathFor(name);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function readSnapshot(name: string): Snapshot {
  const path = pathFor(name);
  if (!existsSync(path)) {
    throw new CliError(`No snapshot called "${name}".`, EXIT.notFound, 'dv snapshots');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

export function listSnapshots(): Snapshot[] {
  return readdirSync(snapshotDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(snapshotDir(), f), 'utf8')) as Snapshot)
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

export function deleteSnapshot(name: string): boolean {
  const path = pathFor(name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export type Change =
  | { kind: 'added'; path: string; now: unknown }
  | { kind: 'removed'; path: string; before: unknown }
  | { kind: 'changed'; path: string; before: unknown; now: unknown };

/**
 * Compare two payloads structurally.
 *
 * Arrays of objects are matched by a stable identity field where one exists — `id`,
 * `key`, `name`, `slug`, `uid` — rather than by index. Index matching reports a
 * reordered list as though every element changed, which buries the one thing that
 * actually did.
 */
export function diff(before: unknown, now: unknown, path = ''): Change[] {
  if (Object.is(before, now)) return [];

  const bothArrays = Array.isArray(before) && Array.isArray(now);
  if (bothArrays) return diffArrays(before, now, path);

  const bothObjects =
    before !== null && now !== null && typeof before === 'object' && typeof now === 'object';

  if (!bothObjects) {
    if (JSON.stringify(before) === JSON.stringify(now)) return [];
    return [{ kind: 'changed', path: path || '.', before, now }];
  }

  const b = before as Record<string, unknown>;
  const n = now as Record<string, unknown>;
  const changes: Change[] = [];
  for (const key of new Set([...Object.keys(b), ...Object.keys(n)])) {
    const child = path ? `${path}.${key}` : key;
    if (!(key in b)) changes.push({ kind: 'added', path: child, now: n[key] });
    else if (!(key in n)) changes.push({ kind: 'removed', path: child, before: b[key] });
    else changes.push(...diff(b[key], n[key], child));
  }
  return changes;
}

const IDENTITY_KEYS = ['id', 'key', 'name', 'slug', 'uid', 'file'];

function identify(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  for (const key of IDENTITY_KEYS) {
    if (typeof v[key] === 'string' || typeof v[key] === 'number') return `${key}=${v[key]}`;
  }
  return null;
}

function diffArrays(before: unknown[], now: unknown[], path: string): Change[] {
  const beforeKeys = before.map(identify);
  const nowKeys = now.map(identify);

  // Fall back to positional comparison only when the elements carry no identity at all.
  if (beforeKeys.some((k) => k === null) || nowKeys.some((k) => k === null)) {
    if (JSON.stringify(before) === JSON.stringify(now)) return [];
    return [{ kind: 'changed', path: path || '.', before, now }];
  }

  const beforeMap = new Map(beforeKeys.map((k, i) => [k!, before[i]]));
  const nowMap = new Map(nowKeys.map((k, i) => [k!, now[i]]));
  const changes: Change[] = [];

  for (const key of new Set([...beforeMap.keys(), ...nowMap.keys()])) {
    const child = `${path}[${key}]`;
    if (!beforeMap.has(key)) changes.push({ kind: 'added', path: child, now: nowMap.get(key) });
    else if (!nowMap.has(key)) changes.push({ kind: 'removed', path: child, before: beforeMap.get(key) });
    else changes.push(...diff(beforeMap.get(key), nowMap.get(key), child));
  }
  return changes;
}
