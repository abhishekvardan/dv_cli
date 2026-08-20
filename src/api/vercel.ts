/**
 * Vercel.
 *
 * Read plus redeploy. Creating a deployment from scratch means uploading a file tree,
 * which is a different job from what this CLI does; redeploying an existing deployment
 * is the operation people actually want from a terminal.
 */

import { AuthError, NotFoundError, ProviderError } from '../cli/errors.js';
import { accessToken } from '../auth/tokens.js';

const BASE = 'https://api.vercel.com';

async function call(path: string, init: RequestInit = {}): Promise<any> {
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

  async envVars(projectId: string) {
    const data = await call(`/v9/projects/${encodeURIComponent(projectId)}/env`);
    // Values are decrypted only on request; the listing gives keys and targets, which
    // is what you want in a terminal anyway.
    return data.envs ?? [];
  },
};
