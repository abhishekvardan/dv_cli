/**
 * `dv vercel …`
 *
 * Same noun-verb shape as `dv gh`, so knowing one teaches the other.
 */

import { CancelledError, ProviderError, UsageError } from '../cli/errors.js';
import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import { describeShape, resolveCommand, type CommandShape } from '../cli/dispatch.js';
import { ask, c, confirm, info, json, out, relative, select, success, table, warn } from '../cli/ui.js';
import { emit, outputOpts, wantsJson } from '../cli/output.js';
import { basename, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { vercel } from '../api/vercel.js';
import { githubRemote, linkedVercelProject, writeVercelLink } from '../workflow/git.js';
import { humanSize, readIgnoreFile, walkProject } from '../workflow/files.js';
import { reportFailure, verify } from '../workflow/verify.js';
import { record } from '../cli/journal.js';
import { stashSecret } from '../cli/vault.js';

const SHAPE: CommandShape = {
  verbs: {
    project: ['list', 'view', 'create', 'delete'],
    deploy: ['list', 'view', 'logs', 'wait', 'create', 'redeploy', 'rollback', 'cancel'],
    env: ['list', 'get', 'add', 'import', 'diff', 'rm'],
    domain: ['list', 'add', 'rm', 'status'],
    dns: ['list', 'add', 'rm'],
    drain: ['list', 'add', 'rm'],
  },
  standalone: ['whoami', 'link'],
  aliases: {
    projects: ['project', 'list'],
    deployments: ['deploy', 'list'],
    deploys: ['deploy', 'list'],
    redeploy: ['deploy', 'redeploy'],
    domains: ['domain', 'list'],
  },
};

/** Collect the output-shaping flags once, rather than in every case. */
function snapshotOpts(args: ParsedArgs, command = '') {
  return {
    fields: str(args.flags, 'fields'),
    reveal: bool(args.flags, 'reveal'),
    snapshot: str(args.flags, 'snapshot'),
    diff: str(args.flags, 'diff'),
    command,
  };
}

/**
 * Put the last healthy production build back.
 *
 * Skips the deployment that just failed, which the naive "most recent READY" search
 * would happily pick: it did reach READY — the build compiled, the verification is what
 * failed — so excluding it explicitly is what stops the heal from reinstating exactly
 * the thing it is meant to undo.
 *
 * Returns null rather than throwing, because the caller has a much more important thing
 * to say about a failed rollback than a raw API error.
 */
async function healByRollback(project: string, failedId: string): Promise<any | null> {
  try {
    const recent = await vercel.deployments({ project, limit: 20 });
    const target = recent.find(
      (d: any) =>
        (d.target ?? 'preview') === 'production' &&
        String(d.uid ?? d.id) !== failedId &&
        (d.readyState ?? d.state) === 'READY',
    );
    if (!target) return null;

    const created = await vercel.redeploy(target.uid ?? target.id, project, 'production');
    record({
      command: 'vercel deploy create --on-fail rollback',
      provider: 'vercel',
      summary: `Rolled ${project} back to ${target.url ?? target.uid} after failed verification`,
      undo: {
        kind: 'vercel.deploy.rollback',
        args: { deploymentId: failedId, project },
        describe: `Redeploy ${failedId} to production`,
      },
    });
    return created;
  } catch {
    return null;
  }
}

/** Vercel timestamps are epoch milliseconds, not ISO strings. */
function iso(ms: unknown): string | undefined {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : undefined;
}

function stateColor(state: string): string {
  if (state === 'READY') return c.green(state);
  if (state === 'ERROR' || state === 'CANCELED') return c.red(state);
  if (state === 'BUILDING' || state === 'QUEUED' || state === 'INITIALIZING') return c.yellow(state);
  return c.gray(state);
}

/** The project name, from a positional or --project. */
function projectName(rest: string[], args: ParsedArgs, hint: string): string {
  const name = rest[0] ?? str(args.flags, 'project', 'p');
  if (!name) throw new UsageError('Which project?', hint);
  return name;
}

/**
 * Link this directory to a Vercel project, without needing the Vercel CLI.
 *
 * Called from `dv vercel link` and from `dv ship` when nothing is linked yet — being
 * told to go and install another tool mid-deploy is the wrong answer when the CLI is
 * already authenticated and can just ask.
 */
export async function linkProject(
  args: ParsedArgs,
  cwd = process.cwd(),
): Promise<{ projectId: string; projectName: string }> {
  const projects = await vercel.projects(100);
  if (projects.length === 0) {
    throw new UsageError(
      'No Vercel projects on this account.',
      'dv vercel project create my-app --repo owner/name',
    );
  }

  const wanted = str(args.flags, 'project', 'p') ?? args.positional[0];
  let chosen = wanted ? projects.find((p: any) => p.name === wanted || p.id === wanted) : undefined;

  if (wanted && !chosen) {
    throw new UsageError(
      `No Vercel project "${wanted}".`,
      `Yours are: ${projects.slice(0, 10).map((p: any) => p.name).join(', ')}`,
    );
  }

  // A sentinel choice rather than a separate command: needing to leave, create the
  // project, and come back is the friction this whole flow exists to remove.
  const CREATE = Symbol('create');

  if (!chosen) {
    if (!process.stdin.isTTY) {
      throw new UsageError(
        'Which Vercel project should this link to?',
        `dv vercel link --project <name>
Yours are: ${projects
          .slice(0, 10)
          .map((p: any) => p.name)
          .join(', ')}`,
      );
    }
    // Most recently updated first — the one you are working on is usually near the top.
    const ordered = [...projects].sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const picked = await select<any>(
      'Which Vercel project does this directory deploy to?',
      [
        ...ordered.slice(0, 20).map((p: any, i: number) => ({
          value: p,
          label: p.name,
          detail: p.framework ?? undefined,
          recommended: i === 0,
        })),
        { value: CREATE, label: '+ Create a new project', detail: 'on Vercel, from here' },
      ],
    );

    if (picked === CREATE) {
      const suggested = basename(cwd);
      const name = await ask('Project name:', suggested);
      if (!name) throw new UsageError('A project name is required.');

      // Offer the git remote, since a project with no repo never deploys on push.
      const detectedRepo = githubRemote('origin', cwd);
      const repo = await ask('GitHub repo to deploy from (blank for none):', detectedRepo ?? '');

      chosen = await vercel.createProject({
        name,
        framework: str(args.flags, 'framework'),
        gitRepo: repo || undefined,
      });
      success(`Created ${c.bold(chosen.name)} on Vercel`);
      if (!repo) {
        info(c.dim('  No repo linked, so pushes will not deploy it automatically.'));
      }
    } else {
      chosen = picked;
    }
  }

  const path = writeVercelLink(
    { orgId: chosen.accountId, projectId: chosen.id, projectName: chosen.name },
    cwd,
  );
  success(`Linked to ${c.bold(chosen.name)}`);
  info(c.dim(`  ${path}`));
  return { projectId: chosen.id, projectName: chosen.name };
}

/**
 * Parse a dotenv file.
 *
 * Handles `export` prefixes and one layer of matched quotes, which real .env files
 * carry often enough that ignoring them silently sets values with quotes baked in.
 */
function parseDotenv(body: string): Array<{ key: string; value: string }> {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^export\s+/, ''))
    .map((l) => {
      const eq = l.indexOf('=');
      if (eq === -1) return null;
      const key = l.slice(0, eq).trim();
      let value = l.slice(eq + 1).trim();
      if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
      return { key, value };
    })
    .filter((v): v is { key: string; value: string } => v !== null);
}

