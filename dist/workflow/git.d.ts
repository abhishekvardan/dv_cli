/**
 * Local git and package.json facts.
 *
 * A cross-service workflow starts from the working copy — which branch, which commit,
 * which repository — so this reads that once and hands it to the steps rather than
 * every step shelling out for itself.
 */
export declare function git(args: string[], cwd?: string): {
    ok: boolean;
    out: string;
    err: string;
};
export declare function isRepo(cwd?: string): boolean;
export declare function currentBranch(cwd?: string): string;
export declare function headSha(cwd?: string): string;
/** Uncommitted changes, as porcelain lines. Empty means clean. */
export declare function dirtyFiles(cwd?: string): string[];
/**
 * The GitHub repo for a remote, as `owner/name`.
 *
 * Handles both URL forms git uses — `https://github.com/o/n.git` and
 * `git@github.com:o/n.git` — because which one you get depends on how the repo was
 * cloned, and a workflow should not care.
 */
export declare function githubRemote(remote?: string, cwd?: string): string | null;
export declare function hasUpstream(branch: string, cwd?: string): boolean;
/** Commits on this branch that the remote does not have. */
export declare function unpushedCount(branch: string, cwd?: string): number;
export interface PackageJson {
    name?: string;
    scripts?: Record<string, string>;
}
export declare function readPackageJson(cwd?: string): PackageJson | null;
export declare function hasScript(name: string, cwd?: string): boolean;
/**
 * Run a shell command, capturing output.
 *
 * Output is captured rather than inherited so a failing build can be reported as the
 * step's error — with the last lines of its output — instead of scrolling past the
 * progress display and leaving no trace of what broke.
 */
export declare function run(command: string, args: string[], cwd?: string): {
    ok: boolean;
    output: string;
};
/** The last few meaningful lines of command output, for an error message. */
export declare function tail(output: string, lines?: number): string;
