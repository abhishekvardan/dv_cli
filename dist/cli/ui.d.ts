/**
 * Terminal output.
 *
 * Colour is applied only when stdout is a TTY and NO_COLOR is unset, so piping to a
 * file or another program yields clean text. Data goes to stdout; progress and
 * warnings go to stderr, so `dv gh repos --json > repos.json` produces a valid
 * JSON file even while status lines are being printed.
 */
export declare const c: {
    bold: (s: string) => string;
    dim: (s: string) => string;
    red: (s: string) => string;
    green: (s: string) => string;
    yellow: (s: string) => string;
    blue: (s: string) => string;
    magenta: (s: string) => string;
    cyan: (s: string) => string;
    gray: (s: string) => string;
};
export declare function setQuiet(value: boolean): void;
/** Data. The only thing that goes to stdout. */
export declare function out(line?: string): void;
/** Progress and commentary. Never stdout, so it cannot corrupt piped output. */
export declare function info(line: string): void;
export declare function warn(line: string): void;
export declare function success(line: string): void;
export declare function fail(line: string): void;
export declare function json(value: unknown): void;
export interface Column<T> {
    header: string;
    value: (row: T) => string;
    /** Truncate to this many characters. Long values otherwise wreck the layout. */
    max?: number;
    align?: 'left' | 'right';
}
/**
 * Aligned table.
 *
 * Widths come from the content so nothing is cut off arbitrarily, but any single
 * column can cap itself. A column whose every value is empty is dropped — printing
 * an always-blank "Description" header is noise.
 */
export declare function table<T>(rows: T[], columns: Column<T>[]): void;
/** "3 minutes ago", "in 2 hours". */
export declare function relative(iso: string | undefined | null): string;
export declare function heading(text: string): void;
export { prompt, confirm, select, promptSecret, ask, type Choice } from './interactive.js';
