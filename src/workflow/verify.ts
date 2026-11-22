/**
 * Closing the loop: did the thing that was deployed actually work?
 *
 * Every CLI of this kind is request/response — it performs one action, reports that the
 * action was accepted, and leaves you to discover separately whether the result is any
 * good. That gap is where the time goes. Deploy, curl, read a 500, guess, redeploy, curl
 * again, eight times over, with a human standing in as the control loop for a tool that
 * has no concept of "did this work".
 *
 * A verification step folds that loop inside the command. `--verify` runs a check once
 * the deployment is live; `--on-fail rollback` reverts to the last known-good build when
 * the check fails. What comes back is not `FUNCTION_INVOCATION_FAILED` but the response
 * body and the status, which is the part you were going to go and fetch by hand anyway.
 *
 * Two properties matter more than the convenience:
 *
 *  - **The check runs against the deployment that was just made**, not against whatever
 *    the domain happens to point at. `{url}` is substituted so the verification cannot
 *    accidentally pass by testing the old build.
 *  - **A failed heal is louder than a failed verify.** Being back on the previous build
 *    is recoverable; believing you are and not being is not.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { c, info, out } from '../cli/ui.js';
import { killTree } from './git.js';

export interface VerifyResult {
  ok: boolean;
  /** Exit status of the check command, or null when it was killed on timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

export interface VerifyOptions {
  /** Shell command to run. `{url}` is replaced with the deployment URL. */
  command: string;
  url: string;
  timeoutMs?: number;
  /** Wait this long before the first attempt — propagation is not instant. */
  settleMs?: number;
  /** Try this many times before calling it failed. */
  attempts?: number;
  /** Gap between attempts. */
  intervalMs?: number;
}

/**
 * Run the verification command, retrying while it fails.
 *
 * Retries exist because "not ready yet" and "broken" look identical for the first few
 * seconds after a deployment goes live, and rolling back a healthy build because a CDN
 * edge had not caught up would be a considerably worse failure than the one being
 * guarded against.
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const intervalMs = options.intervalMs ?? 3000;
  const command = options.command.replaceAll('{url}', options.url);

  if (options.settleMs) {
    info(c.dim(`  settling ${Math.round(options.settleMs / 1000)}s before verifying…`));
    await sleep(options.settleMs);
  }

  let last: VerifyResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await runOnce(command, options.timeoutMs ?? 30_000);
    if (last.ok) {
      info(`  ${c.green('verify')}  ${c.dim(`${command}  (${last.ms}ms)`)}`);
      return last;
    }
    if (attempt < attempts) {
      info(
        `  ${c.yellow('verify')}  ${c.dim(
          `attempt ${attempt}/${attempts} failed (${describeCode(last)}), retrying in ${duration(intervalMs)}…`,
        )}`,
      );
      await sleep(intervalMs);
    }
  }
  return last!;
}

function describeCode(result: VerifyResult): string {
  if (result.timedOut) return 'timed out';
  return `exit ${result.code}`;
}

/** Sub-second waits shown in ms, so a short interval does not read as "in 0s". */
function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Which shell runs the check.
 *
 * `shell: true` picks cmd.exe on Windows, and a health check written the way everyone
 * writes them — `curl -sf {url} -o /dev/null` — then fails with curl exit 23 on a URL
 * that is perfectly healthy. A verification that reports a working deployment as broken
 * is worse than no verification at all, since with `--on-fail rollback` it would revert
 * a good build.
 *
 * So when the surrounding session is a POSIX shell (Git Bash, WSL, anything that sets
 * `SHELL`), that shell runs the check and the usual idioms work. Otherwise the platform
 * default stands, and cmd.exe syntax is what applies.
 */
function verifyShell(): string | boolean {
  if (process.platform !== 'win32') return true;
  const shell = process.env.SHELL;
  if (shell && /(^|[\\/])(ba|z|)sh(\.exe)?$/i.test(shell) && existsSync(shell)) return shell;
  return true;
}

/**
 * One attempt.
 *
 * Output is captured rather than inherited so it can be shown as part of the failure
 * report. A check whose output scrolled past before the rollback message is no better
 * than no check.
 */
function runOnce(command: string, timeoutMs: number): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      shell: verifyShell(),
      // Fully captured: the body of a 500 is the single most useful thing here.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // The shell is the parent of the real process, so killing it alone leaves curl
      // running and the promise unresolved.
      killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();

    const settle = (code: number | null) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ms: Date.now() - started,
        timedOut,
      });
    };

    child.on('error', (err) => {
      stderr += String(err.message);
      settle(null);
    });
    child.on('close', settle);
  });
}

/**
 * Print what a failed check actually returned.
 *
 * This is the reason to fold verification into the tool at all. "Deployment failed
 * verification" repeats what you already know; the response body is what tells you
 * which environment variable is missing.
 */
export function reportFailure(result: VerifyResult, command: string): void {
  out('');
  out(c.red('  Verification failed.'));
  out(`  ${c.dim('command')} ${command}`);
  out(`  ${c.dim('result ')} ${result.timedOut ? 'timed out' : `exit ${result.code}`}  ${c.dim(`${result.ms}ms`)}`);

  const body = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (body) {
    out('');
    // Bounded: a check that dumps a megabyte of HTML should not bury the summary that
    // follows it, and the first lines carry the error in every case worth reading.
    const lines = body.split('\n');
    for (const line of lines.slice(0, 20)) out(`  ${c.dim('│')} ${line.slice(0, 200)}`);
    if (lines.length > 20) out(`  ${c.dim(`│ … ${lines.length - 20} more lines`)}`);
  }
  out('');
}
