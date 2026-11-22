/**
 * Run dv as a child of itself and capture what it printed.
 *
 * Used by anything that drives dv on someone else's behalf — the `ask` agent loop and the
 * MCP server. Going through a fresh process rather than calling a handler in-process is
 * the point: the child runs `main()` exactly as a person typing would, so policy is
 * assessed before the handler, every write lands in the journal, and the exit code means
 * what the exit-code contract says it means. Nothing the caller does can skip a step.
 *
 * It also keeps a handler's stray `process.stdout.write` out of a stream the caller owns,
 * which for an MCP server over stdio would corrupt the protocol.
 */

import { spawn } from 'node:child_process';

import { killTree } from '../workflow/git.js';

export interface SelfExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the run was ended because it took longer than allowed. */
  timedOut: boolean;
}

export interface SelfExecOptions {
  cwd?: string;
  /** Milliseconds before the child is killed. Unlimited when omitted. */
  timeoutMs?: number;
  /** Extra environment for the child, on top of this process's own. */
  env?: Record<string, string>;
}

/** The entry script of the dv that is running now, so the child is the same build. */
function entryScript(): string {
  const script = process.argv[1];
  if (!script) throw new Error('Cannot locate the dv entry script to re-run it.');
  return script;
}

export function runSelf(argv: string[], options: SelfExecOptions = {}): Promise<SelfExecResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entryScript(), ...argv], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group on POSIX, so a timeout can end anything it started.
      detached: process.platform !== 'win32',
      // Colour is disabled rather than stripped afterwards, so the text the reader sees
      // is the text a person sees, without escape codes eating the output budget.
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...options.env },
    });

    // Kept apart and joined by the caller, never merged as chunks arrive. They are two
    // pipes with independent buffering, so interleaving by arrival order scrambles them —
    // a table's header, then a summary line from stderr, then the table's rows.
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, options.timeoutMs)
      : undefined;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: stderr + err.message, exitCode: 1, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? (timedOut ? 1 : 0), timedOut });
    });
  });
}

/** Split a display line back into arguments, honouring quotes. */
export function splitArgs(line: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    parts.push(match[1] ?? match[2] ?? '');
  }
  return parts;
}
