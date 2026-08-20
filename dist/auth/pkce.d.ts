/**
 * PKCE (RFC 7636).
 *
 * Required for a public client: the CLI cannot keep a secret, so the authorization
 * code alone must not be enough to get a token. The verifier stays in this process
 * and only its hash is sent to the authorize endpoint, which means a code
 * intercepted from the loopback redirect is useless on its own.
 */
/** base64url per RFC 7636 §A: no padding, - and _ instead of + and /. */
export declare function base64url(input: Buffer): string;
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
export declare function createPkce(): Pkce;
/** Opaque value tying the redirect back to the request that started it (CSRF). */
export declare function createState(): string;
