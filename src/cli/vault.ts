/**
 * Secret values held only so an undo can put them back.
 *
 * Undoing `env rm` means recreating the variable, which means knowing its value — and
 * the value is unreadable from the provider once deleted, so it has to be captured
 * before the delete or the undo is impossible.
 *
 * The obvious place to keep it is the journal entry itself, and that is wrong. The
 * journal is meant to be read: `dv journal`, `dv journal --json`, pasted into an issue
 * to show what changed. Redaction does not save it either, since redaction recognises
 * secrets by key name or by token shape and a value stored under `value` has neither —
 * an API key like `re_9Kd2…` sails straight through.
 *
 * So the journal holds an opaque handle and the value lives here, in a file that exists
 * for nothing else, with the same permissions as the credential store. Printing the
 * journal can then never disclose a secret, whatever flags are passed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { dvHome } from '../config/paths.js';

/**
 * How long a stashed secret is kept.
 *
 * A deleted credential should not sit on disk forever waiting for an undo nobody is
 * going to run. Two weeks is long enough to notice a mistake and short enough that the
 * file does not become an archive of everything ever removed.
 */
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface Stashed {
  value: string;
  at: number;
}

function vaultPath(): string {
  const home = dvHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  return join(home, 'undo-secrets.json');
}

function read(): Record<string, Stashed> {
  const path = vaultPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, Stashed>;
  } catch {
    return {};
  }
}

function write(entries: Record<string, Stashed>): void {
  writeFileSync(vaultPath(), JSON.stringify(entries), { mode: 0o600 });
}

/** Drop anything past its lifetime. Called on every read and write. */
function prune(entries: Record<string, Stashed>): Record<string, Stashed> {
  const now = Date.now();
  for (const [id, entry] of Object.entries(entries)) {
    if (now - entry.at > TTL_MS) delete entries[id];
  }
  return entries;
}

/** Keep a value and return the handle to record in its place. */
export function stashSecret(value: string): string {
  const entries = prune(read());
  const id = `s_${randomBytes(9).toString('hex')}`;
  entries[id] = { value, at: Date.now() };
  write(entries);
  return id;
}

/**
 * Retrieve a stashed value.
 *
 * Returns undefined once expired or already consumed, which the caller must treat as
 * "this cannot be undone" rather than restoring an empty value — a variable recreated
 * blank is worse than one that is honestly still missing.
 */
export function retrieveSecret(id: string): string | undefined {
  return prune(read())[id]?.value;
}

/** Forget a value once its undo has run, so it is not kept beyond its purpose. */
export function dropSecret(id: string): void {
  const entries = prune(read());
  delete entries[id];
  write(entries);
}
