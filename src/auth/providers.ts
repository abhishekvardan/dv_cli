/**
 * What you can connect to, and how.
 *
 * Two things vary per service and are modelled separately, because conflating them
 * is what makes CLIs support exactly the services their author happened to use:
 *
 *  - **How you get a credential** (`methods`) — device flow, browser loopback, a
 *    pasted token, username+password, or a custom header. Most services allow more
 *    than one; the first listed is the best available for a CLI, and `--method`
 *    overrides it.
 *  - **How the credential is attached to a request** (`authStyle`) — most use
 *    `Authorization: Bearer`, but plenty do not: Notion needs a version header,
 *    Supabase wants `apikey`, some older APIs want it in the query string.
 *
 * Anything expressible in those two axes can be added without touching this file —
 * see `dv connect add`, which writes a definition into config and makes every
 * generic command (`dv api`, `dv auth`) work against it.
 */

import { getOAuthApp, readConfig } from '../config/store.js';

/** How a credential is obtained. */
export type AuthMethod =
  /** OAuth 2.0 device grant (RFC 8628). Best for a CLI where supported. */
  | 'device'
  /** OAuth 2.0 authorization code via a loopback redirect (RFC 8252), with PKCE. */
  | 'loopback'
  /** Paste a personal access token or API key. */
  | 'token'
  /** username:password (or user:token) sent as HTTP Basic. */
  | 'basic'
  /** A fixed custom header, e.g. `X-API-Key: …`. */
  | 'header'
  /** OAuth 2.0 client credentials — machine-to-machine, no user present. */
  | 'client_credentials';

/**
 * How the credential is attached to an API request.
 *
 *  - `bearer`      Authorization: Bearer <token>          (the common case)
 *  - `basic`       Authorization: Basic <base64>
 *  - `token`       Authorization: token <token>           (older GitHub style)
 *  - `header:NAME` NAME: <token>
 *  - `query:PARAM` ?PARAM=<token>
 */
export type AuthStyle = 'bearer' | 'basic' | 'token' | `header:${string}` | `query:${string}`;

export interface ProviderDef {
  id: string;
  label: string;
  /** Ways to connect, best first. */
  methods: AuthMethod[];
  /** Scopes requested during an OAuth login. */
  scopes: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  /** True when the token endpoint refuses a request without a client secret. */
  needsClientSecret?: boolean;
  /** Where to issue a personal token. */
  appSetupUrl?: string;
  /**
   * Where to register an OAuth app, when that is a different page from the token one.
   * GitHub issues tokens at /settings/tokens but registers apps at /settings/developers,
   * and sending someone to the wrong one wastes the minute this is meant to save.
   */
  oauthAppUrl?: string;
  /** Shape check for a pasted token, so an obvious paste error is caught early. */
  tokenPattern?: RegExp;
  /** Root for `dv api <provider> <path>`. */
  apiBase?: string;
  /** How to attach the credential. Defaults to bearer. */
  authStyle?: AuthStyle;
  /** Extra headers every request needs — API version pins live here. */
  headers?: Record<string, string>;
  /** Endpoint that identifies the account. Relative to apiBase, or absolute. */
  whoamiUrl?: string;
  /** Path into the whoami response holding a display name, e.g. "user.name". */
  accountPath?: string;
  docs?: string;
  /** Shown when connecting, for services with a non-obvious setup step. */
  setupHint?: string;
  /**
   * OAuth app shipped with the CLI, so a user needs no setup at all.
   *
   * A client id in a distributed binary is public by definition — anyone can read it
   * out of the package — and that is fine, which is why every CLI that does browser
   * auth ships one. RFC 8252 classifies native apps as *public clients* precisely
   * because they cannot hold a secret, and PKCE is what actually protects the flow.
   *
   * The client SECRET is a different matter. GitHub device flow and Google's loopback
   * flow both work without one, so nothing here needs a shipped secret. LinkedIn does
   * require one and offers no PKCE, meaning a shipped LinkedIn secret would let anyone
   * impersonate this app — so it deliberately has no default and users bring their own.
   */
  defaultClientId?: string;
  defaultClientSecret?: string;
  /** Defined by the user rather than shipped. */
  custom?: boolean;
}

