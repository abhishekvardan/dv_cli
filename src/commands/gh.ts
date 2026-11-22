/**
 * `dv gh …`
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { CliError, NotFoundError, UsageError, CancelledError } from '../cli/errors.js';
import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import { emit, outputOpts, wantsJson } from '../cli/output.js';
import { describeShape, resolveCommand, type CommandShape } from '../cli/dispatch.js';
import { c, confirm, info, json, out, relative, success, table, warn } from '../cli/ui.js';
import { github } from '../api/github.js';

/**
 * Resolve a repo argument to `owner/name`.
 *
 * A bare name is completed with the authenticated login, because that is what someone
 * typing `dv gh issues myproject` means. Two API calls are avoided by only asking
 * for the login when the name has no owner.
 */
async function resolveRepo(input: string | undefined, flags: ParsedArgs['flags']): Promise<string> {
  const value = input ?? str(flags, 'repo', 'r');
  if (!value) {
    throw new UsageError('Which repository?', 'dv gh issue list owner/name   (or just: name)');
  }
  if (value.includes('/')) return value;
  const me = await github.whoami();
  return `${me.login}/${value}`;
}

function stateColor(state: string): string {
  const s = state.toLowerCase();
  if (s === 'open' || s === 'success' || s === 'completed') return c.green(state);
  if (s === 'closed' || s === 'failure' || s === 'error') return c.red(state);
  if (s === 'in_progress' || s === 'queued' || s === 'pending') return c.yellow(state);
  return c.gray(state);
}

const SHAPE: CommandShape = {
  verbs: {
    repo: ['list', 'view', 'stats', 'create', 'edit', 'delete', 'clone'],
    issue: ['list', 'create', 'close', 'comment'],
    pr: ['list', 'create'],
    branch: ['list', 'create'],
    commit: ['list'],
    run: ['list'],
    workflow: ['list', 'run'],
    file: ['ls', 'read', 'put'],
  },
  standalone: ['search', 'activity'],
  // Short forms, kept because they are quicker to type and were the original spelling.
  aliases: {
    repos: ['repo', 'list'],
    issues: ['issue', 'list'],
    prs: ['pr', 'list'],
    pulls: ['pr', 'list'],
    branches: ['branch', 'list'],
    commits: ['commit', 'list'],
    runs: ['run', 'list'],
    workflows: ['workflow', 'list'],
    create: ['repo', 'create'],
    clone: ['repo', 'clone'],
    delete: ['repo', 'delete'],
    ls: ['file', 'ls'],
    read: ['file', 'read'],
    put: ['file', 'put'],
    dispatch: ['workflow', 'run'],
    close: ['issue', 'close'],
    comment: ['issue', 'comment'],
  },
};

