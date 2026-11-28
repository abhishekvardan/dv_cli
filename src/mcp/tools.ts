/**
 * Which dv commands an MCP client can call, and how each becomes an argv.
 *
 * Two sources, deliberately kept apart:
 *
 *  - `AI_COMMANDS` from ai/catalog.ts, the list the local `ask` model picks from. It is
 *    kept short on purpose — a 3B model chooses worse from forty options than from
 *    twenty-five — so it cannot simply grow to cover everything.
 *  - `MCP_EXTRA` below, the commands a capable client such as Claude Code should also be
 *    able to reach: mail, calendar, LinkedIn, the ship pipeline, undo, waiting.
 *
 * Anything in neither is still reachable through the `run` tool. Typed tools exist
 * anyway because they carry read/write hints, which let a person auto-approve every read
 * in their client's permission settings while still being asked about each write.
 */

import { AI_COMMANDS, type AiCommand, type AiParam } from '../ai/catalog.js';

export interface McpParam extends AiParam {
  /** How the value is typed in the schema. Strings unless said otherwise. */
  kind?: 'string' | 'number' | 'boolean';
}

export interface McpCommand extends AiCommand {
  params?: McpParam[];
  /**
   * Whether `--json` is added. On by default; off where the output *is* the answer
   * (a file's contents) or the command has no structured form.
   */
  json?: boolean;
  /** Runs against the working directory, so the tool offers a `cwd` input. */
  local?: boolean;
}

const via = 'via dv (your own OAuth login, journaled, policy-checked)';

/**
 * Commands beyond the `ask` catalogue.
 *
 * Flags are taken from each handler's own parsing (commands/*.ts), not invented here: a
 * flag the handler does not read is silently ignored, which would look like success.
 */