export const BUILT_IN: Record<string, ProviderDef> = {
  github: {
    id: 'github',
    label: 'GitHub',
    // Device flow first: nothing listens on a port and it works over SSH.
    methods: ['device', 'token', 'loopback'],
    scopes: ['repo', 'read:user', 'user:email', 'read:org', 'workflow', 'gist'],
    deviceCodeUrl: 'https://github.com/login/device/code',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    appSetupUrl: 'https://github.com/settings/tokens',
    oauthAppUrl: 'https://github.com/settings/developers',
    tokenPattern: /^(gh[pousr]_|github_pat_)/,
    apiBase: 'https://api.github.com',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    whoamiUrl: '/user',
    accountPath: 'login',
    setupHint: 'For device flow, tick "Enable Device Flow" on the OAuth app — it is off by default.',
    docs: 'https://docs.github.com/rest',
  },

  google: {
    id: 'google',
    label: 'Google (Gmail, Calendar, YouTube)',
    // Google offers no device flow for Gmail or Calendar scopes.
    methods: ['loopback'],
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
    ],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    appSetupUrl: 'https://console.cloud.google.com/apis/credentials',
    apiBase: 'https://www.googleapis.com',
    whoamiUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    accountPath: 'email',
    setupHint:
      'Create the OAuth client as type "Desktop app" - Google then accepts any loopback port.\n' +
      'A "Web application" client needs the port pinned and registered:\n' +
      '  dv config set google.redirectPort 8765   then register http://127.0.0.1:8765/callback',
    docs: 'https://developers.google.com/identity/protocols/oauth2/native-app',
  },

  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    // Supports neither device flow nor PKCE, so the secret is unavoidable.
    methods: ['loopback', 'token'],
    scopes: ['openid', 'profile', 'email', 'w_member_social'],
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    needsClientSecret: true,
    appSetupUrl: 'https://www.linkedin.com/developers/apps',
    apiBase: 'https://api.linkedin.com',
    headers: { 'X-Restli-Protocol-Version': '2.0.0' },
    whoamiUrl: '/v2/userinfo',
    accountPath: 'name',
    docs: 'https://learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow',
  },

  vercel: {
    id: 'vercel',
    label: 'Vercel',
    // Vercel's OAuth is for team integrations, not a CLI acting as a user.
    methods: ['token'],
    scopes: [],
    appSetupUrl: 'https://vercel.com/account/tokens',
    apiBase: 'https://api.vercel.com',
    whoamiUrl: '/v2/user',
    accountPath: 'user.username',
    docs: 'https://vercel.com/docs/rest-api',
  },

  slack: {
    id: 'slack',
    label: 'Slack',
    methods: ['token', 'loopback'],
    scopes: ['channels:read', 'chat:write', 'users:read', 'search:read'],
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    needsClientSecret: true,
    appSetupUrl: 'https://api.slack.com/apps',
    tokenPattern: /^xox[baprs]-/,
    apiBase: 'https://slack.com/api',
    whoamiUrl: '/auth.test',
    accountPath: 'user',
    // Slack answers 200 with {"ok":false} on failure — the api client checks for it.
    setupHint: 'A bot token (xoxb-) from "OAuth & Permissions" is the simplest way in.',
    docs: 'https://api.slack.com/web',
  },

  notion: {
    id: 'notion',
    label: 'Notion',
    methods: ['token', 'loopback'],
    scopes: [],
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    needsClientSecret: true,
    appSetupUrl: 'https://www.notion.so/my-integrations',
    tokenPattern: /^(secret_|ntn_)/,
    apiBase: 'https://api.notion.com',
    // Notion rejects any request without a version header.
    headers: { 'Notion-Version': '2022-06-28' },
    whoamiUrl: '/v1/users/me',
    accountPath: 'name',
    setupHint: 'After creating the integration, share each page or database with it — otherwise it sees nothing.',
    docs: 'https://developers.notion.com/reference',
  },

  linear: {
    id: 'linear',
    label: 'Linear',
    methods: ['token', 'loopback'],
    scopes: ['read', 'write'],
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    needsClientSecret: true,
    appSetupUrl: 'https://linear.app/settings/api',
    tokenPattern: /^lin_(api|oauth)_/,
    apiBase: 'https://api.linear.app',
    // A personal API key goes in Authorization verbatim, without "Bearer".
    authStyle: 'header:Authorization',
    whoamiUrl: '/graphql',
    setupHint: 'Linear is GraphQL-only: dv api linear /graphql --method POST --data \'{"query":"{ viewer { name } }"}\'',
    docs: 'https://developers.linear.app',
  },

  atlassian: {
    id: 'atlassian',
    label: 'Atlassian (Jira, Confluence)',
    // Jira Cloud uses email + API token as Basic, which is the documented path.
    methods: ['basic', 'loopback'],
    scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'],
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    needsClientSecret: true,
    appSetupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    authStyle: 'basic',
    headers: { Accept: 'application/json' },
    setupHint:
      'Set your site first: dv config set atlassian.apiBase https://your-site.atlassian.net\n' +
      'Then connect with your email as the username and the API token as the password.',
    whoamiUrl: '/rest/api/3/myself',
    accountPath: 'displayName',
    docs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
  },

  supabase: {
    id: 'supabase',
    label: 'Supabase',
    methods: ['token'],
    scopes: [],
    appSetupUrl: 'https://supabase.com/dashboard/account/tokens',
    tokenPattern: /^sbp_/,
    apiBase: 'https://api.supabase.com',
    whoamiUrl: '/v1/organizations',
    setupHint: 'This is the management API. For a project\'s data API, add it with `dv connect add`.',
    docs: 'https://supabase.com/docs/reference/api',
  },

  openai: {
    id: 'openai',
    label: 'OpenAI',
    methods: ['token'],
    scopes: [],
    appSetupUrl: 'https://platform.openai.com/api-keys',
    tokenPattern: /^sk-/,
    apiBase: 'https://api.openai.com',
    whoamiUrl: '/v1/models',
    docs: 'https://platform.openai.com/docs/api-reference',
  },

  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    methods: ['header'],
    scopes: [],
    appSetupUrl: 'https://console.anthropic.com/settings/keys',
    tokenPattern: /^sk-ant-/,
    apiBase: 'https://api.anthropic.com',
    // Anthropic uses x-api-key, not Authorization.
    authStyle: 'header:x-api-key',
    headers: { 'anthropic-version': '2023-06-01' },
    whoamiUrl: '/v1/models',
    docs: 'https://docs.claude.com/en/api',
  },

  discord: {
    id: 'discord',
    label: 'Discord',
    methods: ['token', 'loopback'],
    scopes: ['identify', 'guilds'],
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    needsClientSecret: true,
    appSetupUrl: 'https://discord.com/developers/applications',
    apiBase: 'https://discord.com/api/v10',
    // A bot token is sent as "Bot <token>", not "Bearer".
    setupHint: 'For a bot token use --auth-style "header:Authorization" and prefix the value with "Bot ".',
    whoamiUrl: '/users/@me',
    accountPath: 'username',
    docs: 'https://discord.com/developers/docs/reference',
  },

  figma: {
    id: 'figma',
    label: 'Figma',
    methods: ['token', 'loopback'],
    scopes: ['file_read'],
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    needsClientSecret: true,
    appSetupUrl: 'https://www.figma.com/developers/api#access-tokens',
    tokenPattern: /^figd_/,
    apiBase: 'https://api.figma.com',
    authStyle: 'header:X-Figma-Token',
    whoamiUrl: '/v1/me',
    accountPath: 'email',
    docs: 'https://www.figma.com/developers/api',
  },

  stripe: {
    id: 'stripe',
    label: 'Stripe',
    methods: ['token'],
    scopes: [],
    appSetupUrl: 'https://dashboard.stripe.com/apikeys',
    tokenPattern: /^(sk|rk)_(test|live)_/,
    apiBase: 'https://api.stripe.com',
    whoamiUrl: '/v1/account',
    accountPath: 'settings.dashboard.display_name',
    setupHint: 'Use a restricted key (rk_) rather than a secret key where you can.',
    docs: 'https://docs.stripe.com/api',
  },
};

