/**
 * `dv auth …`
 */

import { AuthError, UsageError } from '../cli/errors.js';
import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import {
  ask,
  c,
  info,
  json,
  out,
  promptSecret,
  relative,
  select,
  success,
  table,
  warn,
} from '../cli/ui.js';
import {
  credentialsArePrivate,
  listAccounts,
  renameAccount,
  resolveAccount,
  setActiveAccount,
  credentialsPath,
  deleteCredential,
  getCredential,
  listCredentials,
  mask,
  saveCredential,
} from '../config/store.js';
import {
  allProviders,
  defaultMethod,
  getProvider,
  providerIds,
  supportsMethod,
  resolveApp,
  type AuthMethod,
  type ProviderDef,
} from '../auth/providers.js';
import { pollForToken, requestDeviceCode } from '../auth/device.js';
import { authorizeViaLoopback, exchangeCode, openBrowser } from '../auth/loopback.js';
import { accessToken, grantedScopes, isExpired, isRefreshable } from '../auth/tokens.js';
import { github } from '../api/github.js';
import { identify as genericIdentify } from '../api/client.js';

/**
 * Confirm a credential works, and learn what it can do.
 *
 * The scopes come back only for GitHub, and only for classic tokens — no other
 * provider here reports them at identify time.
 */
async function identify(
  providerId: string,
  token?: string,
): Promise<{ account?: string; scopes?: string[] }> {
  // GitHub is special-cased only because it reports a classic token's scopes in a
  // response header, which the generic path cannot see.
  if (providerId === 'github') {
    const { login, scopes } = await github.whoamiWithScopes(token);
    return { account: login, scopes };
  }

  // Everything else is verified through the connector's own whoami endpoint. This
  // used to be `return {}`, which verified nothing — so a garbage Slack, Notion,
  // OpenAI or Anthropic key was saved and cheerfully reported as connected, and the
  // failure only surfaced at the next command. It also meant no connector added with
  // `dv connect add` was ever checked.
  const provider = getProvider(providerId)!;
  const { account } = await genericIdentify(provider, token);
  return { account };
}

/**
 * Where a freshly obtained credential should be stored.
 *
 * Identifies the token *before* writing it, so it lands under the account it actually
 * belongs to. Storing first and renaming afterwards overwrote whichever account
 * happened to be active — pasting a second GitHub token silently replaced the first,
 * which is the opposite of adding an account.
 *
 * `--as` remains available as a nickname, for when the provider's own name for you is
 * not the one you think in.
 */
export async function accountNameFor(
  providerId: string,
  token: string | undefined,
  as: string | undefined,
): Promise<{ name: string; identity?: { account?: string; scopes?: string[] } }> {
  if (as) return { name: as };
  const identity = await identify(providerId, token).catch(() => undefined);
  return { name: identity?.account ?? 'default', identity };
}

/**
 * Store a credential the user supplies directly — a PAT, an API key, a header value.
 *
 * Shared by `dv auth token <p>` and `dv auth login <p> --method token|header`, so a
 * pasted key is validated and verified identically however you arrived at it.
 */
async function saveSuppliedCredential(providerId: string, args: ParsedArgs): Promise<void> {
  const provider = getProvider(providerId)!;
  let token = str(args.flags, 'token', 'key') ?? process.env.DV_TOKEN;

  if (!token) {
    // A script cannot answer a prompt, so it still gets the flag-based error.
    if (!process.stdin.isTTY) {
      // The suggested command carries --as through. Without it, following this hint
      // while adding a second account would overwrite the first one.
      const as = str(args.flags, 'as', 'account');
      const suffix = as ? ` --as ${as}` : '';
      throw new UsageError(
        '--token is required.',
        `Get one at ${provider.appSetupUrl ?? 'the service dashboard'}, then:\n` +
          `  dv auth token ${providerId} --token <value>${suffix}\n` +
          '  (or set DV_TOKEN to keep it out of your shell history)',
      );
    }

    // Say where to get one before asking for it — the answer is rarely to hand.
    if (provider.appSetupUrl) {
      info('');
      info(`  Create one at ${c.blue(provider.appSetupUrl)}`);
      if (provider.scopes.length) info(c.dim(`  Grant: ${provider.scopes.join(', ')}`));
    }
    info('');
    token = await promptSecret(`Paste your ${provider.label} token:`);
    if (!token) throw new UsageError('Nothing entered.');
  }
  // A paste with the wrong shape is worth catching before it becomes a confusing 401.
  if (provider.tokenPattern && !provider.tokenPattern.test(token)) {
    warn(`That does not look like a ${provider.label} token. Saving it anyway.`);
  }

  // Resolved before the write, so a token belonging to someone else becomes a new
  // account instead of overwriting the active one.
  const { name } = await accountNameFor(providerId, token, str(args.flags, 'as', 'account'));
  saveCredential(providerId, { accessToken: token, method: 'token', scope: undefined }, name);
  await verifyAndReport(providerId, token, name);
}

