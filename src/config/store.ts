/**
 * On-disk credential and config store.
 *
 * Credentials live in a file rather than a keychain deliberately: a keychain binding
 * would be a native dependency per platform, and this file is the same thing `gh`,
 * `aws` and `gcloud` all do. What matters is that it is not readable by other users
 * on the machine, which is enforced on write and checked on read.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { configPath, credentialsPath, dvHome } from './paths.js';
import { CliError } from '../cli/errors.js';

/** Owner read/write only. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface StoredCredential {
  /** The bearer token used against the provider's API. */
  accessToken?: string;
  /** Present only when the provider issues one. */
  refreshToken?: string;
  /** ISO timestamp. Absent means the token does not expire (a PAT, for instance). */
  expiresAt?: string;
  /** Space-separated, as returned by the provider. */
  scope?: string;
  /** How this credential was obtained, so `auth status` can say. */
  method?: 'oauth' | 'device' | 'token';
  /** Login or email, for display. Never used for authorisation. */
  account?: string;
  obtainedAt?: string;
}

export interface OAuthApp {
  clientId?: string;
  /**
   * Pin the loopback redirect to this port.
   *
   * Needed for OAuth clients that require an exactly-registered redirect URI —
   * Google's "Web application" type does, and a random port can never match.
   */
  redirectPort?: string;
  /** Default Supabase project for `dv db`, set by `dv db use`. */
  projectRef?: string;
  /**
   * Overrides the connector's base URL.
   *
   * Required for services hosted per customer — Atlassian Cloud lives at
   * `https://<your-site>.atlassian.net`, so no default can be shipped.
   */
  apiBase?: string;
  /**
   * Kept because LinkedIn's token endpoint requires it and offers no PKCE
   * alternative. GitHub device flow and Google loopback+PKCE do not need one.
   */
  clientSecret?: string;
}

export interface DvConfig {
  apps?: Record<string, OAuthApp>;
  defaults?: Record<string, string>;
  /**
   * Connectors the user defined with `dv connect add`.
   *
   * Plain data, never code — a connector definition must not be able to execute
   * anything just by being loaded.
   */
  providers?: Record<string, Record<string, unknown>>;
}

function ensureHome(): void {
  const home = dvHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: DIR_MODE });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    throw new CliError(
      `${path} is not valid JSON.`,
      1,
      'Delete the file to start fresh, or fix it by hand if it holds credentials you need.',
    );
  }
}

/**
 * Write, then move into place.
 *
 * A direct write can leave a truncated file if the process dies mid-write, and the
 * truncated file is the one holding the tokens. The temp file is created with the
 * restricted mode before any content goes into it, so there is no window where the
 * data exists at default permissions.
 */
function writeJsonSecurely(path: string, value: unknown): void {
  ensureHome();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  try {
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, path);
    chmodSync(path, FILE_MODE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the rename may already have consumed it */
    }
    throw err;
  }
}

/**
 * Whether the credentials file is readable by anyone other than its owner.
 *
 * Windows does not model POSIX bits, so the check is skipped there rather than
 * printing a warning that cannot be acted on.
 */
export function credentialsArePrivate(): boolean {
  const path = credentialsPath();
  if (!existsSync(path)) return true;
  if (process.platform === 'win32') return true;
  const mode = statSync(path).mode & 0o777;
  return (mode & 0o077) === 0;
}

/**
 * Credentials, keyed by provider and then by account.
 *
 * Version 2. Version 1 stored one credential per provider, which made a second GitHub
 * or Google login impossible without logging the first one out — and most people have
 * a work account and a personal one. Old files are migrated on read, so an existing
 * login keeps working and simply becomes that provider's first account.
 */
interface ProviderCredentials {
  /** Which account commands use when none is named. */
  active?: string;
  accounts: Record<string, StoredCredential>;
}

