/**
 * `dv config …` — OAuth client ids and secrets.
 *
 * Keys are `provider.field`, e.g. `github.clientId`. A secret set here lands in
 * ~/.dv/config.json at 0600; the environment variables named by `config list`
 * are the alternative when nothing should touch the disk.
 */
import { type ParsedArgs } from '../cli/args.js';
export declare function configCommand(args: ParsedArgs): Promise<void>;