/**
 * Username + secret as HTTP Basic — Jira Cloud and friends.
 *
 * Stored as `user:secret` and encoded at request time rather than up front, so
 * `dv auth status` can still show which account it belongs to.
 */
async function loginBasic(providerId: string, args: ParsedArgs): Promise<void> {
  const provider = getProvider(providerId)!;
  let user = str(args.flags, 'user', 'username', 'email');
  let secret = str(args.flags, 'token', 'password', 'key') ?? process.env.DV_TOKEN;

  if (!user || !secret) {
    if (!process.stdin.isTTY) {
      throw new UsageError(
        `${provider.label} needs a username and a token.`,
        `dv auth login ${providerId} --user you@example.com --token <api-token>`,
      );
    }
    if (provider.appSetupUrl) {
      info('');
      info(`  Create an API token at ${c.blue(provider.appSetupUrl)}`);
    }
    info('');
    // The username is not a secret, so it is echoed; the token is not.
    if (!user) user = await ask('Email or username:');
    if (!secret) secret = await promptSecret('API token:');
    if (!user || !secret) throw new UsageError('Both an email and a token are needed.');
  }

  // The username is the natural account name here, and is known up front.
  const name = str(args.flags, 'as', 'account') ?? user;
  saveCredential(
    providerId,
    { accessToken: `${user}:${secret}`, method: 'token', account: user, scope: undefined },
    name,
  );
  await verifyAndReport(providerId, `${user}:${secret}`, name);
}

/**
 * Client credentials — a token for the app itself, with no user involved.
 *
 * Useful for CI. There is no refresh token by design: the grant is repeatable, so
 * the correct recovery is to ask for another token rather than renew one.
 */
async function loginClientCredentials(providerId: string): Promise<void> {
  const provider = getProvider(providerId)!;
  const app = resolveApp(providerId);

  if (!app.clientId || !app.clientSecret) {
    throw new AuthError(
      `${provider.label} needs a client id and secret for this grant.`,
      `dv config set ${providerId}.clientId <id>\n  dv config set ${providerId}.clientSecret <secret>`,
    );
  }
  if (!provider.tokenUrl) {
    throw new AuthError(`${provider.label} has no token endpoint configured.`);
  }

  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      ...(provider.scopes.length ? { scope: provider.scopes.join(' ') } : {}),
    }).toString(),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new AuthError(
      `${provider.label} refused the client credentials: ${data.error_description || data.error || res.status}`,
    );
  }

  saveCredential(providerId, {
    accessToken: data.access_token,
    expiresAt: data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
      : undefined,
    scope: data.scope,
    method: 'oauth',
  });
  await verifyAndReport(providerId, data.access_token);
}

/**
 * Confirm a stored credential actually works, and say what it can do.
 *
 * Verification is not optional: saving something the service rejects and reporting
 * success would move the failure to the next command, where the cause is far less
 * obvious.
 */