export const MCP_EXTRA: McpCommand[] = [
  // ── accounts ──────────────────────────────────────────────────────────────
  // Adding one is the auth_add tool in commands/mcp.ts: it must not take a token here.
  {
    id: 'auth accounts',
    purpose: 'Every saved account per service (GitHub, Vercel, Google, …) and which one is active. Any tool can act as another account via its account input.',
    params: [{ positional: true, name: 'provider', describe: 'only this service, e.g. github' }],
  },
  {
    id: 'auth switch',
    purpose: 'Change which saved account a service uses by default.',
    params: [
      { positional: true, name: 'provider', describe: 'the service, e.g. github', required: true },
      { positional: true, name: 'name', describe: 'the account name, as auth accounts lists it', required: true },
    ],
    mutates: true,
    effect: 'change the default account',
    json: false,
  },
  {
    id: 'auth logout',
    purpose: 'Remove one saved account from dv (it stays valid at the provider).',
    params: [
      { positional: true, name: 'provider', describe: 'the service, e.g. github', required: true },
      { name: 'as', describe: 'the account to remove, as auth accounts lists it', required: true },
    ],
    mutates: true,
    danger: 'high',
    effect: 'remove a saved account from dv',
    json: false,
  },

  // ── gmail ─────────────────────────────────────────────────────────────────
  {
    id: 'gmail search',
    purpose: `Search Gmail ${via}. Uses Gmail query syntax; defaults to the inbox.`,
    params: [
      { positional: true, name: 'query', describe: 'Gmail search query, e.g. "from:alice is:unread"' },
      { name: 'limit', describe: 'how many messages', kind: 'number' },
    ],
    needs: 'google',
  },
  {
    id: 'gmail read',
    purpose: `Read one Gmail message in full ${via}. Ids come from gmail search.`,
    params: [{ positional: true, name: 'id', describe: 'message id', required: true }],
    needs: 'google',
  },
  { id: 'gmail labels', purpose: `Every Gmail label ${via}.`, needs: 'google' },
  { id: 'gmail profile', purpose: `The Gmail address and message counts ${via}.`, needs: 'google' },
  {
    id: 'gmail send',
    purpose: `Send an email ${via}. Cannot be undone.`,
    params: [
      { name: 'to', describe: 'recipient address', required: true },
      { name: 'subject', describe: 'subject line', required: true },
      { name: 'body', describe: 'plain-text body', required: true },
      { name: 'cc', describe: 'cc address' },
    ],
    mutates: true,
    danger: 'high',
    effect: 'send an email as you',
    json: false,
    needs: 'google',
  },
  {
    id: 'gmail archive',
    purpose: `Archive a Gmail message (remove it from the inbox) ${via}.`,
    params: [{ positional: true, name: 'id', describe: 'message id', required: true }],
    mutates: true,
    json: false,
    needs: 'google',
  },
  {
    id: 'gmail star',
    purpose: `Star a Gmail message ${via}.`,
    params: [{ positional: true, name: 'id', describe: 'message id', required: true }],
    mutates: true,
    json: false,
    needs: 'google',
  },

  // ── calendar ──────────────────────────────────────────────────────────────
  {
    id: 'cal events',
    purpose: `Upcoming Google Calendar events ${via}.`,
    params: [
      { name: 'days', describe: 'how many days ahead (default 7)', kind: 'number' },
      { name: 'limit', describe: 'how many events', kind: 'number' },
    ],
    needs: 'google',
  },
  {
    id: 'cal free',
    purpose: `Free slots in working hours ${via}.`,
    params: [
      { name: 'days', describe: 'how many days ahead (default 5)', kind: 'number' },
      { name: 'min', describe: 'shortest useful slot in minutes (default 30)', kind: 'number' },
      { name: 'start', describe: 'working day starts at this hour (default 9)', kind: 'number' },
      { name: 'end', describe: 'working day ends at this hour (default 18)', kind: 'number' },
    ],
    needs: 'google',
  },
  {
    id: 'cal add',
    purpose: `Create a Google Calendar event ${via}. May notify attendees.`,
    params: [
      { name: 'title', describe: 'event title', required: true },
      { name: 'start', describe: 'start time, ISO e.g. 2026-08-20T15:00', required: true },
      { name: 'minutes', describe: 'duration in minutes (default 30)', kind: 'number' },
      { name: 'end', describe: 'end time, ISO; overrides minutes' },
      { name: 'description', describe: 'event description' },
      { name: 'where', describe: 'location' },
      { name: 'attendee', describe: 'one attendee email' },
    ],
    mutates: true,
    effect: 'create a calendar event',
    json: false,
    needs: 'google',
  },
  {
    id: 'cal rm',
    purpose: `Delete a Google Calendar event ${via}.`,
    params: [{ positional: true, name: 'id', describe: 'event id (from cal events)', required: true }],
    mutates: true,
    danger: 'high',
    effect: 'delete a calendar event',
    json: false,
    needs: 'google',
  },

  // ── linkedin ──────────────────────────────────────────────────────────────
  { id: 'li me', purpose: `Your LinkedIn identity ${via}.`, needs: 'linkedin' },
  {
    id: 'li post',
    purpose: `Publish a LinkedIn post as you ${via}. Public unless connections is true.`,
    params: [
      { name: 'text', describe: 'the post text', required: true },
      { name: 'url', describe: 'a link to attach' },
      { name: 'connections', describe: 'connections only rather than public', kind: 'boolean' },
      { name: 'video', describe: 'path to a video file to post natively' },
      { name: 'at', describe: 'post later at this local time, e.g. "2026-11-29 18:00" (this PC must be on)' },
    ],
    mutates: true,
    danger: 'high',
    effect: 'publish a LinkedIn post under your name',
    json: false,
    needs: 'linkedin',
  },

  { id: 'yt me', purpose: `Your YouTube channel ${via}.`, needs: 'google' },
  {
    id: 'yt upload',
    purpose: `Upload a video to YouTube ${via}. With publish-at it stays private and goes public at that time.`,
    params: [
      { positional: true, name: 'file', describe: 'path to the video file', required: true },
      { name: 'title', describe: 'video title (max 100 chars)', required: true },
      { name: 'description-file', describe: 'path to a text file with the description' },
      { name: 'description', describe: 'description text' },
      { name: 'tags', describe: 'comma-separated tags' },
      { name: 'thumbnail', describe: 'path to a PNG/JPG thumbnail' },
      { name: 'publish-at', describe: 'when it goes public, e.g. "2026-11-29 18:00" (local time)' },
      { name: 'privacy', describe: 'private, unlisted or public (ignored with publish-at)' },
      { name: 'project', describe: 'project label for the planner, e.g. dv' },
      { name: 'format', describe: 'tutorial, problem-solution, explainer, build-log, tip or launch' },
      { name: 'short', describe: 'it is a Short', kind: 'boolean' },
    ],
    mutates: true,
    danger: 'high',
    effect: 'publish a video on your YouTube channel',
    needs: 'google',
  },
  {
    id: 'yt stats',
    purpose: `Per-video YouTube analytics ${via}: views, average % viewed, CTR, subscribers gained, likes and a 0..1 reward. Saves them for the planner.`,
    params: [{ name: 'days', describe: 'window in days (default 28)', kind: 'number' }],
    needs: 'google',
  },
  {
    id: 'yt learn',
    purpose: `Plan the next videos from what performed (Thompson sampling over project × format) ${via}.`,
    params: [
      { name: 'slots', describe: 'how many videos to plan (default 7)', kind: 'number' },
      { name: 'kind', describe: 'short or long (default short)' },
      { name: 'projects', describe: 'comma-separated projects to consider even if untried' },
    ],
    needs: 'google',
  },
  {
    id: 'yt tag',
    purpose: `Label a YouTube video with its project and format so the planner can learn from it ${via}.`,
    params: [
      { positional: true, name: 'id', describe: 'video id', required: true },
      { name: 'project', describe: 'e.g. dv, pkgguard', required: true },
      { name: 'format', describe: 'tutorial, problem-solution, explainer, build-log, tip or launch', required: true },
      { name: 'short', describe: 'it is a Short', kind: 'boolean' },
    ],
    mutates: true,
    json: false,
    needs: 'google',
  },
  {
    id: 'yt status',
    purpose: `Privacy, scheduled time and processing state of one YouTube video ${via}.`,
    params: [{ positional: true, name: 'id', describe: 'video id', required: true }],
    needs: 'google',
  },

  // ── github, writes beyond the catalogue ───────────────────────────────────
  {
    id: 'gh pr create',
    purpose: 'Open a pull request on GitHub.',
    params: [
      { positional: true, name: 'repo', describe: 'repository name', required: true },
      { name: 'head', describe: 'branch with the changes', required: true },
      { name: 'title', describe: 'PR title', required: true },
      { name: 'base', describe: 'branch to merge into (default: the repo default)' },
      { name: 'body', describe: 'PR description' },
    ],
    mutates: true,
    effect: 'open a pull request',
    needs: 'github',
  },

  // ── vercel, beyond the catalogue ──────────────────────────────────────────
  {
    id: 'vercel deploy create',
    purpose: 'Deploy a directory to Vercel, optionally verifying it and rolling back if the check fails. Production unless preview is true.',
    params: [
      { positional: true, name: 'dir', describe: 'directory to deploy (default: cwd)' },
      { name: 'project', describe: 'Vercel project name' },
      { name: 'preview', describe: 'deploy to preview rather than production', kind: 'boolean' },
      { name: 'prebuilt', describe: 'upload .vercel/output instead of building remotely', kind: 'boolean' },
      { name: 'wait', describe: 'block until the deployment is ready', kind: 'boolean' },
      { name: 'verify', describe: 'shell command that must succeed against the new deployment' },
      { name: 'on-fail', describe: '"rollback" to restore the last good build if verify fails' },
    ],
    mutates: true,
    danger: 'high',
    effect: 'replace what the site serves',
    local: true,
    needs: 'vercel',
  },
  {
    id: 'vercel deploy wait',
    purpose: 'Block until a deployment is ready; fails if it errors.',
    params: [
      { positional: true, name: 'id', describe: 'deployment id', required: true },
      { name: 'timeout', describe: 'seconds to wait', kind: 'number' },
    ],
    needs: 'vercel',
  },
  {
    id: 'vercel deploy rollback',
    purpose: 'Put the last healthy production build back.',
    params: [{ positional: true, name: 'project', describe: 'Vercel project name', required: true }],
    mutates: true,
    danger: 'high',
    effect: 'replace what the live site serves',
    needs: 'vercel',
  },

  // ── database ──────────────────────────────────────────────────────────────
  {
    id: 'db query',
    purpose: 'Run SQL against the selected database (dv db use). Writes need confirm.',
    params: [{ positional: true, name: 'sql', describe: 'the SQL statement', required: true }],
    mutates: true,
    danger: 'high',
    effect: 'run SQL that may change data',
    needs: 'supabase',
  },

  // ── git & pipeline ────────────────────────────────────────────────────────
  {
    id: 'git commit',
    purpose: 'Stage everything and commit, without pushing.',
    params: [{ name: 'm', describe: 'the commit message', required: true }],
    mutates: true,
    effect: 'commit every change here',
    local: true,
  },
  {
    id: 'git push',
    purpose: 'Push the current branch as the active dv GitHub account.',
    mutates: true,
    effect: 'push commits',
    local: true,
  },
  {
    id: 'ship',
    purpose: 'The full pipeline: test, build, push, open a PR, wait for CI, deploy, health-check. Use dry_run first to see the steps.',
    params: [
      { name: 'project', describe: 'Vercel project (default: the linked one)' },
      { name: 'repo', describe: 'owner/name (default: the origin remote)' },
      { name: 'skip-tests', describe: 'do not run tests', kind: 'boolean' },
      { name: 'no-pr', describe: 'do not open a pull request', kind: 'boolean' },
      { name: 'no-deploy', describe: 'do not deploy', kind: 'boolean' },
    ],
    mutates: true,
    danger: 'high',
    effect: 'push, open a PR and deploy',
    local: true,
    needs: 'github',
  },

  // ── closing the loop ──────────────────────────────────────────────────────
  {
    id: 'undo',
    purpose: 'Revert one change dv made, by its journal id (see the journal tool).',
    params: [{ positional: true, name: 'id', describe: 'journal entry id, e.g. j_abc123', required: true }],
    mutates: true,
    effect: 'revert a previous change',
    json: false,
  },
  {
    id: 'watch deployments',
    purpose: 'Block until a new Vercel deployment on a project settles, then report it. Use instead of polling.',
    params: [
      { positional: true, name: 'project', describe: 'Vercel project name', required: true },
      { name: 'timeout', describe: 'seconds before giving up (default 1800)', kind: 'number' },
      { name: 'once', describe: 'report the first change and stop', kind: 'boolean' },
    ],
    needs: 'vercel',
  },
  {
    id: 'policy show',
    purpose: 'The rules dv enforces on itself — what is denied, what needs a dry run or a human.',
    json: false,
  },
];

