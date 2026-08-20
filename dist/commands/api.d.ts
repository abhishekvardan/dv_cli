/**
 * `dv api <provider> <path>` — an authenticated request to any connector.
 *
 * The escape hatch that keeps the CLI from being a list of things I thought of.
 * Every connector, built-in or custom, is reachable the moment it has a credential:
 * auth, base URL, headers, error translation and exit codes are all handled, and
 * what comes back is the raw response for `jq` to work on.
 */
import { type ParsedArgs } from '../cli/args.js';
export declare function apiCommand(args: ParsedArgs): Promise<void>;
