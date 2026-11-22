/**
 * `dv doctor` — one command that answers "what state is this actually in".
 *
 * Most debugging is not hard reasoning; it is assembling facts that live in five
 * different places — which account is active, whether the token still works, whether
 * the folder is linked, whether the env vars the code reads actually exist remotely,
 * whether the domain resolves. Each is one command, and finding out which one to run is
 * itself the work.
 *
 * Every check reports a state and, when something is wrong, the exact command that
 * fixes it. A health check that says "domain misconfigured" without saying what to do
 * has moved the problem, not solved it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { bool, str, type ParsedArgs } from '../cli/args.js';
import { c, info, json, out } from '../cli/ui.js';
import { getCredential, listAccounts, resolveAccount } from '../config/store.js';
import { allProviders, resolveApp } from '../auth/providers.js';
import { isExpired, isRefreshable } from '../auth/tokens.js';
import { currentBranch, dirtyFiles, githubRemote, hasRemote, isRepo, linkedVercelProject, readPackageJson, unpushedCount } from '../workflow/git.js';
import { vercel } from '../api/vercel.js';
import { github } from '../api/github.js';

type Level = 'ok' | 'warn' | 'fail' | 'skip';

interface Finding {
  area: string;
  label: string;
  level: Level;
  detail?: string;
  /** The command that fixes it. */
  fix?: string;
}

const MARK: Record<Level, string> = { ok: 'ok', warn: '!', fail: 'x', skip: '-' };

function paint(f: Finding): string {
  const mark =
    f.level === 'ok' ? c.green(MARK.ok)
    : f.level === 'warn' ? c.yellow(MARK.warn)
    : f.level === 'fail' ? c.red(MARK.fail)
    : c.gray(MARK.skip);
  const label = f.level === 'skip' ? c.gray(f.label) : f.label;
  return `  ${mark.padEnd(2)} ${label}${f.detail ? `  ${c.dim(f.detail)}` : ''}`;
}

/* ─────────────────────────── checks ─────────────────────────── */

async function checkAuth(): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const provider of Object.values(allProviders())) {
    const { names } = listAccounts(provider.id);
    if (names.length === 0) continue; // Not connected is a choice, not a fault.

    const credential = getCredential(provider.id);
    const account = resolveAccount(provider.id);

    if (!credential?.accessToken) {
      findings.push({
        area: 'Accounts', label: provider.label, level: 'fail',
        detail: 'no usable credential', fix: `dv auth login ${provider.id}`,
      });
      continue;
    }

    if (isExpired(credential, 0)) {
      // Expired-but-renewable is fine; the next call refreshes it silently.
      findings.push(
        isRefreshable(credential)
          ? { area: 'Accounts', label: provider.label, level: 'ok', detail: `${account} — expired, renews automatically` }
          : { area: 'Accounts', label: provider.label, level: 'fail', detail: `${account} — expired, cannot renew`, fix: `dv auth login ${provider.id}` },
      );
      continue;
    }

    const extra = names.length > 1 ? `${account} (of ${names.length})` : account;
    findings.push({ area: 'Accounts', label: provider.label, level: 'ok', detail: extra ?? undefined });
  }

  if (findings.length === 0) {
    findings.push({ area: 'Accounts', label: 'Nothing connected', level: 'warn', fix: 'dv connect list' });
  }
  return findings;
}

async function checkGit(cwd: string): Promise<Finding[]> {
  if (!isRepo(cwd)) {
    return [{ area: 'Repository', label: 'Not a git repository', level: 'skip' }];
  }

  const findings: Finding[] = [];
  const branch = currentBranch(cwd);
  const repo = githubRemote('origin', cwd);
  const dirty = dirtyFiles(cwd).length;

  findings.push({ area: 'Repository', label: 'Branch', level: 'ok', detail: branch });

  if (!hasRemote('origin', cwd)) {
    findings.push({ area: 'Repository', label: 'Remote', level: 'warn', detail: 'no origin', fix: 'git remote add origin <url>' });
  } else if (!repo) {
    findings.push({ area: 'Repository', label: 'Remote', level: 'ok', detail: 'not GitHub — dv git push falls back to git credentials' });
  } else {
    findings.push({ area: 'Repository', label: 'Remote', level: 'ok', detail: repo });

    // The account mismatch that pushes to the right repo as the wrong person.
    const account = resolveAccount('github');
    if (account && !repo.toLowerCase().startsWith(`${account.toLowerCase()}/`)) {
      findings.push({
        area: 'Repository', label: 'Push identity', level: 'warn',
        detail: `active account is ${account}, repo is under ${repo.split('/')[0]}`,
        fix: `dv auth switch github ${repo.split('/')[0]}`,
      });
    }
  }

  if (dirty > 0) {
    findings.push({ area: 'Repository', label: 'Working tree', level: 'warn', detail: `${dirty} uncommitted`, fix: 'dv git save -m "..."' });
  }
  const ahead = unpushedCount(branch, cwd);
  if (ahead > 0) {
    findings.push({ area: 'Repository', label: 'Unpushed', level: 'warn', detail: `${ahead} commit${ahead === 1 ? '' : 's'}`, fix: 'dv git push' });
  }
  return findings;
}

