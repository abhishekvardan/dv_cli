/**
 * Output safety and shaping.
 *
 * Three problems that showed up in real use, all of which belong here rather than in
 * each command:
 *
 *  - A raw API response can contain a token, and printing it puts a live credential in
 *    scrollback, in a screen share, and in whatever log captured the terminal.
 *  - `--json` on a verbose endpoint dumps dozens of irrelevant fields, so every use is
 *    followed by a `grep` or a `jq`.
 *  - Provider errors arrive in provider-specific shapes, so every failure has to be
 *    read differently.
 */

import { DryRunError } from './errors.js';
import { isDryRun } from './interactive.js';
import { c, info, json, out, success, warn } from './ui.js';
import { diff, readSnapshot, saveSnapshot } from './snapshot.js';

const { dim, green, red, yellow } = c;

/**
 * Keys whose values are secrets, whatever the provider calls them.
 *
 * Matched on the key name rather than the value, because a token is just a string and
 * there is no reliable way to recognise one by shape — GitHub's look nothing like
 * Supabase's, and a short API key is indistinguishable from an id.
 */
const SECRET_KEY = /(^|[_-])(token|secret|password|passwd|apikey|api_key|access_key|private_key|client_secret|refresh_token|authorization|credential|db_pass)($|[_-])/i;

/** Values that are unmistakably credentials regardless of the key they arrived under. */
const SECRET_VALUE = [
  /^gh[pousr]_[A-Za-z0-9]{16,}/,
  /^github_pat_[A-Za-z0-9_]{20,}/,
  /^sk-[A-Za-z0-9-_]{20,}/,
  /^sbp_[a-f0-9]{40,}/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}/,
  /^ya29\.[A-Za-z0-9\-_]{20,}/,
  /^eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\./, // a JWT
];

function looksSecret(key: string, value: unknown): boolean {
  if (SECRET_KEY.test(key)) return true;
  return typeof value === 'string' && SECRET_VALUE.some((re) => re.test(value));
}

function maskValue(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/**
 * Recursively mask anything that looks like a credential.
 *
 * Applied to every `--json` and `dv api` payload. A caller who genuinely needs the real
 * value passes `--reveal`, which is an explicit, visible decision rather than the
 * default behaviour.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && looksSecret(key, v)) out[key] = maskValue(v);
    else out[key] = redact(v, depth + 1);
  }
  return out as unknown as T;
}

/**
 * Keep only the requested fields.
 *
 * Supports dotted paths (`link.repo`) and applies element-wise to arrays, so
 * `--fields name,framework` turns a project listing into something readable without a
 * second tool.
 */
export function pick<T>(value: T, fields: string[]): unknown {
  if (fields.length === 0) return value;
  if (Array.isArray(value)) return value.map((v) => pick(v, fields));
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const path = field.split('.');
    let cursor: any = source;
    for (const key of path) {
      if (cursor == null) break;
      cursor = cursor[key];
    }
    if (cursor !== undefined) result[field] = cursor;
  }
  return result;
}

export interface EmitOptions {
  fields?: string;
  reveal?: boolean;
  /** Save this payload under a name for later comparison. */
  snapshot?: string;
  /** Compare against a saved snapshot instead of printing. */
  diff?: string;
  /** Shown in the snapshot file so you can tell where it came from. */
  command?: string;
}

/**
 * Print a JSON payload — redacted, trimmed, and optionally saved or compared.
 *
 * Snapshot and diff live here because every read command already funnels through this
 * one function, so they work everywhere without each command opting in.
 */
export function emit(value: unknown, options: EmitOptions = {}): void {
  const trimmed = options.fields
    ? pick(value, options.fields.split(',').map((f) => f.trim()).filter(Boolean))
    : value;

  if (options.diff) {
    printDiff(options.diff, trimmed);
    return;
  }
  if (options.snapshot) {
    const path = saveSnapshot(options.snapshot, trimmed, options.command ?? '');
    success(`Saved snapshot "${options.snapshot}".`);
    info(dim(`  ${path}`));
    return;
  }
  json(options.reveal ? trimmed : redact(trimmed));
}

