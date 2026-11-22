/**
 * GitHub REST client.
 *
 * Errors are translated at this boundary rather than at each call site, because
 * GitHub's status codes carry meaning a CLI should act on: 404 on an authenticated
 * request is very often a scope problem rather than a missing resource, and the
 * rate-limit headers distinguish "slow down" from "you are not allowed".
 */

import { AuthError, NotFoundError, ProviderError } from '../cli/errors.js';
import { accessToken } from '../auth/tokens.js';
import { guardDryRun } from '../cli/output.js';

const BASE = 'https://api.github.com';

export interface GhOptions {
  method?: string;
  body?: unknown;
  /** Treat 404 as an empty result instead of an error. */
  allowMissing?: boolean;
  /** Overrides the stored token — used by `--token` on individual commands. */
  token?: string;
}

/**
 * A request that hands back the whole response.
 *
 * [request] returns the parsed body, which is right nearly everywhere — but GitHub reports
 * pagination in the `Link` header, and a commit count is only derivable from it.
 */
async function requestRaw(path: string): Promise<Response | null> {
  guardDryRun('GET', `${BASE}${path}`);
  const token = await accessToken('github');
  const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dv-cli',
    },
  });
  // An empty repository answers 409, which is a fact about the repository rather than a
  // failure — it simply has no commits yet.
  if (res.status === 404 || res.status === 409) return null;
  if (!res.ok) return null;
  return res;
}

async function request(path: string, options: GhOptions = {}): Promise<any> {
  guardDryRun(options.method ?? 'GET', `${BASE}${path}`);
  const token = options.token ?? (await accessToken('github'));
  const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dv-cli',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) return null;

  // 401 means the credential itself is bad — a different problem from "forbidden",
  // and it should exit 3 so a script knows to re-authenticate rather than retry.
  if (res.status === 401) {
    throw new AuthError(
      'GitHub rejected the credential.',
      'The token may have been revoked or expired. Run: dv auth login github',
    );
  }

  if (res.status === 404) {
    if (options.allowMissing) return null;
    throw new NotFoundError(
      `GitHub has no such resource: ${path}`,
      'If you expected a private repository, check the token has the `repo` scope: dv auth status',
    );
  }

  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    // 403 with remaining=0 is a rate limit; 403 with remaining left is a permission
    // problem. Reporting both as "forbidden" sends the user looking in the wrong place.
    if (remaining === '0' && reset) {
      const at = new Date(Number(reset) * 1000);
      throw new ProviderError(
        `GitHub rate limit reached. It resets at ${at.toLocaleTimeString()}.`,
        res.status,
        'Authenticated requests get 5,000/hour; unauthenticated ones only 60.',
      );
    }
    const body: any = await res.json().catch(() => ({}));
    throw new ProviderError(
      `GitHub refused: ${body?.message ?? 'forbidden'}`,
      res.status,
      'This usually means the token is missing a scope. Check with: dv auth status',
    );
  }

  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    // 422 carries per-field detail that is the actual reason.
    const detail = body?.errors?.length
      ? `${body.message}: ${body.errors.map((e: any) => e.message ?? `${e.field} ${e.code}`).join('; ')}`
      : (body?.message ?? res.statusText);
    throw new ProviderError(`GitHub ${res.status}: ${detail}`, res.status);
  }

  return res.json();
}

/**
 * Follow `Link: rel="next"` until `limit` items are collected.
 *
 * GitHub caps per_page at 100, so anything above that needs real pagination. Stopping
 * at the first page silently truncated results for anyone with more than 100 repos.
 */
async function paginate(path: string, limit: number, token?: string): Promise<any[]> {
  const items: any[] = [];
  let url: string | null = path.includes('?')
    ? `${BASE}${path}&per_page=${Math.min(limit, 100)}`
    : `${BASE}${path}?per_page=${Math.min(limit, 100)}`;

  while (url && items.length < limit) {
    const token2 = token ?? (await accessToken('github'));
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token2}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dv-cli',
      },
    });
    if (!res.ok) {
      // Reuse the single-request path for consistent error text.
      await request(url.replace(BASE, ''), { token: token2 });
      break;
    }
    const page = await res.json();
    if (!Array.isArray(page)) break;
    items.push(...page);

    const link = res.headers.get('link') ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1]! : null;
  }
  return items.slice(0, limit);
}

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

