/**
 * Run a dv command once, later, on this machine.
 *
 * For services whose API has no "publish at" (LinkedIn), dv schedules the post
 * itself: a one-time Windows scheduled task runs `dv … --yes` at the chosen minute.
 * The task is set to start as soon as possible if the machine was off at that time,
 * so a post can go out late but is not silently dropped.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { dvHome } from '../config/paths.js';
import { CliError, EXIT } from './errors.js';

export interface LaterJob {
  id: string;
  /** ISO time it should run. */
  at: string;
  /** The dv arguments, without `dv`. */
  argv: string[];
  label: string;
  createdAt: string;
  log: string;
}

export function laterDir(): string {
  const d = join(dvHome(), 'scheduled');
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

const taskName = (id: string) => `dv later ${id}`;

/** The dv entry point this process is running from. */
function dvEntry(): string {
  return resolve(fileURLToPath(new URL('../index.js', import.meta.url)));
}

/** Quote one argument for a .cmd line. Exported for tests. */
export function cmdQuote(a: string): string {
  return `"${a.replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

/**
 * PowerShell that registers the one-time task. Exported for tests.
 *
 * The task starts node directly (`dv later run <id>`), which writes its own log. A
 * wscript/.vbs launcher was tried first and hung under Task Scheduler on Windows 11.
 * S4U runs it without a console window, whether or not anyone is signed in.
 */
export function registerScript(id: string, at: Date, node: string, entry: string, workDir: string, s4u = true): string {
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    `$a = New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps(`"${entry}" later run ${id}`)} -WorkingDirectory ${ps(workDir)}`,
    `$t = New-ScheduledTaskTrigger -Once -At ([datetime]${ps(local)})`,
    `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
    s4u
      ? `$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U; Register-ScheduledTask -TaskName ${ps(taskName(id))} -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`
      : `Register-ScheduledTask -TaskName ${ps(taskName(id))} -Action $a -Trigger $t -Settings $s -Force | Out-Null`,
  ].join('; ');
}

export function scheduleLater(input: { at: Date; argv: string[]; label: string }): LaterJob & { hidden: boolean } {
  if (process.platform !== 'win32') {
    throw new CliError(
      'Scheduling a post is only built for Windows so far.',
      EXIT.usage,
      `Run it at that time with cron or at:  dv ${input.argv.join(' ')} --yes`,
    );
  }
  const id = `l_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const dir = laterDir();
  const log = join(dir, `${id}.log`);
  const argv = [...input.argv, '--yes'];
  const job: LaterJob = { id, at: input.at.toISOString(), argv, label: input.label, createdAt: new Date().toISOString(), log };
  const file = join(dir, `${id}.json`);
  writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`);

  const register = (s4u: boolean) =>
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', registerScript(id, input.at, process.execPath, dvEntry(), dir, s4u)],
      { encoding: 'utf8', windowsHide: true },
    );
  // S4U can be refused by local policy; then fall back to running in the signed-in
  // session, where a console window shows briefly while it posts.
  let hidden = true;
  let r = register(true);
  if (r.status !== 0) {
    hidden = false;
    r = register(false);
  }
  if (r.status !== 0) {
    rmSync(file, { force: true });
    throw new CliError(`Could not create the scheduled task: ${(r.stderr || r.stdout).trim()}`, EXIT.provider);
  }
  return { ...job, hidden };
}

/** Called by the scheduled task: run the job's dv command and log everything. */
export function runLater(id: string): number {
  const dir = laterDir();
  const job = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as LaterJob;
  appendFileSync(job.log, `[${new Date().toISOString()}] dv ${job.argv.join(' ')}\n`);
  const fd = openSync(job.log, 'a');
  try {
    const r = spawnSync(process.execPath, [dvEntry(), ...job.argv], { stdio: ['ignore', fd, fd], windowsHide: true });
    appendFileSync(job.log, `[${new Date().toISOString()}] exit ${r.status ?? 'signal ' + r.signal}\n`);
    return r.status ?? 1;
  } finally {
    closeSync(fd);
  }
}

export function listLater(): (LaterJob & { state: string })[] {
  const dir = laterDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as LaterJob)
    .map((j) => {
      let state = new Date(j.at) > new Date() ? 'scheduled' : 'due';
      try {
        const log = readFileSync(j.log, 'utf8');
        state = /] exit 0/.test(log) ? 'done' : /] exit/.test(log) ? 'failed (see log)' : log.trim() ? 'running' : state;
      } catch {
        /* not run yet */
      }
      return { ...j, state };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function cancelLater(id: string): void {
  const dir = laterDir();
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) throw new CliError(`No scheduled job ${id}.`, EXIT.notFound, 'dv later   lists them');
  spawnSync('schtasks', ['/Delete', '/TN', taskName(id), '/F'], { windowsHide: true });
  rmSync(join(dir, `${id}.json`), { force: true });
}