/** Compare a live payload against a saved snapshot and report what moved. */
export function printDiff(name: string, now: unknown): void {
  const saved = readSnapshot(name);
  // Both sides redacted, or a masked secret would read as a change on every run.
  const changes = diff(saved.data, redact(now));

  if (changes.length === 0) {
    success(`No drift since "${name}" (${saved.takenAt.slice(0, 16).replace('T', ' ')}).`);
    return;
  }

  warn(`${changes.length} change${changes.length === 1 ? '' : 's'} since "${name}":`);
  out('');
  for (const change of changes) {
    if (change.kind === 'added') out(`  ${green('+')} ${change.path}  ${short(change.now)}`);
    else if (change.kind === 'removed') out(`  ${red('-')} ${change.path}  ${short(change.before)}`);
    else out(`  ${yellow('~')} ${change.path}  ${short(change.before)} -> ${short(change.now)}`);
  }
}

function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text && text.length > 60 ? `${text.slice(0, 59)}…` : String(text);
}

/**
 * Collect the output-shaping flags.
 *
 * Declared once so `--fields`, `--reveal`, `--snapshot` and `--diff` behave the same on
 * every command that returns JSON — documenting them as common flags and then wiring
 * them into only some commands is worse than not having them.
 */
export function outputOpts(
  flags: Record<string, string | boolean | string[]>,
  command = '',
): EmitOptions {
  const one = (name: string): string | undefined => {
    const v = flags[name];
    if (Array.isArray(v)) return v[v.length - 1];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    fields: one('fields'),
    reveal: flags.reveal === true,
    snapshot: one('snapshot'),
    diff: one('diff'),
    command,
  };
}

/** True when the caller wants JSON at all, including via snapshot or diff. */
export function wantsJson(flags: Record<string, string | boolean | string[]>): boolean {
  return flags.json === true || Boolean(flags.snapshot) || Boolean(flags.diff);
}

/**
 * Pull a human sentence out of whatever shape a provider returned.
 *
 * Every service nests its message somewhere different, and the alternative is each
 * caller reading a different error shape by hand.
 */
export function explainProviderError(body: unknown, fallback: string): string {
  if (typeof body === 'string') return body.slice(0, 300) || fallback;
  if (!body || typeof body !== 'object') return fallback;
  const b = body as Record<string, any>;
  const candidates = [
    b.message,
    b.error?.message,
    b.error_description,
    typeof b.error === 'string' ? b.error : undefined,
    b.errors?.[0]?.message,
    b.msg,
    b.detail,
    b.hint,
  ];
  const found = candidates.find((c) => typeof c === 'string' && c.trim());
  return found ? String(found) : fallback;
}

/**
 * How many attempts a transient failure gets, set once from `--retries`.
 *
 * Global rather than per-call: retrying is about how patient this invocation should
 * be, and threading a number through every API function to express that would put
 * the knob in the wrong place.
 */
let retryAttempts = 3;
export function setRetryAttempts(n: number): void {
  retryAttempts = Math.max(1, Math.min(Math.floor(n) || 1, 10));
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  /** Called before each wait, so a long retry does not look like a hang. */
  onRetry?: (attempt: number, waitMs: number, reason: string) => void;
}

/**
 * Retry transient failures with exponential backoff and jitter.
 *
 * Only retries what is worth retrying: network resets, 429, and 5xx. A 401, 403 or 404
 * is a settled answer, and retrying it wastes time and rate limit while looking like
 * the tool is stuck.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? retryAttempts;
  const baseMs = options.baseMs ?? 500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as any)?.status;
      const transient =
        status === 429 ||
        (typeof status === 'number' && status >= 500) ||
        /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i.test(message);

      if (!transient || attempt === attempts) throw err;

      // Jitter so several parallel callers do not retry in lockstep.
      const wait = Math.round(baseMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      options.onRetry?.(attempt, wait, message);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/**
 * Stop a mutating request when `--dry-run` is set.
 *
 * Enforced here, at the one place every HTTP call passes through, rather than at each
 * command's confirmation prompt. Not every write confirms — creating a private repo
 * does not, because there is nothing dangerous about it — so a prompt-level guard
 * silently misses exactly the commands that never ask.
 */
export function guardDryRun(method: string, url: string): void {
  const verb = method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) return;
  if (!isDryRun()) return;
  // The URL is the honest description of what would have happened.
  throw new DryRunError(`Dry run — would have sent ${verb} ${url}`);
}
