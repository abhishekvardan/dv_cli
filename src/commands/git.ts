/**
 * `dv git …` — the local half of the loop.
 *
 * Wrapping `git add` for its own sake would be pointless; git does that well. Two
 * things make this worth having:
 *
 *  - **One command for the whole cycle.** `dv git save -m "..."` stages, commits and
 *    pushes, which is what the three-command dance actually means.
 *  - **Pushing as the account you selected.** `git push` uses git's own credential
 *    helper, which knows nothing about `dv auth switch`. With two GitHub accounts
 *    that is exactly how you push to the right repo as the wrong person. Pushing with
 *    the active account's token makes the two agree.
 */

import { UsageError } from '../cli/errors.js';
import { bool, negated, num, str, type ParsedArgs } from '../cli/args.js';
import { describeShape, resolveCommand, type CommandShape } from '../cli/dispatch.js';
import { c, confirm, info, json, out, success, table, warn } from '../cli/ui.js';
import { CancelledError } from '../cli/errors.js';
import {
  currentBranch,
  dirtyFiles,
  git,
  githubRemote,
  hasRemote,
  hasUpstream,
  headSha,
  isRepo,
  unpushedCount,
} from '../workflow/git.js';
import { accessToken } from '../auth/tokens.js';
import { getCredential, resolveAccount } from '../config/store.js';

const SHAPE: CommandShape = {
  verbs: {},
  standalone: ['status', 'save', 'commit', 'push', 'log', 'diff'],
};

/** Porcelain status codes to something readable. */
function describeChange(line: string): { state: string; path: string } {
  const code = line.slice(0, 2);
  const path = line.slice(3);
  if (code.includes('?')) return { state: c.gray('new'), path };
  if (code.includes('D')) return { state: c.red('deleted'), path };
  if (code.includes('A')) return { state: c.green('added'), path };
  if (code.includes('R')) return { state: c.blue('renamed'), path };
  return { state: c.yellow('modified'), path };
}

function requireRepo(cwd: string): void {
  if (!isRepo(cwd)) {
    throw new UsageError('Not a git repository.', 'Run this from inside your project.');
  }
}

/**
 * Push, authenticating as the dv account rather than whatever git has cached.
 *
 * The token goes into the remote URL for exactly one invocation — never written to
 * `.git/config`, never printed. Any git error is scrubbed before display, because a
 * failed push echoes the URL it tried, token included.
 */
async function pushWithAccount(
  cwd: string,
  branch: string,
  repo: string,
  setUpstream: boolean,
): Promise<string> {
  const token = await accessToken('github');
  // x-access-token is GitHub's documented username for token auth over HTTPS.
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;

  const args = setUpstream
    ? ['push', '--set-upstream', url, branch]
    : ['push', url, `HEAD:${branch}`];
  const result = git(args, cwd);

  if (!result.ok) {
    const scrubbed = `${result.err}`.split(token).join('***');
    throw new Error(scrubbed.split('\n').slice(0, 4).join('\n') || 'git push failed');
  }
  // `--set-upstream` against a URL records the URL as the upstream, token and all.
  // Point it back at the named remote so nothing durable holds the credential.
  if (setUpstream && hasRemote('origin', cwd)) {
    git(['branch', `--set-upstream-to=origin/${branch}`, branch], cwd);
  }
  return branch;
}

