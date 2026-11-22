/**
 * Vercel.
 *
 * Read plus redeploy. Creating a deployment from scratch means uploading a file tree,
 * which is a different job from what this CLI does; redeploying an existing deployment
 * is the operation people actually want from a terminal.
 */

import { AuthError, NotFoundError, ProviderError } from '../cli/errors.js';
import { accessToken } from '../auth/tokens.js';
import { guardDryRun } from '../cli/output.js';

const BASE = 'https://api.vercel.com';

async function call(path: string, init: RequestInit = {}): Promise<any> {
  guardDryRun(String(init.method ?? 'GET'), `${BASE}${path}`);
  const token = await accessToken('vercel');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthError(
      'Vercel rejected the token.',
      'Create a new one at https://vercel.com/account/tokens then: dv auth token vercel --token <token>',
    );
  }
  if (res.status === 404) throw new NotFoundError(`Vercel has no such resource: ${path}`);
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw new ProviderError(`Vercel ${res.status}: ${body?.error?.message ?? res.statusText}`, res.status);
  }
  return res.status === 204 ? null : res.json();
}

export const vercel = {
  async whoami() {
    const data = await call('/v2/user');
    return data.user ?? data;
  },

  async projects(limit = 20) {
    const data = await call(`/v9/projects?limit=${Math.min(limit, 100)}`);
    return data.projects ?? [];
  },

  async deployments(opts: { project?: string; limit?: number } = {}) {
    const params = new URLSearchParams({ limit: String(Math.min(opts.limit ?? 10, 100)) });
    if (opts.project) params.set('app', opts.project);
    const data = await call(`/v6/deployments?${params}`);
    return data.deployments ?? [];
  },

  /**
   * Redeploy an existing deployment.
   *
   * `deploymentId` plus the target is enough — Vercel reuses the source of the
   * referenced deployment, which is why this does not need a file upload.
   */
  async redeploy(deploymentId: string, name: string, target: 'production' | 'preview' = 'production') {
    return call('/v13/deployments', {
      method: 'POST',
      body: JSON.stringify({ deploymentId, name, target }),
    });
  },

  async project(name: string) {
    return call(`/v9/projects/${encodeURIComponent(name)}`);
  },

  async createProject(input: { name: string; framework?: string; gitRepo?: string }) {
    return call('/v11/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        framework: input.framework ?? null,
        // `type` must accompany the repo or Vercel ignores the link silently.
        ...(input.gitRepo ? { gitRepository: { type: 'github', repo: input.gitRepo } } : {}),
      }),
    });
  },

  async deleteProject(name: string) {
    await call(`/v9/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },

  async deployment(idOrUrl: string) {
    return call(`/v13/deployments/${encodeURIComponent(idOrUrl)}`);
  },

  /** Build and runtime events for one deployment — what you want when a deploy failed. */
  async deploymentEvents(id: string, limit = 100) {
    const data = await call(`/v3/deployments/${encodeURIComponent(id)}/events?limit=${limit}`);
    return Array.isArray(data) ? data : (data.events ?? []);
  },

  async cancelDeployment(id: string) {
    return call(`/v12/deployments/${encodeURIComponent(id)}/cancel`, { method: 'PATCH' });
  },

  async addEnv(
    projectId: string,
    input: { key: string; value: string; target: string[]; type?: string },
  ) {
    return call(`/v10/projects/${encodeURIComponent(projectId)}/env`, {
      method: 'POST',
      body: JSON.stringify({
        key: input.key,
        value: input.value,
        target: input.target,
        // `encrypted` is the default and the right one for anything secret.
        type: input.type ?? 'encrypted',
      }),
    });
  },

  async removeEnv(projectId: string, envId: string) {
    await call(`/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`, {
      method: 'DELETE',
    });
  },

  async domains(projectId: string) {
    const data = await call(`/v9/projects/${encodeURIComponent(projectId)}/domains`);
    return data.domains ?? [];
  },

  async addDomain(projectId: string, name: string) {
    return call(`/v10/projects/${encodeURIComponent(projectId)}/domains`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  async removeDomain(projectId: string, name: string) {
    await call(
      `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  },


  /**
   * Runtime logs for a deployment.
   *
   * Vercel's public REST API does not serve these. Verified against a real deployment:
   * every row `/v3/deployments/{id}/events` returns carries `info.type: "build"`, and
   * the runtime-logs paths the dashboard uses answer 404 for an API token.
   *
   * This returns null rather than falling back to build events. An earlier version did
   * fall back, which was worse than having nothing: you appear to have checked the
   * runtime logs, see a successful build, and conclude the function is fine.
   *
   * The supported route for runtime logs is a log drain — see `logDrains` below.
   */
  async runtimeLogs(deploymentId: string, opts: { limit?: number } = {}): Promise<any[] | null> {
    const params = new URLSearchParams({ limit: String(Math.min(opts.limit ?? 200, 1000)) });
    try {
      const data = await call(`/v1/deployments/${encodeURIComponent(deploymentId)}/runtime-logs?${params}`);
      const rows = Array.isArray(data) ? data : (data?.logs ?? []);
      return Array.isArray(rows) ? rows : null;
    } catch {
      // Any failure means unavailable, which the caller must report rather than paper over.
      return null;
    }
  },

  /** Build events — what the API does reliably provide. */
  async buildLogs(deploymentId: string, limit = 200): Promise<any[]> {
    const data = await call(
      `/v3/deployments/${encodeURIComponent(deploymentId)}/events?limit=${Math.min(limit, 1000)}`,
    );
    return Array.isArray(data) ? data : (data?.events ?? []);
  },

  /**
   * Log drains — the supported way to see runtime logs.
   *
   * Push-based: Vercel posts logs to a URL you own, as they happen. That is why there
   * is no historical endpoint to poll, and why a drain has to exist *before* the
   * invocation you want to inspect.
   */
  async logDrains(): Promise<any[]> {
    const data = await call('/v2/integrations/log-drains');
    return Array.isArray(data) ? data : [];
  },

  async addLogDrain(input: {
    name: string;
    url: string;
    projectIds?: string[];
    sources?: string[];
  }): Promise<any> {
    return call('/v2/integrations/log-drains', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        url: input.url,
        deliveryFormat: 'ndjson',
        // "lambda" is the source that carries function invocations — the thing you
        // actually want when a request failed.
        sources: input.sources ?? ['lambda', 'static', 'edge'],
        ...(input.projectIds ? { projectIds: input.projectIds } : {}),
      }),
    });
  },

  async removeLogDrain(id: string): Promise<void> {
    await call(`/v1/integrations/log-drains/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /**
   * Wait for a deployment to stop building.
   *
   * Polling this by hand is eight lines of shell that everyone writes slightly
   * differently and nobody handles the ERROR case in.
   */
  async waitForDeployment(
    idOrUrl: string,
    opts: { timeoutMs?: number; intervalMs?: number; onTick?: (state: string, ms: number) => void } = {},
  ): Promise<any> {
    const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    const intervalMs = opts.intervalMs ?? 4000;
    const started = Date.now();

    for (;;) {
      const deployment = await this.deployment(idOrUrl);
      const state = deployment.readyState ?? deployment.state ?? 'UNKNOWN';
      opts.onTick?.(state, Date.now() - started);

      // READY, ERROR and CANCELED are all terminal; only the first is success, and the
      // caller needs to be able to tell them apart rather than just "stopped changing".
      if (state === 'READY' || state === 'ERROR' || state === 'CANCELED') return deployment;
      if (Date.now() - started > timeoutMs) {
        throw new ProviderError(
          `Deployment still ${state} after ${Math.round(timeoutMs / 1000)}s.`,
          504,
          `dv vercel deploy logs ${idOrUrl}`,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  },

  /**
   * One coherent answer to "is this domain working".
   *
   * The information is spread across three endpoints — project attachment,
   * verification state, and DNS configuration — and any one of them alone will tell you
   * a domain is fine while it is in fact serving nothing.
   */
  async domainStatus(projectId: string, domain: string): Promise<any> {
    const [attached, config] = await Promise.all([
      call(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`).catch(
        () => null,
      ),
      call(`/v6/domains/${encodeURIComponent(domain)}/config`).catch(() => null),
    ]);

    const misconfigured = config?.misconfigured === true;
    return {
      domain,
      attachedToProject: Boolean(attached),
      verified: attached?.verified ?? false,
      misconfigured,
      // The actionable part: what DNS records are missing or wrong.
      verification: attached?.verification ?? [],
      nameservers: config?.nameservers ?? [],
      intendedNameservers: config?.intendedNameservers ?? [],
      aValues: config?.aValues ?? [],
      healthy: Boolean(attached) && attached?.verified === true && !misconfigured,
    };
  },

  /**
   * Set several environment variables.
   *
   * `atomic` gives all-or-nothing by *compensating* — undoing what already landed —
   * because the API has no transaction to roll back. That distinction matters: the
   * undo can itself fail, and when it does the caller is told exactly what is left
   * behind rather than being reassured by a rollback that did not happen.
   */
  async addEnvBulk(
    projectId: string,
    vars: Array<{ key: string; value: string; target: string[] }>,
    options: { atomic?: boolean } = {},
  ): Promise<{
    results: Array<{ key: string; ok: boolean; error?: string; id?: string }>;
    rolledBack?: string[];
    rollbackFailed?: string[];
  }> {
    const results: Array<{ key: string; ok: boolean; error?: string; id?: string }> = [];

    for (const v of vars) {
      try {
        const created = await this.addEnv(projectId, v);
        results.push({ key: v.key, ok: true, id: created?.created?.id ?? created?.id });
      } catch (err) {
        results.push({ key: v.key, ok: false, error: err instanceof Error ? err.message : String(err) });
        // Stop on first failure when atomic; otherwise keep going and report the lot,
        // which is more useful than an arbitrary partial stop.
        if (options.atomic) break;
      }
    }

    if (!options.atomic || results.every((r) => r.ok)) return { results };

    const rolledBack: string[] = [];
    const rollbackFailed: string[] = [];
    for (const done of results.filter((r) => r.ok && r.id)) {
      try {
        await this.removeEnv(projectId, done.id!);
        rolledBack.push(done.key);
      } catch {
        rollbackFailed.push(done.key);
      }
    }
    return { results, rolledBack, rollbackFailed };
  },

  /** One environment variable with its value decrypted, so you can check what you set. */
  async envValue(projectId: string, envId: string): Promise<any> {
    return call(`/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`);
  },


  /**
   * Upload one file, addressed by its SHA1.
   *
   * Content-addressed: a file the platform already holds returns immediately without
   * transferring bytes, which is what makes redeploying a mostly-unchanged tree quick.
   * Sent as a raw body rather than base64 inside JSON — encoding a whole project into
   * one JSON payload inflates it by a third and gives no per-file failure detail.
   */
  async uploadFile(sha: string, size: number, body: Buffer): Promise<void> {
    const token = await accessToken('vercel');
    const res = await fetch(`${BASE}/v2/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'x-vercel-digest': sha,
      },
      body: new Uint8Array(body),
    });
    // 200 means stored, 409 means it was already there — both are success.
    if (res.ok || res.status === 409) return;
    const detail: any = await res.json().catch(() => ({}));
    throw new ProviderError(
      `Upload failed (${res.status}): ${detail?.error?.message ?? res.statusText}`,
      res.status,
    );
  },

  /**
   * Create a deployment from files already uploaded.
   *
   * Files are referenced by digest, so this call stays small however large the project.
   */
  async createDeployment(input: {
    name: string;
    files: Array<{ file: string; sha: string; size: number }>;
    target?: 'production' | 'preview';
    projectSettings?: Record<string, unknown>;
    env?: Record<string, string>;
  }): Promise<any> {
    return call('/v13/deployments', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        files: input.files,
        target: input.target ?? 'production',
        projectSettings: input.projectSettings ?? {},
        ...(input.env ? { env: input.env } : {}),
      }),
    });
  },


  /** DNS records for a domain you hold at Vercel. */
  async dnsRecords(domain: string, limit = 100): Promise<any[]> {
    const data = await call(`/v4/domains/${encodeURIComponent(domain)}/records?limit=${limit}`);
    return data.records ?? [];
  },

  async addDnsRecord(
    domain: string,
    record: { type: string; name: string; value: string; ttl?: number; priority?: number },
  ): Promise<any> {
    return call(`/v2/domains/${encodeURIComponent(domain)}/records`, {
      method: 'POST',
      body: JSON.stringify({
        type: record.type.toUpperCase(),
        // Vercel uses "" for the apex, and people type "@" for it.
        name: record.name === '@' ? '' : record.name,
        value: record.value,
        ttl: record.ttl ?? 60,
        ...(record.priority !== undefined ? { mxPriority: record.priority } : {}),
      }),
    });
  },

  async removeDnsRecord(domain: string, recordId: string): Promise<void> {
    await call(
      `/v2/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(recordId)}`,
      { method: 'DELETE' },
    );
  },

  async envVars(projectId: string) {
    const data = await call(`/v9/projects/${encodeURIComponent(projectId)}/env`);
    // Values are decrypted only on request; the listing gives keys and targets, which
    // is what you want in a terminal anyway.
    return data.envs ?? [];
  },
};
