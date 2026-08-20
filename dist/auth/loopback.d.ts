/**
 * Loopback redirect flow for installed apps (RFC 8252) — used for Google and LinkedIn.
 *
 * A short-lived HTTP server on 127.0.0.1 receives the redirect. Points that matter:
 *
 *  - It binds 127.0.0.1 explicitly, not 0.0.0.0. Binding all interfaces would put the
 *    authorization code on the local network for as long as the server is up.
 *  - The port is whatever the OS gives (port 0), so two logins cannot collide, and
 *    nothing needs a fixed port registered.
 *  - `state` is compared before the code is used. Without that check any page the
 *    user visits could hit the loopback URL and inject its own code.
 *  - The server closes as soon as it has an answer, so it is listening for seconds.
 */
import { type Pkce } from './pkce.js';
import type { ProviderDef } from './providers.js';
export interface LoopbackResult {
    code: string;
    pkce: Pkce;
    redirectUri: string;
}
/** Open a URL in the default browser, best effort. */
export declare function browserCommand(platform: string, url: string): {
    command: string;
    args: string[];
};
/**
 * Open a URL in the default browser, best effort.
 *
 * A `true` return means the launcher started, not that the browser rendered the right
 * page — which is why the caller prints the URL regardless.
 */
export declare function openBrowser(url: string): boolean;
export interface LoopbackOptions {
    timeoutMs?: number;
    /**
     * Listen on this exact port instead of whatever the OS hands out.
     *
     * Google allows any loopback port only for OAuth clients of type "Desktop app".
     * A "Web application" client demands the redirect URI be registered exactly, port
     * included, which a random port can never satisfy. Pinning the port makes that
     * client type usable: register `http://127.0.0.1:<port>/callback` once.
     */
    port?: number;
    /** Called with the URL to visit once the port is known. */
    onUrl: (url: string, redirectUri: string) => void;
}
/**
 * Run the authorize step and resolve with the returned code.
 *
 * The redirect URI is only known after the OS assigns a port, so the authorize URL
 * is built inside the listen callback rather than up front.
 */
export declare function authorizeViaLoopback(provider: ProviderDef, clientId: string, options: LoopbackOptions): Promise<LoopbackResult>;
/** Exchange the authorization code for tokens. */
export declare function exchangeCode(provider: ProviderDef, clientId: string, clientSecret: string | undefined, result: LoopbackResult): Promise<any>;
