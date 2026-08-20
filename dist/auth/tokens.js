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
import { AuthError } from '../cli/errors.js';
import { getCredential, saveCredential } from '../config/store.js';
import { getProvider, resolveApp } from './providers.js';
/**
 * Renew this far ahead of expiry. Google access tokens last an hour; five minutes
 * covers a slow request, clock skew, and a laptop that resumed mid-command.
 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** In-flight refreshes, so concurrent callers share one request. */
const inFlight = new Map();
export function isExpired(credential, skewMs = REFRESH_SKEW_MS) {
    if (!credential.expiresAt)
        return false; // A token with no expiry (a PAT).
    const at = new Date(credential.expiresAt).getTime();
    if (Number.isNaN(at))
        return false;
    return at - Date.now() < skewMs;
}
export function isRefreshable(credential) {
    return typeof credential.refreshToken === 'string' && credential.refreshToken.length > 0;
}
async function refresh(provider, credential) {
    const app = resolveApp(provider.id);
    if (!app.clientId) {
        throw new AuthError(`No OAuth client id configured for ${provider.label}, so the session cannot be renewed.`, `dv config set ${provider.id}.clientId <id>`);
    }
    const body = {
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: app.clientId,
    };
    if (app.clientSecret)
        body.client_secret = app.clientSecret;
    const res = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(body).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
        const detail = data.error_description || data.error || `HTTP ${res.status}`;
        // `invalid_grant` means the refresh token is dead — revoked, expired, or
        // superseded. Nothing to retry; the user has to log in again.
        throw new AuthError(`Could not renew the ${provider.label} session: ${detail}`, `dv auth login ${provider.id}`);
    }
    return saveCredential(provider.id, {
        accessToken: data.access_token,
        // Providers usually omit the refresh token on renewal; keep the existing one.
        refreshToken: data.refresh_token || credential.refreshToken,
        expiresAt: data.expires_in
            ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
            : undefined,
        scope: data.scope || credential.scope,
    });
}
/**
 * A usable access token for a provider, renewing first if needed.
 *
 * Throws AuthError (exit code 3) when there is nothing usable, so a caller can tell
 * "log in" from "the request failed".
 */
export async function accessToken(providerId, options = {}) {
    const provider = getProvider(providerId);
    if (!provider)
        throw new AuthError(`Unknown provider "${providerId}".`);
    const credential = getCredential(provider.id);
    if (!credential?.accessToken) {
        throw new AuthError(`${provider.label} is not connected.`, 
        // Name the way this particular service is connected, not a generic command.
        provider.methods.includes('device') || provider.methods.includes('loopback')
            ? `dv auth login ${provider.id}`
            : `dv auth token ${provider.id} --token <token>`);
    }
    const needsRenewal = options.force || isExpired(credential);
    if (!needsRenewal)
        return credential.accessToken;
    if (!isRefreshable(credential)) {
        // A token that cannot be renewed and has expired is not usable. Being explicit
        // beats letting the provider answer 401 and guessing at the reason.
        if (isExpired(credential, 0)) {
            throw new AuthError(`The ${provider.label} session expired and there is no refresh token to renew it.`, `dv auth login ${provider.id}`);
        }
        return credential.accessToken;
    }
    const existing = inFlight.get(provider.id);
    if (existing)
        return (await existing).accessToken;
    const pending = refresh(provider, credential).finally(() => inFlight.delete(provider.id));
    inFlight.set(provider.id, pending);
    return (await pending).accessToken;
}
/** The granted scopes, if the provider told us. */
export function grantedScopes(providerId) {
    const scope = getCredential(providerId)?.scope ?? '';
    return scope.split(/[\s,]+/).filter(Boolean);
}
/**
 * Scopes a provider needs but the stored grant does not cover.
 *
 * Worth checking before a write: a token issued without `w_member_social` will fail
 * a LinkedIn post with a 403 that says nothing useful.
 */
export function missingScopes(providerId, required) {
    const granted = new Set(grantedScopes(providerId));
    // No scope recorded means we cannot judge — do not invent a problem.
    if (granted.size === 0)
        return [];
    return required.filter((s) => !granted.has(s));
}
/** For tests. */
export function clearRefreshState() {
    inFlight.clear();
}
//# sourceMappingURL=tokens.js.map