/**
 * Rendering arbitrary query results.
 *
 * Different problem from the curated tables elsewhere in the CLI. Those have columns
 * chosen to fit; a `select *` can return twenty columns of UUIDs and JSON, and laying
 * that out as plain aligned text produces something no one can read — rows wrap into
 * each other and there is no way to tell where one column ends.
 *
 * Two renderings, and the choice between them is made for you:
 *
 *  - **Bordered grid** when the row fits the terminal. Borders matter here in a way
 *    they do not for a three-column list: with twenty columns, whitespace alone gives
 *    the eye nothing to track along.
 *  - **Expanded**, one field per line, when it does not. This is what `psql \\x auto`
 *    does, for the same reason — past a certain width a grid is not salvageable, and
 *    a record-per-block is readable at any width.
 */

import { c, clipVisible, out, terminalWidth } from './ui.js';

/** Printable width, ignoring ANSI. */
function visibleWidth(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function pad(text: string, to: number): string {
  return text + ' '.repeat(Math.max(0, to - visibleWidth(text)));
}

/**
 * Turn a value into one line of display text.
 *
 * `null` is styled rather than blank, because an empty cell is indistinguishable from
 * an empty string — and in a database those are very different things.
 */
export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return c.dim('null');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  // Newlines inside a cell would break every row below it.
  return text.includes('\n') ? text.replace(/\s*\n\s*/g, ' ') : text;
}

function truncate(text: string, max: number): string {
  return visibleWidth(text) > max ? `${clipVisible(text, max - 1)}…` : text;
}

/** Shortest a column may become before it stops being worth showing. */
const MIN_COLUMN = 8;

/**
 * Shrink columns until the row fits the terminal.
 *
 * The widest column is shrunk first, repeatedly. That naturally targets UUIDs and JSON
 * blobs — the things that make a row too wide — while leaving short columns like
 * `status` or `unit` untouched. Shrinking everything proportionally instead would
 * mangle the readable columns to protect the unreadable ones.
 *
 * Returns null when even minimum widths do not fit, which means there are simply too
 * many columns for this terminal and a grid cannot be salvaged.
 */
function fitWidths(natural: number[], available: number): number[] | null {
  const widths = [...natural];
  // Each column costs its width plus "│ " and " "; the row costs one closing "│".
  const overhead = widths.length * 3 + 1;
  let total = widths.reduce((a, b) => a + b, 0) + overhead;

  while (total > available) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i]! > widths[widest]!) widest = i;
    }
    if (widths[widest]! <= MIN_COLUMN) return null;
    widths[widest]!--;
    total--;
  }
  return widths;
}

export interface RenderOptions {
  /** Force one field per line. */
  expanded?: boolean;
  /** Never draw borders. */
  plain?: boolean;
  /** Widest any single column may be. */
  maxColumnWidth?: number;
  /** How many rows to show. */
  limit?: number;
}

const BOX = {
  topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
  horizontal: '─', vertical: '│',
  teeDown: '┬', teeUp: '┴', teeRight: '├', teeLeft: '┤', cross: '┼',
};

/**
 * Print rows, choosing a layout that fits.
 *
 * Returns the layout used, so the caller can mention `--expanded` only when it is
 * not already in effect.
 */
