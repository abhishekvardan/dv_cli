/**
 * `dv connect …` — add and inspect connectors.
 *
 * The point: connecting to something this CLI has never heard of should not require
 * changing this CLI. A definition is four facts — base URL, how the credential
 * attaches, any fixed headers, and an endpoint that proves it works — and once
 * stored, every generic command works against it.
 */

import { UsageError } from '../cli/errors.js';
import { bool, str, unmanglePath, type ParsedArgs } from '../cli/args.js';
import { ask, c, info, json, out, promptSecret, success, table, warn } from '../cli/ui.js';
import { readConfig, writeConfig, getCredential, setOAuthApp } from '../config/store.js';
import {
  allProviders,
  BUILT_IN,
  getProvider,
  providerIds,
  resolveApp,
  type AuthMethod,
  type AuthStyle,
  type CustomProviderRecord,
} from '../auth/providers.js';
import { identify } from '../api/client.js';
import { authCommand } from './auth.js';

const METHODS: AuthMethod[] = ['device', 'loopback', 'token', 'basic', 'header', 'client_credentials'];

function parseAuthStyle(value: string | undefined): AuthStyle | undefined {
  if (!value) return undefined;
  if (['bearer', 'basic', 'token'].includes(value)) return value as AuthStyle;
  if (value.startsWith('header:') || value.startsWith('query:')) return value as AuthStyle;
  throw new UsageError(
    `"${value}" is not a valid auth style.`,
    'One of: bearer, basic, token, header:<Name>, query:<param>',
  );
}

/** `--header "X: Y"` repeated, or a single value. */
function parseHeaders(raw: string | string[] | boolean | undefined): Record<string, string> | undefined {
  if (raw === undefined || typeof raw === 'boolean') return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const headers: Record<string, string> = {};
  for (const entry of list) {
    const colon = entry.indexOf(':');
    if (colon === -1) {
      throw new UsageError(`Header "${entry}" needs a colon.`, '--header "Notion-Version: 2022-06-28"');
    }
    headers[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
  }
  return headers;
}

/**
 * What a connector needs before it can be used, in the order you would supply it.
 *
 * `dv connect <name>` exists because "connect" is the word people reach for, and
 * being told "unknown command" at that moment is the worst possible answer — the user
 * knows exactly what they want and the tool refuses to help. This walks through the
 * requirements, asks for each one, and finishes by actually signing in.
 */
async function setupConnector(providerId: string, args: ParsedArgs): Promise<void> {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new UsageError(
      `No connector "${providerId}".`,
      `Available: ${providerIds().join(', ')}\nOr define your own: dv connect add ${providerId} --api-base https://…`,
    );
  }

  const app = resolveApp(provider.id);
  const needsId = provider.methods.some((m) => m === 'device' || m === 'loopback' || m === 'client_credentials');
  const needsSecret = Boolean(provider.needsClientSecret);

  info('');
  info(c.bold(`Connecting ${provider.label}`));
  info('');

  // Say what is required before asking for anything, so the user knows how long this
  // is going to take and can go and get the values first.
  const wants: string[] = [];
  if (needsId && !app.clientId) wants.push('an OAuth client id');
  if (needsSecret && !app.clientSecret) wants.push('a client secret');
  if (!needsId) wants.push(provider.methods.includes('basic') ? 'an email and API token' : 'an API token');

  info(`  ${provider.label} needs ${wants.join(' and ')}.`);
  if (provider.oauthAppUrl ?? provider.appSetupUrl) {
    info(`  Get it at ${c.blue(provider.oauthAppUrl ?? provider.appSetupUrl!)}`);
  }
  if (provider.setupHint) {
    info('');
    for (const line of provider.setupHint.split('\n')) info(c.dim(`  ${line}`));
  }
  info('');

  // Collect the OAuth app values first — the login cannot start without them.
  if (needsId && !app.clientId) {
    if (!process.stdin.isTTY) {
      throw new UsageError(
        `${provider.label} needs an OAuth client id.`,
        `dv config set ${provider.id}.clientId <id>`,
      );
    }
    const clientId = await ask('Client id:');
    if (!clientId) throw new UsageError('A client id is required.');
    setOAuthApp(provider.id, { clientId });
    success('Saved the client id.');
  }

  if (needsSecret && !resolveApp(provider.id).clientSecret) {
    if (!process.stdin.isTTY) {
      throw new UsageError(
        `${provider.label} needs a client secret.`,
        `dv config set ${provider.id}.clientSecret <secret>`,
      );
    }
    // Hidden: a secret echoed here ends up in scrollback and screen recordings.
    const clientSecret = await promptSecret('Client secret:');
    if (!clientSecret) throw new UsageError('A client secret is required.');
    setOAuthApp(provider.id, { clientSecret });
    success('Saved the client secret.');
  }

  // Hand off to the real login, so there is one implementation of every flow.
  await authCommand({
    ...args,
    command: ['auth', 'login', provider.id],
    positional: [],
    // The requirements were already spelled out above; the login would repeat them.
    flags: { ...args.flags, __hintShown: true },
  });
}

