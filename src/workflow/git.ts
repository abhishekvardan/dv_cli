/**
 * Local git and package.json facts.
 *
 * A cross-service workflow starts from the working copy — which branch, which commit,
 * which repository — so this reads that once and hands it to the steps rather than
 * every step shelling out for itself.
 */

import { spawn, spawnSync } from 'node:child_process';
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

/**
 * The Vercel project this directory is linked to.
 *
 * `.vercel/project.json` is written by `vercel link` and is the authoritative answer.
 * Falling back to the package.json name guesses wrong constantly — a project scaffolded
 * from a template keeps the template's name, which is how `tanstack_start_ts` ends up
 * being looked for on Vercel when the real project is called something else.
 *
 * The file holds an id rather than a name; Vercel's project endpoint accepts either.
 */
export function linkedVercelProject(cwd = process.cwd()): string | null {
  const path = join(cwd, '.vercel', 'project.json');
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { projectId?: string };
    return data.projectId ?? null;
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


export interface RunAsyncOptions {
  cwd?: string;
  /** Kill the child after this long. A build with no ceiling hangs the workflow forever. */
  timeoutMs?: number;
  /** Called with each chunk of output, for live progress. */
  onOutput?: (chunk: string) => void;
}

/**
 * Run a command without blocking the event loop.
 *
 * `spawnSync` was wrong here for three reasons, all of which showed up as a workflow
 * that appeared frozen:
 *
 *  - It blocks the loop, so nothing can tick a clock or redraw while a build runs, and
 *    a slow step is indistinguishable from a hung one.
 *  - There was no timeout, so a genuinely stuck child hung the workflow indefinitely.
 *  - The child inherited a live stdin, so anything that prompted — npm asking to
 *    install a missing package, a git credential helper — waited for input that was
 *    never coming.
 */
export function runAsync(
  command: string,
  args: string[],
  options: RunAsyncOptions = {},
): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  const { cwd = process.cwd(), timeoutMs = 10 * 60_000, onOutput } = options;

  return new Promise((resolve) => {
    const useShell = process.platform === 'win32';
    const child = useShell
      ? spawn([command, ...args.map(shellQuote)].join(' '), {
          cwd,
          shell: true,
          // stdin closed: a child that asks a question gets EOF and fails fast
          // instead of waiting for an answer nobody can give.
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      onOutput?.(text);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // SIGTERM is a request. Something wedged needs SIGKILL.
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    timer.unref();

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        timedOut: false,
        output:
          err.code === 'ENOENT'
            ? `${command} is not installed, or not on PATH.`
            : `could not run ${command}: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        timedOut,
        output: timedOut
          ? `${output.trim()}

timed out after ${Math.round(timeoutMs / 1000)}s`.trim()
          : output.trim(),
      });
    });
  });
}

/** The last few meaningful lines of command output, for an error message. */
export function tail(output: string, lines = 6): string {
  const meaningful = output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  return meaningful.slice(-lines).join('\n');
}