type CredentialFileV1 = { version?: 1; providers: Record<string, StoredCredential> };
type CredentialFile = { version: 2; providers: Record<string, ProviderCredentials> };

/**
 * A one-off account override, from the global `--as` flag.
 *
 * Held here rather than threaded through every call site because the alternative is an
 * account parameter on every API function in the codebase, and it is genuinely
 * request-scoped: one CLI invocation, one choice.
 */
let accountOverride: string | undefined;

export function setAccountOverride(name: string | undefined): void {
  accountOverride = name;
}

export function getAccountOverride(): string | undefined {
  return accountOverride;
}

function migrate(raw: any): CredentialFile {
  if (raw?.version === 2 && raw.providers) return raw as CredentialFile;

  // v1: a flat credential per provider. Its account name comes from the identity we
  // recorded at login, falling back to "default" so the entry is never lost.
  const old = (raw ?? {}) as CredentialFileV1;
  const providers: Record<string, ProviderCredentials> = {};
  for (const [id, credential] of Object.entries(old.providers ?? {})) {
    if (!credential || typeof credential !== 'object') continue;
    const name = (credential as StoredCredential).account || 'default';
    providers[id] = { active: name, accounts: { [name]: credential as StoredCredential } };
  }
  return { version: 2, providers };
}

function readCredentialFile(): CredentialFile {
  return migrate(readJson<any>(credentialsPath(), { version: 2, providers: {} }));
}

/** Accounts stored for a provider, and which one is active. */
export function listAccounts(provider: string): { active?: string; names: string[] } {
  const entry = readCredentialFile().providers[provider];
  return { active: entry?.active, names: Object.keys(entry?.accounts ?? {}) };
}

/**
 * Resolve which account a command should use.
 *
 * `--as` wins, then the provider's active account, then its only account. Naming an
 * account that does not exist is an error rather than a silent fallback — quietly
 * using a different account than the one asked for is how you push to the wrong repo.
 */
export function resolveAccount(provider: string, explicit?: string): string | undefined {
  const entry = readCredentialFile().providers[provider];
  if (!entry) return undefined;

  const names = Object.keys(entry.accounts);
  const wanted = explicit ?? accountOverride;

  if (wanted) {
    if (!names.includes(wanted)) {
      throw new CliError(
        `No "${wanted}" account for ${provider}.`,
        2,
        names.length
          ? `Available: ${names.join(', ')}`
          : `dv auth login ${provider} --as ${wanted}`,
      );
    }
    return wanted;
  }
  if (entry.active && names.includes(entry.active)) return entry.active;
  return names[0];
}

export function getCredential(provider: string, account?: string): StoredCredential | undefined {
  const entry = readCredentialFile().providers[provider];
  if (!entry) return undefined;
  const name = resolveAccount(provider, account);
  return name ? entry.accounts[name] : undefined;
}

/** Every provider's active credential, for `dv auth status`. */
export function listCredentials(): Record<string, StoredCredential> {
  const file = readCredentialFile();
  const out: Record<string, StoredCredential> = {};
  for (const id of Object.keys(file.providers)) {
    const credential = getCredential(id);
    if (credential) out[id] = credential;
  }
  return out;
}

/**
 * Merge a patch into one account's credential.
 *
 * Read-modify-write against the file rather than an in-memory copy: two commands can
 * run at once, and rebuilding the whole file from a stale snapshot is how you lose an
 * unrelated provider's token.
 */
export function saveCredential(
  provider: string,
  patch: StoredCredential,
  account?: string,
): StoredCredential {
  const file = readCredentialFile();
  const entry = (file.providers[provider] ??= { accounts: {} });

  // A new login with no name given becomes "default" until identification renames it.
  // An explicit name is where to write, not a name to look up: going through
  // resolveAccount would reject it at the very moment it is being created.
  const name = account ?? resolveAccountSafely(provider) ?? 'default';
  const merged: StoredCredential = {
    ...entry.accounts[name],
    ...patch,
    obtainedAt: patch.obtainedAt ?? entry.accounts[name]?.obtainedAt ?? new Date().toISOString(),
  };
  entry.accounts[name] = merged;
  entry.active ??= name;
  writeJsonSecurely(credentialsPath(), file);
  return merged;
}