/**
 * Custom providers the user added with `dv connect add`.
 *
 * Stored as plain data in config, never code — a connector definition should not be
 * able to execute anything. Regex is the one exception and is rebuilt from a string.
 */
export interface CustomProviderRecord {
  label?: string;
  methods?: AuthMethod[];
  apiBase?: string;
  authStyle?: AuthStyle;
  headers?: Record<string, string>;
  whoamiUrl?: string;
  accountPath?: string;
  scopes?: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  needsClientSecret?: boolean;
  appSetupUrl?: string;
  docs?: string;
}

function fromRecord(id: string, record: CustomProviderRecord): ProviderDef {
  return {
    id,
    label: record.label ?? id,
    methods: record.methods?.length ? record.methods : ['token'],
    scopes: record.scopes ?? [],
    apiBase: record.apiBase,
    authStyle: record.authStyle ?? 'bearer',
    headers: record.headers,
    whoamiUrl: record.whoamiUrl,
    accountPath: record.accountPath,
    authorizeUrl: record.authorizeUrl,
    tokenUrl: record.tokenUrl,
    deviceCodeUrl: record.deviceCodeUrl,
    needsClientSecret: record.needsClientSecret,
    appSetupUrl: record.appSetupUrl,
    docs: record.docs,
    custom: true,
  };
}