export async function gitCommand(args: ParsedArgs): Promise<void> {
  const { key, rest } = resolveCommand(args, SHAPE);
  const cwd = process.cwd();
  const asJson = bool(args.flags, 'json');

  switch (key) {
    case 'status': {
      requireRepo(cwd);
      const branch = currentBranch(cwd);
      const changes = dirtyFiles(cwd).map(describeChange);
      const ahead = unpushedCount(branch, cwd);

      if (asJson) {
        return json({
          branch,
          sha: headSha(cwd),
          repo: githubRemote('origin', cwd),
          account: resolveAccount('github') ?? null,
          changes: changes.length,
          unpushed: ahead,
        });
      }

      out(`${c.dim('branch  ')} ${c.bold(branch)}  ${c.dim(headSha(cwd).slice(0, 7))}`);
      out(`${c.dim('repo    ')} ${githubRemote('origin', cwd) ?? c.yellow('no GitHub remote')}`);
      // Shown because it decides who the push will be attributed to.
      out(`${c.dim('account ')} ${resolveAccount('github') ?? c.yellow('not signed in')}`);
      out(
        `${c.dim('unpushed')} ${
          ahead === -1 ? c.yellow('branch never pushed') : ahead === 0 ? 'nothing' : `${ahead} commit${ahead === 1 ? '' : 's'}`
        }`,
      );
      out('');

      if (changes.length === 0) {
        info(c.dim('  Working tree clean.'));
        return;
      }
      table(changes, [
        { header: 'state', value: (ch) => ch.state },
        { header: 'file', value: (ch) => ch.path, max: 60 },
      ]);
      return;
    }

    case 'commit':
    case 'save': {
      requireRepo(cwd);
      const message = str(args.flags, 'message', 'm') ?? rest.join(' ');
      if (!message) {
        throw new UsageError(
          'What is this change?',
          'dv git save -m "fix the login redirect"',
        );
      }

      const changes = dirtyFiles(cwd);
      const branch = currentBranch(cwd);

      if (changes.length === 0) {
        // Nothing staged and nothing to stage. `save` still pushes, since unpushed
        // commits are a perfectly normal reason to run it.
        info('Nothing to commit.');
      } else {
        // Everything is about to be committed, so show what that means. `git add -A`
        // is easy to run without noticing a stray key or dump file.
        out(`${c.bold(String(changes.length))} file${changes.length === 1 ? '' : 's'} will be committed:`);
        out('');
        for (const line of changes.slice(0, 20)) {
          const ch = describeChange(line);
          out(`  ${ch.state.padEnd(18)} ${ch.path}`);
        }
        if (changes.length > 20) out(c.dim(`  … and ${changes.length - 20} more`));
        out('');

        const ok = await confirm(`Commit as "${message}"?`, bool(args.flags, 'yes', 'y'));
        if (!ok) throw new CancelledError('Nothing was committed.');

        const staged = git(['add', '-A'], cwd);
        if (!staged.ok) throw new Error(staged.err || 'git add failed');

        const committed = git(['commit', '-m', message], cwd);
        if (!committed.ok) throw new Error(committed.err || committed.out || 'git commit failed');
        success(`Committed ${changes.length} file${changes.length === 1 ? '' : 's'}.`);
      }

      if (key === 'commit' || negated(args.flags, 'push')) return;

      // fall through to pushing
      await pushCurrent(cwd, branch, args);
      return;
    }

    case 'push': {
      requireRepo(cwd);
      await pushCurrent(cwd, currentBranch(cwd), args);
      return;
    }

    case 'log': {
      requireRepo(cwd);
      const limit = num(args.flags, 'limit', 10);
      const result = git(
        ['log', `-${limit}`, '--pretty=format:%h%x1f%s%x1f%an%x1f%ar'],
        cwd,
      );
      if (!result.ok) throw new Error(result.err || 'git log failed');
      const rows = result.out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, subject, author, when] = line.split('\u001f');
          return { sha, subject, author, when };
        });
      if (asJson) return json(rows);
      table(rows, [
        { header: 'sha', value: (r) => c.dim(r.sha ?? '') },
        { header: 'message', value: (r) => r.subject ?? '', max: 58 },
        { header: 'author', value: (r) => r.author ?? '', max: 20 },
        { header: 'when', value: (r) => c.dim(r.when ?? '') },
      ]);
      return;
    }

    case 'diff': {
      requireRepo(cwd);
      const result = git(['diff', ...(bool(args.flags, 'staged') ? ['--staged'] : []), ...rest], cwd);
      if (result.out) out(result.out);
      else info(c.dim('  No differences.'));
      return;
    }

    default:
      throw new UsageError(
        key ? `Unknown git command "${key}".` : 'What would you like to do?',
        `${describeShape(SHAPE)}\n\n` +
          'e.g.  dv git status\n' +
          '      dv git save -m "fix the login redirect"     stage, commit and push\n' +
          '      dv git commit -m "wip"                      stage and commit only\n' +
          '      dv git push',
      );
  }
}

/** Push the current branch, reporting what happened. */
async function pushCurrent(cwd: string, branch: string, args: ParsedArgs): Promise<void> {
  if (!hasRemote('origin', cwd)) {
    throw new UsageError('No origin remote to push to.', 'git remote add origin <url>');
  }
  const repo = githubRemote('origin', cwd);
  const ahead = unpushedCount(branch, cwd);

  if (ahead === 0) {
    info(`${branch} is already up to date.`);
    return;
  }

  // Only GitHub can be pushed as a dv account; anything else falls back to git's own
  // credentials rather than pretending the account switch applied.
  if (!repo) {
    const result = git(
      hasUpstream(branch, cwd) ? ['push'] : ['push', '--set-upstream', 'origin', branch],
      cwd,
    );
    if (!result.ok) throw new Error(result.err || 'git push failed');
    success(`Pushed ${branch}.`);
    info(c.dim('  Not a GitHub remote, so git\'s own credentials were used.'));
    return;
  }

  const account = resolveAccount('github');
  if (!getCredential('github')?.accessToken) {
    throw new UsageError(
      'Not signed in to GitHub, so the push cannot be attributed.',
      'dv auth login github    (or use plain `git push`)',
    );
  }

  await pushWithAccount(cwd, branch, repo, !hasUpstream(branch, cwd));
  success(`Pushed ${branch} to ${repo}${account ? ` as ${c.bold(account)}` : ''}.`);
}
