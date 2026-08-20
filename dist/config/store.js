/**
 * On-disk credential and config store.
 *
 * Credentials live in a file rather than a keychain deliberately: a keychain binding
 * would be a native dependency per platform, and this file is the same thing `gh`,
 * `aws` and `gcloud` all do. What matters is that it is not readable by other users
 * on the machine, which is enforced on write and checked on read.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { configPath, credentialsPath, dvHome } from './paths.js';
import { CliError } from '../cli/errors.js';
/** Owner read/write only. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
function ensureHome() {
    const home = dvHome();
    if (!existsSync(home))
        mkdirSync(home, { recursive: true, mode: DIR_MODE });
}
function readJson(path, fallback) {
    if (!existsSync(path))
        return fallback;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        throw new CliError(`${path} is not valid JSON.`, 1, 'Delete the file to start fresh, or fix it by hand if it holds credentials you need.');
    }
}
/**
 * Write, then move into place.
 *
 * A direct write can leave a truncated file if the process dies mid-write, and the
 * truncated file is the one holding the tokens. The temp file is created with the
 * restricted mode before any content goes into it, so there is no window where the
 * data exists at default permissions.
 */
function writeJsonSecurely(path, value) {
    ensureHome();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
    try {
        chmodSync(tmp, FILE_MODE);
        renameSync(tmp, path);
        chmodSync(path, FILE_MODE);
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch {
            /* the rename may already have consumed it */
        }
        throw err;
    }
}
/**
 * Whether the credentials file is readable by anyone other than its owner.
 *
 * Windows does not model POSIX bits, so the check is skipped there rather than
 * printing a warning that cannot be acted on.
 */
export function credentialsArePrivate() {
    const path = credentialsPath();
    if (!existsSync(path))
        return true;
    if (process.platform === 'win32')
        return true;
    const mode = statSync(path).mode & 0o777;
    return (mode & 0o077) === 0;
}
function readCredentialFile() {
    const data = readJson(credentialsPath(), { version: 1, providers: {} });
    return { version: 1, providers: data.providers ?? {} };
}
export function getCredential(provider) {
    return readCredentialFile().providers[provider];
}
export function listCredentials() {
    return readCredentialFile().providers;
}
/**
 * Merge a patch into one provider's credential.
 *
 * Read-modify-write against the file rather than an in-memory copy: two commands can
 * run at once, and rebuilding the whole file from a stale snapshot is how you lose
 * an unrelated provider's token.
 */
export function saveCredential(provider, patch) {
    const file = readCredentialFile();
    const merged = {
        ...file.providers[provider],
        ...patch,
        obtainedAt: patch.obtainedAt ?? file.providers[provider]?.obtainedAt ?? new Date().toISOString(),
    };
    file.providers[provider] = merged;
    writeJsonSecurely(credentialsPath(), file);
    return merged;
}
export function deleteCredential(provider) {
    const file = readCredentialFile();
    if (!file.providers[provider])
        return false;
    delete file.providers[provider];
    writeJsonSecurely(credentialsPath(), file);
    return true;
}
export function readConfig() {
    return readJson(configPath(), {});
}
export function writeConfig(config) {
    writeJsonSecurely(configPath(), config);
}
/**
 * The OAuth app for a provider.
 *
 * Environment variables win over the config file so CI can supply them without
 * writing anything to disk.
 */
export function getOAuthApp(provider) {
    const config = readConfig();
    const stored = config.apps?.[provider] ?? {};
    const upper = provider.toUpperCase();
    return {
        clientId: process.env[`DV_${upper}_CLIENT_ID`] || stored.clientId,
        clientSecret: process.env[`DV_${upper}_CLIENT_SECRET`] || stored.clientSecret,
        apiBase: process.env[`DV_${upper}_API_BASE`] || stored.apiBase,
        redirectPort: process.env[`DV_${upper}_REDIRECT_PORT`] || stored.redirectPort,
    };
}
export function setOAuthApp(provider, app) {
    const config = readConfig();
    config.apps = config.apps ?? {};
    config.apps[provider] = { ...config.apps[provider], ...app };
    writeConfig(config);
}
/** Mask a secret for display. Never print a whole token. */
export function mask(value) {
    if (!value)
        return '—';
    if (value.length <= 8)
        return '•'.repeat(value.length);
    return `${value.slice(0, 4)}${'•'.repeat(6)}${value.slice(-4)}`;
}
export { credentialsPath, configPath, dvHome };
//# sourceMappingURL=store.js.map