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

type CredentialFile = { version: 1; providers: Record<string, StoredCredential> };

function readCredentialFile(): CredentialFile {
  const data = readJson<Partial<CredentialFile>>(credentialsPath(), { version: 1, providers: {} });
  return { version: 1, providers: data.providers ?? {} };
}

export function getCredential(provider: string): StoredCredential | undefined {
  return readCredentialFile().providers[provider];
}

export function listCredentials(): Record<string, StoredCredential> {
  return readCredentialFile().providers;
}

/**
 * Merge a patch into one provider's credential.
 *
 * Read-modify-write against the file rather than an in-memory copy: two commands can
 * run at once, and rebuilding the whole file from a stale snapshot is how you lose
 * an unrelated provider's token.
 */
export function saveCredential(provider: string, patch: StoredCredential): StoredCredential {
  const file = readCredentialFile();
  const merged: StoredCredential = {
    ...file.providers[provider],
    ...patch,
    obtainedAt: patch.obtainedAt ?? file.providers[provider]?.obtainedAt ?? new Date().toISOString(),
  };
  file.providers[provider] = merged;
  writeJsonSecurely(credentialsPath(), file);
  return merged;
}

export function deleteCredential(provider: string): boolean {
  const file = readCredentialFile();
  if (!file.providers[provider]) return false;
  delete file.providers[provider];
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
