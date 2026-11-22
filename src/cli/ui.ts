/**
 * Terminal output.
 *
 * Colour is applied only when stdout is a TTY and NO_COLOR is unset, so piping to a
 * file or another program yields clean text. Data goes to stdout; progress and
 * warnings go to stderr, so `dv gh repos --json > repos.json` produces a valid
 * JSON file even while status lines are being printed.
 */

const useColor =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

const wrap = (open: string, close: string) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('90', '39'),
};

let quiet = false;
export function setQuiet(value: boolean): void {
  quiet = value;
}

/** Whether the caller asked for silence. Progress indicators honour this too. */
export function isQuiet(): boolean {
  return quiet;
}

/** Data. The only thing that goes to stdout. */
export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** Progress and commentary. Never stdout, so it cannot corrupt piped output. */
export function info(line: string): void {
  if (!quiet) process.stderr.write(`${line}\n`);
}

export function warn(line: string): void {
  process.stderr.write(`${c.yellow('!')} ${line}\n`);
}

export function success(line: string): void {
  if (!quiet) process.stderr.write(`${c.green('✓')} ${line}\n`);
}

export function fail(line: string): void {
  process.stderr.write(`${c.red('✗')} ${line}\n`);
}

export function json(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/** Visible width, ignoring the escape sequences colour adds. */
function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(s: string, to: number): string {
  return s + ' '.repeat(Math.max(0, to - width(s)));
}

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
export function table<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) return;

  const cells = rows.map((row) =>
    columns.map((col) => {
      let v = col.value(row) ?? '';
      if (col.max && width(v) > col.max) v = `${v.slice(0, col.max - 1)}…`;
      return v;
    }),
  );

  const keep = columns.map((_, i) => cells.some((r) => width(r[i] ?? '') > 0));
  const widths = columns.map((col, i) =>
    Math.max(width(col.header), ...cells.map((r) => width(r[i] ?? ''))),
  );

  const line = (values: string[], style?: (s: string) => string) =>
    out(
      values
        .map((v, i) => {
          if (!keep[i]) return null;
          const w = widths[i]!;
          const text = columns[i]!.align === 'right' ? ' '.repeat(Math.max(0, w - width(v))) + v : pad(v, w);
          return style ? style(text) : text;
        })
        .filter((v): v is string => v !== null)
        .join('  ')
        .trimEnd(),
    );

  line(columns.map((col) => col.header.toUpperCase()), c.gray);
  for (const row of cells) line(row);
}

/** "3 minutes ago", "in 2 hours". */
export function relative(iso: string | undefined | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const future = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60_000);
  const say = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`);
  if (mins < 1) return 'just now';
  if (mins < 60) return say(mins, 'm');
  const hours = Math.round(mins / 60);
  if (hours < 24) return say(hours, 'h');
  const days = Math.round(hours / 24);
  if (days < 30) return say(days, 'd');
  return new Date(then).toISOString().slice(0, 10);
}

export function heading(text: string): void {
  info(`\n${c.bold(text)}`);
}

// Prompts live in interactive.ts — they need raw-mode teardown that the rest of the
// output layer has no business knowing about. Re-exported so call sites keep one import.
export { prompt, confirm, select, promptSecret, ask, type Choice } from './interactive.js';

/**
 * Truncate to a visible width, leaving ANSI sequences intact.
 *
 * Essential for anything that redraws by moving the cursor up N lines. A row wider
 * than the terminal wraps onto two physical lines, so "up N" lands in the wrong place
 * and every redraw appends instead of replacing — which looks exactly like the arrow
 * keys adding entries rather than moving the highlight.
 */
export function clipVisible(text: string, max: number): string {
  if (max <= 0) return '';
  let visible = 0;
  let out = '';
  let i = 0;
  let sawAnsi = false;

  while (i < text.length) {
    if (text[i] === '\u001b') {
      // Copy the whole escape sequence without counting it toward the width.
      const end = text.indexOf('m', i);
      if (end === -1) break;
      out += text.slice(i, end + 1);
      sawAnsi = true;
      i = end + 1;
      continue;
    }
    if (visible >= max) {
      // Close any open styling so the truncation cannot leak colour onto the next line.
      return sawAnsi ? `${out}\u001b[0m` : out;
    }
    out += text[i];
    visible++;
    i++;
  }
  return sawAnsi ? `${out}\u001b[0m` : out;
}

/** Usable terminal width, with a sane default when it cannot be determined. */
export function terminalWidth(): number {
  return process.stderr.columns && process.stderr.columns > 20 ? process.stderr.columns : 80;
}
