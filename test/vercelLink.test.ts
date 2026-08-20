import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { linkedVercelProject, writeVercelLink } from '../src/workflow/git.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dv-link-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('linking a directory to a Vercel project', () => {
  it('writes the same shape the Vercel CLI does', () => {
    const dir = scratch();
    writeVercelLink({ orgId: 'team_x', projectId: 'prj_123', projectName: 'studio-genesis' }, dir);
    const written = JSON.parse(readFileSync(join(dir, '.vercel', 'project.json'), 'utf8'));
    // Matching the official format is what lets both tools read one link.
    expect(written).toEqual({
      orgId: 'team_x',
      projectId: 'prj_123',
      projectName: 'studio-genesis',
    });
  });

  it('round-trips through the reader', () => {
    const dir = scratch();
    writeVercelLink({ orgId: 'o', projectId: 'prj_abc' }, dir);
    expect(linkedVercelProject(dir)).toBe('prj_abc');
  });

  it('returns null when nothing is linked', () => {
    expect(linkedVercelProject(scratch())).toBeNull();
  });

  it('survives a corrupt link file rather than throwing mid-deploy', () => {
    const dir = scratch();
    writeVercelLink({ orgId: 'o', projectId: 'p' }, dir);
    writeFileSync(join(dir, '.vercel', 'project.json'), '{ not json');
    expect(linkedVercelProject(dir)).toBeNull();
  });

  it('gitignores .vercel, since it holds account-specific ids', () => {
    const dir = scratch();
    writeVercelLink({ orgId: 'o', projectId: 'p' }, dir);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.vercel');
  });

  it('appends without mangling a file that lacks a trailing newline', () => {
    const dir = scratch();
    writeFileSync(join(dir, '.gitignore'), 'node_modules');
    writeVercelLink({ orgId: 'o', projectId: 'p' }, dir);
    // Not "node_modules.vercel".
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.vercel\n');
  });

  it('does not add a duplicate entry on relink', () => {
    const dir = scratch();
    writeVercelLink({ orgId: 'o', projectId: 'p' }, dir);
    writeVercelLink({ orgId: 'o', projectId: 'p2' }, dir);
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(ignore.match(/\.vercel/g)).toHaveLength(1);
    // Relinking must actually change the target.
    expect(linkedVercelProject(dir)).toBe('p2');
  });
});