/**
 * Everything connectable: built-ins plus anything the user defined.
 *
 * A custom entry with a built-in's id overrides it, on purpose — that is how you
 * repoint `atlassian` at your own site, or pin a different API version, without
 * waiting for a release.
 */
export function allProviders(): Record<string, ProviderDef> {
  const config = readConfig();
  const merged: Record<string, ProviderDef> = { ...BUILT_IN };

  for (const [id, record] of Object.entries(config.providers ?? {})) {
    merged[id] = merged[id]
      ? { ...merged[id]!, ...fromRecord(id, record as CustomProviderRecord), custom: true }
      : fromRecord(id, record as CustomProviderRecord);
  }

  // A base URL set with `dv config set <id>.apiBase` wins. Services hosted per
  // customer — Atlassian Cloud, self-hosted GitLab, a private Supabase — cannot
  // ship a default, so this is the only way they are reachable at all.
  for (const [id, app] of Object.entries(config.apps ?? {})) {
    const base = (app as { apiBase?: string })?.apiBase;
    if (base && merged[id]) merged[id] = { ...merged[id]!, apiBase: base.replace(/\/+$/, '') };
  }
  return merged;
}

export interface ResolvedApp {
  clientId?: string;
  clientSecret?: string;
  apiBase?: string;
  redirectPort?: string;
  /** Where the client id came from, so the UI can say. */
  source: 'env' | 'config' | 'built-in' | 'none';
}

/**
 * The OAuth app to use for a provider.
 *
 * Order matters: an explicit environment variable beats a saved config, which beats
 * the app shipped with the CLI. That way a user or a CI job can always take over
 * without the built-in silently winning.
 */
export function resolveApp(providerId: string): ResolvedApp {
  const stored = getOAuthApp(providerId);
  const provider = getProvider(providerId);
  const upper = providerId.toUpperCase();

  const fromEnv = process.env[`DV_${upper}_CLIENT_ID`];
  const clientId = stored.clientId ?? provider?.defaultClientId;

  return {
    clientId,
    clientSecret: stored.clientSecret ?? provider?.defaultClientSecret,
    apiBase: stored.apiBase,
    redirectPort: stored.redirectPort,
    source: !clientId
      ? 'none'
      : fromEnv
        ? 'env'
        : stored.clientId
          ? 'config'
          : 'built-in',
  };
}

export function getProvider(id: string): ProviderDef | undefined {
  if (!id) return undefined;
  const all = allProviders();
  const direct = all[id.toLowerCase()];
  if (direct) return direct;
  // Per-provider overrides live under config.apps — a site URL for Atlassian, say.
  return undefined;
}

export function providerIds(): string[] {
  return Object.keys(allProviders()).sort();
}

/** The method to use when the user did not name one. */
export function defaultMethod(provider: ProviderDef): AuthMethod {
  return provider.methods[0] ?? 'token';
}

export function supportsMethod(provider: ProviderDef, method: AuthMethod): boolean {
  return provider.methods.includes(method);
}

/** Kept for older call sites: whether a provider has any browser-based login. */
export function hasOAuth(provider: ProviderDef): boolean {
  return provider.methods.some((m) => m === 'device' || m === 'loopback' || m === 'client_credentials');
}

/** Back-compat alias; `allProviders()` is the live view. */
export const PROVIDERS = BUILT_IN;
