/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) — used for GitHub.
 *
 * The best fit for a CLI: nothing listens on a port, no redirect URI is registered,
 * no client secret exists to leak, and it works unchanged over SSH where the browser
 * is on a different machine entirely.
 */
import { ProviderError, AuthError, CliError } from '../cli/errors.js';
async function postForm(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(body).toString(),
    });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        // GitHub answers form-encoded unless Accept: application/json is honoured.
        data = Object.fromEntries(new URLSearchParams(text));
    }
    if (!res.ok && !data?.error) {
        throw new ProviderError(`${url} returned ${res.status}.`, res.status);
    }
    return data;
}
export async function requestDeviceCode(provider, clientId) {
    if (!provider.deviceCodeUrl) {
        throw new CliError(`${provider.label} does not support the device flow.`);
    }
    const data = await postForm(provider.deviceCodeUrl, {
        client_id: clientId,
        scope: provider.scopes.join(' '),
    });
    if (data.error) {
        throw new AuthError(`${provider.label} refused the device request: ${data.error_description || data.error}`, data.error === 'unauthorized_client'
            ? 'The OAuth app must have "Device flow" enabled in its settings.'
            : undefined);
    }
    if (!data.device_code || !data.user_code) {
        throw new AuthError(`${provider.label} did not return a device code.`);
    }
    return data;
}
/**
 * Poll until the user finishes approving, or the code expires.
 *
 * The four documented states are handled distinctly, which matters:
 *  - `authorization_pending` is the normal case — keep waiting, say nothing.
 *  - `slow_down` requires *increasing* the interval. Ignoring it gets the client
 *    rate-limited and the login fails for no visible reason.
 *  - `expired_token` and `access_denied` are terminal; polling on is pointless.
 */
export async function pollForToken(provider, clientId, device, options = {}) {
    const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = options.now ?? (() => Date.now());
    let intervalMs = Math.max((device.interval ?? 5) * 1000, 1000);
    const deadline = now() + device.expires_in * 1000;
    for (;;) {
        if (now() >= deadline) {
            throw new AuthError('The device code expired before the login was approved.', 'Run the login again and complete it in the browser within the time shown.');
        }
        await sleep(intervalMs);
        const data = await postForm(provider.tokenUrl, {
            client_id: clientId,
            device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (data.access_token)
            return data;
        switch (data.error) {
            case 'authorization_pending':
                continue;
            case 'slow_down':
                // RFC 8628 §3.5: add 5 seconds to the interval.
                intervalMs += 5000;
                options.onSlowDown?.(intervalMs);
                continue;
            case 'expired_token':
                throw new AuthError('The device code expired.', 'Run the login again.');
            case 'access_denied':
                throw new AuthError(`The login was declined in ${provider.label}.`);
            default:
                throw new AuthError(`${provider.label} refused: ${data.error_description || data.error || 'unknown error'}`);
        }
    }
}
//# sourceMappingURL=device.js.map