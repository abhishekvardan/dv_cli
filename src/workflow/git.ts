/**
 * Local git and package.json facts.
 *
 * A cross-service workflow starts from the working copy — which branch, which commit,
 * which repository — so this reads that once and hands it to the steps rather than
 * every step shelling out for itself.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliError, EXIT } from '../cli/errors.js';

export function git(args: string[], cwd = process.cwd()): { ok: boolean; out: string; err: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) {
    throw new CliError('git is not installed, or not on PATH.', EXIT.failure);
  }
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  };
}

export function isRepo(cwd = process.cwd()): boolean {
  return git(['rev-parse', '--is-inside-work-tree'], cwd).ok;
}

export function currentBranch(cwd = process.cwd()): string {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!r.ok) throw new CliError('Could not read the current branch.');
  return r.out;
}

export function headSha(cwd = process.cwd()): string {
  return git(['rev-parse', 'HEAD'], cwd).out;
}

/** Uncommitted changes, as porcelain lines. Empty means clean. */
export function dirtyFiles(cwd = process.cwd()): string[] {
  const r = git(['status', '--porcelain'], cwd);
  return r.out ? r.out.split('\n').filter(Boolean) : [];
}

/**
 * The GitHub repo for a remote, as `owner/name`.
 *
 * Handles both URL forms git uses — `https://github.com/o/n.git` and
 * `git@github.com:o/n.git` — because which one you get depends on how the repo was
 * cloned, and a workflow should not care.
 */
export function githubRemote(remote = 'origin', cwd = process.cwd()): string | null {
  const r = git(['remote', 'get-url', remote], cwd);
  if (!r.ok) return null;
  const url = r.out;
  const https = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  return https ? `${https[1]}/${https[2]}` : null;
}

export function hasUpstream(branch: string, cwd = process.cwd()): boolean {
  return git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], cwd).ok;
}

/** Commits on this branch that the remote does not have. */
export function unpushedCount(branch: string, cwd = process.cwd()): number {
  if (!hasUpstream(branch, cwd)) return -1; // never pushed
  const r = git(['rev-list', '--count', `${branch}@{upstream}..${branch}`], cwd);
  return r.ok ? Number(r.out) || 0 : 0;
}

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

export function readPackageJson(cwd = process.cwd()): PackageJson | null {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

export function hasScript(name: string, cwd = process.cwd()): boolean {
  return Boolean(readPackageJson(cwd)?.scripts?.[name]);
}

/**
 * Run a shell command, capturing output.
 *
 * Output is captured rather than inherited so a failing build can be reported as the
 * step's error — with the last lines of its output — instead of scrolling past the
 * progress display and leaving no trace of what broke.
 */
export function run(
  command: string,
  args: string[],
  cwd = process.cwd(),
): { ok: boolean; output: string } {
  // Windows needs a shell here and there is no way around it: `npm` is a `.cmd` shim,
  // and since the CVE-2024-27980 fix Node refuses to spawn `.cmd` without one, while
  // bare `npm` is simply not an executable. Passing the command as a single
  // pre-quoted string rather than a string plus an args array is what avoids the
  // unescaped-concatenation problem Node warns about.
  const useShell = process.platform === 'win32';
  const result = useShell
    ? spawnSync([command, ...args.map(shellQuote)].join(' '), {
        cwd,
        encoding: 'utf8',
        shell: true,
      })
    : spawnSync(command, args, { cwd, encoding: 'utf8' });

  // A failure to launch sets `error` and leaves status null. Without this the caller
  // reports an empty message and the real cause — a missing binary — is invisible.
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      output:
        code === 'ENOENT'
          ? `${command} is not installed, or not on PATH.`
          : `could not run ${command}: ${result.error.message}`,
    };
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output };
}

/** Quote an argument for a shell, leaving simple ones alone so output stays readable. */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@:./=-]+$/.test(arg)) return arg;
  return process.platform === 'win32'
    ? `"${arg.replace(/"/g, '""')}"`
    : `'${arg.replace(/'/g, `'''`)}'`;
}

/** The last few meaningful lines of command output, for an error message. */
export function tail(output: string, lines = 6): string {
  const meaningful = output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  return meaningful.slice(-lines).join('\n');
}
