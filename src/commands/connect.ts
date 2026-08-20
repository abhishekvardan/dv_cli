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
import { c, info, json, out, success, table, warn } from '../cli/ui.js';
import { readConfig, writeConfig, getCredential } from '../config/store.js';
import {
  allProviders,
  BUILT_IN,
  getProvider,
  type AuthMethod,
  type AuthStyle,
  type CustomProviderRecord,
} from '../auth/providers.js';
import { identify } from '../api/client.js';

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
        { header: '', value: (p) => (p.custom ? c.cyan('custom') : '') },
      ]);
      info('');
      info(c.dim(`  ${providers.length} connectors · dv connect add <id> to define your own`));
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
        for (const line of provider.setupHint.split('\n')) out(c.yellow(line));
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

    default:
      throw new UsageError(
        `Unknown connect command "${sub}".`,
        'Try: list, show, add, rm, test',
      );
  }
}