export const github = {
  async whoami(token?: string) {
    return request('/user', { token });
  },

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
  async whoamiWithScopes(token?: string): Promise<{ login: string; scopes: string[] }> {
    const bearer = token ?? (await accessToken('github'));
    const res = await fetch(`${BASE}/user`, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dv-cli',
      },
    });

    if (res.status === 401) {
      throw new AuthError(
        'GitHub rejected the token.',
        'Check it was copied whole, and that it has not expired or been revoked.',
      );
    }
    if (!res.ok) {
      const body: any = await res.json().catch(() => ({}));
      throw new ProviderError(`GitHub ${res.status}: ${body?.message ?? res.statusText}`, res.status);
    }

    const header = res.headers.get('x-oauth-scopes') ?? '';
    const user: any = await res.json();
    return {
      login: user.login,
      scopes: header.split(',').map((s) => s.trim()).filter(Boolean),
    };
  },

  async listRepos(opts: { limit?: number; affiliation?: string; sort?: string } = {}): Promise<Repo[]> {
    const sort = opts.sort ?? 'pushed';
    const affiliation = opts.affiliation ?? 'owner,collaborator,organization_member';
    return paginate(
      `/user/repos?sort=${sort}&affiliation=${encodeURIComponent(affiliation)}`,
      opts.limit ?? 30,
    );
  },

  async getRepo(fullName: string): Promise<Repo> {
    return request(`/repos/${fullName}`);
  },

  /**
   * Create a repository.
   *
   * Under a user it is `POST /user/repos`; under an organisation it is
   * `POST /orgs/{org}/repos` — the user endpoint cannot create org repos, and using
   * it with an `owner` field silently creates the repo under the user instead.
   */
  async createRepo(input: {
    name: string;
    org?: string;
    description?: string;
    private?: boolean;
    autoInit?: boolean;
    gitignore?: string;
    license?: string;
    homepage?: string;
  }): Promise<Repo> {
    const path = input.org ? `/orgs/${input.org}/repos` : '/user/repos';
    return request(path, {
      method: 'POST',
      body: {
        name: input.name,
        description: input.description,
        private: input.private ?? true,
        // Without a first commit the repo has no default branch, and cloning it
        // warns about an empty repository.
        auto_init: input.autoInit ?? true,
        gitignore_template: input.gitignore,
        license_template: input.license,
        homepage: input.homepage,
      },
    });
  },

  /**
   * Change repository settings.
   *
   * Only the fields given are sent. GitHub treats an omitted field as "leave alone",
   * so building the patch from what the user actually passed avoids resetting
   * settings they never mentioned.
   */
  async updateRepo(fullName: string, patch: Record<string, unknown>): Promise<Repo> {
    return request(`/repos/${fullName}`, { method: 'PATCH', body: patch });
  },

  async deleteRepo(fullName: string): Promise<void> {
    await request(`/repos/${fullName}`, { method: 'DELETE' });
  },

  async listBranches(fullName: string, limit = 100) {
    return paginate(`/repos/${fullName}/branches`, limit);
  },

  /**
   * How many commits a repository has.
   *
   * GitHub exposes no commit-count field, and paging the whole history to count would be
   * thousands of requests for a busy repository. The standard trick instead: ask for one
   * commit per page, and read the last page number out of the `Link` header — with a page
   * size of one, the number of pages *is* the number of commits.
   *
   * Costs a single request regardless of history length.
   */
  async commitCount(fullName: string, branch?: string): Promise<number | null> {
    // Already owner/name, as everywhere else in this client — the caller resolves it.
    const query = new URLSearchParams({ per_page: '1' });
    if (branch) query.set('sha', branch);

    const res = await requestRaw(`/repos/${fullName}/commits?${query}`);
    if (!res) return null;

    const link = res.headers.get('link');
    if (link) {
      // rel="last" is absent when there is only one page, which is the small-repo case
      // handled below rather than an error.
      const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
      if (last?.[1]) return Number(last[1]);
    }

    // No last link: either one commit, or none at all.
    const body = (await res.json()) as unknown[];
    return Array.isArray(body) ? body.length : 0;
  },

  async listCommits(fullName: string, opts: { limit?: number; path?: string; sha?: string } = {}) {
    const params = new URLSearchParams();
    if (opts.path) params.set('path', opts.path);
    if (opts.sha) params.set('sha', opts.sha);
    const q = params.toString();
    return paginate(`/repos/${fullName}/commits${q ? `?${q}` : ''}`, opts.limit ?? 20);
  },

  async listIssues(fullName: string, opts: { state?: string; limit?: number; labels?: string } = {}) {
    const params = new URLSearchParams({ state: opts.state ?? 'open' });
    if (opts.labels) params.set('labels', opts.labels);
    const items = await paginate(`/repos/${fullName}/issues?${params}`, opts.limit ?? 30);
    // The issues endpoint returns pull requests too. They are not issues.
    return items.filter((i) => !i.pull_request);
  },

  async createIssue(fullName: string, input: { title: string; body?: string; labels?: string[] }) {
    return request(`/repos/${fullName}/issues`, { method: 'POST', body: input });
  },

  async closeIssue(fullName: string, number: number) {
    return request(`/repos/${fullName}/issues/${number}`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
  },

  async comment(fullName: string, number: number, body: string) {
    return request(`/repos/${fullName}/issues/${number}/comments`, { method: 'POST', body: { body } });
  },

  async listPulls(fullName: string, opts: { state?: string; limit?: number } = {}) {
    return paginate(
      `/repos/${fullName}/pulls?state=${opts.state ?? 'open'}`,
      opts.limit ?? 30,
    );
  },

  async createPull(
    fullName: string,
    input: { title: string; head: string; base: string; body?: string; draft?: boolean },
  ) {
    return request(`/repos/${fullName}/pulls`, { method: 'POST', body: input });
  },

  async listWorkflows(fullName: string) {
    const data = await request(`/repos/${fullName}/actions/workflows`);
    return data?.workflows ?? [];
  },

  async listRuns(fullName: string, opts: { limit?: number; workflow?: string } = {}) {
    const path = opts.workflow
      ? `/repos/${fullName}/actions/workflows/${encodeURIComponent(opts.workflow)}/runs`
      : `/repos/${fullName}/actions/runs`;
    const data = await request(`${path}?per_page=${Math.min(opts.limit ?? 10, 100)}`);
    return data?.workflow_runs ?? [];
  },

  /** Dispatch a `workflow_dispatch` workflow. Returns nothing — GitHub answers 204. */
  async dispatchWorkflow(fullName: string, workflow: string, ref: string, inputs?: Record<string, string>) {
    await request(`/repos/${fullName}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      body: { ref, inputs },
    });
  },

  async rerunRun(fullName: string, runId: number) {
    await request(`/repos/${fullName}/actions/runs/${runId}/rerun`, { method: 'POST' });
  },

  async browse(fullName: string, path = '', ref?: string) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return request(`/repos/${fullName}/contents/${path}${q}`);
  },

  /** File contents as text. Returns null when the path is a directory. */
  async readFile(fullName: string, path: string, ref?: string): Promise<{ path: string; size: number; text: string } | null> {
    const data = await this.browse(fullName, path, ref);
    if (Array.isArray(data)) return null;
    return {
      path: data.path,
      size: data.size,
      text: Buffer.from(data.content ?? '', 'base64').toString('utf8'),
    };
  },

  /**
   * Create or update a file.
   *
   * An update needs the blob `sha` of the version being replaced; GitHub rejects the
   * write without it. Looking it up here means the caller cannot accidentally
   * clobber a concurrent change.
   */
  async putFile(
    fullName: string,
    path: string,
    content: string,
    message: string,
    branch?: string,
  ) {
    const existing = await request(
      `/repos/${fullName}/contents/${path}${branch ? `?ref=${branch}` : ''}`,
      { allowMissing: true },
    );
    const sha = existing && !Array.isArray(existing) ? existing.sha : undefined;
    return request(`/repos/${fullName}/contents/${path}`, {
      method: 'PUT',
      body: {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha,
        branch,
      },
    });
  },

  async searchCode(query: string, opts: { repo?: string; user?: string; limit?: number } = {}) {
    const scope = opts.repo ? `repo:${opts.repo}` : opts.user ? `user:${opts.user}` : '';
    const q = encodeURIComponent(`${query} ${scope}`.trim());
    const data = await request(`/search/code?q=${q}&per_page=${Math.min(opts.limit ?? 20, 100)}`);
    return { total: data.total_count ?? 0, items: data.items ?? [] };
  },

  async activity(login: string, limit = 30) {
    return paginate(`/users/${login}/events`, limit);
  },

  async createBranch(fullName: string, name: string, fromRef?: string) {
    const repo = await this.getRepo(fullName);
    const base = fromRef ?? repo.default_branch;
    const ref = await request(`/repos/${fullName}/git/ref/heads/${base}`);
    return request(`/repos/${fullName}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${name}`, sha: ref.object.sha },
    });
  },
};

export { request as githubRequest };
