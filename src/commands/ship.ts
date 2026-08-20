/**
 * `dv ship` — the cross-service deploy workflow.
 *
 * This is the reason the CLI exists rather than being three thin API wrappers. Each
 * individual call is easy; the sequence is not, because it spans git, GitHub, Vercel
 * and the running site, and every one of them has a different idea of what "done"
 * means. Getting the waits right is most of the work:
 *
 *  - GitHub reports check runs per commit SHA, and reports *none* for a few seconds
 *    after a push, which reads identically to "all passed" if you do not allow for it.
 *  - Vercel builds are triggered by the git push, not by this CLI, so the step is to
 *    find the deployment for our SHA rather than to create one.
 *  - A deployment being READY means the build finished, not that the site serves —
 *    hence the separate health check.
 */

import { UsageError } from '../cli/errors.js';
import { bool, negated, num, str, type ParsedArgs } from '../cli/args.js';
import { c, confirm, info, json, out, success } from '../cli/ui.js';
import { runWorkflow, summary, type Step } from '../workflow/engine.js';
import {
  currentBranch,
  dirtyFiles,
  git,
  githubRemote,
  hasScript,
  headSha,
  isRepo,
  readPackageJson,
  run,
  tail,
  unpushedCount,
} from '../workflow/git.js';
import { github } from '../api/github.js';
import { vercel } from '../api/vercel.js';

interface ShipContext {
  cwd: string;
  branch: string;
  sha: string;
  repo: string | null;
  /** Vercel project name, if one is involved. */
  project?: string;
  prNumber?: number;
  prUrl?: string;
  deploymentUrl?: string;
  healthStatus?: number;
  flags: ParsedArgs['flags'];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `check` returns a value, or the deadline passes. */
async function waitFor<T>(
  check: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs: number; onTimeout: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== null) return result;
    if (Date.now() >= deadline) throw new Error(opts.onTimeout);
    await sleep(opts.intervalMs);
  }
}

