/**
 * Local git and package.json facts.
 *
 * A cross-service workflow starts from the working copy — which branch, which commit,
 * which repository — so this reads that once and hands it to the steps rather than
 * every step shelling out for itself.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT } from '../cli/errors.js';
export function git(args, cwd = process.cwd()) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error) {
        throw new CliError('git is not installed, or not on PATH.', EXIT.failure);
    }
    return {
        ok: result.status === 0,
        out: (result.stdout ?? '').trim(),
        err: (result.stderr ?? '').trim(),
    };
}
export function isRepo(cwd = process.cwd()) {
    return git(['rev-parse', '--is-inside-work-tree'], cwd).ok;
}
export function currentBranch(cwd = process.cwd()) {
    const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (!r.ok)
        throw new CliError('Could not read the current branch.');
    return r.out;
}
export function headSha(cwd = process.cwd()) {
    return git(['rev-parse', 'HEAD'], cwd).out;
}
/** Uncommitted changes, as porcelain lines. Empty means clean. */
export function dirtyFiles(cwd = process.cwd()) {
    const r = git(['status', '--porcelain'], cwd);
    return r.out ? r.out.split('\n').filter(Boolean) : [];
}
/**
 * The GitHub repo for a remote, as `owner/name`.
 *
 * Handles both URL forms git uses — `https://github.com/o/n.git` and
 * `git@github.com:o/n.git` — because which one you get depends on how the repo was
 * cloned, and a workflow should not care.
 */
export function githubRemote(remote = 'origin', cwd = process.cwd()) {
    const r = git(['remote', 'get-url', remote], cwd);
    if (!r.ok)
        return null;
    const url = r.out;
    const https = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    return https ? `${https[1]}/${https[2]}` : null;
}
export function hasUpstream(branch, cwd = process.cwd()) {
    return git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], cwd).ok;
}
/** Commits on this branch that the remote does not have. */
export function unpushedCount(branch, cwd = process.cwd()) {
    if (!hasUpstream(branch, cwd))
        return -1; // never pushed
    const r = git(['rev-list', '--count', `${branch}@{upstream}..${branch}`], cwd);
    return r.ok ? Number(r.out) || 0 : 0;
}
export function readPackageJson(cwd = process.cwd()) {
    const path = join(cwd, 'package.json');
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
export function hasScript(name, cwd = process.cwd()) {
    return Boolean(readPackageJson(cwd)?.scripts?.[name]);
}
/**
 * Run a shell command, capturing output.
 *
 * Output is captured rather than inherited so a failing build can be reported as the
 * step's error — with the last lines of its output — instead of scrolling past the
 * progress display and leaving no trace of what broke.
 */
export function run(command, args, cwd = process.cwd()) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        // npm and friends are .cmd shims on Windows and are not directly executable.
        shell: process.platform === 'win32',
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return { ok: result.status === 0, output };
}
/** The last few meaningful lines of command output, for an error message. */
export function tail(output, lines = 6) {
    const meaningful = output
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0);
    return meaningful.slice(-lines).join('\n');
}
//# sourceMappingURL=git.js.map