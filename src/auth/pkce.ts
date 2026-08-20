/**
 * PKCE (RFC 7636).
 *
 * Required for a public client: the CLI cannot keep a secret, so the authorization
 * code alone must not be enough to get a token. The verifier stays in this process
 * and only its hash is sent to the authorize endpoint, which means a code
 * intercepted from the loopback redirect is useless on its own.
 */

import { createHash, randomBytes } from 'node:crypto';

/** base64url per RFC 7636 §A: no padding, - and _ instead of + and /. */
export function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * A verifier and its S256 challenge.
 *
 * 32 random bytes becomes a 43-character verifier — the shortest the spec allows,
 * and the length Google's own examples use. `plain` is deliberately not supported;
 * it offers no protection over sending the code itself.
 */
export function createPkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** Opaque value tying the redirect back to the request that started it (CSRF). */
export function createState(): string {
  return base64url(randomBytes(16));
}
