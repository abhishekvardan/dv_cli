/**
 * The journal is only worth trusting if it survives the messy cases: an interrupted
 * write, an entry that genuinely cannot be undone, and an undo run twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findEntry,
  markReverted,
  readJournal,
  record,
  registerUndo,
  runUndo,
} from '../src/cli/journal.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-journal-'));
  process.env.DV_HOME = home;
});

afterEach(() => {
  delete process.env.DV_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('recording writes', () => {
  it('returns an entry with an id that can be used immediately', () => {
    const entry = record({
      command: 'vercel env add',
      provider: 'vercel',
      summary: 'Added API_URL to my-app',
    });
    expect(entry.id).toMatch(/^j_/);
    expect(findEntry(entry.id).summary).toBe('Added API_URL to my-app');
  });

  it('gives each entry a distinct id', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () =>
        record({ command: 'x', provider: 'p', summary: 's' }).id,
      ),
    );
    expect(ids.size).toBe(50);
  });

  it('returns the most recent first', () => {
    record({ command: 'a', provider: 'p', summary: 'first' });
    record({ command: 'b', provider: 'p', summary: 'second' });
    expect(readJournal().map((e) => e.summary)).toEqual(['second', 'first']);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 10; i++) record({ command: 'x', provider: 'p', summary: `s${i}` });
    expect(readJournal(3)).toHaveLength(3);
  });

  it('survives a truncated line from an interrupted write', () => {
    // Append-only means a killed process can leave half a line. Losing that entry is
    // acceptable; losing the history above it is not.
    record({ command: 'a', provider: 'p', summary: 'intact' });
    appendFileSync(join(home, 'journal.jsonl'), '{"id":"j_broken","command":');
    record({ command: 'b', provider: 'p', summary: 'after' });

    const summaries = readJournal().map((e) => e.summary);
    expect(summaries).toContain('intact');
    expect(summaries).toContain('after');
  });
});

describe('finding an entry', () => {
  it('accepts a suffix, so a partial id from a scrollback works', () => {
    const entry = record({ command: 'x', provider: 'p', summary: 's' });
    expect(findEntry(entry.id.slice(-4)).id).toBe(entry.id);
  });

  it('raises a not-found error for an unknown id', () => {
    expect(() => findEntry('j_nope')).toThrow(/no journal entry/i);
  });
});

describe('undo', () => {
  it('runs the registered handler with the recorded arguments', async () => {
    const handler = vi.fn(async () => {});
    registerUndo('test.remove', handler);

    const entry = record({
      command: 'vercel env add',
      provider: 'vercel',
      summary: 'Added API_URL',
      undo: { kind: 'test.remove', args: { envId: 'env_123' }, describe: 'Remove API_URL' },
    });

    await runUndo(entry);
    expect(handler).toHaveBeenCalledWith({ envId: 'env_123' });
  });

  it('refuses an entry that recorded no way back, and says why', async () => {
    const entry = record({
      command: 'vercel env rm',
      provider: 'vercel',
      summary: 'Removed API_URL',
      irreversible: 'the value could not be read before deletion',
    });
    await expect(runUndo(entry)).rejects.toThrow(/could not be read/);
  });

  it('reports an unknown handler rather than doing nothing', async () => {
    // An undo that silently succeeds without reverting anything is the one outcome
    // that would make the journal actively dangerous to rely on.
    const entry = record({
      command: 'x',
      provider: 'p',
      summary: 's',
      undo: { kind: 'not.registered', args: {}, describe: 'nothing' },
    });
    await expect(runUndo(entry)).rejects.toThrow(/no undo handler/i);
  });

  it('marks an entry reverted without disturbing the others', () => {
    const first = record({ command: 'a', provider: 'p', summary: 'first' });
    record({ command: 'b', provider: 'p', summary: 'second' });

    markReverted(first.id, 'dv undo');

    expect(findEntry(first.id).revertedAt).toBeTruthy();
    expect(readJournal().find((e) => e.summary === 'second')?.revertedAt).toBeUndefined();
  });

  it('keeps the file valid JSONL after marking', () => {
    const entry = record({ command: 'a', provider: 'p', summary: 'first' });
    markReverted(entry.id, 'dv undo');

    const lines = readFileSync(join(home, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
  });
});