/** Exit codes, named, for a reader that cannot look them up. See cli/errors.ts. */
export const EXIT_NAMES: Record<number, string> = {
  0: 'ok',
  1: 'failure',
  2: 'usage — the command was wrong, or a policy rule blocked it',
  3: 'auth — not logged in; the user must run `dv auth login <provider>` in a terminal',
  4: 'provider refused — rate limit, missing scope or permission',
  5: 'not found',
  6: 'cancelled — NOTHING HAPPENED. Not a success',
};

export function allCommands(): McpCommand[] {
  const seen = new Set<string>();
  const list: McpCommand[] = [];
  for (const command of [...AI_COMMANDS, ...MCP_EXTRA] as McpCommand[]) {
    if (seen.has(command.id)) continue;
    seen.add(command.id);
    list.push(command);
  }
  return list;
}

/**
 * The tool name for a command: `gh pr list` → `gh_pr_list`.
 *
 * No `dv_` prefix. Claude Code already shows a tool as `mcp__dv__<name>`, so a prefix
 * would only make every name longer.
 */
export function toolName(command: McpCommand): string {
  return command.id.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

/** Inputs every tool understands, on top of its own parameters. */
export interface CommonInputs {
  fields?: string;
  confirm?: boolean;
  dry_run?: boolean;
  account?: string;
  cwd?: string;
}

/** Parameter names that would collide with the common inputs. */
const RESERVED = new Set(['confirm', 'dry_run', 'account', 'cwd', 'fields']);

/** Whether a command's output is JSON, and so can be narrowed with `--fields`. */
export function emitsJson(command: McpCommand): boolean {
  return command.json !== false && !command.rendersContent;
}

export function inputKey(param: McpParam): string {
  // `on-fail` is not a friendly key in JSON; `on_fail` is.
  const key = param.name.replace(/-/g, '_');
  return RESERVED.has(key) ? `${key}_value` : key;
}

/**
 * Turn tool inputs into dv's argv.
 *
 * Positional parameters go in declaration order, as bare words; the rest become flags.
 * A single-letter name is a short flag (`-m`), because that is how the handler reads it.
 */
export function buildArgv(command: McpCommand, input: Record<string, unknown> & CommonInputs): string[] {
  const argv = command.id.split(' ');
  const params = command.params ?? [];

  for (const param of params.filter((p) => p.positional)) {
    const value = input[inputKey(param)] ?? param.fallback;
    if (value === undefined || value === null || value === '') continue;
    argv.push(String(value));
  }

  for (const param of params.filter((p) => !p.positional)) {
    const value = input[inputKey(param)] ?? param.fallback;
    if (value === undefined || value === null || value === '') continue;
    const flag = param.name.length === 1 ? `-${param.name}` : `--${param.name}`;

    // A boolean flag is present or absent. `--build true` would be read by some handlers
    // as the flag plus a stray positional word.
    if (param.kind === 'boolean' || value === true || value === 'true') {
      if (value === true || value === 'true') argv.push(flag);
      continue;
    }
    argv.push(flag, String(value));
  }

  if (emitsJson(command)) {
    argv.push('--json');
    if (input.fields) argv.push('--fields', String(input.fields));
  }
  if (command.mutates && input.confirm === true) argv.push('--yes');
  if (input.dry_run === true) argv.push('--dry-run');
  if (input.account) argv.push('--as', String(input.account));
  return argv;
}

/** The description a client shows, including how writes are gated. */
export function describe(command: McpCommand): string {
  const parts = [command.purpose];
  if (command.needs) parts.push(`Needs the ${command.needs} connection (dv auth login ${command.needs}).`);
  if (command.mutates) {
    parts.push(
      `WRITE: ${command.effect ?? 'changes something'}. Without confirm=true it only previews and exits 6 (nothing happened); `
        + 'show the preview to the user, then call again with confirm=true once they agree. dry_run=true shows the plan without doing it.',
    );
  }
  return parts.join(' ');
}
