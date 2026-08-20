/**
 * One authenticated request path, for every connector.
 *
 * This is what makes a new connector immediately useful. Adding a service needs a
 * definition — base URL, how the credential attaches, any fixed headers — and
 * nothing else: `dv api <provider> <path>` then works against it, and so does
 * `dv auth status`, which verifies the credential through the same code.
 */
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
export declare function applyAuth(headers: Record<string, string>, url: URL, style: AuthStyle, credential: string): void;
/** The base URL for a provider, allowing a per-user override. */
export declare function resolveBase(provider: ProviderDef): string;
/**
 * Call a connector's API.
 *
 * Status handling is shared so every connector reports failures the same way, with
 * the same exit codes — 3 to re-authenticate, 4 for a refusal, 5 for missing.
 */
export declare function call(provider: ProviderDef, path: string, options?: CallOptions): Promise<any>;
/** Read "settings.dashboard.display_name" out of a response. */
export declare function pluck(value: any, path: string | undefined): string | undefined;
/**
 * Verify a credential and return the account it belongs to.
 *
 * Used by every login path, so a connector is never reported as connected on a
 * credential that does not actually work.
 */
export declare function identify(provider: ProviderDef, token?: string): Promise<{
    account?: string;
    raw: any;
}>;
/** Whether anything is stored for a provider. */
export declare function isConnected(providerId: string): boolean;