function steps(): Step<ShipContext>[] {
  return [
    {
      name: 'Git status clean',
      skip: (ctx) => (bool(ctx.flags, 'allow-dirty') ? 'allowed by --allow-dirty' : false),
      async run(ctx) {
        const dirty = dirtyFiles(ctx.cwd);
        if (dirty.length > 0) {
          throw new Error(
            `${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}. ` +
              'Commit them, or pass --allow-dirty.',
          );
        }
        return `${ctx.branch} at ${ctx.sha.slice(0, 7)}`;
      },
    },

    {
      name: 'Tests passed',
      skip: (ctx) => {
        if (bool(ctx.flags, 'skip-tests')) return 'skipped by flag';
        if (!hasScript('test', ctx.cwd)) return 'no test script';
        return false;
      },
      async run(ctx) {
        const result = run('npm', ['test', '--silent'], ctx.cwd);
        if (!result.ok) throw new Error(`\n${tail(result.output, 12)}`);
        return undefined;
      },
    },

    {
      name: 'Build successful',
      skip: (ctx) => {
        if (bool(ctx.flags, 'skip-build')) return 'skipped by flag';
        if (!hasScript('build', ctx.cwd)) return 'no build script';
        return false;
      },
      async run(ctx) {
        const result = run('npm', ['run', 'build', '--silent'], ctx.cwd);
        if (!result.ok) throw new Error(`\n${tail(result.output, 12)}`);
        return undefined;
      },
    },

    {
      name: 'Pushed to origin',
      skip: (ctx) => (negated(ctx.flags, 'push') ? 'skipped by flag' : false),
      async run(ctx) {
        const ahead = unpushedCount(ctx.branch, ctx.cwd);
        if (ahead === 0) return `${ctx.branch} already up to date`;
        // -1 means no upstream yet, so the push has to create one.
        const args =
          ahead === -1
            ? ['push', '--set-upstream', 'origin', ctx.branch]
            : ['push', 'origin', ctx.branch];
        const result = git(args, ctx.cwd);
        if (!result.ok) throw new Error(tail(result.err, 4) || 'git push failed');
        return ahead === -1 ? `${ctx.branch} (new branch)` : `${ahead} commit${ahead === 1 ? '' : 's'}`;
      },
    },

    {
      name: 'Pull request open',
      skip: (ctx) => {
        if (negated(ctx.flags, 'pr')) return 'skipped by flag';
        if (!ctx.repo) return 'no GitHub remote';
        if (ctx.branch === (str(ctx.flags, 'base') ?? 'main')) return 'already on the base branch';
        return false;
      },
      async run(ctx) {
        const base = str(ctx.flags, 'base') ?? (await github.getRepo(ctx.repo!)).default_branch;

        // Reuse an open PR rather than failing on GitHub's "already exists" — running
        // ship twice on a branch is normal, not an error.
        const existing = await github.listPulls(ctx.repo!, { state: 'open', limit: 100 });
        const match = existing.find((p: any) => p.head?.ref === ctx.branch);
        if (match) {
          ctx.prNumber = match.number;
          ctx.prUrl = match.html_url;
          return `#${match.number} (existing)`;
        }

        const pr = await github.createPull(ctx.repo!, {
          title: str(ctx.flags, 'title') ?? ctx.branch,
          head: ctx.branch,
          base,
          body: str(ctx.flags, 'body'),
          draft: bool(ctx.flags, 'draft'),
        });
        ctx.prNumber = pr.number;
        ctx.prUrl = pr.html_url;
        return `#${pr.number} -> ${base}`;
      },
    },

    {
      name: 'CI passed',
      skip: (ctx) => {
        if (negated(ctx.flags, 'ci')) return 'skipped by flag';
        if (!ctx.repo) return 'no GitHub remote';
        return false;
      },
      async run(ctx) {
        const timeoutMs = num(ctx.flags, 'ci-timeout', 900) * 1000;
        const started = Date.now();

        const result = await waitFor(
          async () => {
            const runs = await github.listRuns(ctx.repo!, { limit: 30 });
            const mine = runs.filter((r: any) => r.head_sha === ctx.sha);

            // No runs yet is ambiguous: the push may not have registered. Treat the
            // first 20 seconds as "still starting" rather than as success.
            if (mine.length === 0) {
              return Date.now() - started > 20_000 ? { none: true } : null;
            }
            const pending = mine.filter((r: any) => r.status !== 'completed');
            if (pending.length > 0) return null;

            const failed = mine.filter(
              (r: any) => r.conclusion !== 'success' && r.conclusion !== 'skipped',
            );
            return { failed, total: mine.length };
          },
          {
            timeoutMs,
            intervalMs: 5000,
            onTimeout: `CI did not finish within ${timeoutMs / 1000}s`,
          },
        );

        if ((result as any).none) return 'no workflows for this commit';
        const { failed, total } = result as { failed: any[]; total: number };
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} of ${total} failed: ${failed.map((r: any) => r.name).join(', ')}`,
          );
        }
        return `${total} check${total === 1 ? '' : 's'}`;
      },
    },

    {
      name: 'Deployment ready',
      skip: (ctx) => {
        if (negated(ctx.flags, 'deploy')) return 'skipped by flag';
        if (!ctx.project) return 'no Vercel project (use --project)';
        return false;
      },
      async run(ctx) {
        const timeoutMs = num(ctx.flags, 'deploy-timeout', 900) * 1000;
        const started = Date.now();

        const deployment = await waitFor(
          async () => {
            const list = await vercel.deployments({ project: ctx.project, limit: 20 });
            // Vercel builds from the git push, so the deployment is found by SHA
            // rather than created here. Matching on the SHA is what ties it to the
            // commit we just shipped instead of whatever deployed most recently.
            const mine = list.find((d: any) => d.meta?.githubCommitSha === ctx.sha);
            if (!mine) return Date.now() - started > 60_000 ? { missing: true } : null;

            const state = mine.readyState ?? mine.state;
            if (state === 'READY') return mine;
            if (state === 'ERROR' || state === 'CANCELED') {
              throw new Error(
                `deployment ${state.toLowerCase()} - dv vercel deploy logs ${mine.uid ?? mine.id}`,
              );
            }
            return null;
          },
          {
            timeoutMs,
            intervalMs: 5000,
            onTimeout: `deployment did not become ready within ${timeoutMs / 1000}s`,
          },
        );

        if ((deployment as any).missing) {
          throw new Error(
            'no Vercel deployment for this commit - is the project linked to this repo?',
          );
        }
        ctx.deploymentUrl = (deployment as any).url ? `https://${(deployment as any).url}` : undefined;
        return ctx.deploymentUrl;
      },
    },

    {
      name: 'Health check',
      skip: (ctx) => {
        const url = str(ctx.flags, 'health') ?? ctx.deploymentUrl;
        if (negated(ctx.flags, 'health')) return 'skipped by flag';
        if (!url) return 'nothing deployed to check';
        return false;
      },
      async run(ctx) {
        const base = str(ctx.flags, 'health') ?? ctx.deploymentUrl!;
        const path = str(ctx.flags, 'health-path') ?? '/';
        const url = base.startsWith('http') ? new URL(path, base).toString() : base;

        // A deployment reporting READY only means the build finished. Requesting the
        // site is the only way to know it actually serves.
        const res = await fetch(url, { redirect: 'follow' });
        ctx.healthStatus = res.status;
        if (!res.ok) throw new Error(`${url} returned ${res.status}`);
        return `${res.status} ${url}`;
      },
    },
  ];
}