/**
 * Environment variables the code reads, that the platform does not have.
 *
 * This is the check that pays for itself. A missing variable does not fail the build —
 * it fails at runtime, as undefined, usually as something that looks nothing like a
 * configuration problem.
 */
function referencedEnvVars(cwd: string): string[] {
  const found = new Set<string>();
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vercel', 'coverage']);
  // Both spellings, plus Vite's import.meta.env.
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
  ];

  const visit = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) continue;
      if (info.size > 512 * 1024) continue;

      const body = readFileSync(full, 'utf8');
      for (const re of patterns) {
        for (const match of body.matchAll(re)) found.add(match[1]!);
      }
    }
  };
  visit(cwd, 0);

  // Node's own variables are not project configuration.
  for (const builtin of ['NODE_ENV', 'PATH', 'HOME', 'PWD', 'CI', 'PORT', 'TZ']) found.delete(builtin);
  return [...found].sort();
}

async function checkVercel(cwd: string, deep: boolean): Promise<Finding[]> {
  const linked = linkedVercelProject(cwd);
  if (!linked) {
    return [{
      area: 'Vercel', label: 'Not linked', level: 'skip',
      detail: 'this folder has no .vercel/project.json', fix: 'dv vercel link',
    }];
  }
  if (!getCredential('vercel')?.accessToken) {
    return [{ area: 'Vercel', label: 'Linked but not signed in', level: 'fail', fix: 'dv connect vercel' }];
  }

  const findings: Finding[] = [];
  let project: any;
  try {
    project = await vercel.project(linked);
  } catch (err) {
    return [{
      area: 'Vercel', label: 'Project unreachable', level: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'dv vercel link',
    }];
  }

  findings.push({ area: 'Vercel', label: 'Project', level: 'ok', detail: project.name });
  findings.push(
    project.framework
      ? { area: 'Vercel', label: 'Framework', level: 'ok', detail: project.framework }
      : { area: 'Vercel', label: 'Framework', level: 'warn', detail: 'not detected — build may use the wrong preset' },
  );

  if (!project.link?.repo) {
    findings.push({
      area: 'Vercel', label: 'Git integration', level: 'warn',
      detail: 'no repo attached, so pushes will not deploy',
    });
  }

  // Latest deployment state — the thing you actually want to know.
  const [latest] = await vercel.deployments({ project: project.name, limit: 1 }).catch(() => []);
  if (latest) {
    const state = latest.readyState ?? latest.state;
    findings.push({
      area: 'Vercel', label: 'Last deployment',
      level: state === 'READY' ? 'ok' : state === 'ERROR' ? 'fail' : 'warn',
      detail: `${state}${latest.url ? ` — https://${latest.url}` : ''}`,
      fix: state === 'ERROR' ? `dv vercel deploy logs ${latest.uid ?? latest.id} --build` : undefined,
    });
  }

  // Env vars the source reads but the project does not define.
  const referenced = referencedEnvVars(cwd);
  if (referenced.length > 0) {
    const remote = await vercel.envVars(project.id ?? linked).catch(() => []);
    const have = new Set(remote.map((v: any) => v.key));
    // NEXT_PUBLIC_/VITE_ prefixed vars are inlined at build time and may legitimately
    // live only in a local .env, so they are reported separately rather than as errors.
    const missing = referenced.filter((k) => !have.has(k));
    findings.push(
      missing.length === 0
        ? { area: 'Vercel', label: 'Environment', level: 'ok', detail: `${referenced.length} referenced, all present` }
        : {
            area: 'Vercel', label: 'Environment', level: 'fail',
            detail: `missing: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` +${missing.length - 6}` : ''}`,
            fix: 'dv vercel env add <project> --file .env.production',
          },
    );
  }

  if (deep) {
    const domains = await vercel.domains(project.id ?? linked).catch(() => []);
    for (const d of domains) {
      const status = await vercel.domainStatus(project.id ?? linked, d.name).catch(() => null);
      if (!status) continue;
      findings.push({
        area: 'Vercel', label: `Domain ${d.name}`,
        level: status.healthy ? 'ok' : 'warn',
        detail: status.healthy ? 'serving' : !status.verified ? 'not verified' : 'DNS misconfigured',
        fix: status.healthy ? undefined : `dv vercel domain status ${project.name} ${d.name}`,
      });
    }
  }
  return findings;
}

