/**
 * `dv vercel …`
 *
 * Same noun-verb shape as `dv gh`, so knowing one teaches the other.
 */

import { UsageError } from '../cli/errors.js';
import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import { describeShape, resolveCommand, type CommandShape } from '../cli/dispatch.js';
import { c, confirm, info, json, out, relative, select, success, table } from '../cli/ui.js';
import { vercel } from '../api/vercel.js';
import { writeVercelLink } from '../workflow/git.js';

const SHAPE: CommandShape = {
  verbs: {
    project: ['list', 'view', 'create', 'delete'],
    deploy: ['list', 'view', 'logs', 'redeploy', 'cancel'],
    env: ['list', 'add', 'rm'],
    domain: ['list', 'add', 'rm'],
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
    chosen = await select(
      'Which Vercel project does this directory deploy to?',
      ordered.slice(0, 20).map((p: any, i: number) => ({
        value: p,
        label: p.name,
        detail: p.framework ?? undefined,
        recommended: i === 0,
      })),
    );
  }

  const path = writeVercelLink(
    { orgId: chosen.accountId, projectId: chosen.id, projectName: chosen.name },
    cwd,
  );
  success(`Linked to ${c.bold(chosen.name)}`);
  info(c.dim(`  ${path}`));
  return { projectId: chosen.id, projectName: chosen.name };
}

export async function vercelCommand(args: ParsedArgs): Promise<void> {
  const { key, rest } = resolveCommand(args, SHAPE);
  const asJson = bool(args.flags, 'json');

  switch (key) {
    /* ─────────── projects ─────────── */

    case 'project list': {
      const projects = await vercel.projects(num(args.flags, 'limit', 20));
      if (asJson) return json(projects);
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
      if (asJson) return json(project);
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
      if (asJson) return json(project);
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
      if (!ok) return info('Cancelled. Nothing was deleted.');
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
      if (asJson) return json(deployments);
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
      if (asJson) return json(d);
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
      const events = await vercel.deploymentEvents(id, num(args.flags, 'limit', 100));
      if (asJson) return json(events);
      if (events.length === 0) return info('No log output for that deployment.');
      for (const e of events) {
        const text = e.payload?.text ?? e.text ?? '';
        if (!text) continue;
        // Vercel marks stderr as type "stderr"; colouring it makes a failure findable.
        out(e.type === 'stderr' ? c.red(String(text).trimEnd()) : String(text).trimEnd());
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
      if (!ok) return info('Not redeployed.');

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
      if (asJson) return json(vars);
      if (vars.length === 0) return info('No environment variables.');
      table(vars, [
        { header: 'key', value: (v: any) => v.key, max: 36 },
        { header: 'targets', value: (v: any) => (v.target ?? []).join(',') },
        { header: 'type', value: (v: any) => c.dim(v.type ?? '') },
        { header: 'id', value: (v: any) => c.dim(v.id ?? '') },
      ]);
      info('');
      // Values are secrets; listing them would put them in scrollback for no reason.
      info(c.dim('  Values are not shown — they are secrets and are not requested.'));
      return;
    }

    case 'env add': {
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
      success(`Added ${c.bold(key)} to ${project} (${target.join(', ')}).`);
      if (asJson) json(created);
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
      if (!ok) return info('Not removed.');
      await vercel.removeEnv(project, match.id);
      success(`Removed ${key}.`);
      return;
    }

    /* ─────────── domains ─────────── */

    case 'domain list': {
      const project = projectName(rest, args, 'dv vercel domain list my-app');
      const domains = await vercel.domains(project);
      if (asJson) return json(domains);
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
      success(`Added ${c.bold(domain)} to ${project}.`);
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
      if (!ok) return info('Not removed.');
      await vercel.removeDomain(project, domain);
      success(`Removed ${domain}.`);
      return;
    }

    case 'link': {
      await linkProject(args);
      return;
    }

    case 'whoami': {
      const me = await vercel.whoami();
      if (asJson) return json(me);
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
