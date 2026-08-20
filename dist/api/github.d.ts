/**
 * GitHub REST client.
 *
 * Errors are translated at this boundary rather than at each call site, because
 * GitHub's status codes carry meaning a CLI should act on: 404 on an authenticated
 * request is very often a scope problem rather than a missing resource, and the
 * rate-limit headers distinguish "slow down" from "you are not allowed".
 */
export interface GhOptions {
    method?: string;
    body?: unknown;
    /** Treat 404 as an empty result instead of an error. */
    allowMissing?: boolean;
    /** Overrides the stored token — used by `--token` on individual commands. */
    token?: string;
}
declare function request(path: string, options?: GhOptions): Promise<any>;
export interface Repo {
    name: string;
    full_name: string;
    private: boolean;
    description: string | null;
    language: string | null;
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
    default_branch: string;
    pushed_at: string;
    html_url: string;
    clone_url: string;
    ssh_url: string;
    archived: boolean;
    fork: boolean;
    homepage: string | null;
}
export declare const github: {
    whoami(token?: string): Promise<any>;
    /**
     * Identify a token and read the scopes it carries.
     *
     * A classic personal access token does not describe itself anywhere in a response
     * body — GitHub reports the granted scopes only in the `X-OAuth-Scopes` header. So
     * this is the one way to know whether a pasted token can do what the commands need,
     * rather than finding out at the first 403.
     *
     * Fine-grained tokens (`github_pat_`) use per-resource permissions and send no such
     * header. An empty list there means "cannot tell", not "no access", which is why
     * `missingScopes` stays quiet when nothing was recorded.
     */
    whoamiWithScopes(token?: string): Promise<{
        login: string;
        scopes: string[];
    }>;
    listRepos(opts?: {
        limit?: number;
        affiliation?: string;
        sort?: string;
    }): Promise<Repo[]>;
    getRepo(fullName: string): Promise<Repo>;
    /**
     * Create a repository.
     *
     * Under a user it is `POST /user/repos`; under an organisation it is
     * `POST /orgs/{org}/repos` — the user endpoint cannot create org repos, and using
     * it with an `owner` field silently creates the repo under the user instead.
     */
    createRepo(input: {
        name: string;
        org?: string;
        description?: string;
        private?: boolean;
        autoInit?: boolean;
        gitignore?: string;
        license?: string;
        homepage?: string;
    }): Promise<Repo>;
    /**
     * Change repository settings.
     *
     * Only the fields given are sent. GitHub treats an omitted field as "leave alone",
     * so building the patch from what the user actually passed avoids resetting
     * settings they never mentioned.
     */
    updateRepo(fullName: string, patch: Record<string, unknown>): Promise<Repo>;
    deleteRepo(fullName: string): Promise<void>;
    listBranches(fullName: string, limit?: number): Promise<any[]>;
    listCommits(fullName: string, opts?: {
        limit?: number;
        path?: string;
        sha?: string;
    }): Promise<any[]>;
    listIssues(fullName: string, opts?: {
        state?: string;
        limit?: number;
        labels?: string;
    }): Promise<any[]>;
    createIssue(fullName: string, input: {
        title: string;
        body?: string;
        labels?: string[];
    }): Promise<any>;
    closeIssue(fullName: string, number: number): Promise<any>;
    comment(fullName: string, number: number, body: string): Promise<any>;
    listPulls(fullName: string, opts?: {
        state?: string;
        limit?: number;
    }): Promise<any[]>;
    createPull(fullName: string, input: {
        title: string;
        head: string;
        base: string;
        body?: string;
        draft?: boolean;
    }): Promise<any>;
    listWorkflows(fullName: string): Promise<any>;
    listRuns(fullName: string, opts?: {
        limit?: number;
        workflow?: string;
    }): Promise<any>;
    /** Dispatch a `workflow_dispatch` workflow. Returns nothing — GitHub answers 204. */
    dispatchWorkflow(fullName: string, workflow: string, ref: string, inputs?: Record<string, string>): Promise<void>;
    rerunRun(fullName: string, runId: number): Promise<void>;
    browse(fullName: string, path?: string, ref?: string): Promise<any>;
    /** File contents as text. Returns null when the path is a directory. */
    readFile(fullName: string, path: string, ref?: string): Promise<{
        path: string;
        size: number;
        text: string;
    } | null>;
    /**
     * Create or update a file.
     *
     * An update needs the blob `sha` of the version being replaced; GitHub rejects the
     * write without it. Looking it up here means the caller cannot accidentally
     * clobber a concurrent change.
     */
    putFile(fullName: string, path: string, content: string, message: string, branch?: string): Promise<any>;
    searchCode(query: string, opts?: {
        repo?: string;
        user?: string;
        limit?: number;
    }): Promise<{
        total: any;
        items: any;
    }>;
    activity(login: string, limit?: number): Promise<any[]>;
    createBranch(fullName: string, name: string, fromRef?: string): Promise<any>;
};
export { request as githubRequest };