async function verifyAndReport(providerId: string, token?: string, as?: string): Promise<void> {
  const provider = getProvider(providerId)!;

  if (!provider.whoamiUrl) {
    // Nothing to verify against. Say so rather than implying it was checked.
    success(`Saved the ${provider.label} credential.`);
    info(c.dim('  No verify endpoint is defined, so it has not been tested.'));
    info(c.dim(`  Add one:  dv connect add ${providerId} --whoami /me`));
    return;
  }

  const identity = await identify(providerId, token).catch((e) => {
    warn(`Saved, but ${provider.label} rejected it: ${e.message}`);
    return null;
  });
  if (!identity?.account && identity === null) return;

  // Written to the account the caller already decided on — no renaming, which is
  // what used to clobber whichever account happened to be active.
  if (identity?.account) saveCredential(providerId, { account: identity.account }, as);
  if (identity?.scopes?.length) {
    saveCredential(providerId, { scope: identity.scopes.join(' ') }, as);
  }

  success(`${provider.label} connected${identity?.account ? ` as ${c.bold(identity.account)}` : ''}.`);

  // Say what this credential cannot do, while the user is still here to fix it.
  if (identity?.scopes?.length) {
    info(c.dim(`  scopes: ${identity.scopes.join(', ')}`));
    const missing = provider.scopes.filter((s) => !identity.scopes!.includes(s));
    if (missing.length > 0) {
      warn(`Not granted: ${missing.join(', ')} — commands needing those will fail.`);
    }
  } else if (providerId === 'github') {
    // A fine-grained token sends no scope header at all. Empty means "cannot tell",
    // not "no access", so it gets its own note rather than a scary warning.
    info(c.dim('  GitHub reported no scope list — this looks like a fine-grained token.'));
    info(c.dim('  Check it grants Contents, Issues, Pull requests and Workflows as needed.'));
  }
}

/** What each way in means, in the terms someone choosing between them would care about. */
const METHOD_INFO: Record<AuthMethod, { label: string; detail: string }> = {
  device: { label: 'Browser code', detail: 'Shows a code to paste - no port, works over SSH' },
  loopback: { label: 'Browser sign-in', detail: 'Opens a browser and listens on 127.0.0.1' },
  token: { label: 'Paste a token', detail: 'A personal access token or API key' },
  basic: { label: 'Email and token', detail: 'Sent as HTTP Basic' },
  header: { label: 'Paste an API key', detail: 'Sent in a custom header' },
  client_credentials: { label: 'App credentials', detail: 'Machine-to-machine, no user involved' },
};

/**
 * Decide how to connect.
 *
 * `--method` wins. Otherwise ask: being told to re-run with a flag you could not have
 * known about is a worse experience than a menu. A non-TTY falls through to the
 * provider's best method, so scripts keep working without one.
 */
async function chooseMethod(provider: ProviderDef, args: ParsedArgs): Promise<AuthMethod> {
  const explicit = str(args.flags, 'method', 'm') as AuthMethod | undefined;
  if (explicit) {
    if (!supportsMethod(provider, explicit)) {
      throw new UsageError(
        `${provider.label} cannot be connected with "${explicit}".`,
        `It supports: ${provider.methods.join(', ')}`,
      );
    }
    return explicit;
  }

  // Recommend what actually works right now, not what is best in principle.
  // Device flow and browser sign-in both need an OAuth app registered first, so
  // suggesting them to someone who has not done that is suggesting an error.
  const app = resolveApp(provider.id);
  const usable = (method: AuthMethod): boolean => {
    if (method === 'device' || method === 'client_credentials') return Boolean(app.clientId);
    if (method === 'loopback') {
      return Boolean(app.clientId) && !(provider.needsClientSecret && !app.clientSecret);
    }
    // Pasting a token or a username needs nothing configured in advance.
    return true;
  };

  const firstUsable = provider.methods.findIndex(usable);

  return select(
    `How would you like to connect to ${provider.label}?`,
    provider.methods.map((method, i) => {
      const ready = usable(method);
      const detail = METHOD_INFO[method]?.detail;
      return {
        value: method,
        label: METHOD_INFO[method]?.label ?? method,
        // Say why an option is not ready rather than listing it as if it were.
        detail: ready ? detail : `${detail} - needs an OAuth app first`,
        recommended: i === firstUsable,
      };
    }),
  );
}

/**
 * Explain how to get an OAuth app, in the order a person would do it.
 *
 * This is the one place a user is genuinely blocked, so it spells out every step
 * rather than naming a command and leaving the rest as an exercise.
 */
function setupInstructions(provider: ProviderDef, extra: string[] = []): string {
  return [
    `${provider.label} needs an OAuth app. It takes about a minute:`,
    '',
    `  1. Open ${provider.oauthAppUrl ?? provider.appSetupUrl ?? 'the developer console'}`,
    ...extra.map((line) => `  ${line}`),
    `  ${extra.length + 2}. Copy the client id, then run:`,
    `       dv config set ${provider.id}.clientId <id>`,
    ...(provider.needsClientSecret
      ? [`       dv config set ${provider.id}.clientSecret <secret>`]
      : []),
  ].join('\n');
}