export async function shipCommand(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  if (!isRepo(cwd)) {
    throw new UsageError('Not a git repository.', 'Run dv ship from inside your project.');
  }

  const ctx: ShipContext = {
    cwd,
    branch: currentBranch(cwd),
    sha: headSha(cwd),
    repo: str(args.flags, 'repo') ?? githubRemote('origin', cwd),
    // Defaults to the package name, which is what a Vercel project is usually called.
    project: str(args.flags, 'project', 'p') ?? readPackageJson(cwd)?.name,
    flags: args.flags,
  };

  const dryRun = bool(args.flags, 'dry-run');

  if (!dryRun) {
    info('');
    info(`  ${c.dim('repo   ')} ${ctx.repo ?? c.yellow('none detected')}`);
    info(`  ${c.dim('branch ')} ${ctx.branch}  ${c.dim(ctx.sha.slice(0, 7))}`);
    info(`  ${c.dim('project')} ${ctx.project ?? c.yellow('none detected')}`);

    // This pushes commits and opens a PR, so it confirms unless told not to.
    const ok = await confirm('\nShip it?', bool(args.flags, 'yes', 'y'));
    if (!ok) return info('Cancelled. Nothing was pushed.');
  }

  const result = await runWorkflow(steps(), ctx, { title: 'DevOS Ship', dryRun });
  if (dryRun) return;

  if (bool(args.flags, 'json')) {
    return json({
      branch: ctx.branch,
      sha: ctx.sha,
      repo: ctx.repo,
      pr: ctx.prNumber ? { number: ctx.prNumber, url: ctx.prUrl } : null,
      deployment: ctx.deploymentUrl ?? null,
      health: ctx.healthStatus ?? null,
      steps: result.steps.map((s) => ({ name: s.name, status: s.status, ms: s.ms ?? null })),
    });
  }

  const rows: Array<[string, string]> = [];
  if (ctx.prUrl) rows.push(['Pull request', ctx.prUrl]);
  if (ctx.deploymentUrl) rows.push(['Deployment', ctx.deploymentUrl]);
  if (rows.length > 0) {
    summary(rows);
    out('');
  }
  success('Ship: SUCCESS');
}
