import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-snap-'));
  process.env.DV_HOME = home;
  vi.resetModules();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DV_HOME;
});

const snap = () => import('../src/cli/snapshot.js');

describe('diff', () => {
  it('reports nothing for identical payloads', async () => {
    const { diff } = await snap();
    expect(diff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it('reports added, removed and changed keys', async () => {
    const { diff } = await snap();
    const changes = diff({ a: 1, gone: true }, { a: 2, added: 'x' });
    expect(changes).toContainEqual({ kind: 'changed', path: 'a', before: 1, now: 2 });
    expect(changes).toContainEqual({ kind: 'removed', path: 'gone', before: true });
    expect(changes).toContainEqual({ kind: 'added', path: 'added', now: 'x' });
  });

  it('matches array elements by identity, not position', async () => {
    const { diff } = await snap();
    const before = [{ key: 'A', value: '1' }, { key: 'B', value: '2' }];
    // Same content, reordered. Index matching would call this two changes.
    const now = [{ key: 'B', value: '2' }, { key: 'A', value: '1' }];
    expect(diff(before, now)).toEqual([]);
  });

  it('finds the one element that really changed in a reordered list', async () => {
    const { diff } = await snap();
    const before = [{ key: 'A', value: '1' }, { key: 'B', value: '2' }];
    const now = [{ key: 'B', value: 'CHANGED' }, { key: 'A', value: '1' }];
    const changes = diff(before, now);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'changed', before: '2', now: 'CHANGED' });
  });

  it('reports elements added to and removed from a list', async () => {
    const { diff } = await snap();
    const changes = diff([{ id: 1 }], [{ id: 1 }, { id: 2 }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('added');
  });

  it('falls back to whole-value comparison when elements have no identity', async () => {
    const { diff } = await snap();
    expect(diff([1, 2, 3], [1, 2, 3])).toEqual([]);
    expect(diff([1, 2, 3], [1, 2, 4])).toHaveLength(1);
  });

  it('descends into nested structures', async () => {
    const { diff } = await snap();
    const changes = diff({ link: { repo: 'a' } }, { link: { repo: 'b' } });
    expect(changes[0]).toMatchObject({ path: 'link.repo', before: 'a', now: 'b' });
  });
});

describe('snapshots on disk', () => {
  it('round-trips', async () => {
    const { saveSnapshot, readSnapshot } = await snap();
    saveSnapshot('known-good', { a: 1 }, 'vercel env list');
    const loaded = readSnapshot('known-good');
    expect(loaded.data).toEqual({ a: 1 });
    expect(loaded.command).toBe('vercel env list');
  });

  it('redacts before writing', async () => {
    const { saveSnapshot, readSnapshot } = await snap();
    saveSnapshot('creds', { access_token: 'ghp_abcdefghijklmnopqrst' }, '');
    // A snapshot outlives the session and may reach a repository; a live token in one
    // is worse than printing it once.
    expect(JSON.stringify(readSnapshot('creds').data)).not.toContain('abcdefghijklmnop');
  });

  it('refuses a name that would escape the snapshot directory', async () => {
    const { saveSnapshot } = await snap();
    expect(() => saveSnapshot('../../etc/passwd', {}, '')).toThrow(/not a usable snapshot name/);
  });

  it('lists newest first and deletes', async () => {
    const { saveSnapshot, listSnapshots, deleteSnapshot } = await snap();
    saveSnapshot('one', {}, '');
    saveSnapshot('two', {}, '');
    expect(listSnapshots().map((s) => s.name).sort()).toEqual(['one', 'two']);
    expect(deleteSnapshot('one')).toBe(true);
    expect(deleteSnapshot('one')).toBe(false);
  });

  it('says so when a snapshot is missing', async () => {
    const { readSnapshot } = await snap();
    expect(() => readSnapshot('nope')).toThrow(/No snapshot called/);
  });
});
