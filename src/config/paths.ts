import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the CLI keeps state.
 *
 * `DV_HOME` exists so tests never touch a real user's credentials, and so a CI
 * job can point at a scratch directory.
 */
export function dvHome(): string {
  return process.env.DV_HOME || join(homedir(), '.dv');
}

/** Tokens. Written 0600 — see config/store.ts. */
export function credentialsPath(): string {
  return join(dvHome(), 'credentials.json');
}

/** OAuth client ids and preferences. Not secret, but not world-readable either. */
export function configPath(): string {
  return join(dvHome(), 'config.json');
}
