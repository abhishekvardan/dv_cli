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
/** How a credential is obtained. */
export type AuthMethod = 
/** OAuth 2.0 device grant (RFC 8628). Best for a CLI where supported. */
'device'
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
export declare const BUILT_IN: Record<string, ProviderDef>;
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
/**
 * Everything connectable: built-ins plus anything the user defined.
 *
 * A custom entry with a built-in's id overrides it, on purpose — that is how you
 * repoint `atlassian` at your own site, or pin a different API version, without
 * waiting for a release.
 */
export declare function allProviders(): Record<string, ProviderDef>;
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
export declare function resolveApp(providerId: string): ResolvedApp;
export declare function getProvider(id: string): ProviderDef | undefined;
export declare function providerIds(): string[];
/** The method to use when the user did not name one. */
export declare function defaultMethod(provider: ProviderDef): AuthMethod;
export declare function supportsMethod(provider: ProviderDef, method: AuthMethod): boolean;
/** Kept for older call sites: whether a provider has any browser-based login. */
export declare function hasOAuth(provider: ProviderDef): boolean;
/** Back-compat alias; `allProviders()` is the live view. */
export declare const PROVIDERS: Record<string, ProviderDef>;
