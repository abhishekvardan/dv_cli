/**
 * Where the CLI keeps state.
 *
 * `DV_HOME` exists so tests never touch a real user's credentials, and so a CI
 * job can point at a scratch directory.
 */
export declare function dvHome(): string;
/** Tokens. Written 0600 — see config/store.ts. */
export declare function credentialsPath(): string;
/** OAuth client ids and preferences. Not secret, but not world-readable either. */
export declare function configPath(): string;
