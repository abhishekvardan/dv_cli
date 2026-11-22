/**
 * The database providers `dv db` can talk to.
 *
 * Each one is small because the interesting part — introspection, formatting, write
 * confirmation — lives in the layer above. An adapter only has to answer "run this
 * SQL and give me rows".
 */

import { AuthError, CliError, EXIT, NotFoundError, ProviderError } from '../cli/errors.js';
import { accessToken } from '../auth/tokens.js';
import { registerAdapter, type DbAdapter, type DbTarget } from './adapter.js';

/* ───────────────────────────── Supabase ───────────────────────────── */

const SUPABASE_API = 'https://api.supabase.com';

async function supabaseCall(path: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken('supabase');
  const res = await fetch(`${SUPABASE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    throw new AuthError('Supabase rejected the token.', 'dv connect supabase');
  }
  if (res.status === 403) {
    throw new ProviderError('Supabase refused: the token does not cover that project.', 403);
  }
  if (res.status === 404) throw new NotFoundError(`Supabase has no such resource: ${path}`);
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    // The database error is the useful part — "400 Bad Request" is not.
    throw new ProviderError(
      `Supabase ${res.status}: ${body?.message ?? body?.error ?? body?.msg ?? res.statusText}`,
      res.status,
    );
  }
  return res.status === 204 ? null : res.json();
}

/** The project's state, or undefined if it cannot be determined. */
async function supabaseProjectStatus(ref: string): Promise<string | undefined> {
  try {
    const projects = await supabaseCall('/v1/projects');
    const match = (Array.isArray(projects) ? projects : []).find(
      (p: any) => (p.ref ?? p.id) === ref,
    );
    return match?.status;
  } catch {
    // Diagnosing the failure must never replace it with a different failure.
    return undefined;
  }
}

const supabaseAdapter: DbAdapter = {
  id: 'supabase',
  label: 'Supabase',
  hint: 'dv connect supabase, then dv db use',
  async query(ref, sql) {
    try {
      const data = await supabaseCall(`/v1/projects/${encodeURIComponent(ref)}/database/query`, {
        method: 'POST',
        body: JSON.stringify({ query: sql }),
      });
      return Array.isArray(data) ? data : data ? [data] : [];
    } catch (err) {
      // A paused project has no database running, and Supabase reports that as a
      // bare connection timeout — which reads like a network problem and sends you
      // looking in entirely the wrong place. Cost of one extra request only on the
      // failure path.
      const message = err instanceof Error ? err.message : String(err);
      if (/timeout|ECONNREFUSED|connection terminated/i.test(message)) {
        const status = await supabaseProjectStatus(ref);
        if (status && status !== 'ACTIVE_HEALTHY') {
          throw new ProviderError(
            `That Supabase project is ${status.toLowerCase().replace(/_/g, ' ')}, so it has no database to query.`,
            503,
            'Resume it from the Supabase dashboard, or switch: dv db use',
          );
        }
      }
      throw err;
    }
  },
  async list(): Promise<DbTarget[]> {
    const projects = await supabaseCall('/v1/projects');
    return (Array.isArray(projects) ? projects : []).map((p: any) => ({
      provider: 'supabase',
      ref: p.ref ?? p.id,
      // Paused projects cannot answer a query, so the state belongs in the label.
      label: p.status === 'ACTIVE_HEALTHY' ? p.name : `${p.name} (${p.status})`,
    }));
  },
};


/** Regions Supabase accepts. Passed through verbatim; the API rejects anything else. */
export const SUPABASE_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ca-central-1', 'sa-east-1',
];

export interface SupabaseOrg {
  id: string;
  name: string;
  slug?: string;
}

export async function supabaseOrgs(): Promise<SupabaseOrg[]> {
  const data = await supabaseCall('/v1/organizations');
  return Array.isArray(data) ? data : [];
}

export interface CreateProjectInput {
  name: string;
  organizationId: string;
  region: string;
  dbPass: string;
  plan?: string;
}

/**
 * Create a Supabase project.
 *
 * The database password is set here and, on Supabase's side, cannot be read back
 * afterwards — only reset. That is why the caller shows it once and says so plainly
 * rather than tucking it into a log line.
 */
export async function supabaseCreateProject(input: CreateProjectInput): Promise<any> {
  return supabaseCall('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      organization_id: input.organizationId,
      region: input.region,
      db_pass: input.dbPass,
      plan: input.plan ?? 'free',
    }),
  });
}

/* ───────────────────── Supabase Edge Functions ───────────────────── */

export interface EdgeFunction {
  id?: string;
  slug: string;
  name?: string;
  status?: string;
  version?: number;
  verify_jwt?: boolean;
}

export async function supabaseFunctions(ref: string): Promise<EdgeFunction[]> {
  const data = await supabaseCall(`/v1/projects/${encodeURIComponent(ref)}/functions`);
  return Array.isArray(data) ? data : [];
}

export async function supabaseFunction(ref: string, slug: string): Promise<EdgeFunction | null> {
  return supabaseCall(
    `/v1/projects/${encodeURIComponent(ref)}/functions/${encodeURIComponent(slug)}`,
  ).catch(() => null);
}

/**
 * Create or update an Edge Function from source.
 *
 * There is no bundler step: Deno resolves imports at deploy time from the URLs in the
 * source, so a single file is a complete deployable unit. A function importing local
 * relative files is the exception, and the command warns rather than shipping something
 * that only fails once invoked.
 */
export async function supabaseDeployFunction(
  ref: string,
  input: { slug: string; name?: string; body: string; verifyJwt?: boolean },
): Promise<EdgeFunction> {
  const existing = await supabaseFunction(ref, input.slug);
  const payload = {
    slug: input.slug,
    name: input.name ?? input.slug,
    body: input.body,
    verify_jwt: input.verifyJwt ?? true,
  };

  // PATCH for an existing slug, POST for a new one: POSTing over an existing function
  // is rejected rather than treated as an update.
  return existing
    ? supabaseCall(
        `/v1/projects/${encodeURIComponent(ref)}/functions/${encodeURIComponent(input.slug)}`,
        { method: 'PATCH', body: JSON.stringify(payload) },
      )
    : supabaseCall(`/v1/projects/${encodeURIComponent(ref)}/functions`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
}

export async function supabaseDeleteFunction(ref: string, slug: string): Promise<void> {
  await supabaseCall(
    `/v1/projects/${encodeURIComponent(ref)}/functions/${encodeURIComponent(slug)}`,
    { method: 'DELETE' },
  );
}

/* ─────────────────────────────── Neon ─────────────────────────────── */

/**
 * Neon exposes SQL over HTTP at the project's endpoint, authenticated by the
 * connection string rather than by an API token — which is why the ref here is the
 * whole `postgres://…` URL rather than a project id.
 *
 * NOT VERIFIED against a live Neon project. Written from their documented serverless
 * SQL-over-HTTP endpoint; treat the first run as its test.
 */
const neonAdapter: DbAdapter = {
  id: 'neon',
  label: 'Neon',
  hint: 'dv db use neon:postgres://user:pass@ep-xxx.region.aws.neon.tech/dbname',
  async query(ref, sql) {
    let host: string;
    try {
      host = new URL(ref).host;
    } catch {
      throw new CliError(
        'Neon needs a full connection string.',
        EXIT.usage,
        'dv db use "neon:postgres://user:pass@ep-xxx.region.aws.neon.tech/neondb"',
      );
    }

    const res = await fetch(`https://${host}/sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': ref,
        'Neon-Raw-Text-Output': 'false',
        'Neon-Array-Mode': 'false',
      },
      body: JSON.stringify({ query: sql, params: [] }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new AuthError('Neon rejected the connection string.', 'Check the password in the URL.');
    }
    if (!res.ok) {
      const body: any = await res.json().catch(() => ({}));
      throw new ProviderError(`Neon ${res.status}: ${body?.message ?? res.statusText}`, res.status);
    }
    const data: any = await res.json();
    return data.rows ?? [];
  },
};

/* ─────────────── providers that only give a connection string ─────────────── */

/**
 * Render, Railway, Fly, Heroku and self-hosted Postgres all hand you a URL and
 * nothing else — there is no HTTP SQL endpoint to call.
 *
 * Declared rather than omitted so `dv db use render` explains the situation instead of
 * reporting an unknown provider, which would look like the CLI simply had not heard
 * of a service everyone uses.
 */
function connectionStringOnly(id: string, label: string): DbAdapter {
  return {
    id,
    label,
    requiresDriver: true,
    hint: `${label} provides a Postgres connection string only`,
    async query() {
      throw new CliError(
        `${label} does not offer SQL over HTTP, so dv cannot query it directly.`,
        EXIT.usage,
        'Use psql with the connection string from their dashboard.\n' +
          'Supabase and Neon do expose HTTP SQL and work with `dv db`.',
      );
    },
  };
}

registerAdapter(supabaseAdapter);
registerAdapter(neonAdapter);
registerAdapter(connectionStringOnly('render', 'Render'));
registerAdapter(connectionStringOnly('railway', 'Railway'));
registerAdapter(connectionStringOnly('postgres', 'Postgres'));
