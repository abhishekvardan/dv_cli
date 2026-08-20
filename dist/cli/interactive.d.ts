/**
 * Asking the user things.
 *
 * Kept separate from `ui.ts` because these take over stdin and the cursor, which needs
 * careful teardown — a prompt that exits without restoring raw mode leaves the shell
 * unable to echo what you type, and one that exits without restoring the cursor leaves
 * it invisible.
 */
/** Read a line from stdin. Used for confirmations, never for secrets. */
export declare function prompt(question: string): Promise<string>;
/**
 * Confirm a destructive or outward-facing action.
 *
 * Returns true without asking when `--yes` was passed. A non-interactive run without
 * `--yes` is refused rather than assumed, because the caller cannot see the question.
 */
export declare function confirm(question: string, assumeYes: boolean): Promise<boolean>;
export interface Choice<T> {
    value: T;
    label: string;
    /** One line on what this option means. */
    detail?: string;
    /** Starts highlighted, and is used when the user just presses Enter. */
    recommended?: boolean;
}
/**
 * Ask the user to pick one option.
 *
 * Arrow keys where the terminal can be driven, numbers where it cannot. The fallback
 * is not hypothetical — redirected stderr, CI logs and terminals without VT support all
 * leave the cursor uncontrollable, and a menu that repaints itself into garbage is
 * worse than a plain list.
 *
 * Returns the recommended option without asking when there is only one, or when stdin
 * is not a TTY: a script cannot answer a question, and failing there would make every
 * non-interactive run need a flag it did not need before.
 */
export declare function select<T>(question: string, choices: Choice<T>[]): Promise<T>;
/**
 * Read a secret without echoing it.
 *
 * A pasted token that appears on screen ends up in scrollback, in screen shares and
 * in terminal recordings. Raw mode is restored on every exit path, Ctrl-C included,
 * so a cancelled prompt cannot leave the terminal unable to echo.
 */
export declare function promptSecret(question: string): Promise<string>;
/** Ask for a value, with an optional default shown in the prompt. */
export declare function ask(question: string, fallback?: string): Promise<string>;
