/**
 * A record of every write, and how to take it back.
 *
 * The blocker to letting something else run this tool is not capability, it is
 * recovery. If a mistake means reconstructing what happened from three provider
 * dashboards, nobody hands over the keys. An append-only journal with one-command
 * reversal changes that calculus.
 *
 * Two design choices worth stating:
 *
 *  - **The undo is recorded at write time, not derived later.** Removing an env var
 *    needs the id the create returned; rolling back a deploy needs the id that was
 *    live *before*. That information exists at the moment of the write and is gone
 *    afterwards, so it is captured then.
 *  - **Not everything is reversible, and the journal says so.** A deleted repository
 *    does not come back. An entry with no undo records why, which is far better than
 *    an `undo` that silently does nothing.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { dvHome } from '../config/paths.js';
import { CliError, EXIT } from './errors.js';

export interface UndoPlan {
  /** Registered handler name, e.g. "vercel.env.remove". */
  kind: string;
  args: Record<string, unknown>;
  /** Shown before running, so a person can judge it. */
  describe: string;
}

export interface JournalEntry {
  id: string;
  at: string;
  /** The command the user ran. */
  command: string;
  provider: string;
  /** What it did, in plain words. */
  summary: string;
  account?: string;
  /** Absent when the action cannot be undone; `irreversible` says why. */
  undo?: UndoPlan;
  irreversible?: string;
  revertedAt?: string;
  revertedBy?: string;
}

function journalPath(): string {
  const home = dvHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  return join(home, 'journal.jsonl');
}

/** Short, sortable, and readable enough to type. */
function newId(): string {
  const stamp = Date.now().toString(36);
  return `j_${stamp}${randomBytes(2).toString('hex')}`;
}

/**
 * Record a write.
 *
 * Append-only and one JSON object per line, so a partially written entry costs at most
 * that entry — rewriting a whole file on every write would risk the entire history.
 */
export function record(entry: Omit<JournalEntry, 'id' | 'at'>): JournalEntry {
  const full: JournalEntry = { id: newId(), at: new Date().toISOString(), ...entry };
  const path = journalPath();

  // If a previous write was interrupted the file ends mid-line, and appending straight
  // onto it would fuse the two into one unparseable record — losing this entry as well
  // as the broken one. A leading newline costs nothing and confines the damage to the
  // line that was already lost.
  let prefix = '';
  try {
    const existing = readFileSync(path, 'utf8');
    if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n';
  } catch {
    // No file yet.
  }

  appendFileSync(path, `${prefix}${JSON.stringify(full)}\n`, { mode: 0o600 });
  return full;
}

export function readJournal(limit = 50): JournalEntry[] {
  const path = journalPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);

  const entries: JournalEntry[] = [];
  // Read backwards: recent entries are what anyone is looking for, and a long history
  // should not have to be parsed in full to show the last ten.
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    try {
      entries.push(JSON.parse(lines[i]!) as JournalEntry);
    } catch {
      // A truncated line from an interrupted write is skipped, not fatal.
    }
  }
  return entries;
}

export function findEntry(id: string): JournalEntry {
  const entry = readJournal(5000).find((e) => e.id === id || e.id.endsWith(id));
  if (!entry) throw new CliError(`No journal entry "${id}".`, EXIT.notFound, 'dv journal');
  return entry;
}

/** Mark an entry reverted. Rewrites the file, which is acceptable for a rare operation. */
export function markReverted(id: string, by: string): void {
  const path = journalPath();
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const updated = lines.map((line) => {
    try {
      const entry = JSON.parse(line) as JournalEntry;
      if (entry.id !== id) return line;
      return JSON.stringify({ ...entry, revertedAt: new Date().toISOString(), revertedBy: by });
    } catch {
      return line;
    }
  });
  writeFileSync(path, `${updated.join('\n')}\n`, { mode: 0o600 });
}

/* ─────────────────────────── undo handlers ─────────────────────────── */

type UndoHandler = (args: Record<string, any>) => Promise<void>;

const HANDLERS = new Map<string, UndoHandler>();

export function registerUndo(kind: string, handler: UndoHandler): void {
  HANDLERS.set(kind, handler);
}

export async function runUndo(entry: JournalEntry): Promise<void> {
  if (!entry.undo) {
    throw new CliError(
      entry.irreversible
        ? `That cannot be undone: ${entry.irreversible}`
        : 'That action recorded no way to undo it.',
      EXIT.usage,
    );
  }
  const handler = HANDLERS.get(entry.undo.kind);
  if (!handler) {
    throw new CliError(
      `No undo handler for "${entry.undo.kind}".`,
      EXIT.failure,
      'The entry was written by a newer version of dv.',
    );
  }
  await handler(entry.undo.args);
}
