/**
 * `dv connect …` — add and inspect connectors.
 *
 * The point: connecting to something this CLI has never heard of should not require
 * changing this CLI. A definition is four facts — base URL, how the credential
 * attaches, any fixed headers, and an endpoint that proves it works — and once
 * stored, every generic command works against it.
 */
import { type ParsedArgs } from '../cli/args.js';
export declare function connectCommand(args: ParsedArgs): Promise<void>;