/**
 * Rename an account, used once a login reveals who it belongs to.
 *
 * Logging in produces a credential before we know the identity, so it lands under a
 * placeholder and is renamed here — that is what makes `dv auth switch github octocat`
 * possible without the user inventing names.
 */
/** Like resolveAccount, but returns undefined instead of throwing on an unknown name. */
function resolveAccountSafely(provider: string): string | undefined {
  try {
    return resolveAccount(provider);
  } catch {
    return undefined;
  }
}

export function renameAccount(provider: string, from: string, to: string): void {
  if (from === to) return;
  const file = readCredentialFile();
  const entry = file.providers[provider];
  const credential = entry?.accounts[from];
  if (!entry || !credential) return;

  delete entry.accounts[from];
  entry.accounts[to] = credential;
  if (entry.active === from) entry.active = to;
  writeJsonSecurely(credentialsPath(), file);
}

export function setActiveAccount(provider: string, account: string): void {
  const file = readCredentialFile();
  const entry = file.providers[provider];
  if (!entry?.accounts[account]) {
    throw new CliError(
      `No "${account}" account for ${provider}.`,
      2,
      `Available: ${Object.keys(entry?.accounts ?? {}).join(', ') || 'none'}`,
    );
  }
  entry.active = account;
  writeJsonSecurely(credentialsPath(), file);
}

/** Remove one account, or the whole provider when no account is named. */
export function deleteCredential(provider: string, account?: string): boolean {
  const file = readCredentialFile();
  const entry = file.providers[provider];
  if (!entry) return false;

  if (!account) {
    delete file.providers[provider];
    writeJsonSecurely(credentialsPath(), file);
    return true;
  }
  if (!entry.accounts[account]) return false;

  delete entry.accounts[account];
  const remaining = Object.keys(entry.accounts);
  if (remaining.length === 0) delete file.providers[provider];
  // Removing the active account must promote another, or every later command reports
  // "not connected" while a perfectly good credential sits in the file.
  else if (entry.active === account) entry.active = remaining[0];
  writeJsonSecurely(credentialsPath(), file);
  return true;
}


export function readConfig(): DvConfig {
  return readJson<DvConfig>(configPath(), {});
}

export function writeConfig(config: DvConfig): void {
  writeJsonSecurely(configPath(), config);
}

/**
 * The OAuth app for a provider.
 *
 * Environment variables win over the config file so CI can supply them without
 * writing anything to disk.
 */
export function getOAuthApp(provider: string): OAuthApp {
  const config = readConfig();
  const stored = config.apps?.[provider] ?? {};
  const upper = provider.toUpperCase();
  return {
    clientId: process.env[`DV_${upper}_CLIENT_ID`] || stored.clientId,
    clientSecret: process.env[`DV_${upper}_CLIENT_SECRET`] || stored.clientSecret,
    apiBase: process.env[`DV_${upper}_API_BASE`] || stored.apiBase,
    redirectPort: process.env[`DV_${upper}_REDIRECT_PORT`] || stored.redirectPort,
    projectRef: process.env[`DV_${upper}_PROJECT_REF`] || stored.projectRef,
  };
}

export function setOAuthApp(provider: string, app: OAuthApp): void {
  const config = readConfig();
  config.apps = config.apps ?? {};
  config.apps[provider] = { ...config.apps[provider], ...app };
  writeConfig(config);
}

/** Mask a secret for display. Never print a whole token. */
export function mask(value: string | undefined): string {
  if (!value) return '—';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(6)}${value.slice(-4)}`;
}

export { credentialsPath, configPath, dvHome };
