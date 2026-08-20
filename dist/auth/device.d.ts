/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) — used for GitHub.
 *
 * The best fit for a CLI: nothing listens on a port, no redirect URI is registered,
 * no client secret exists to leak, and it works unchanged over SSH where the browser
 * is on a different machine entirely.
 */
import type { ProviderDef } from './providers.js';
export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval?: number;
}
export interface TokenResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
}
export declare function requestDeviceCode(provider: ProviderDef, clientId: string): Promise<DeviceCodeResponse>;
export interface PollOptions {
    /** Injected in tests so a poll loop does not really wait. */
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Called when the interval increases, so the user learns why it slowed. */
    onSlowDown?: (intervalMs: number) => void;
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
export declare function pollForToken(provider: ProviderDef, clientId: string, device: DeviceCodeResponse, options?: PollOptions): Promise<TokenResponse>;
