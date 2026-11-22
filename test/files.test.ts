import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { humanSize, readIgnoreFile, walkProject } from '../src/workflow/files.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dv-walk-'));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const names = (root: string, ignore: string[] = []) =>
  walkProject(root, { ignore }).map((f) => f.file).sort();

describe('walkProject', () => {
  it('finds files with POSIX paths regardless of platform', () => {
    const root = project({ 'src/index.ts': 'x', 'package.json': '{}' });
    // The upload API expects forward slashes; a Windows path would be rejected.
    expect(names(root)).toEqual(['package.json', 'src/index.ts']);
  });

  it('never uploads node_modules', () => {
    const root = project({
      'index.js': 'x',
      'node_modules/pkg/index.js': 'huge',
    });
    // The difference between a 300 kB upload and a 300 MB one.
    expect(names(root)).toEqual(['index.js']);
  });

  it('never uploads .git or build output', () => {
    const root = project({
      'a.js': 'x',
      '.git/config': 'secret',
      'dist/bundle.js': 'built',
      '.next/cache': 'built',
    });
    expect(names(root)).toEqual(['a.js']);
  });

  it('never uploads .env files', () => {
    const root = project({ 'app.js': 'x', '.env': 'SECRET=1', '.env.production': 'SECRET=2' });
    // These are credentials; they must not travel in a deployment payload.
    expect(names(root)).toEqual(['app.js']);
  });

  it('honours ignore patterns, including directories and globs', () => {
    const root = project({
      'keep.js': 'x',
      'tmp/scratch.js': 'x',
      'notes.md': 'x',
    });
    expect(names(root, ['tmp', '*.md'])).toEqual(['keep.js']);
  });

  it('hashes content, and identical files share a digest', () => {
    const root = project({ 'a.txt': 'same', 'b.txt': 'same', 'c.txt': 'different' });
    const walked = walkProject(root);
    const a = walked.find((f) => f.file === 'a.txt')!;
    const b = walked.find((f) => f.file === 'b.txt')!;
    const c = walked.find((f) => f.file === 'c.txt')!;
    // Content addressing is what lets the platform skip files it already holds.
    expect(a.sha).toBe(b.sha);
    expect(a.sha).not.toBe(c.sha);
    expect(a.size).toBe(4);
  });

  it('skips files above the size limit rather than failing the whole walk', () => {
    const root = project({ 'small.txt': 'x', 'big.txt': 'y'.repeat(2000) });
    expect(walkProject(root, { maxFileBytes: 100 }).map((f) => f.file)).toEqual(['small.txt']);
  });

  it('returns a stable order', () => {
    const root = project({ 'b.js': 'x', 'a.js': 'x', 'c/d.js': 'x' });
    expect(walkProject(root).map((f) => f.file)).toEqual(['a.js', 'b.js', 'c/d.js']);
  });
});

describe('readIgnoreFile', () => {
  it('reads patterns, skipping blanks and comments', () => {
    const root = project({ '.vercelignore': '# comment\n\ntmp\n*.log\n' });
    expect(readIgnoreFile(root, '.vercelignore')).toEqual(['tmp', '*.log']);
  });

  it('ignores negations rather than half-applying them', () => {
    // Honouring the positive half of `!keep.js` would exclude something explicitly
    // asked for.
    const root = project({ '.vercelignore': 'tmp\n!keep.js\n' });
    expect(readIgnoreFile(root, '.vercelignore')).toEqual(['tmp']);
  });

  it('returns nothing when the file is absent', () => {
    expect(readIgnoreFile(project({ 'a.js': 'x' }), '.vercelignore')).toEqual([]);
  });
});

describe('humanSize', () => {
  it('scales units', () => {
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(2048)).toBe('2.0 kB');
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
