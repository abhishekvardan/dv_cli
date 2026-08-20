/**
 * Argument parsing.
 *
 * Hand-written rather than pulled from a dependency: the CLI has no runtime deps at
 * all, which means `npm i -g` cannot fail on a transitive install and there is no
 * supply-chain surface for a tool that holds OAuth tokens.
 */
export interface ParsedArgs {
    /** Positional words before any flag, e.g. ["gh", "repos"]. */
    command: string[];
    /** Positional words after the command path is consumed. */
    positional: string[];
    flags: Record<string, string | boolean | string[]>;
}
/**
 * Parse argv.
 *
 * Supports `--flag`, `--flag=value`, `--flag value`, `--no-flag`, short `-x`, and
 * `--` to stop parsing. A repeated flag collects into an array so `--label a
 * --label b` works without special-casing at each call site.
 */
export declare function parseArgs(argv: string[]): ParsedArgs;
/** A flag's string value, or undefined. Arrays collapse to the last value. */
export declare function str(flags: ParsedArgs['flags'], ...names: string[]): string | undefined;
/** A flag's value, or fail. */
export declare function require(flags: ParsedArgs['flags'], name: string, hint?: string): string;
export declare function bool(flags: ParsedArgs['flags'], ...names: string[]): boolean;
export declare function num(flags: ParsedArgs['flags'], name: string, fallback: number): number;
/** All flag names that are not in the allowed set — catches typos like --limmit. */
export declare function unknownFlags(flags: ParsedArgs['flags'], allowed: string[]): string[];
/**
 * Undo Git Bash's POSIX-path conversion.
 *
 * MSYS rewrites any argument that looks like an absolute POSIX path into a Windows
 * one *before the program sees it*, so on Git Bash `dv api github /user` arrives as
 * `C:/Program Files/Git/user`. Nothing in the process can tell that happened by
 * looking at the string alone, and the result is a request against a nonsense path
 * that 404s for no visible reason.
 *
 * The install root is derived from `EXEPATH`, which Git Bash sets to `<root>\bin`,
 * so this is an exact match rather than a guess. Applied only to URL-path arguments —
 * never to file paths, where a real Windows path is what the user means.
 */
export declare function unmanglePath(value: string): string;
/**
 * Whether a `--no-x` style flag was given.
 *
 * The parser normalises `--no-push` into `push: false`, so asking for a flag literally
 * named "no-push" always answers false and the negation is silently ignored. Both
 * spellings are accepted here because both are natural to type.
 */
export declare function negated(flags: ParsedArgs['flags'], name: string): boolean;
