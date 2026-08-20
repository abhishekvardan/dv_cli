/**
 * One authenticated request path, for every connector.
 *
 * This is what makes a new connector immediately useful. Adding a service needs a
 * definition — base URL, how the credential attaches, any fixed headers — and
 * nothing else: `dv api <provider> <path>` then works against it, and so does
 * `dv auth status`, which verifies the credential through the same code.
 */

import { AuthError, CliError, EXIT, NotFoundError, ProviderError } from '../cli/errors.js';
import { accessToken } from '../auth/tokens.js';
import { getCredential } from '../config/store.js';
import type { AuthStyle, ProviderDef } from '../auth/providers.js';

export interface CallOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Use this credential instead of the stored one. */
  token?: string;
  /** Return null on 404 rather than raising. */
  allowMissing?: boolean;
}

/**
 * Apply a credential to a request the way the provider expects.
 *
 * Bearer is the common case but far from universal: Notion and Stripe take bearer,
 * Anthropic wants `x-api-key`, Figma wants `X-Figma-Token`, Jira wants Basic, and
 * Linear wants the raw key in `Authorization` with no scheme at all. Getting this
 * wrong produces a 401 that looks like a bad token, so it is data, not a guess.
 */
export function applyAuth(
  headers: Record<string, string>,
  url: URL,
  style: AuthStyle,
  credential: string,
): void {
  if (style === 'bearer') {
    headers.Authorization = `Bearer ${credential}`;
    return;
  }
  if (style === 'token') {
    headers.Authorization = `token ${credential}`;
    return;
  }
  if (style === 'basic') {
    // The credential is stored as `user:secret`; encode only if it is not already.
    const encoded = credential.includes(':')
      ? Buffer.from(credential, 'utf8').toString('base64')
      : credential;
    headers.Authorization = `Basic ${encoded}`;
    return;
  }
  if (style.startsWith('header:')) {
    headers[style.slice('header:'.length)] = credential;
    return;
  }
  if (style.startsWith('query:')) {
    url.searchParams.set(style.slice('query:'.length), credential);
    return;
  }
  throw new CliError(`Unknown auth style "${style}".`);
}

/** The base URL for a provider, allowing a per-user override. */
export function resolveBase(provider: ProviderDef): string {
  const base = provider.apiBase;
  if (!base) {
    throw new CliError(
      `${provider.label} has no API base URL configured.`,
      EXIT.usage,
      `dv connect add ${provider.id} --api-base https://…`,
    );
  }
  return base.replace(/\/+$/, '');
}

/**
 * Call a connector's API.
 *
 * Status handling is shared so every connector reports failures the same way, with
 * the same exit codes — 3 to re-authenticate, 4 for a refusal, 5 for missing.
 */
export async function call(provider: ProviderDef, path: string, options: CallOptions = {}): Promise<any> {
  const base = resolveBase(provider);
  const url = new URL(path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`);
  for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);

  const credential = options.token ?? (await accessToken(provider.id));
  const headers: Record<string, string> = {
    'User-Agent': 'dv-cli',
    ...(provider.headers ?? {}),
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) headers['Content-Type'] ??= 'application/json';

  applyAuth(headers, url, provider.authStyle ?? 'bearer', credential);

  const res = await fetch(url, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body),
  });

  if (res.status === 204) return null;

  if (res.status === 401) {
    throw new AuthError(
      `${provider.label} rejected the credential.`,
      `It may be expired or revoked. Run: dv auth login ${provider.id}`,
    );
  }
  if (res.status === 403) {
    const detail = await describe(res);
    throw new ProviderError(
      `${provider.label} refused: ${detail}`,
      403,
      `Usually a missing scope. Check with: dv auth scopes ${provider.id}`,
    );
  }
  if (res.status === 404) {
    if (options.allowMissing) return null;
    throw new NotFoundError(`${provider.label} has no such resource: ${url.pathname}`);
  }
  if (res.status === 429) {
    // Both spellings are in the wild; either is more useful than "try later".
    const after = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset');
    throw new ProviderError(
      `${provider.label} is rate limiting requests${after ? ` — retry after ${after}` : ''}.`,
      429,
    );
  }
  if (!res.ok) {
    throw new ProviderError(`${provider.label} ${res.status}: ${await describe(res)}`, res.status);
  }

  const text = await res.text();
  if (!text) return null;

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // Not every endpoint returns JSON. Hand back the text rather than failing.
    return text;
  }

  // Slack answers HTTP 200 with {"ok": false, "error": "..."} — treating that as
  // success is how a CLI silently reports nothing and claims it worked.
  if (data && typeof data === 'object' && data.ok === false && typeof data.error === 'string') {
    throw new ProviderError(`${provider.label} refused: ${data.error}`, 200);
  }
  // GraphQL does the same: 200 with an `errors` array.
  if (data && Array.isArray(data.errors) && data.errors.length > 0 && data.data == null) {
    const first = data.errors[0]?.message ?? 'GraphQL error';
    throw new ProviderError(`${provider.label} refused: ${first}`, 200);
  }
  return data;
}

/** Pull the most useful message out of an error body, whatever shape it is. */
async function describe(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return res.statusText;
  try {
    const body: any = JSON.parse(text);
    return (
      body?.message ??
      body?.error?.message ??
      body?.error_description ??
      (typeof body?.error === 'string' ? body.error : undefined) ??
      body?.errors?.[0]?.message ??
      res.statusText
    );
  } catch {
    return text.slice(0, 200);
  }
}

/** Read "settings.dashboard.display_name" out of a response. */
export function pluck(value: any, path: string | undefined): string | undefined {
  if (!path) return undefined;
  let cursor = value;
  for (const key of path.split('.')) {
    if (cursor == null) return undefined;
    cursor = cursor[key];
  }
  if (cursor == null) return undefined;
  return typeof cursor === 'string' ? cursor : String(cursor);
}

/**
 * Verify a credential and return the account it belongs to.
 *
 * Used by every login path, so a connector is never reported as connected on a
 * credential that does not actually work.
 */
export async function identify(
  provider: ProviderDef,
  token?: string,
): Promise<{ account?: string; raw: any }> {
  if (!provider.whoamiUrl) return { account: undefined, raw: null };
  const raw = await call(provider, provider.whoamiUrl, { token });
  let account = pluck(raw, provider.accountPath);
  // Fall back to whatever identity-shaped field exists — better than "connected"
  // with no name at all.
  if (!account && raw && typeof raw === 'object') {
    account =
      pluck(raw, 'login') ?? pluck(raw, 'email') ?? pluck(raw, 'name') ?? pluck(raw, 'username');
  }
  return { account, raw };
}

/** Whether anything is stored for a provider. */
export function isConnected(providerId: string): boolean {
  return Boolean(getCredential(providerId)?.accessToken);
}
