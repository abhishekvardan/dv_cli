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

import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';

import { AuthError, CliError, ProviderError } from '../cli/errors.js';
import { createPkce, createState, type Pkce } from './pkce.js';
import type { ProviderDef } from './providers.js';

export interface LoopbackResult {
  code: string;
  pkce: Pkce;
  redirectUri: string;
}

function page(title: string, message: string, ok: boolean): string {
  // Self-contained: this renders in the user's browser and must not fetch anything.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
 body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;
      min-height:100vh;margin:0;background:#0b0d10;color:#e6e8eb}
 .card{max-width:26rem;padding:2rem;border:1px solid #23272e;border-radius:14px;background:#12151a;text-align:center}
 .icon{font-size:2rem}
 h1{font-size:1.15rem;margin:.6rem 0 .4rem}
 p{margin:0;color:#9aa4b2;font-size:.94rem}
</style></head><body><div class="card">
<div class="icon">${ok ? '✅' : '⚠️'}</div><h1>${title}</h1><p>${message}</p>
</div></body></html>`;
}

/** Open a URL in the default browser, best effort. */
export function browserCommand(platform: string, url: string): { command: string; args: string[] } {
  if (platform === 'win32') {
    // NOT `cmd /c start`. cmd treats `&` as a command separator, so an OAuth URL is
    // delivered truncated at the first parameter — the browser received only
    // `?client_id=…` and Google rejected the request for a missing `response_type`.
    // rundll32 takes the URL as a single argument with no shell parsing at all.
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  }
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Open a URL in the default browser, best effort.
 *
 * A `true` return means the launcher started, not that the browser rendered the right
 * page — which is why the caller prints the URL regardless.
 */
export function openBrowser(url: string): boolean {
  const { command, args } = browserCommand(process.platform, url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    // Headless machine, or no handler registered.
    return false;
  }
}

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
  /**
   * Ask for these scopes instead of the provider's full set.
   *
   * Some scopes are gated behind a product or review the app has not been granted yet,
   * and the provider refuses the *whole* authorisation when one is unavailable — so a
   * single ungranted scope blocks reading your own profile. Narrowing the request lets
   * the login succeed now and the extra scope be added once it is approved.
   */
  scopes?: string[];
  /** Called with the URL to visit once the port is known. */
  onUrl: (url: string, redirectUri: string) => void;
}

/**
 * Run the authorize step and resolve with the returned code.
 *
 * The redirect URI is only known after the OS assigns a port, so the authorize URL
 * is built inside the listen callback rather than up front.
 */
export async function authorizeViaLoopback(
  provider: ProviderDef,
  clientId: string,
  options: LoopbackOptions,
): Promise<LoopbackResult> {
  if (!provider.authorizeUrl) {
    throw new CliError(`${provider.label} has no authorize endpoint configured.`);
  }

  const pkce = createPkce();
  const state = createState();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  return new Promise<LoopbackResult>((resolve, reject) => {
    let settled = false;
    let server: Server | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (err: Error | null, value?: LoopbackResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Close before settling so the port is released even if the caller throws.
      server?.close(() => (err ? reject(err) : resolve(value!)));
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const respond = (title: string, message: string, ok: boolean) => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(title, message, ok));
      };

      const error = url.searchParams.get('error_description') || url.searchParams.get('error');
      if (error) {
        respond('Login failed', 'You can close this tab and read the terminal.', false);
        const message = decodeEntities(error);
        finish(new AuthError(`${provider.label} refused the login: ${message}`, scopeHint(provider, message)));
        return;
      }

      // Checked before the code is touched.
      const returnedState = url.searchParams.get('state');
      if (returnedState !== state) {
        respond('Login rejected', 'The security check did not match. Start the login again.', false);
        finish(
          new AuthError(
            'The OAuth state did not match, so the redirect was rejected.',
            'Start the login again and do not reuse an old browser tab.',
          ),
        );
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        respond('Login failed', 'No authorization code was returned.', false);
        finish(new AuthError(`${provider.label} returned no authorization code.`));
        return;
      }

      respond('Signed in', 'You can close this tab and go back to the terminal.', true);
      finish(null, {
        code,
        pkce,
        redirectUri: `http://127.0.0.1:${(server!.address() as any).port}/callback`,
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && options.port) {
        finish(
          new AuthError(
            `Port ${options.port} is already in use, so the redirect cannot be received.`,
            'Close whatever is using it, or pick another port and register that one instead.',
          ),
        );
        return;
      }
      finish(err);
    });

    // 127.0.0.1 rather than localhost: on some systems localhost resolves to ::1
    // first and the provider's redirect to the IPv4 literal then fails to connect.
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const { port } = server!.address() as any;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: (options.scopes ?? provider.scopes).join(' '),
        state,
      });

      // LinkedIn rejects the request outright if it sees PKCE parameters it does
      // not support, so they are only added for providers that accept them.
      if (!provider.needsClientSecret) {
        params.set('code_challenge', pkce.challenge);
        params.set('code_challenge_method', pkce.method);
      }
      if (provider.id === 'google') {
        // Without these Google returns no refresh token on a repeat authorisation,
        // and the login silently becomes good for one hour only.
        params.set('access_type', 'offline');
        params.set('prompt', 'consent');
      }

      options.onUrl(`${provider.authorizeUrl}?${params}`, redirectUri);

      timer = setTimeout(
        () =>
          finish(
            new AuthError(
              'Timed out waiting for the browser to complete the login.',
              'Run the command again, or use `dv auth token` to paste a token instead.',
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
    });
  });
}

