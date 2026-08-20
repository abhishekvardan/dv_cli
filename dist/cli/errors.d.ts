/**
 * Failures a script can branch on.
 *
 * A CLI that exits 1 for everything forces callers to grep stderr. These codes let
 * a wrapper tell "you are not logged in" from "the API said no" from "you typed the
 * command wrong", which are three different things to recover from.
 */
export declare const EXIT: {
    readonly ok: 0;
    /** Something went wrong at runtime. */
    readonly failure: 1;
    /** The command line itself was wrong — unknown command, missing argument. */
    readonly usage: 2;
    /** No credential, or one that cannot be renewed. Re-run `dv auth login`. */
    readonly auth: 3;
    /** The provider refused: rate limit, insufficient scope, permission denied. */
    readonly provider: 4;
    /** Nothing matched. Useful for `if dv gh repo x; then`. */
    readonly notFound: 5;
};
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
export declare class CliError extends Error {
    readonly code: ExitCode;
    /** Shown under the error as the next thing to try. */
    readonly hint?: string | undefined;
    constructor(message: string, code?: ExitCode, 
    /** Shown under the error as the next thing to try. */
    hint?: string | undefined);
}
export declare class AuthError extends CliError {
    constructor(message: string, hint?: string);
}
export declare class UsageError extends CliError {
    constructor(message: string, hint?: string);
}
export declare class ProviderError extends CliError {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined, hint?: string);
}
export declare class NotFoundError extends CliError {
    constructor(message: string, hint?: string);
}