async function loginDevice(providerId: string, args: ParsedArgs): Promise<void> {
  const provider = getProvider(providerId)!;
  const app = resolveApp(providerId);
  if (!app.clientId) {
    throw new AuthError(
      `${provider.label} is not set up yet.`,
      setupInstructions(provider, ['2. Create an OAuth App and tick "Enable Device Flow" (it is off by default)']),
    );
  }

  const device = await requestDeviceCode(provider, app.clientId);

  // The code is the thing the user must act on, so it gets its own line and colour.
  info('');
  info(`  ${c.bold('One-time code:')}  ${c.cyan(c.bold(device.user_code))}`);
  info(`  ${c.dim('Enter it at')}     ${c.blue(device.verification_uri)}`);
  info('');

  const opened = openBrowser(device.verification_uri);
  info(opened ? c.dim('  Opening your browser…') : c.dim('  Open that URL to continue.'));
  info(c.dim('  Waiting for approval — this window stays open.'));

  const token = await pollForToken(provider, app.clientId, device, {
    onSlowDown: (ms) => warn(`${provider.label} asked us to slow down; polling every ${ms / 1000}s.`),
  });

  const { name } = await accountNameFor(
    providerId,
    token.access_token,
    str(args.flags, 'as', 'account'),
  );
  saveCredential(
    providerId,
    {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in
        ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
        : undefined,
      scope: token.scope,
      method: 'device',
    },
    name,
  );

  await verifyAndReport(providerId, token.access_token, name);
}