/** Exchange the authorization code for tokens. */
export async function exchangeCode(
  provider: ProviderDef,
  clientId: string,
  clientSecret: string | undefined,
  result: LoopbackResult,
): Promise<any> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: result.code,
    redirect_uri: result.redirectUri,
    client_id: clientId,
  };
  if (!provider.needsClientSecret) body.code_verifier = result.pkce.verifier;
  // Google's desktop clients are issued a secret and require it here, even though
  // the docs class it as non-confidential. Sent when we have one.
  if (clientSecret) body.client_secret = clientSecret;

  const res = await fetch(provider.tokenUrl!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new AuthError(
      `${provider.label} would not exchange the code: ${detail}`,
      provider.needsClientSecret && !clientSecret
        ? `${provider.label} requires a client secret. Set it with: dv config set ${provider.id}.clientSecret <value>`
        : 'Check that the OAuth app allows http://127.0.0.1 as a redirect URI.',
    );
  }
  return data;
}

/**
 * Undo the HTML escaping providers apply to error text.
 *
 * These messages are written for a browser, so a quoted scope name arrives as
 * `&quot;w_member_social&quot;` and lands in the terminal looking like a bug in this
 * tool rather than an answer from theirs.
 */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    quot: '"',
    apos: "'",
    amp: '&',
    lt: '<',
    gt: '>',
    nbsp: ' ',
    '#39': "'",
    '#x27': "'",
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key in named) return named[key]!;
    const numeric = /^#x/i.test(name)
      ? parseInt(name.slice(2), 16)
      : /^#/.test(name)
        ? parseInt(name.slice(1), 10)
        : NaN;
    return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : whole;
  });
}

/**
 * Turn "scope X is not authorized" into the thing you actually have to go and do.
 *
 * An unauthorised scope is never a problem with the login — it means the OAuth app has
 * not been granted that permission, which is a few clicks in the provider's developer
 * console. Without this the message is accurate and completely unactionable.
 */
export function scopeHint(provider: ProviderDef, message: string): string | undefined {
  const match = /scope\s+"?([a-z0-9_.:-]+)"?\s+is not authori/i.exec(message);
  if (!match) return undefined;
  const scope = match[1]!;

  const productFor: Record<string, string> = {
    w_member_social: 'Share on LinkedIn',
    r_liteprofile: 'Sign In with LinkedIn using OpenID Connect',
    openid: 'Sign In with LinkedIn using OpenID Connect',
  };
  const product = productFor[scope];

  const lines = [`Your OAuth app has not been granted "${scope}".`];
  if (provider.id === 'linkedin') {
    lines.push(
      `Open https://www.linkedin.com/developers/apps -> your app -> Products,`,
      `and request "${product ?? scope}". Approval is usually immediate.`,
      '',
      'To sign in without it in the meantime:',
      `  dv auth login linkedin --scopes "openid profile email"`,
    );
  } else {
    lines.push(
      `Grant it on the app, or request fewer scopes:`,
      `  dv auth login ${provider.id} --scopes "<space separated>"`,
    );
  }
  return lines.join('\n');
}
