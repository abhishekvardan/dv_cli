/**
 * Noun-verb command routing.
 *
 * Every command group reads `<noun> <verb>` — `dv gh repo list`, `dv vercel deploy
 * list` — so the surface stays guessable as it grows. Having seen one group, you can
 * predict the next, which was not true of the older mix of `repos`, `branches` and
 * `create`.
 *
 * Shared rather than written per group: the fiddly parts (aliases, a bare noun
 * meaning "list", a name where a verb was expected) are easy to get subtly different
 * in each copy.
 */
import type { ParsedArgs } from './args.js';
export interface CommandShape {
    /** Verbs each noun understands. The first is what a bare noun means. */
    verbs: Record<string, string[]>;
    /** Commands with no noun at all, e.g. `dv gh search`. */
    standalone?: string[];
    /** Short forms mapped to their canonical pair, e.g. `repos` -> `repo list`. */
    aliases?: Record<string, [string, string]>;
}
export interface ResolvedCommand {
    /** "noun verb", or the bare word for a standalone command. Empty when nothing given. */
    key: string;
    /** Positional arguments left after the noun and verb are consumed. */
    rest: string[];
}
/**
 * Work out which command was meant.
 *
 * `args.positional` holds words that appeared after a flag, which the parser keeps
 * separate from the command path — they are appended so `dv gh file read --ref main
 * src/x.ts` still finds its path.
 */
export declare function resolveCommand(args: ParsedArgs, shape: CommandShape): ResolvedCommand;
/** "repo      list, view, create" lines for a usage error. */
export declare function describeShape(shape: CommandShape): string;
