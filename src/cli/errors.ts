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
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ExitCode = EXIT.failure,
    /** Shown under the error as the next thing to try. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class AuthError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.auth, hint);
    this.name = 'AuthError';
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.usage, hint);
    this.name = 'UsageError';
  }
}

export class ProviderError extends CliError {
  constructor(
    message: string,
    readonly status?: number,
    hint?: string,
  ) {
    super(message, EXIT.provider, hint);
    this.name = 'ProviderError';
  }
}

export class NotFoundError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.notFound, hint);
    this.name = 'NotFoundError';
  }
}