export async function ghCommand(args: ParsedArgs): Promise<void> {
  const { key: sub, rest } = resolveCommand(args, SHAPE);
  // --snapshot and --diff consume the JSON payload, so they imply it.
  const asJson = wantsJson(args.flags);
  const arg1 = rest[0];

  switch (sub) {
    /* ─────────── read ─────────── */

    case 'repo stats': {
      // Answers a question that no single API call does: "which repository has the most
      // commits". The alternative was leaving it to a language model to list repositories,
      // count each one, and compare — three steps a small model reliably loses its way in.
      // Doing it here makes the answer correct rather than merely likely.
      const limit = num(args.flags, 'limit', 20);
      const repos = await github.listRepos({ limit });

      if (repos.length === 0) return info('No repositories.');

      // Only when someone is watching. Captured runs keep it out of the output, where a
      // line saying "counting…" is stale by the time anything reads it.
      if (process.stderr.isTTY) {
        info(c.dim(`  counting commits across ${repos.length} repositories…`));
      }

      // Concurrent, because each count is one request and doing them in series makes
      // twenty repositories feel broken. Capped so a large account does not open fifty
      // sockets at once and trip the rate limiter.
      const rows: Array<{ repo: string; commits: number | null; pushed?: string; private: boolean }> = [];
      const queue = [...repos];

      const worker = async () => {
        for (;;) {
          const repo = queue.shift();
          if (!repo) return;
          let commits: number | null = null;
          try {
            commits = await github.commitCount(repo.full_name);
          } catch {
            // One unreadable repository must not sink the whole ranking — it is reported
            // as unknown and the rest still answer the question.
            commits = null;
          }
          rows.push({
            repo: repo.full_name,
            commits,
            pushed: repo.pushed_at,
            private: repo.private === true,
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, repos.length) }, worker));

      // Most commits first, which is the whole point. Unknown counts sink rather than
      // sorting as zero, so a repository we could not read is not reported as empty.
      rows.sort((a, b) => (b.commits ?? -1) - (a.commits ?? -1));

      if (asJson) return emit(rows, outputOpts(args.flags, 'gh'));

      table(rows, [
        { header: 'repo', value: (r: any) => r.repo },
        {
          header: 'commits',
          value: (r: any) => (r.commits === null ? c.dim('unknown') : String(r.commits)),
        },
        { header: 'vis', value: (r: any) => (r.private ? c.dim('private') : 'public') },
        { header: 'pushed', value: (r: any) => c.dim(relative(r.pushed)) },
      ]);

      const top = rows[0];
      if (top && top.commits !== null) {
        out('');
        success(`${top.repo} has the most commits (${top.commits}).`);
      }
      return;
    }

    case 'repo list': {
      const repos = await github.listRepos({
        limit: num(args.flags, 'limit', 30),
        sort: str(args.flags, 'sort') ?? 'pushed',
        affiliation: bool(args.flags, 'mine') ? 'owner' : undefined,
      });
      const filtered = bool(args.flags, 'public')
        ? repos.filter((r) => !r.private)
        : bool(args.flags, 'private')
          ? repos.filter((r) => r.private)
          : repos;

      if (asJson) return emit(filtered, outputOpts(args.flags, 'gh'));
      if (filtered.length === 0) return info('No repositories matched.');

      table(filtered, [
        { header: 'repo', value: (r) => c.bold(r.full_name), max: 44 },
        { header: 'vis', value: (r) => (r.private ? c.yellow('private') : c.gray('public')) },
        { header: 'lang', value: (r) => r.language ?? '—' },
        { header: '★', value: (r) => String(r.stargazers_count), align: 'right' },
        { header: 'issues', value: (r) => String(r.open_issues_count), align: 'right' },
        { header: 'pushed', value: (r) => relative(r.pushed_at) },
      ]);
      return;
    }

    case 'repo view': {
      const full = await resolveRepo(arg1, args.flags);
      const repo = await github.getRepo(full);
      if (asJson) return emit(repo, outputOpts(args.flags, 'gh'));
      out(c.bold(repo.full_name));
      if (repo.description) out(repo.description);
      out('');
      out(`${c.dim('visibility ')} ${repo.private ? 'private' : 'public'}${repo.archived ? c.yellow(' (archived)') : ''}`);
      out(`${c.dim('default    ')} ${repo.default_branch}`);
      out(`${c.dim('language   ')} ${repo.language ?? '—'}`);
      out(`${c.dim('stars      ')} ${repo.stargazers_count}   forks ${repo.forks_count}   open issues ${repo.open_issues_count}`);
      out(`${c.dim('pushed     ')} ${relative(repo.pushed_at)}`);
      out(`${c.dim('url        ')} ${repo.html_url}`);
      if (repo.homepage) out(`${c.dim('homepage   ')} ${repo.homepage}`);
      return;
    }

    case 'branch list': {
      const full = await resolveRepo(arg1, args.flags);
      const [repo, branches] = await Promise.all([github.getRepo(full), github.listBranches(full)]);
      if (asJson) return emit(branches, outputOpts(args.flags, 'gh'));
      table(branches, [
        { header: 'branch', value: (b: any) => (b.name === repo.default_branch ? c.bold(b.name) : b.name) },
        { header: '', value: (b: any) => (b.name === repo.default_branch ? c.dim('default') : '') },
        { header: 'protected', value: (b: any) => (b.protected ? c.yellow('yes') : '') },
        { header: 'sha', value: (b: any) => c.dim(String(b.commit?.sha ?? '').slice(0, 8)) },
      ]);
      return;
    }

    case 'commit list': {
      const full = await resolveRepo(arg1, args.flags);
      const commits = await github.listCommits(full, {
        limit: num(args.flags, 'limit', 20),
        path: str(args.flags, 'path'),
        sha: str(args.flags, 'branch', 'ref'),
      });
      if (asJson) return emit(commits, outputOpts(args.flags, 'gh'));
      table(commits, [
        { header: 'sha', value: (x: any) => c.dim(String(x.sha).slice(0, 8)) },
        { header: 'message', value: (x: any) => String(x.commit?.message ?? '').split('\n')[0] ?? '', max: 62 },
        { header: 'author', value: (x: any) => x.commit?.author?.name ?? '—', max: 20 },
        { header: 'when', value: (x: any) => relative(x.commit?.author?.date) },
      ]);
      return;
    }

    case 'issue list': {
      const full = await resolveRepo(arg1, args.flags);
      const issues = await github.listIssues(full, {
        state: str(args.flags, 'state') ?? 'open',
        limit: num(args.flags, 'limit', 30),
        labels: str(args.flags, 'label'),
      });
      if (asJson) return emit(issues, outputOpts(args.flags, 'gh'));
      if (issues.length === 0) return info('No issues matched.');
      table(issues, [
        { header: '#', value: (i: any) => String(i.number), align: 'right' },
        { header: 'title', value: (i: any) => i.title, max: 58 },
        { header: 'state', value: (i: any) => stateColor(i.state) },
        { header: 'labels', value: (i: any) => (i.labels ?? []).map((l: any) => l.name ?? l).join(','), max: 24 },
        { header: 'opened', value: (i: any) => relative(i.created_at) },
      ]);
      return;
    }

    case 'pr list': {
      const full = await resolveRepo(arg1, args.flags);
      const prs = await github.listPulls(full, {
        state: str(args.flags, 'state') ?? 'open',
        limit: num(args.flags, 'limit', 30),
      });
      if (asJson) return emit(prs, outputOpts(args.flags, 'gh'));
      if (prs.length === 0) return info('No pull requests matched.');
      table(prs, [
        { header: '#', value: (p: any) => String(p.number), align: 'right' },
        { header: 'title', value: (p: any) => p.title, max: 52 },
        {
          header: 'state',
          value: (p: any) => (p.merged_at ? c.magenta('merged') : p.draft ? c.gray('draft') : stateColor(p.state)),
        },
        { header: 'head → base', value: (p: any) => `${p.head?.ref} → ${p.base?.ref}`, max: 34 },
        { header: 'opened', value: (p: any) => relative(p.created_at) },
      ]);
      return;
    }

    case 'file ls': {
      const full = await resolveRepo(arg1, args.flags);
      const path = rest[1] ?? str(args.flags, 'path') ?? '';
      const entries = await github.browse(full, path, str(args.flags, 'ref'));
      if (asJson) return emit(entries, outputOpts(args.flags, 'gh'));
      if (!Array.isArray(entries)) {
        throw new UsageError(`${path} is a file.`, `dv gh file read ${full} ${path}`);
      }
      table(entries, [
        { header: 'type', value: (e: any) => (e.type === 'dir' ? c.blue('dir') : c.gray('file')) },
        { header: 'name', value: (e: any) => e.name },
        { header: 'size', value: (e: any) => (e.type === 'file' ? String(e.size) : ''), align: 'right' },
      ]);
      return;
    }

    case 'file read': {
      const path = rest[1] ?? str(args.flags, 'path');
      if (!path) throw new UsageError('Which file?', 'dv gh file read owner/name src/index.ts');
      const full = await resolveRepo(arg1, args.flags);

      const file = await github.readFile(full, path, str(args.flags, 'ref'));
      if (!file) throw new UsageError(`${path} is a directory.`, `dv gh file ls ${full} ${path}`);

      const outFile = str(args.flags, 'out', 'o');
      if (outFile) {
        writeFileSync(outFile, file.text, 'utf8');
        success(`Wrote ${file.text.length} bytes to ${outFile}`);
        return;
      }
      if (asJson) return emit(file, outputOpts(args.flags, 'gh'));
      // Raw contents, unstyled — this is meant to be piped.
      process.stdout.write(file.text.endsWith('\n') ? file.text : `${file.text}\n`);
      return;
    }

    case 'search': {
      const query = arg1;
      if (!query) throw new UsageError('What are you searching for?', 'dv gh search createKiln');
      const repoFlag = str(args.flags, 'repo', 'r');
      const scope = repoFlag ? await resolveRepo(repoFlag, {}) : undefined;
      const result = await github.searchCode(query, {
        repo: scope,
        user: scope ? undefined : (await github.whoami()).login,
        limit: num(args.flags, 'limit', 20),
      });
      if (asJson) return emit(result, outputOpts(args.flags, 'gh'));
      info(c.dim(`  ${result.total} match${result.total === 1 ? '' : 'es'}`));
      table(result.items, [
        { header: 'repo', value: (i: any) => i.repository?.full_name ?? '—', max: 34 },
        { header: 'path', value: (i: any) => i.path, max: 58 },
      ]);
      return;
    }

    case 'activity': {
      const login = str(args.flags, 'user') ?? (await github.whoami()).login;
      const events = await github.activity(login, num(args.flags, 'limit', 25));
      if (asJson) return emit(events, outputOpts(args.flags, 'gh'));
      table(events, [
        { header: 'when', value: (e: any) => relative(e.created_at) },
        { header: 'event', value: (e: any) => String(e.type ?? '').replace(/Event$/, '') },
        { header: 'repo', value: (e: any) => e.repo?.name ?? '—', max: 38 },
        {
          header: 'detail',
          value: (e: any) =>
            e.type === 'PushEvent'
              ? (e.payload?.commits?.[0]?.message ?? '').split('\n')[0] ?? ''
              : (e.payload?.pull_request?.title ?? e.payload?.issue?.title ?? ''),
          max: 46,
        },
      ]);
      return;
    }

    case 'run list': {
      const full = await resolveRepo(arg1, args.flags);
      const runs = await github.listRuns(full, {
        limit: num(args.flags, 'limit', 15),
        workflow: str(args.flags, 'workflow', 'w'),
      });
      if (asJson) return emit(runs, outputOpts(args.flags, 'gh'));
      if (runs.length === 0) return info('No workflow runs found.');
      table(runs, [
        { header: 'run', value: (r: any) => `#${r.run_number}`, align: 'right' },
        { header: 'workflow', value: (r: any) => r.name ?? '—', max: 28 },
        {
          header: 'result',
          value: (r: any) => stateColor(r.conclusion ?? r.status ?? '—'),
        },
        { header: 'branch', value: (r: any) => r.head_branch ?? '—', max: 22 },
        { header: 'when', value: (r: any) => relative(r.created_at) },
      ]);
      return;
    }

    case 'workflow list': {
      const full = await resolveRepo(arg1, args.flags);
      const workflows = await github.listWorkflows(full);
      if (asJson) return emit(workflows, outputOpts(args.flags, 'gh'));
      table(workflows, [
        { header: 'name', value: (w: any) => w.name, max: 36 },
        { header: 'file', value: (w: any) => String(w.path ?? '').replace('.github/workflows/', '') },
        { header: 'state', value: (w: any) => stateColor(w.state ?? '') },
      ]);
      return;
    }

    /* ─────────── write ─────────── */

    case 'repo create': {
      const name = arg1 ?? str(args.flags, 'name');
      if (!name) throw new UsageError('What should the repository be called?', 'dv gh create my-project');

      // Public is opt-in. Defaulting to public would publish code on a typo.
      const isPublic = bool(args.flags, 'public');
      const org = str(args.flags, 'org');
      const target = `${org ? `${org}/` : ''}${name}`;

      if (isPublic) {
        const ok = await confirm(
          `Create ${c.bold(target)} as a ${c.yellow('PUBLIC')} repository?`,
          bool(args.flags, 'yes', 'y'),
        );
        if (!ok) {
          throw new CancelledError('Cancelled. Nothing was created.');
        }
      }

      const repo = await github.createRepo({
        name,
        org,
        description: str(args.flags, 'description', 'd'),
        private: !isPublic,
        autoInit: !bool(args.flags, 'bare'),
        gitignore: str(args.flags, 'gitignore'),
        license: str(args.flags, 'license'),
        homepage: str(args.flags, 'homepage'),
      });

      if (asJson) return emit(repo, outputOpts(args.flags, 'gh'));
      success(`Created ${c.bold(repo.full_name)} (${repo.private ? 'private' : 'public'})`);
      out(repo.html_url);

      if (bool(args.flags, 'clone')) {
        info(c.dim(`  Cloning into ./${repo.name}…`));
        const result = spawnSync('git', ['clone', repo.clone_url], { stdio: 'inherit' });
        if (result.status !== 0) {
          // The repo exists regardless; a clone failure must not read as a failed create.
          warn('The repository was created but the clone failed. Clone it manually:');
          out(`  git clone ${repo.clone_url}`);
        }
      }
      return;
    }

    case 'repo edit': {
      // Everything below is local. The repo is not resolved until the request is known
      // to be valid, so a missing or contradictory flag costs no API call.
      const named = arg1 ?? str(args.flags, 'repo', 'r') ?? 'owner/name';

      // Built from the flags actually given, so an unmentioned setting is never reset.
      const patch: Record<string, unknown> = {};
      const setBool = (flag: string, field: string) => {
        if (args.flags[flag] !== undefined) patch[field] = bool(args.flags, flag);
      };

      if (bool(args.flags, 'public')) patch.private = false;
      if (bool(args.flags, 'private')) patch.private = true;
      if (str(args.flags, 'description', 'd') !== undefined) {
        patch.description = str(args.flags, 'description', 'd');
      }
      if (str(args.flags, 'homepage') !== undefined) patch.homepage = str(args.flags, 'homepage');
      if (str(args.flags, 'rename') !== undefined) patch.name = str(args.flags, 'rename');
      if (str(args.flags, 'default-branch') !== undefined) {
        patch.default_branch = str(args.flags, 'default-branch');
      }
      setBool('issues', 'has_issues');
      setBool('wiki', 'has_wiki');
      setBool('projects', 'has_projects');
      setBool('template', 'is_template');
      setBool('delete-branch-on-merge', 'delete_branch_on_merge');
      if (bool(args.flags, 'archive')) patch.archived = true;
      if (bool(args.flags, 'unarchive')) patch.archived = false;

      if (Object.keys(patch).length === 0) {
        throw new UsageError(
          'Nothing to change.',
          [
            `dv gh repo edit ${named} --private`,
            `dv gh repo edit ${named} --public`,
            `dv gh repo edit ${named} -d "New description" --homepage https://…`,
            `dv gh repo edit ${named} --rename new-name --default-branch main`,
            `dv gh repo edit ${named} --no-wiki --no-projects --delete-branch-on-merge`,
            `dv gh repo edit ${named} --archive`,
          ].join('\n'),
        );
      }

      // Both flags together is a contradiction, and guessing which one was meant
      // would silently change visibility the wrong way.
      if (bool(args.flags, 'public') && bool(args.flags, 'private')) {
        throw new UsageError('--public and --private cannot both be given.');
      }
      if (bool(args.flags, 'archive') && bool(args.flags, 'unarchive')) {
        throw new UsageError('--archive and --unarchive cannot both be given.');
      }

      const full = await resolveRepo(arg1, args.flags);

      // Publishing source code is not undoable in any meaningful sense — forks and
      // caches persist — so it is confirmed even though nothing is deleted.
      if (patch.private === false) {
        const ok = await confirm(
          `Make ${c.bold(full)} ${c.yellow('PUBLIC')}? Anyone will be able to read the code.`,
          bool(args.flags, 'yes', 'y'),
        );
        if (!ok) throw new CancelledError();
      }
      if (patch.archived === true) {
        const ok = await confirm(
          `Archive ${c.bold(full)}? It becomes read-only until unarchived.`,
          bool(args.flags, 'yes', 'y'),
        );
        if (!ok) throw new CancelledError();
      }

      const updated = await github.updateRepo(full, patch);
      if (asJson) return emit(updated, outputOpts(args.flags, 'gh'));

      success(`Updated ${c.bold(updated.full_name)}`);
      for (const [field, value] of Object.entries(patch)) {
        const shown =
          field === 'private' ? (value ? 'private' : 'public') : String(value);
        out(`  ${c.dim(field.padEnd(24))} ${shown}`);
      }
      if (patch.name) out(`  ${c.dim('url'.padEnd(24))} ${updated.html_url}`);
      return;
    }

    case 'repo delete': {
      const full = await resolveRepo(arg1, args.flags);
      // Typing the full name is the confirmation — a y/N prompt is too easy to
      // fat-finger for something irreversible.
      if (!bool(args.flags, 'yes', 'y')) {
        if (!process.stdin.isTTY) {
          throw new UsageError(
            'Refusing to delete a repository without confirmation.',
            'Re-run with --yes if you are certain.',
          );
        }
        const { prompt } = await import('../cli/ui.js');
        warn(`This permanently deletes ${c.bold(full)} and cannot be undone.`);
        const typed = await prompt(`Type the full name to confirm:`);
        if (typed !== full) {
          throw new CancelledError('Names did not match. Nothing was deleted.');
        }
      }
      await github.deleteRepo(full);
      success(`Deleted ${full}.`);
      return;
    }

    case 'issue create': {
      const title = str(args.flags, 'title', 't');
      if (!title) {
        throw new UsageError('--title is required.', 'dv gh issue create owner/name --title "It crashes"');
      }
      const full = await resolveRepo(arg1, args.flags);
      const labels = args.flags['label'];
      const issue = await github.createIssue(full, {
        title,
        body: str(args.flags, 'body', 'b'),
        labels: labels === undefined ? undefined : Array.isArray(labels) ? labels : [String(labels)],
      });
      if (asJson) return emit(issue, outputOpts(args.flags, 'gh'));
      success(`Opened #${issue.number}: ${issue.title}`);
      out(issue.html_url);
      return;
    }

    case 'issue close': {
      const full = await resolveRepo(arg1, args.flags);
      const number = Number(rest[1] ?? str(args.flags, 'number'));
      if (!Number.isFinite(number)) throw new UsageError('Which issue number?', `dv gh issue close ${full} 12`);
      const issue = await github.closeIssue(full, number);
      success(`Closed #${issue.number}: ${issue.title}`);
      return;
    }

    case 'issue comment': {
      const full = await resolveRepo(arg1, args.flags);
      const number = Number(rest[1] ?? str(args.flags, 'number'));
      const body = str(args.flags, 'body', 'b');
      if (!Number.isFinite(number) || !body) {
        throw new UsageError('Need an issue number and --body.', `dv gh issue comment ${full} 12 --body "on it"`);
      }
      const posted = await github.comment(full, number, body);
      success('Comment posted.');
      out(posted.html_url);
      return;
    }

    case 'pr create': {
      const full = await resolveRepo(arg1, args.flags);
      const head = str(args.flags, 'head');
      const title = str(args.flags, 'title', 't');
      if (!head || !title) {
        throw new UsageError(
          'Need --head and --title.',
          `dv gh pr create ${full} --head feature/x --title "Add x"`,
        );
      }
      const base = str(args.flags, 'base') ?? (await github.getRepo(full)).default_branch;
      const pr = await github.createPull(full, {
        title,
        head,
        base,
        body: str(args.flags, 'body', 'b'),
        draft: bool(args.flags, 'draft'),
      });
      if (asJson) return emit(pr, outputOpts(args.flags, 'gh'));
      success(`Opened #${pr.number}: ${pr.title} (${head} → ${base})`);
      out(pr.html_url);
      return;
    }

    case 'branch create': {
      const name = rest[1] ?? str(args.flags, 'name');
      if (!name) {
        throw new UsageError('What should the branch be called?', 'dv gh branch create owner/name feature/x');
      }
      const full = await resolveRepo(arg1, args.flags);
      await github.createBranch(full, name, str(args.flags, 'from'));
      success(`Created branch ${name}.`);
      return;
    }

    case 'workflow run': {
      const workflow = str(args.flags, 'workflow', 'w');
      if (!workflow) {
        throw new UsageError(
          '--workflow is required.',
          'dv gh workflow list owner/name   # to see the file names',
        );
      }
      const full = await resolveRepo(arg1, args.flags);
      const ref = str(args.flags, 'ref') ?? (await github.getRepo(full)).default_branch;
      await github.dispatchWorkflow(full, workflow, ref);
      // GitHub answers 204 with no body, so there is no run id to report yet.
      success(`Dispatched ${workflow} on ${ref}.`);
      info(c.dim(`  dv gh run list ${full} --workflow ${workflow}`));
      return;
    }

    case 'file put': {
      const full = await resolveRepo(arg1, args.flags);
      const path = rest[1] ?? str(args.flags, 'path');
      const content = str(args.flags, 'content');
      const fromFile = str(args.flags, 'file', 'f');
      if (!path || (!content && !fromFile)) {
        throw new UsageError(
          'Need a path and either --content or --file.',
          `dv gh file put ${full} README.md --file ./README.md -m "docs: update"`,
        );
      }
      const { readFileSync } = await import('node:fs');
      const text = fromFile ? readFileSync(fromFile, 'utf8') : content!;
      const message = str(args.flags, 'message', 'm') ?? `Update ${path}`;
      const result = await github.putFile(full, path, text, message, str(args.flags, 'branch'));
      success(`Committed ${path} (${String(result.commit?.sha ?? '').slice(0, 8)}).`);
      out(result.content?.html_url ?? '');
      return;
    }

    case 'repo clone': {
      const full = await resolveRepo(arg1, args.flags);
      const repo = await github.getRepo(full);
      const url = bool(args.flags, 'ssh') ? repo.ssh_url : repo.clone_url;
      const result = spawnSync('git', ['clone', url, ...(rest[1] ? [rest[1]] : [])], {
        stdio: 'inherit',
      });
      if (result.error) throw new CliError(`Could not run git: ${result.error.message}`);
      if (result.status !== 0) throw new CliError(`git clone exited ${result.status}.`);
      return;
    }

    default:
      throw new UsageError(
        sub ? `Unknown gh command "${sub}".` : 'What would you like to do?',
        `${describeShape(SHAPE)}

e.g.  dv gh repo list      dv gh issue create owner/name --title "..."`,
      );
  }
}
