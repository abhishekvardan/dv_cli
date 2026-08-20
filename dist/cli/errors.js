/**
 * Failures a script can branch on.
 *
 * A CLI that exits 1 for everything forces callers to grep stderr. These codes let
 * a wrapper tell "you are not logged in" from "the API said no" from "you typed the
 * command wrong", which are three different things to recover from.
 */
export const EXIT = {
    ok: 0,
    /** Something went wrong at runtime. */
    failure: 1,
    /** The command line itself was wrong — unknown command, missing argument. */
    usage: 2,
    /** No credential, or one that cannot be renewed. Re-run `dv auth login`. */
    auth: 3,
    /** The provider refused: rate limit, insufficient scope, permission denied. */
    provider: 4,
    /** Nothing matched. Useful for `if dv gh repo x; then`. */
    notFound: 5,
};
export class CliError extends Error {
    code;
    hint;
    constructor(message, code = EXIT.failure, 
    /** Shown under the error as the next thing to try. */
    hint) {
        super(message);
        this.code = code;
        this.hint = hint;
        this.name = 'CliError';
    }
}
export class AuthError extends CliError {
    constructor(message, hint) {
        super(message, EXIT.auth, hint);
        this.name = 'AuthError';
    }
}
export class UsageError extends CliError {
    constructor(message, hint) {
        super(message, EXIT.usage, hint);
        this.name = 'UsageError';
    }
}
export class ProviderError extends CliError {
    status;
    constructor(message, status, hint) {
        super(message, EXIT.provider, hint);
        this.status = status;
        this.name = 'ProviderError';
    }
}
export class NotFoundError extends CliError {
    constructor(message, hint) {
        super(message, EXIT.notFound, hint);
        this.name = 'NotFoundError';
    }
}
//# sourceMappingURL=errors.js.map