export async function vercelCommand(args: ParsedArgs): Promise<void> {
  const { key, rest } = resolveCommand(args, SHAPE);
  // --snapshot and --diff consume the JSON payload, so they imply it.
  const asJson = wantsJson(args.flags);

  switch (key) {
    /* ─────────── projects ─────────── */

    case 'project list': {
      const projects = await vercel.projects(num(args.flags, 'limit', 20));
      if (asJson || snapshotOpts(args).snapshot || snapshotOpts(args).diff) {
        return emit(projects, snapshotOpts(args, 'vercel project list'));
      }
      if (projects.length === 0) return info('No Vercel projects.');
      table(projects, [
        { header: 'project', value: (p: any) => c.bold(p.name), max: 32 },
        { header: 'framework', value: (p: any) => p.framework ?? '—' },
        {
          header: 'latest',
          value: (p: any) => (p.latestDeployments?.[0]?.url ? `https://${p.latestDeployments[0].url}` : '—'),
          max: 44,
        },
        { header: 'updated', value: (p: any) => relative(iso(p.updatedAt)) },
      ]);
      return;
    }

    case 'project view': {
      const name = projectName(rest, args, 'dv vercel project view my-app');
      const project = await vercel.project(name);
      if (asJson) return emit(project, outputOpts(args.flags, 'vercel'));
      out(c.bold(project.name));
      out('');
      out(`${c.dim('id        ')} ${project.id}`);
      out(`${c.dim('framework ')} ${project.framework ?? '—'}`);
      out(`${c.dim('node      ')} ${project.nodeVersion ?? '—'}`);
      out(`${c.dim('root dir  ')} ${project.rootDirectory ?? '.'}`);
      if (project.link?.repo) {
        out(`${c.dim('repo      ')} ${project.link.org}/${project.link.repo}`);
      }
      out(`${c.dim('updated   ')} ${relative(iso(project.updatedAt))}`);
      const live = project.latestDeployments?.[0]?.url;
      if (live) out(`${c.dim('latest    ')} https://${live}`);
      return;
    }

    case 'project create': {
      const name = rest[0] ?? str(args.flags, 'name');
      if (!name) {
        throw new UsageError(
          'What should the project be called?',
          'dv vercel project create my-app --repo owner/name',
        );
      }
      const project = await vercel.createProject({
        name,
        framework: str(args.flags, 'framework'),
        gitRepo: str(args.flags, 'repo'),
      });
      if (asJson) return emit(project, outputOpts(args.flags, 'vercel'));
      success(`Created project ${c.bold(project.name)}`);
      out(`https://vercel.com/${project.accountId ?? ''}/${project.name}`.replace('//', '/'));
      if (!str(args.flags, 'repo')) {
        info(c.dim('  No git repo linked. Link one with --repo owner/name to deploy on push.'));
      }
      return;
    }

    case 'project delete': {
      const name = projectName(rest, args, 'dv vercel project delete my-app');
      // Deleting takes the deployments and domains with it, so it is confirmed.
      const ok = await confirm(
        `Delete project ${c.bold(name)} and all its deployments?`,
        bool(args.flags, 'yes', 'y'),
      );
      if (!ok) throw new CancelledError('Cancelled. Nothing was deleted.');
      await vercel.deleteProject(name);
      success(`Deleted ${name}.`);
      return;
    }

    /* ─────────── deployments ─────────── */

    case 'deploy list': {
      const deployments = await vercel.deployments({
        project: rest[0] ?? str(args.flags, 'project', 'p'),
        limit: num(args.flags, 'limit', 10),
      });
      if (asJson) return emit(deployments, outputOpts(args.flags, 'vercel'));
      if (deployments.length === 0) return info('No deployments.');
      table(deployments, [
        { header: 'project', value: (d: any) => d.name, max: 24 },
        { header: 'state', value: (d: any) => stateColor(d.state ?? d.readyState ?? '—') },
        { header: 'target', value: (d: any) => d.target ?? 'preview' },
        { header: 'url', value: (d: any) => (d.url ? `https://${d.url}` : '—'), max: 46 },
        { header: 'when', value: (d: any) => relative(iso(d.created ?? d.createdAt)) },
        { header: 'id', value: (d: any) => c.dim(d.uid ?? d.id ?? '') },
      ]);
      return;
    }

    case 'deploy view': {
      const id = rest[0];
      if (!id) throw new UsageError('Which deployment?', 'dv vercel deploy view <id-or-url>');
      const d = await vercel.deployment(id);
      if (asJson) return emit(d, outputOpts(args.flags, 'vercel'));
      out(c.bold(d.name ?? d.url ?? id));
      out('');
      out(`${c.dim('state   ')} ${stateColor(d.readyState ?? d.state ?? '—')}`);
      out(`${c.dim('target  ')} ${d.target ?? 'preview'}`);
      out(`${c.dim('url     ')} ${d.url ? `https://${d.url}` : '—'}`);
      out(`${c.dim('created ')} ${relative(iso(d.createdAt ?? d.created))}`);
      if (d.meta?.githubCommitMessage) {
        out(`${c.dim('commit  ')} ${String(d.meta.githubCommitMessage).split('\n')[0]}`);
      }
      return;
    }

    case 'deploy logs': {
      const id = rest[0];
      if (!id) throw new UsageError('Which deployment?', 'dv vercel deploy logs <id>');

      // Build logs are the default because they are what the API actually serves.
      // `--runtime` asks for the other thing and says plainly when it is unavailable.
      if (bool(args.flags, 'runtime')) {
        const rows = await vercel.runtimeLogs(id, { limit: num(args.flags, 'limit', 200) });
        if (rows === null) {
          throw new ProviderError(
            'Vercel does not serve historical runtime logs through its API.',
            501,
            [
              'Runtime logs are push-only. To capture them:',
              '  dv vercel drain add <name> <https-url>   set up before the invocation',
              '',
              'For a one-off look, the dashboard has them:',
              `  https://vercel.com/deployments/${id}`,
              '',
              'Build output is available here:',
              `  dv vercel deploy logs ${id}`,
            ].join('\n'),
          );
        }
        if (asJson) return emit(rows, outputOpts(args.flags, 'vercel runtime logs'));
        if (rows.length === 0) return info('No runtime logs in that window.');
        for (const e of rows) {
          const text = e.message ?? e.text ?? '';
          if (!text) continue;
          const stamp = e.timestamp ? c.dim(`${new Date(Number(e.timestamp)).toISOString().slice(11, 19)} `) : '';
          const level = String(e.level ?? '').toLowerCase();
          out(stamp + (level.includes('err') ? c.red(String(text).trimEnd()) : String(text).trimEnd()));
        }
        return;
      }

      const fetchLogs = () => vercel.buildLogs(id, num(args.flags, 'limit', 200));
      const render = (rows: any[]) => {
        for (const e of rows) {
          const text = e.payload?.text ?? e.text ?? '';
          if (!text) continue;
          const when = e.created ?? e.date;
          const stamp = when ? c.dim(`${new Date(Number(when)).toISOString().slice(11, 19)} `) : '';
          const line = String(text).trimEnd();
          out(stamp + (e.type === 'stderr' ? c.red(line) : line));
        }
      };

      if (!bool(args.flags, 'follow', 'f')) {
        const rows = await fetchLogs();
        if (asJson) return emit(rows, outputOpts(args.flags, 'vercel build logs'));
        if (rows.length === 0) return info('No build output for that deployment.');
        return render(rows);
      }

      // Follow: poll and print only what is new, keyed by id so a repeated row is not
      // printed twice.
      info(c.dim('  Following build output. Ctrl-C to stop.'));
      const seen = new Set<string>();
      for (;;) {
        const rows = await fetchLogs().catch(() => []);
        render(
          rows.filter((e: any) => {
            const key = String(e.id ?? `${e.created}-${e.text ?? e.payload?.text}`);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        );
        if (seen.size > 5000) seen.clear();
        await new Promise((r) => setTimeout(r, num(args.flags, 'interval', 3) * 1000));
      }
    }

    case 'deploy wait': {
      const id = rest[0];
      if (!id) throw new UsageError('Which deployment?', 'dv vercel deploy wait <id>');

      let lastState = '';
      const deployment = await vercel.waitForDeployment(id, {
        timeoutMs: num(args.flags, 'timeout', 900) * 1000,
        onTick: (state, ms) => {
          // Only on change, so a fifteen-minute build is not fifteen minutes of noise.
          if (state === lastState) return;
          lastState = state;
          info(`  ${stateColor(state)}  ${c.dim(`${Math.round(ms / 1000)}s`)}`);
        },
      });

      const state = deployment.readyState ?? deployment.state;
      if (asJson) return emit(deployment, { fields: str(args.flags, 'fields'), reveal: bool(args.flags, 'reveal') });
      if (state === 'READY') {
        success(`Ready — ${deployment.url ? `https://${deployment.url}` : id}`);
        return;
      }
      // A finished-but-failed deploy is not a success, and the exit code has to say so.
      throw new ProviderError(
        `Deployment ${String(state).toLowerCase()}.`,
        502,
        `dv vercel deploy logs ${id}`,
      );
    }

    case 'domain status': {
      const project = projectName(rest, args, 'dv vercel domain status my-app example.com');
      const domain = rest[1] ?? str(args.flags, 'domain');
      if (!domain) throw new UsageError('Which domain?', 'dv vercel domain status my-app example.com');

      const status = await vercel.domainStatus(project, domain);
      if (asJson) return emit(status, { fields: str(args.flags, 'fields') });

      out(c.bold(domain));
      out('');
      const mark = (ok: boolean) => (ok ? c.green('yes') : c.red('no'));
      out(`${c.dim('attached  ')} ${mark(status.attachedToProject)}`);
      out(`${c.dim('verified  ')} ${mark(status.verified)}`);
      out(`${c.dim('dns ok    ')} ${mark(!status.misconfigured)}`);
      out('');
      out(status.healthy ? c.green('  Serving.') : c.yellow('  Not serving yet.'));

      // The actionable part: what DNS is expected versus what is there.
      if (!status.healthy) {
        if (status.verification?.length) {
          out('');
          out(c.dim('  Add these records:'));
          for (const v of status.verification) {
            out(`    ${v.type ?? '?'}  ${v.domain ?? ''}  ${v.value ?? ''}`);
          }
        }
        if (status.intendedNameservers?.length) {
          out('');
          out(c.dim(`  Expected nameservers: ${status.intendedNameservers.join(', ')}`));
          out(c.dim(`  Currently:            ${status.nameservers?.join(', ') || 'none'}`));
        }
      }
      return;
    }

    case 'deploy create': {
      const dir = rest[0] ? resolve(rest[0]) : process.cwd();
      if (!existsSync(dir)) throw new UsageError(`No such directory: ${dir}`);

      const project =
        str(args.flags, 'project', 'p') ??
        linkedVercelProject(dir) ??
        basename(dir);

      // Ignore rules come from the project, so a deploy respects what the repo already
      // says rather than a list baked into this tool.
      const ignore = [
        ...readIgnoreFile(dir, '.vercelignore'),
        ...(bool(args.flags, 'no-gitignore') ? [] : readIgnoreFile(dir, '.gitignore')),
      ];

      // A prebuilt deploy ships `.vercel/output` as produced by the Build Output API,
      // and Vercel skips the remote build entirely. Much faster to iterate on, and it
      // deploys exactly the artefact you tested rather than a fresh remote rebuild.
      const prebuilt = bool(args.flags, 'prebuilt');
      const outputDir = join(dir, '.vercel', 'output');
      if (prebuilt && !existsSync(outputDir)) {
        throw new UsageError(
          'No .vercel/output to deploy.',
          'Build it first, e.g. `npx vercel build`, then run this again.',
        );
      }

      info(c.dim(`  Scanning ${prebuilt ? outputDir : dir}…`));
      const files = prebuilt
        ? walkProject(outputDir, {}).map((f) => ({ ...f, file: `.vercel/output/${f.file}` }))
        : walkProject(dir, { ignore });
      if (files.length === 0) throw new UsageError('Nothing to deploy — every file was ignored.');

      const total = files.reduce((n, f) => n + f.size, 0);
      const target = bool(args.flags, 'preview') ? 'preview' : 'production';

      out(`${c.dim('project ')} ${project}`);
      out(`${c.dim('files   ')} ${files.length}  ${c.dim(`(${humanSize(total)})`)}`);
      out(`${c.dim('target  ')} ${target}`);
      if (bool(args.flags, 'list')) {
        out('');
        for (const f of files.slice(0, 50)) out(`  ${c.dim(humanSize(f.size).padStart(9))}  ${f.file}`);
        if (files.length > 50) out(c.dim(`  … and ${files.length - 50} more`));
      }
      out('');

      const ok = await confirm(`Deploy to ${target}?`, bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Nothing was deployed.');

      // Uploaded a few at a time with per-file reporting. One giant payload gives no
      // progress and, when it fails, no indication which file was the problem.
      let done = 0;
      let uploaded = 0;
      const failures: Array<{ file: string; error: string }> = [];
      const concurrency = num(args.flags, 'concurrency', 8);
      const queue = [...files];

      const worker = async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          try {
            await vercel.uploadFile(next.sha, next.size, readFileSync(next.absolute));
            uploaded += next.size;
          } catch (err) {
            failures.push({ file: next.file, error: err instanceof Error ? err.message : String(err) });
          }
          done++;
          if (process.stderr.isTTY) {
            process.stderr.write(
              `\r\u001b[2K  uploading ${done}/${files.length}  ${c.dim(`${humanSize(uploaded)} of ${humanSize(total)}`)}`,
            );
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
      if (process.stderr.isTTY) process.stderr.write('\r\u001b[2K');

      if (failures.length > 0) {
        // Named individually: "the upload failed" is not actionable when it was one
        // file out of three hundred.
        for (const f of failures.slice(0, 10)) warn(`${f.file}: ${f.error}`);
        throw new ProviderError(`${failures.length} of ${files.length} files failed to upload.`, 502);
      }
      success(`Uploaded ${files.length} files (${humanSize(total)}).`);

      const deployment = await vercel.createDeployment({
        name: project,
        files: files.map((f) => ({ file: f.file, sha: f.sha, size: f.size })),
        target,
        // Tells Vercel the tree is already built, so it serves the output rather than
        // running a build step over it.
        ...(prebuilt ? { projectSettings: { framework: null } } : {}),
      });

      const url = deployment.url ? `https://${deployment.url}` : deployment.id;
      success(`Deployment created — ${url}`);

      if (!bool(args.flags, 'wait')) {
        info(c.dim(`  dv vercel deploy wait ${deployment.id}`));
        if (asJson) emit(deployment, { fields: str(args.flags, 'fields') });
        return;
      }

      let lastState = '';
      const finished = await vercel.waitForDeployment(deployment.id, {
        timeoutMs: num(args.flags, 'timeout', 900) * 1000,
        onTick: (state, ms) => {
          if (state === lastState) return;
          lastState = state;
          info(`  ${stateColor(state)}  ${c.dim(`${Math.round(ms / 1000)}s`)}`);
        },
      });
      const state = finished.readyState ?? finished.state;
      if (state !== 'READY') {
        throw new ProviderError(
          `Deployment ${String(state).toLowerCase()}.`,
          502,
          `dv vercel deploy logs ${deployment.id} --build`,
        );
      }
      const liveUrl = finished.url ? `https://${finished.url}` : url;
      success(`Ready — ${liveUrl}`);

      // A build that compiled is not a build that works. Everything below closes that
      // gap: run the check, and put the previous build back if it fails.
      const check = str(args.flags, 'verify');
      if (!check) return;

      const result = await verify({
        command: check,
        url: liveUrl,
        timeoutMs: num(args.flags, 'verify-timeout', 30) * 1000,
        settleMs: num(args.flags, 'settle', 3) * 1000,
        attempts: num(args.flags, 'verify-attempts', 3),
      });

      if (result.ok) {
        success('Verified.');
        return;
      }

      reportFailure(result, check.replaceAll('{url}', liveUrl));

      const onFail = str(args.flags, 'on-fail') ?? 'none';
      if (onFail !== 'rollback') {
        info(c.dim(`  Left in place. Pass --on-fail rollback to revert automatically.`));
        info(c.dim(`  dv vercel deploy rollback ${project}`));
        throw new ProviderError('Deployment failed verification.', 502);
      }

      if (target !== 'production') {
        // Rolling back a preview is meaningless — it was never serving anything.
        info(c.dim('  Preview deployment, nothing to roll back.'));
        throw new ProviderError('Deployment failed verification.', 502);
      }

      warn('Rolling back to the last healthy production deployment…');
      const healed = await healByRollback(project, deployment.id);
      if (!healed) {
        // Being loud here matters more than anywhere else in this command. Believing you
        // are back on the previous build when you are not is worse than the broken
        // deploy that started it.
        throw new ProviderError(
          'Rollback failed — the broken deployment is still live.',
          502,
          `dv vercel deploy list ${project}\ndv vercel deploy rollback ${project}`,
        );
      }
      success(`Rolled back to ${healed.url ? `https://${healed.url}` : healed.id}`);
      throw new ProviderError('Deployment failed verification and was rolled back.', 502);
    }

    case 'deploy rollback': {
      const project = projectName(rest, args, 'dv vercel deploy rollback my-app');
      const recent = await vercel.deployments({ project, limit: 20 });

      const production = recent.filter((d: any) => (d.target ?? 'preview') === 'production');
      const current = production[0];
      // The last *good* one, not simply the previous one: rolling back onto another
      // failed build is the classic way to make an incident longer.
      const target = production.find(
        (d: any, i: number) => i > 0 && (d.readyState ?? d.state) === 'READY',
      );

      if (!current) throw new UsageError(`No production deployments for "${project}".`);
      if (!target) {
        throw new UsageError(
          'No earlier healthy production deployment to roll back to.',
          `dv vercel deploy list ${project}`,
        );
      }

      out(`${c.dim('project')} ${project}`);
      out(`${c.dim('current')} ${current.url ? `https://${current.url}` : current.uid}  ${stateColor(current.readyState ?? current.state)}`);
      out(`${c.dim('roll to')} ${target.url ? `https://${target.url}` : target.uid}  ${c.dim(relative(iso(target.created ?? target.createdAt)))}`);
      out('');

      const ok = await confirm('Roll production back to that deployment?', bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Nothing was rolled back.');

      // Redeploying the known-good build is how a rollback is expressed here — there is
      // no "make this one live" call, and rebuilding from source could produce a
      // different artefact than the one being rolled back to.
      const created = await vercel.redeploy(target.uid ?? target.id, project, 'production');
      // Recorded with the id that *was* live, which is the only moment that information
      // is available — after the rollback, "what was serving before" is gone.
      const entry = record({
        command: 'vercel deploy rollback',
        provider: 'vercel',
        summary: `Rolled ${project} back to ${target.url ?? target.uid}`,
        undo: {
          kind: 'vercel.deploy.rollback',
          args: { deploymentId: String(current.uid ?? current.id), project },
          describe: `Redeploy ${current.url ?? current.uid} to production`,
        },
      });

      success(`Rolling back — ${created.url ? `https://${created.url}` : created.id}`);
      info(c.dim(`  dv vercel deploy wait ${created.id}`));
      info(c.dim(`  dv undo ${entry.id}`));
      return;
    }

    case 'env get': {
      const project = projectName(rest, args, 'dv vercel env get my-app API_URL');
      const key = rest[1] ?? str(args.flags, 'key', 'k');
      if (!key) throw new UsageError('Which variable?', 'dv vercel env get my-app API_URL');

      const vars = await vercel.envVars(project);
      const match = vars.find((v: any) => v.key === key);
      if (!match) throw new UsageError(`No variable "${key}" on ${project}.`, `dv vercel env list ${project}`);

      // One value, on request. The listing stays masked; this is the escape hatch for
      // "did I actually set the right thing", without a separate decrypt flow.
      if (!bool(args.flags, 'reveal')) {
        out(`${c.dim('key    ')} ${match.key}`);
        out(`${c.dim('targets')} ${(match.target ?? []).join(', ')}`);
        out(`${c.dim('value  ')} ${c.dim('hidden — pass --reveal')}`);
        return;
      }
      const full = await vercel.envValue(project, match.id);
      out(full?.value ?? '');
      return;
    }

    case 'env diff': {
      const project = projectName(rest, args, 'dv vercel env diff my-app .env.production');
      const file = rest[1] ?? str(args.flags, 'file', 'f') ?? '.env.production';
      if (!existsSync(file)) throw new UsageError(`No such file: ${file}`);

      const local = parseDotenv(readFileSync(file, 'utf8'));
      const remote = await vercel.envVars(project);
      const remoteKeys = new Set(remote.map((v: any) => v.key));
      const localKeys = new Set(local.map((v) => v.key));

      const missing = local.filter((v) => !remoteKeys.has(v.key)).map((v) => v.key);
      const extra = remote.filter((v: any) => !localKeys.has(v.key)).map((v: any) => v.key);

      if (asJson) return emit({ project, file, missing, extra }, outputOpts(args.flags, 'vercel env diff'));

      out(`${c.dim('local ')} ${file}  ${c.dim(`${local.length} variables`)}`);
      out(`${c.dim('remote')} ${project}  ${c.dim(`${remote.length} variables`)}`);
      out('');

      if (missing.length === 0 && extra.length === 0) {
        success('The same keys are set in both.');
        // Values are deliberately not compared: doing so means decrypting every remote
        // value, and printing a diff of secrets is exactly what should not happen.
        info(c.dim('  Keys only — values are not fetched or compared.'));
        return;
      }
      for (const key of missing) out(`  ${c.red('-')} ${key}  ${c.dim('in the file, not on Vercel')}`);
      for (const key of extra) out(`  ${c.yellow('+')} ${key}  ${c.dim('on Vercel, not in the file')}`);
      out('');
      if (missing.length > 0) {
        info(c.dim(`  dv vercel env add ${project} --file ${file} --yes`));
      }
      return;
    }

    case 'deploy redeploy': {
      const project = projectName(rest, args, 'dv vercel deploy redeploy my-app');
      const [latest] = await vercel.deployments({ project, limit: 1 });
      if (!latest) throw new UsageError(`No existing deployment for "${project}" to redeploy.`);

      const target = bool(args.flags, 'preview') ? 'preview' : 'production';
      out(`${c.dim('project')} ${project}`);
      out(`${c.dim('source ')} ${latest.url ? `https://${latest.url}` : latest.uid}`);
      out(`${c.dim('target ')} ${target}`);
      const ok = await confirm(`Redeploy to ${target}?`, bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Not redeployed.');

      const created = await vercel.redeploy(latest.uid ?? latest.id, project, target);
      success(`Redeploying — ${created.url ? `https://${created.url}` : created.id}`);
      info(c.dim(`  dv vercel deploy list ${project}`));
      return;
    }

    case 'deploy cancel': {
      const id = rest[0];
      if (!id) throw new UsageError('Which deployment?', 'dv vercel deploy cancel <id>');
      const ok = await confirm(`Cancel deployment ${id}?`, bool(args.flags, 'yes', 'y'));
      if (!ok) return info('Not cancelled.');
      await vercel.cancelDeployment(id);
      success('Cancelled.');
      return;
    }

    /* ─────────── environment variables ─────────── */

    case 'env list': {
      const project = projectName(rest, args, 'dv vercel env list my-app');
      const vars = await vercel.envVars(project);
      if (asJson || snapshotOpts(args).snapshot || snapshotOpts(args).diff) {
        return emit(vars, snapshotOpts(args, `vercel env list ${project}`));
      }
      if (vars.length === 0) return info('No environment variables.');
      table(vars, [
        { header: 'key', value: (v: any) => v.key, max: 36 },
        { header: 'targets', value: (v: any) => (v.target ?? []).join(',') },
        { header: 'type', value: (v: any) => c.dim(v.type ?? '') },
        { header: 'id', value: (v: any) => c.dim(v.id ?? '') },
      ]);
      info('');
      if (bool(args.flags, 'reveal')) {
        // Fetched one at a time and only on request: the list endpoint returns
        // encrypted blobs, so "did I set the right value" is otherwise unanswerable
        // without leaving the terminal.
        out('');
        for (const v of vars) {
          const full = await vercel.envValue(project, v.id).catch(() => null);
          out(`  ${c.bold(v.key.padEnd(28))} ${full?.value ?? c.dim('(could not decrypt)')}`);
        }
        return;
      }
      info(c.dim('  Values are not shown. Use --reveal to fetch and print them.'));
      return;
    }

    case 'env import':
    case 'env add': {
      // `env import my-app .env` takes the file positionally; `env add --file` keeps
      // the flag form working.
      const fromFile = str(args.flags, 'file', 'f') ?? rest[1];
      if (fromFile) {
        const project = projectName(rest, args, 'dv vercel env add my-app --file .env.production');
        const { readFileSync } = await import('node:fs');
        // .env format: KEY=value, ignoring blanks, comments and an optional `export`.
        const vars = readFileSync(fromFile, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .map((l) => l.replace(/^export\s+/, ''))
          .map((l) => {
            const eq = l.indexOf('=');
            if (eq === -1) return null;
            const key = l.slice(0, eq).trim();
            let value = l.slice(eq + 1).trim();
            // Strip one layer of matched quotes, which .env files routinely carry.
            if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
            return { key, value };
          })
          .filter((v): v is { key: string; value: string } => v !== null);

        if (vars.length === 0) throw new UsageError(`No variables found in ${fromFile}.`);

        const targetFlag = args.flags['target'];
        const target =
          targetFlag === undefined
            ? ['production', 'preview', 'development']
            : Array.isArray(targetFlag)
              ? targetFlag
              : [String(targetFlag)];

        out(`${vars.length} variable${vars.length === 1 ? '' : 's'} from ${fromFile}:`);
        // Names only. Printing the values would put every secret in scrollback.
        for (const v of vars) out(`  ${v.key}`);
        out('');
        const ok = await confirm(`Add to ${project} (${target.join(', ')})?`, bool(args.flags, 'yes', 'y'));
        if (!ok) throw new CancelledError('Nothing was added.');

        const atomic = bool(args.flags, 'atomic');
        const outcome = await vercel.addEnvBulk(
          project,
          vars.map((v) => ({ ...v, target })),
          { atomic },
        );
        const failed = outcome.results.filter((r) => !r.ok);
        for (const r of outcome.results) {
          if (r.ok) success(r.key);
          else warn(`${r.key}: ${r.error}`);
        }

        if (failed.length === 0) return;

        if (outcome.rolledBack?.length) {
          info(c.dim(`  Rolled back: ${outcome.rolledBack.join(', ')}`));
        }
        if (outcome.rollbackFailed?.length) {
          // The worst case, and the one that must never be quiet: the undo failed too,
          // so the project is genuinely half-configured and only you can fix it.
          warn(`Could not roll back: ${outcome.rollbackFailed.join(', ')} — these are still set.`);
        }
        if (!atomic && outcome.results.some((r) => r.ok)) {
          info(c.dim('  Some variables were set. Pass --atomic to undo them all on failure.'));
        }
        // Partial success is reported as failure, or a script carries on with a
        // half-configured project.
        throw new ProviderError(`${failed.length} of ${outcome.results.length} variables failed.`, 502);
      }

      const project = projectName(rest, args, 'dv vercel env add my-app --key API_URL --value https://…');
      const key = str(args.flags, 'key', 'k') ?? rest[1];
      const value = str(args.flags, 'value');
      if (!key || value === undefined) {
        throw new UsageError(
          'Need --key and --value.',
          'dv vercel env add my-app --key API_URL --value https://api.example.com --target production',
        );
      }
      const targetFlag = args.flags['target'];
      const target =
        targetFlag === undefined
          ? ['production', 'preview', 'development']
          : Array.isArray(targetFlag)
            ? targetFlag
            : [String(targetFlag)];

      const created = await vercel.addEnv(project, { key, value, target });
      const added = record({
        command: 'vercel env add',
        provider: 'vercel',
        summary: `Added ${key} to ${project} (${target.join(', ')})`,
        // The id comes back from the create and is what the delete needs. Nothing about
        // the variable's name is enough to find it again reliably.
        undo: {
          kind: 'vercel.env.remove',
          args: { projectId: project, envId: (created as any)?.created?.id ?? (created as any)?.id },
          describe: `Remove ${key} from ${project}`,
        },
      });

      success(`Added ${c.bold(key)} to ${project} (${target.join(', ')}).`);
      info(c.dim(`  dv undo ${added.id}`));
      if (asJson) emit(created, outputOpts(args.flags, 'vercel'));
      return;
    }

    case 'env rm': {
      const project = projectName(rest, args, 'dv vercel env rm my-app --key API_URL');
      const key = str(args.flags, 'key', 'k') ?? rest[1];
      if (!key) throw new UsageError('Which variable?', 'dv vercel env rm my-app --key API_URL');

      // The delete endpoint takes an id, not a name, so the name is resolved first.
      const vars = await vercel.envVars(project);
      const match = vars.find((v: any) => v.key === key);
      if (!match) throw new UsageError(`No variable "${key}" on ${project}.`, `dv vercel env list ${project}`);

      const ok = await confirm(`Remove ${c.bold(key)} from ${project}?`, bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Not removed.');

      // Read the value before deleting it. Vercel will not return it afterwards, so this
      // is the only moment an undo can be made possible at all — and an undo that
      // restores the name with an empty value would be worse than admitting it is gone.
      let savedRef: string | undefined;
      try {
        const value = (await vercel.envValue(project, match.id))?.value;
        // Stashed, not recorded. The journal is meant to be read and pasted around, and
        // a secret under a key called `value` defeats redaction entirely.
        if (value !== undefined) savedRef = stashSecret(value);
      } catch {
        savedRef = undefined;
      }

      await vercel.removeEnv(project, match.id);

      const removed = record({
        command: 'vercel env rm',
        provider: 'vercel',
        summary: `Removed ${key} from ${project}`,
        ...(savedRef === undefined
          ? { irreversible: 'the value could not be read before deletion' }
          : {
              undo: {
                kind: 'vercel.env.restore',
                args: {
                  projectId: project,
                  key,
                  // A handle, never the secret itself.
                  valueRef: savedRef,
                  target: match.target ?? ['production', 'preview', 'development'],
                  type: match.type,
                },
                describe: `Recreate ${key} on ${project}`,
              },
            }),
      });

      success(`Removed ${key}.`);
      if (savedRef !== undefined) info(c.dim(`  dv undo ${removed.id}`));
      else warn('The value could not be read first, so this cannot be undone.');
      return;
    }

    /* ─────────── domains ─────────── */

    case 'drain list': {
      const drains = await vercel.logDrains();
      if (asJson) return emit(drains, outputOpts(args.flags, 'vercel drain list'));
      if (drains.length === 0) {
        info('No log drains.');
        // The reason someone is here at all: runtime logs cannot be polled after the fact.
        info(c.dim('  A drain is the only way to capture runtime logs, and must exist'));
        info(c.dim('  before the invocation you want to see.'));
        info(c.dim('  dv vercel drain add my-logs https://your-endpoint.example.com/logs'));
        return;
      }
      table(drains, [
        { header: 'name', value: (d: any) => c.bold(d.name ?? '—'), max: 24 },
        { header: 'url', value: (d: any) => d.url ?? '', max: 44 },
        { header: 'sources', value: (d: any) => (d.sources ?? []).join(',') },
        { header: 'id', value: (d: any) => c.dim(d.id ?? '') },
      ]);
      return;
    }

    case 'drain add': {
      const name = rest[0] ?? str(args.flags, 'name');
      const url = rest[1] ?? str(args.flags, 'url');
      if (!name || !url) {
        throw new UsageError(
          'Need a name and an HTTPS endpoint to receive the logs.',
          'dv vercel drain add my-logs https://your-endpoint.example.com/logs',
        );
      }
      if (!url.startsWith('https://')) {
        // Logs can contain request bodies and headers; sending them over plain HTTP is
        // not a preference, it is a leak.
        throw new UsageError('The drain URL must be https.', 'Logs may contain request data.');
      }

      out(`${c.dim('name   ')} ${name}`);
      out(`${c.dim('url    ')} ${url}`);
      out(`${c.dim('sources')} lambda, static, edge`);
      out('');
      const ok = await confirm('Add this log drain?', bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Nothing was added.');

      const created = await vercel.addLogDrain({ name, url });
      const drainEntry = record({
        command: 'vercel drain add',
        provider: 'vercel',
        summary: `Added log drain "${name}" -> ${url}`,
        undo: {
          kind: 'vercel.drain.remove',
          args: { drainId: created?.id },
          describe: `Remove log drain "${name}"`,
        },
      });
      success(`Added drain "${name}" (${created?.id ?? 'created'}).`);
      info(c.dim('  It captures invocations from now on, not past ones.'));
      info(c.dim(`  dv undo ${drainEntry.id}`));
      return;
    }

    case 'drain rm': {
      const id = rest[0] ?? str(args.flags, 'id');
      if (!id) throw new UsageError('Which drain?', 'dv vercel drain list');
      const ok = await confirm(`Remove log drain ${id}?`, bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Nothing was removed.');
      await vercel.removeLogDrain(id);
      success('Removed.');
      return;
    }

    case 'dns list': {
      const domain = rest[0] ?? str(args.flags, 'domain');
      if (!domain) throw new UsageError('Which domain?', 'dv vercel dns list example.com');
      const records = await vercel.dnsRecords(domain);
      if (asJson) return emit(records, outputOpts(args.flags, 'vercel dns list'));
      if (records.length === 0) return info('No DNS records.');
      table(records, [
        { header: 'type', value: (r: any) => c.bold(r.type) },
        // Vercel stores the apex as an empty name; showing nothing there reads as a bug.
        { header: 'name', value: (r: any) => (r.name ? r.name : '@'), max: 30 },
        { header: 'value', value: (r: any) => r.value ?? '', max: 44 },
        { header: 'ttl', value: (r: any) => String(r.ttl ?? ''), align: 'right' },
        { header: 'id', value: (r: any) => c.dim(r.id ?? '') },
      ]);
      return;
    }

    case 'dns add': {
      const domain = rest[0] ?? str(args.flags, 'domain');
      const type = (rest[1] ?? str(args.flags, 'type'))?.toUpperCase();
      const name = rest[2] ?? str(args.flags, 'name') ?? '@';
      const value = rest[3] ?? str(args.flags, 'value');

      if (!domain || !type || !value) {
        throw new UsageError(
          'Need a domain, a record type and a value.',
          'dv vercel dns add example.com CNAME www cname.vercel-dns.com\n' +
            'dv vercel dns add example.com A @ 76.76.21.21',
        );
      }

      out(`${c.dim('domain')} ${domain}`);
      out(`${c.dim('record')} ${type}  ${name}  ->  ${value}`);
      out('');
      const ok = await confirm('Add this record?', bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Nothing was added.');

      const created = await vercel.addDnsRecord(domain, {
        type,
        name,
        value,
        ttl: num(args.flags, 'ttl', 60),
        ...(str(args.flags, 'priority') ? { priority: num(args.flags, 'priority', 10) } : {}),
      });
      const dnsEntry = record({
        command: 'vercel dns add',
        provider: 'vercel',
        summary: `Added ${type} ${name} -> ${value} on ${domain}`,
        undo: {
          kind: 'vercel.dns.remove',
          args: { domain, recordId: created?.uid ?? created?.id },
          describe: `Remove ${type} ${name} from ${domain}`,
        },
      });
      success(`Added ${type} ${name} (${created?.uid ?? created?.id ?? 'created'}).`);
      info(c.dim('  DNS changes take a few minutes to propagate.'));
      info(c.dim(`  dv undo ${dnsEntry.id}`));
      return;
    }

    case 'dns rm': {
      const domain = rest[0] ?? str(args.flags, 'domain');
      const id = rest[1] ?? str(args.flags, 'id');
      if (!domain || !id) {
        throw new UsageError(
          'Need a domain and a record id.',
          'dv vercel dns list example.com   # the id is in the last column',
        );
      }
      const ok = await confirm(`Remove DNS record ${id} from ${domain}?`, bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Nothing was removed.');
      // Read the record before deleting, so the undo can recreate it exactly. After the
      // delete its type and value are unrecoverable, and a DNS record restored with the
      // wrong value is worse than one that is honestly gone.
      let previous: any;
      try {
        previous = (await vercel.dnsRecords(domain)).find(
          (r: any) => String(r.id ?? r.uid) === id,
        );
      } catch {
        previous = undefined;
      }

      await vercel.removeDnsRecord(domain, id);

      const dnsRemoved = record({
        command: 'vercel dns rm',
        provider: 'vercel',
        summary: `Removed ${previous ? `${previous.type} ${previous.name}` : `record ${id}`} from ${domain}`,
        ...(previous
          ? {
              undo: {
                kind: 'vercel.dns.restore',
                args: {
                  domain,
                  type: previous.type,
                  name: previous.name,
                  value: previous.value,
                  ttl: previous.ttl,
                },
                describe: `Recreate ${previous.type} ${previous.name} -> ${previous.value}`,
              },
            }
          : { irreversible: 'the record could not be read before deletion' }),
      });

      success('Removed.');
      if (previous) info(c.dim(`  dv undo ${dnsRemoved.id}`));
      return;
    }

    case 'domain list': {
      const project = projectName(rest, args, 'dv vercel domain list my-app');
      const domains = await vercel.domains(project);
      if (asJson) return emit(domains, outputOpts(args.flags, 'vercel'));
      if (domains.length === 0) return info('No custom domains.');
      table(domains, [
        { header: 'domain', value: (d: any) => c.bold(d.name), max: 40 },
        {
          header: 'verified',
          value: (d: any) => (d.verified ? c.green('yes') : c.yellow('pending')),
        },
        { header: 'redirect', value: (d: any) => d.redirect ?? '' },
      ]);
      return;
    }

    case 'domain add': {
      const project = projectName(rest, args, 'dv vercel domain add my-app example.com');
      const domain = rest[1] ?? str(args.flags, 'domain');
      if (!domain) throw new UsageError('Which domain?', 'dv vercel domain add my-app example.com');
      const added = await vercel.addDomain(project, domain);
      const domainEntry = record({
        command: 'vercel domain add',
        provider: 'vercel',
        summary: `Added ${domain} to ${project}`,
        undo: {
          kind: 'vercel.domain.remove',
          args: { projectId: project, domain },
          describe: `Remove ${domain} from ${project}`,
        },
      });
      success(`Added ${c.bold(domain)} to ${project}.`);
      info(c.dim(`  dv undo ${domainEntry.id}`));
      if (!added.verified) {
        // Adding is not the same as working; DNS still has to point at Vercel.
        info(c.dim('  Not verified yet — point its DNS at Vercel, then check with:'));
        info(c.dim(`  dv vercel domain list ${project}`));
      }
      return;
    }

    case 'domain rm': {
      const project = projectName(rest, args, 'dv vercel domain rm my-app example.com');
      const domain = rest[1] ?? str(args.flags, 'domain');
      if (!domain) throw new UsageError('Which domain?', 'dv vercel domain rm my-app example.com');
      const ok = await confirm(`Remove ${c.bold(domain)} from ${project}?`, bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Not removed.');
      await vercel.removeDomain(project, domain);
      const domainRemoved = record({
        command: 'vercel domain rm',
        provider: 'vercel',
        summary: `Removed ${domain} from ${project}`,
        undo: {
          kind: 'vercel.domain.restore',
          args: { projectId: project, domain },
          describe: `Re-attach ${domain} to ${project}`,
        },
      });
      success(`Removed ${domain}.`);
      info(c.dim(`  dv undo ${domainRemoved.id}`));
      return;
    }

    case 'link': {
      await linkProject(args);
      return;
    }

    case 'whoami': {
      const me = await vercel.whoami();
      if (asJson) return emit(me, outputOpts(args.flags, 'vercel'));
      out(me.username ?? me.email ?? me.uid);
      return;
    }

    default:
      throw new UsageError(
        key ? `Unknown vercel command "${key}".` : 'What would you like to do?',
        `${describeShape(SHAPE)}\n\ne.g.  dv vercel project list      dv vercel deploy logs <id>`,
      );
  }
}