export function printResult(rows: any[], options: RenderOptions = {}): 'grid' | 'expanded' | 'empty' {
  if (rows.length === 0) return 'empty';

  const limit = options.limit ?? 50;
  const shown = rows.slice(0, limit);
  const keys = [...new Set(shown.flatMap((r) => Object.keys(r ?? {})))];
  if (keys.length === 0) return 'empty';

  const maxCol = options.maxColumnWidth ?? 48;

  // Natural widths first, then shrink to fit rather than abandoning the grid. Long ids
  // are what push a row over the edge, and a truncated UUID is still recognisable —
  // far more useful than a screen of one-field-per-line blocks.
  const natural = keys.map((key, i) =>
    Math.min(
      maxCol,
      Math.max(
        visibleWidth(key),
        ...shown.map((row) => visibleWidth(renderValue(row?.[key]))),
      ),
    ),
  );

  const available = terminalWidth() - 1;

  // Twenty columns cannot fit an eighty-column terminal at any width, so rather than
  // abandoning the grid, drop columns from the right until the rest fit and say how
  // many were hidden. Keeping the leading columns keeps the identifying ones, which
  // are the reason you ran `select *` in the first place.
  let visible = keys.length;
  let fitted: number[] | null = null;
  if (!options.expanded) {
    while (visible > 0) {
      fitted = fitWidths(natural.slice(0, visible), available);
      if (fitted) break;
      visible--;
    }
  }
  const hidden = keys.length - visible;
  const expanded = options.expanded || fitted === null;

  if (expanded) {
    printExpanded(keys, shown);
    return 'expanded';
  }
  const widths = fitted!;
  const shownKeys = keys.slice(0, visible);
  const cells = shown.map((row) =>
    shownKeys.map((k, i) => truncate(renderValue(row?.[k]), widths[i]!)),
  );
  printGrid(shownKeys, cells, widths, options.plain === true);
  if (hidden > 0) {
    out(
      c.dim(
        `  ${hidden} more column${hidden === 1 ? '' : 's'} not shown: ` +
          `${keys.slice(visible).join(', ')}`,
      ),
    );
  }
  return 'grid';
}

function printGrid(keys: string[], cells: string[][], widths: number[], plain: boolean): void {
  // Headers are truncated to the final width like any other cell. A column shrunk
  // below its own name would otherwise push the border out and misalign the grid.
  const heads = keys.map((k, i) => truncate(k, widths[i]!));

  if (plain) {
    out(heads.map((k, i) => pad(c.gray(k.toUpperCase()), widths[i]!)).join('  ').trimEnd());
    for (const row of cells) {
      out(row.map((v, i) => pad(v, widths[i]!)).join('  ').trimEnd());
    }
    return;
  }

  const rule = (left: string, mid: string, right: string) =>
    left + widths.map((w) => BOX.horizontal.repeat(w + 2)).join(mid) + right;

  out(c.dim(rule(BOX.topLeft, BOX.teeDown, BOX.topRight)));
  out(
    c.dim(BOX.vertical) +
      heads.map((k, i) => ` ${pad(c.bold(k), widths[i]!)} `).join(c.dim(BOX.vertical)) +
      c.dim(BOX.vertical),
  );
  out(c.dim(rule(BOX.teeRight, BOX.cross, BOX.teeLeft)));

  for (const row of cells) {
    out(
      c.dim(BOX.vertical) +
        row.map((v, i) => ` ${pad(v, widths[i]!)} `).join(c.dim(BOX.vertical)) +
        c.dim(BOX.vertical),
    );
  }
  out(c.dim(rule(BOX.bottomLeft, BOX.teeUp, BOX.bottomRight)));
}

/**
 * One record per block, one field per line.
 *
 * Values are not truncated here — the whole point of this layout is that there is room
 * for them, and a truncated UUID or JSON blob is useless.
 */
function printExpanded(keys: string[], rows: any[]): void {
  const keyWidth = Math.max(...keys.map((k) => k.length));
  const width = Math.min(terminalWidth() - 1, 100);

  rows.forEach((row, i) => {
    const header = `─[ ${i + 1} ]`;
    out(c.dim(header + BOX.horizontal.repeat(Math.max(0, width - header.length))));
    for (const key of keys) {
      const value = renderValue(row?.[key]);
      const label = c.bold(pad(key, keyWidth));
      const indent = ' '.repeat(keyWidth + 3);
      // Wrap long values under the label rather than letting the terminal wrap them
      // to column zero, which would make them look like new fields.
      const room = Math.max(20, width - keyWidth - 3);
      const chunks: string[] = [];
      let rest = value;
      while (visibleWidth(rest) > room) {
        chunks.push(clipVisible(rest, room));
        rest = rest.slice(clipVisible(rest, room).length);
      }
      chunks.push(rest);
      out(`  ${label} ${chunks[0]}`);
      for (const extra of chunks.slice(1)) out(`${indent}${extra}`);
    }
  });
}