async function loginLoopback(providerId: string, args: ParsedArgs): Promise<void> {
  const provider = getProvider(providerId)!;
  const app = resolveApp(providerId);

  if (!app.clientId) {
    throw new AuthError(
      `${provider.label} is not set up yet.`,
      setupInstructions(provider, ['2. Create the app and allow http://127.0.0.1 as a redirect URI']),
    );
  }
  if (provider.needsClientSecret && !app.clientSecret) {
    throw new AuthError(
      `${provider.label} requires a client secret — it does not support PKCE.`,
      `dv config set ${providerId}.clientSecret <secret>`,
    );
  }

  // A pinned port makes a client that requires an exactly-registered redirect URI
  // usable; otherwise the OS picks one and the URI changes every attempt.
  const pinnedPort = num(args.flags, 'port', Number(app.redirectPort ?? 0)) || undefined;
  if (pinnedPort) {
    info('');
    info(`  ${c.dim('This exact URI must be registered on the OAuth app:')}`);
    info(`  ${c.bold(`http://127.0.0.1:${pinnedPort}/callback`)}`);
  }

  // A narrowed scope set, for when one scope is gated behind an unapproved product.
  const scopeOverride = str(args.flags, 'scopes', 'scope')
    ?.split(/[\s,]+/)
    .filter(Boolean);
  if (scopeOverride?.length) {
    info('');
    info(`  ${c.dim(`Requesting only: ${scopeOverride.join(' ')}`)}`);
  }

  const result = await authorizeViaLoopback(provider, app.clientId, {
    port: pinnedPort,
    scopes: scopeOverride?.length ? scopeOverride : undefined,
    onUrl: (url, redirectUri) => {
      const opened = openBrowser(url);
      info('');
      info(opened ? `  ${c.dim('Opening your browser…')}` : '  Open this URL to approve access:');
      // Always shown, even when the launcher started. A successful spawn does not
      // mean the browser rendered the right page — a shell that mangled the URL
      // looked identical to success until Google rejected the request.
      info(`  ${c.blue(url)}`);
      info('');
      info(`  ${c.dim(`Waiting for the redirect on ${redirectUri}`)}`);
      info('');
    },
  });

  const token = await exchangeCode(provider, app.clientId, app.clientSecret, result);

  const { name } = await accountNameFor(
    providerId,
    token.access_token,
    str(args.flags, 'as', 'account'),
  );
  saveCredential(
    providerId,
    {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in
        ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
        : undefined,
      scope: token.scope,
      method: 'oauth',
    },
    name,
  );

  await verifyAndReport(providerId, token.access_token, name);

  // Worth flagging now rather than at the first expiry.
  if (!token.refresh_token) {
    warn(
      `${provider.label} issued no refresh token, so this session ends when it expires. ` +
        `Re-run the login then, or check the app is configured for offline access.`,
    );
  }
}

export async function authCommand(args: ParsedArgs): Promise<void> {
  const sub = args.command[1] ?? (args.positional[0] as string | undefined);

  switch (sub) {
    case 'login': {
      const providerId = args.command[2] ?? args.positional[0];
      if (!providerId) {
        throw new UsageError(
          'Which provider?',
          `One of: ${providerIds().join(', ')}\n  dv auth login github`,
        );
      }
      const provider = getProvider(providerId);
      if (!provider) throw new UsageError(`Unknown provider "${providerId}".`, `Try: ${providerIds().join(', ')}`);

      // A service usually allows more than one way in. The default is the best
      // available for a CLI; --method picks another when you have a reason.
      const chosen = await chooseMethod(provider, args);

      if (provider.setupHint && args.flags.__hintShown !== true) {
        info('');
        for (const line of provider.setupHint.split('\n')) info(c.dim(`  ${line}`));
      }

      switch (chosen) {
        case 'device':
          await loginDevice(providerId, args);
          return;
        case 'loopback':
          await loginLoopback(providerId, args);
          return;
        case 'basic':
          await loginBasic(providerId, args);
          return;
        case 'token':
        case 'header':
          // Both store a value the user supplies. The difference is only in how it
          // gets attached to a request, which the provider definition already says.
          await saveSuppliedCredential(providerId, args);
          return;
        case 'client_credentials':
          await loginClientCredentials(providerId);
          return;
        default:
          throw new UsageError(`"${chosen}" is not a connection method.`);
      }
    }

    case 'token': {
      const providerId = args.command[2] ?? args.positional[0];
      if (!providerId) throw new UsageError('Which provider?', 'dv auth token github --token ghp_…');
      if (!getProvider(providerId)) {
        throw new UsageError(`Unknown provider "${providerId}".`, `Try: ${providerIds().join(', ')}`);
      }
      // Same path as `auth login --method token`, so a pasted key is validated and
      // verified identically however you arrived at it.
      await saveSuppliedCredential(providerId, args);
      return;
    }

    case 'accounts': {
      const providerId = args.command[2] ?? args.positional[0];
      const wanted = providerId ? [providerId] : Object.keys(allProviders());

      const rows = wanted.flatMap((id) => {
        const { active, names } = listAccounts(id);
        return names.map((name) => {
          const credential = getCredential(id, name);
          return { provider: id, name, active: name === active, credential };
        });
      });

      if (bool(args.flags, 'json')) {
        return json(
          rows.map((r) => ({
            provider: r.provider,
            account: r.name,
            active: r.active,
            method: r.credential?.method ?? null,
            expiresAt: r.credential?.expiresAt ?? null,
          })),
        );
      }
      if (rows.length === 0) {
        return info(providerId ? `No accounts for ${providerId}.` : 'No accounts yet.');
      }

      table(rows, [
        { header: '', value: (r) => (r.active ? c.green('*') : ' ') },
        { header: 'provider', value: (r) => r.provider },
        { header: 'account', value: (r) => (r.active ? c.bold(r.name) : r.name), max: 34 },
        { header: 'via', value: (r) => r.credential?.method ?? '—' },
        {
          header: 'expires',
          value: (r) => (r.credential?.expiresAt ? relative(r.credential.expiresAt) : '—'),
        },
      ]);
      info('');
      info(c.dim('  dv auth switch <provider> <account>   ·   or one-off: --as <account>'));
      return;
    }

    case 'switch':
    case 'use': {
      const providerId = args.command[2] ?? args.positional[0];
      if (!providerId) {
        throw new UsageError('Which provider?', 'dv auth switch github personal');
      }
      const { active, names } = listAccounts(providerId);
      if (names.length === 0) {
        throw new UsageError(`No accounts for ${providerId}.`, `dv auth login ${providerId}`);
      }

      let target = args.command[3] ?? args.positional[1];
      if (!target) {
        if (names.length === 1) {
          return info(`${providerId} has only one account (${names[0]}).`);
        }
        if (!process.stdin.isTTY) {
          throw new UsageError('Which account?', `Available: ${names.join(', ')}`);
        }
        target = await select(
          `Which ${providerId} account?`,
          names.map((name) => ({
            value: name,
            label: name,
            detail: name === active ? 'current' : undefined,
            recommended: name === active,
          })),
        );
      }

      setActiveAccount(providerId, target);
      success(`${providerId} now uses ${c.bold(target)}.`);
      return;
    }

    case 'logout': {
      const providerId = args.command[2] ?? args.positional[0];
      if (!providerId) throw new UsageError('Which provider?', 'dv auth logout github');
      // Without --as this removes every account for the provider, which is what
      // "log out of GitHub" means; with it, just the one named.
      const account = str(args.flags, 'as', 'account');
      const removed = deleteCredential(providerId, account);
      if (removed) {
        success(account ? `Removed ${providerId} account "${account}".` : `Logged out of ${providerId}.`);
        const left = listAccounts(providerId);
        if (left.names.length > 0) info(c.dim(`  Still signed in as: ${left.names.join(', ')}`));
      } else {
        info(account ? `No "${account}" account for ${providerId}.` : `${providerId} was not connected.`);
      }
      return;
    }

    case 'refresh': {
      const providerId = args.command[2] ?? args.positional[0];
      if (!providerId) throw new UsageError('Which provider?', 'dv auth refresh google');
      await accessToken(providerId, { force: true });
      success(`Renewed the ${providerId} session.`);
      return;
    }

    case 'status':
    case undefined: {
      const stored = listCredentials();
      const rows = Object.values(allProviders()).map((p) => {
        const cred = stored[p.id];
        const state = !cred?.accessToken
          ? c.gray('not connected')
          : isExpired(cred, 0)
            ? isRefreshable(cred)
              ? c.yellow('expired, renewable')
              : c.red('expired')
            : isExpired(cred)
              ? c.yellow('renewing soon')
              : c.green('connected');
        return { p, cred, state };
      });

      if (bool(args.flags, 'json')) {
        json(
          rows.map(({ p, cred }) => ({
            provider: p.id,
            connected: Boolean(cred?.accessToken),
            account: cred?.account ?? null,
            method: cred?.method ?? null,
            expiresAt: cred?.expiresAt ?? null,
            refreshable: cred ? isRefreshable(cred) : false,
            scopes: grantedScopes(p.id),
          })),
        );
        return;
      }

      table(rows, [
        { header: 'provider', value: (r) => r.p.id },
        { header: 'status', value: (r) => r.state },
        { header: 'account', value: (r) => r.cred?.account ?? '—' },
        { header: 'via', value: (r) => r.cred?.method ?? '—' },
        { header: 'expires', value: (r) => (r.cred?.expiresAt ? relative(r.cred.expiresAt) : '—') },
      ]);

      const connected = rows.filter((r) => r.cred?.accessToken).length;
      info('');
      info(c.dim(`  ${connected} of ${rows.length} connected · ${credentialsPath()}`));

      // A world-readable token file is worth saying out loud.
      if (!credentialsArePrivate()) {
        warn(`${credentialsPath()} is readable by other users. Fix with: chmod 600 ${credentialsPath()}`);
      }
      return;
    }

    case 'scopes': {
      const providerId = args.command[2] ?? args.positional[0];
      if (!providerId) throw new UsageError('Which provider?', 'dv auth scopes github');
      const granted = grantedScopes(providerId);
      const provider = getProvider(providerId);
      if (bool(args.flags, 'json')) {
        json({ provider: providerId, granted, requested: provider?.scopes ?? [] });
        return;
      }
      if (granted.length === 0) {
        info(`${providerId} did not report its scopes, so they cannot be listed.`);
        return;
      }
      for (const s of granted) out(s);
      return;
    }

    case 'whoami': {
      const providerId = args.command[2] ?? args.positional[0];
      if (!providerId) throw new UsageError('Which provider?', 'dv auth whoami github');
      const { account } = await identify(providerId);
      if (!account) throw new AuthError(`Could not identify the ${providerId} account.`);
      out(account);
      return;
    }

    default:
      throw new UsageError(
        `Unknown auth command "${sub}".`,
        'Try: login, token, logout, refresh, status, scopes, whoami, accounts, switch',
      );
  }
}
