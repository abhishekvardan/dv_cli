/**
 * Getting a usable token, renewing it when needed.
 *
 * Every API call goes through `accessToken()`. The rules:
 *  - Renew *before* expiry, not after a 401. A request that starts with seconds left
 *    can still arrive after the token has died.
 *  - One refresh at a time per provider. Two commands in the same process asking at
 *    once would otherwise each spend the refresh token, and providers may invalidate
 *    the older one.
 *  - No refresh token means no silent recovery. Say so plainly and name the command
 *    that fixes it, rather than surfacing a 401 from three layers down.
 */
import { type StoredCredential } from '../config/store.js';
/**
 * Renew this far ahead of expiry. Google access tokens last an hour; five minutes
 * covers a slow request, clock skew, and a laptop that resumed mid-command.
 */
export declare const REFRESH_SKEW_MS: number;
export declare function isExpired(credential: StoredCredential, skewMs?: number): boolean;
export declare function isRefreshable(credential: StoredCredential): boolean;
export interface TokenOptions {
    /** Renew even if the stored token still looks valid. */
    force?: boolean;
}
/**
 * A usable access token for a provider, renewing first if needed.
 *
 * Throws AuthError (exit code 3) when there is nothing usable, so a caller can tell
 * "log in" from "the request failed".
 */
export declare function accessToken(providerId: string, options?: TokenOptions): Promise<string>;
/** The granted scopes, if the provider told us. */
export declare function grantedScopes(providerId: string): string[];
/**
 * Scopes a provider needs but the stored grant does not cover.
 *
 * Worth checking before a write: a token issued without `w_member_social` will fail
 * a LinkedIn post with a 403 that says nothing useful.
 */
export declare function missingScopes(providerId: string, required: string[]): string[];
/** For tests. */
export declare function clearRefreshState(): void;
