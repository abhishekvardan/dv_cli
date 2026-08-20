/**
 * On-disk credential and config store.
 *
 * Credentials live in a file rather than a keychain deliberately: a keychain binding
 * would be a native dependency per platform, and this file is the same thing `gh`,
 * `aws` and `gcloud` all do. What matters is that it is not readable by other users
 * on the machine, which is enforced on write and checked on read.
 */
import { configPath, credentialsPath, dvHome } from './paths.js';
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
/**
 * Whether the credentials file is readable by anyone other than its owner.
 *
 * Windows does not model POSIX bits, so the check is skipped there rather than
 * printing a warning that cannot be acted on.
 */
export declare function credentialsArePrivate(): boolean;
export declare function getCredential(provider: string): StoredCredential | undefined;
export declare function listCredentials(): Record<string, StoredCredential>;
/**
 * Merge a patch into one provider's credential.
 *
 * Read-modify-write against the file rather than an in-memory copy: two commands can
 * run at once, and rebuilding the whole file from a stale snapshot is how you lose
 * an unrelated provider's token.
 */
export declare function saveCredential(provider: string, patch: StoredCredential): StoredCredential;
export declare function deleteCredential(provider: string): boolean;
export declare function readConfig(): DvConfig;
export declare function writeConfig(config: DvConfig): void;
/**
 * The OAuth app for a provider.
 *
 * Environment variables win over the config file so CI can supply them without
 * writing anything to disk.
 */
export declare function getOAuthApp(provider: string): OAuthApp;
export declare function setOAuthApp(provider: string, app: OAuthApp): void;
/** Mask a secret for display. Never print a whole token. */
export declare function mask(value: string | undefined): string;
export { credentialsPath, configPath, dvHome };