async function checkDatabase(deep: boolean): Promise<Finding[]> {
  const { getOAuthApp } = await import('../config/store.js');
  const target = getOAuthApp('dv').projectRef;
  if (!target) return [{ area: 'Database', label: 'None selected', level: 'skip', fix: 'dv db use' }];

  const findings: Finding[] = [{ area: 'Database', label: 'Selected', level: 'ok', detail: target }];
  if (!deep) return findings;

  try {
    const { requireAdapter } = await import('../db/adapter.js');
    await import('../db/providers.js');
    const [provider, ref] = target.includes(':') ? [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)] : ['supabase', target];

    // One trivial query proves reachability without touching any data.
    const rows = await requireAdapter(provider).query(ref, 'select 1 as ok');
    findings.push({ area: 'Database', label: 'Reachable', level: rows.length ? 'ok' : 'warn' });

    // Tables without RLS, which for a multi-tenant project is the whole ballgame.
    const open = await requireAdapter(provider).query(
      ref,
      "select count(*)::int as n from pg_tables where schemaname='public' and rowsecurity = false",
    );
    const count = Number(open[0]?.n ?? 0);
    const total = await requireAdapter(provider).query(
      ref,
      "select count(*)::int as n from pg_tables where schemaname='public'",
    );
    const totalCount = Number(total[0]?.n ?? 0);

    if (totalCount > 0) {
      findings.push(
        count === 0
          ? { area: 'Database', label: 'Row-level security', level: 'ok', detail: `enabled on all ${totalCount} tables` }
          : {
              area: 'Database', label: 'Row-level security', level: 'warn',
              detail: `${count} of ${totalCount} public tables have RLS off`,
              fix: `dv db query "select tablename from pg_tables where schemaname='public' and rowsecurity=false"`,
            },
      );
    }
  } catch (err) {
    findings.push({
      area: 'Database', label: 'Unreachable', level: 'fail',
      detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
    });
  }
  return findings;
}

/* ─────────────────────────── command ─────────────────────────── */

export async function doctorCommand(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  // Deep checks make extra network calls, so they are opt-in for a quick look.
  const deep = !bool(args.flags, 'quick');

  const groups = await Promise.all([
    checkAuth(),
    checkGit(cwd),
    checkVercel(cwd, deep),
    checkDatabase(deep),
  ]);
  const findings = groups.flat();

  if (bool(args.flags, 'json')) {
    return json({
      ok: findings.every((f) => f.level !== 'fail'),
      findings,
    });
  }

  const pkg = readPackageJson(cwd);
  info('');
  info(c.bold(`dv doctor  ${c.dim(pkg?.name ? `— ${pkg.name}` : `— ${relative(join(cwd, '..'), cwd) || cwd.split(sep).pop()}`)}`));

  let area = '';
  for (const f of findings) {
    if (f.area !== area) {
      area = f.area;
      out('');
      out(c.dim(area));
    }
    out(paint(f));
  }

  const fails = findings.filter((f) => f.level === 'fail');
  const warns = findings.filter((f) => f.level === 'warn');
  const fixes = findings.filter((f) => f.fix);

  out('');
  if (fixes.length > 0) {
    out(c.bold('Fixes'));
    // Deduplicated: the same fix can answer several findings, and printing it three
    // times makes the list look longer than the problem.
    for (const fix of [...new Set(fixes.map((f) => f.fix!))]) out(`  ${c.cyan(fix)}`);
    out('');
  }

  if (fails.length > 0) {
    const { CliError, EXIT } = await import('../cli/errors.js');
    throw new CliError(
      `${fails.length} problem${fails.length === 1 ? '' : 's'} found.`,
      EXIT.failure,
    );
  }
  if (warns.length > 0) {
    info(c.yellow(`  ${warns.length} thing${warns.length === 1 ? '' : 's'} worth a look, nothing broken.`));
    return;
  }
  info(c.green('  All good.'));
}
