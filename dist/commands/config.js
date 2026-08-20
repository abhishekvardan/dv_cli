/**
 * `dv config …` — OAuth client ids and secrets.
 *
 * Keys are `provider.field`, e.g. `github.clientId`. A secret set here lands in
 * ~/.dv/config.json at 0600; the environment variables named by `config list`
 * are the alternative when nothing should touch the disk.
 */
import { UsageError } from '../cli/errors.js';
import { bool } from '../cli/args.js';
import { c, info, json, out, success, table } from '../cli/ui.js';
import { configPath, mask, readConfig, setOAuthApp, writeConfig } from '../config/store.js';
import { allProviders, getProvider, providerIds } from '../auth/providers.js';
const FIELDS = ['clientId', 'clientSecret', 'apiBase', 'redirectPort'];
function parseKey(key) {
    const dot = key.indexOf('.');
    if (dot === -1) {
        throw new UsageError(`"${key}" is not a config key.`, 'Keys look like <provider>.<field>, e.g. github.clientId');
    }
    const provider = key.slice(0, dot).toLowerCase();
    const field = key.slice(dot + 1);
    if (!getProvider(provider)) {
        throw new UsageError(`Unknown provider "${provider}".`, `Try: ${providerIds().join(', ')}`);
    }
    if (!FIELDS.includes(field)) {
        throw new UsageError(`Unknown field "${field}".`, `Try: ${FIELDS.join(', ')}`);
    }
    return { provider, field };
}
export async function configCommand(args) {
    const sub = args.command[1];
    switch (sub) {
        case 'set': {
            const key = args.command[2] ?? args.positional[0];
            const value = args.command[3] ?? args.positional[1];
            if (!key || value === undefined) {
                throw new UsageError('Need a key and a value.', 'dv config set github.clientId Iv1.abc123');
            }
            const { provider, field } = parseKey(key);
            setOAuthApp(provider, { [field]: value });
            // Only a secret is masked. A client id, base URL or port is public, and hiding
            // it just makes the confirmation useless for spotting a typo.
            const shown = field === 'clientSecret' ? mask(value) : value;
            success(`Set ${c.bold(`${provider}.${field}`)} = ${shown}`);
            return;
        }
        case 'get': {
            const key = args.command[2] ?? args.positional[0];
            if (!key)
                throw new UsageError('Which key?', 'dv config get github.clientId');
            const { provider, field } = parseKey(key);
            const stored = readConfig().apps?.[provider]?.[field];
            if (!stored) {
                info(`${provider}.${field} is not set.`);
                return;
            }
            // A client id is public and often needed verbatim; a secret is not printed.
            if (field === 'clientSecret')
                out(mask(stored));
            else
                out(stored);
            return;
        }
        case 'unset': {
            const key = args.command[2] ?? args.positional[0];
            if (!key)
                throw new UsageError('Which key?', 'dv config unset github.clientSecret');
            const { provider, field } = parseKey(key);
            const config = readConfig();
            if (config.apps?.[provider]) {
                delete config.apps[provider][field];
                writeConfig(config);
            }
            success(`Unset ${provider}.${field}.`);
            return;
        }
        case 'path':
            out(configPath());
            return;
        case 'list':
        case undefined: {
            const config = readConfig();
            const rows = Object.values(allProviders()).flatMap((p) => 
            // Only providers with a browser-based login need an OAuth app at all.
            FIELDS
                // Only a browser-based login needs an OAuth app; apiBase applies to any
                // connector whose host is per-customer.
                .filter((f) => f === 'apiBase'
                ? !p.apiBase
                : f === 'redirectPort'
                    ? // Only a browser-redirect flow has a redirect URI to pin.
                        p.methods.includes('loopback')
                    : p.methods.some((m) => m === 'device' || m === 'loopback' || m === 'client_credentials'))
                .filter((f) => !(f === 'clientSecret' && !p.needsClientSecret && !p.methods.includes('loopback')))
                .map((f) => {
                const stored = config.apps?.[p.id]?.[f];
                const suffix = f === 'clientId'
                    ? 'CLIENT_ID'
                    : f === 'clientSecret'
                        ? 'CLIENT_SECRET'
                        : f === 'apiBase'
                            ? 'API_BASE'
                            : 'REDIRECT_PORT';
                const envVar = `DV_${p.id.toUpperCase()}_${suffix}`;
                const fromEnv = process.env[envVar];
                return {
                    key: `${p.id}.${f}`,
                    value: fromEnv ? mask(fromEnv) : stored ? (f === 'clientSecret' ? mask(stored) : stored) : '—',
                    source: fromEnv ? 'env' : stored ? 'config' : 'unset',
                    envVar,
                    required: f === 'clientId' || Boolean(p.needsClientSecret),
                };
            }));
            if (bool(args.flags, 'json')) {
                json(rows);
                return;
            }
            table(rows, [
                { header: 'key', value: (r) => r.key },
                { header: 'value', value: (r) => r.value, max: 44 },
                {
                    header: 'source',
                    value: (r) => r.source === 'unset'
                        ? r.required
                            ? c.yellow('unset (needed)')
                            : c.gray('unset')
                        : c.green(r.source),
                },
                { header: 'env var', value: (r) => c.dim(r.envVar) },
            ]);
            info('');
            info(c.dim(`  ${configPath()}`));
            info(c.dim('  Vercel needs no OAuth app — it uses a personal access token.'));
            return;
        }
        default:
            throw new UsageError(`Unknown config command "${sub}".`, 'Try: set, get, unset, list, path');
    }
}
//# sourceMappingURL=config.js.map