export async function connectCommand(args: ParsedArgs): Promise<void> {
  const sub = args.command[1] ?? 'list';
  const asJson = bool(args.flags, 'json');

  switch (sub) {
    case 'list': {
      const providers = Object.values(allProviders());
      if (asJson) {
        json(
          providers.map((p) => ({
            id: p.id,
            label: p.label,
            methods: p.methods,
            apiBase: p.apiBase ?? null,
            authStyle: p.authStyle ?? 'bearer',
            custom: Boolean(p.custom),
            connected: Boolean(getCredential(p.id)?.accessToken),
          })),
        );
        return;
      }

      table(providers, [
        { header: 'id', value: (p) => (p.custom ? c.cyan(p.id) : c.bold(p.id)) },
        {
          header: 'status',
          value: (p) => (getCredential(p.id)?.accessToken ? c.green('connected') : c.gray('—')),
        },
        { header: 'ways to connect', value: (p) => p.methods.join(', '), max: 34 },
        { header: 'auth', value: (p) => c.dim(p.authStyle ?? 'bearer') },
        {
          header: 'next step',
          // A bare dash tells you nothing. Every unconnected row carries the command
          // that connects it, and rows needing setup first say which.
          value: (p) => {
            if (getCredential(p.id)?.accessToken) return p.custom ? c.cyan('custom') : '';
            const app = resolveApp(p.id);
            // Only a problem when *every* way in needs an app. A service that also
            // accepts a pasted token needs no setup at all, and saying otherwise sends
            // people to a developer console they never had to visit.
            const needsApp =
              !app.clientId &&
              p.methods.every((m) => m === 'device' || m === 'loopback' || m === 'client_credentials');
            return needsApp
              ? c.dim(`dv connect ${p.id}  (register an OAuth app first)`)
              : c.dim(`dv connect ${p.id}`);
          },
        },
      ]);
      info('');
      info(c.dim(`  ${providers.length} connectors`));
      info(c.dim('  dv connect <name>      guided setup for one'));
      info(c.dim('  dv connect add <name>  define your own'));
      return;
    }

    case 'show': {
      const id = args.command[2] ?? args.positional[0];
      if (!id) throw new UsageError('Which connector?', 'dv connect show notion');
      const provider = getProvider(id);
      if (!provider) throw new UsageError(`No connector "${id}".`, 'dv connect list');

      if (asJson) return json(provider);

      out(c.bold(provider.label) + (provider.custom ? c.cyan('  (custom)') : ''));
      out('');
      out(`${c.dim('id         ')} ${provider.id}`);
      out(`${c.dim('connect via')} ${provider.methods.join(', ')}`);
      out(`${c.dim('api base   ')} ${provider.apiBase ?? '—'}`);
      out(`${c.dim('auth style ')} ${provider.authStyle ?? 'bearer'}`);
      if (provider.headers) {
        out(`${c.dim('headers    ')} ${Object.entries(provider.headers).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
      }
      if (provider.scopes.length) out(`${c.dim('scopes     ')} ${provider.scopes.join(' ')}`);
      if (provider.whoamiUrl) out(`${c.dim('verify with')} ${provider.whoamiUrl}`);
      if (provider.appSetupUrl) out(`${c.dim('get a key  ')} ${provider.appSetupUrl}`);
      if (provider.docs) out(`${c.dim('docs       ')} ${provider.docs}`);
      if (provider.setupHint) {
        out('');
    for (const line of provider.setupHint.split('\n')) info(c.dim(`  ${line}`));
      }
      return;
    }

    case 'add': {
      const id = (args.command[2] ?? args.positional[0] ?? '').toLowerCase();
      if (!id) {
        throw new UsageError(
          'What should the connector be called?',
          'dv connect add pagerduty --api-base https://api.pagerduty.com \\\n' +
            '    --auth-style "header:Authorization" --whoami /users/me',
        );
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
        throw new UsageError(
          `"${id}" is not a usable id.`,
          'Use lowercase letters, digits, dash or underscore, starting with a letter.',
        );
      }

      const apiBase = str(args.flags, 'api-base', 'base');
      if (!apiBase) {
        throw new UsageError(
          '--api-base is required — it is what `dv api` calls.',
          'dv connect add mysvc --api-base https://api.mysvc.com',
        );
      }

      const methodsFlag = str(args.flags, 'methods', 'method');
      const methods = methodsFlag
        ? (methodsFlag.split(',').map((m) => m.trim()) as AuthMethod[])
        : (['token'] as AuthMethod[]);
      for (const m of methods) {
        if (!METHODS.includes(m)) {
          throw new UsageError(`"${m}" is not a connection method.`, `One of: ${METHODS.join(', ')}`);
        }
      }

      const record: CustomProviderRecord = {
        label: str(args.flags, 'label') ?? id,
        methods,
        apiBase,
        authStyle: parseAuthStyle(str(args.flags, 'auth-style', 'auth')) ?? 'bearer',
        headers: parseHeaders(args.flags['header']),
        whoamiUrl: ((v) => (v ? unmanglePath(v) : undefined))(str(args.flags, 'whoami')),
        accountPath: str(args.flags, 'account-path'),
        scopes: str(args.flags, 'scopes')?.split(/[,\s]+/).filter(Boolean),
        authorizeUrl: str(args.flags, 'authorize-url'),
        tokenUrl: str(args.flags, 'token-url'),
        deviceCodeUrl: str(args.flags, 'device-code-url'),
        needsClientSecret: bool(args.flags, 'needs-secret') || undefined,
        appSetupUrl: str(args.flags, 'setup-url'),
        docs: str(args.flags, 'docs'),
      };

      const config = readConfig();
      config.providers = config.providers ?? {};
      const existed = Boolean(config.providers[id]);
      const shadowsBuiltIn = Boolean(BUILT_IN[id]);
      config.providers[id] = { ...(config.providers[id] as object), ...record };
      writeConfig(config);

      success(`${existed ? 'Updated' : 'Added'} connector ${c.bold(id)}.`);
      if (shadowsBuiltIn) {
        // Silently overriding a built-in would be confusing later.
        warn(`This overrides the built-in "${id}" connector.`);
      }
      info('');
      info(`  Connect it:  ${c.bold(`dv auth token ${id} --token <key>`)}`);
      info(`  Then call:   ${c.bold(`dv api ${id} ${record.whoamiUrl ?? '/'}`)}`);
      return;
    }

    case 'remove':
    case 'rm': {
      const id = args.command[2] ?? args.positional[0];
      if (!id) throw new UsageError('Which connector?', 'dv connect rm mysvc');
      const config = readConfig();
      if (!config.providers?.[id]) {
        if (BUILT_IN[id]) {
          throw new UsageError(
            `"${id}" is built in and cannot be removed.`,
            `To stop using it: dv auth logout ${id}`,
          );
        }
        info(`No custom connector "${id}".`);
        return;
      }
      delete config.providers[id];
      writeConfig(config);
      success(`Removed the custom connector "${id}".`);
      if (BUILT_IN[id]) info(c.dim(`  The built-in "${id}" is in effect again.`));
      return;
    }

    case 'test': {
      const id = args.command[2] ?? args.positional[0];
      if (!id) throw new UsageError('Which connector?', 'dv connect test notion');
      const provider = getProvider(id);
      if (!provider) throw new UsageError(`No connector "${id}".`, 'dv connect list');
      if (!provider.whoamiUrl) {
        throw new UsageError(
          `"${id}" has no verify endpoint, so there is nothing to test.`,
          `dv connect add ${id} --whoami /me   # to set one`,
        );
      }

      const { account, raw } = await identify(provider);
      if (asJson) return json({ provider: id, ok: true, account: account ?? null, response: raw });
      success(`${provider.label} works${account ? ` — ${c.bold(account)}` : ''}.`);
      return;
    }

    default: {
      // `dv connect supabase` is a provider name, not a mistyped subcommand.
      if (getProvider(sub)) return setupConnector(sub, args);
      throw new UsageError(
        `Unknown connect command "${sub}".`,
        `Try: list, show, add, rm, test
Or name a connector: dv connect ${providerIds()[0]}`,
      );
    }
  }
}
