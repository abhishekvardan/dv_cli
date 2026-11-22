/**
 * Markdown, rendered for a terminal.
 *
 * A README printed as raw markdown asks you to read the punctuation and imagine the
 * formatting. The information is all there; it is simply harder to take in than it needs
 * to be, and a terminal can do headings, emphasis, rules and tables perfectly well.
 *
 * Deliberately not a full CommonMark implementation. It handles what documentation
 * actually contains — headings, emphasis, code, lists, tables, quotes, links — and leaves
 * anything it does not recognise as plain text. That is the right failure: an unrendered
 * line is readable, whereas a half-parsed one is worse than the original.
 *
 * Written from scratch because dv ships with no runtime dependencies, and a markdown
 * renderer is not worth surrendering that for.
 */

import { c, clipVisible, terminalWidth } from './ui.js';

export interface RenderOptions {
  /** Total width to render into. Defaults to the terminal's. */
  width?: number;
  /** Spaces before every line. */
  indent?: number;
}

/** Render a markdown document into terminal lines. */
export function renderMarkdown(source: string, options: RenderOptions = {}): string[] {
  const indent = ' '.repeat(options.indent ?? 0);
  // Leaves room for the indent and a character of slack, so a full-width line does not
  // wrap in the terminal and undo the layout.
  const width = Math.max(28, (options.width ?? terminalWidth()) - (options.indent ?? 0) - 1);

  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // ── fenced code ────────────────────────────────────────────────────────
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const language = fence[1]?.trim() ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      blank(out);
      out.push(...renderCode(body, language, width).slice(1));
      continue;
    }

    // ── table ──────────────────────────────────────────────────────────────
    //
    // Recognised by its separator row rather than its pipes: a line of pipes on its own is
    // just a line of pipes, and `|` appears in prose often enough to matter.
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1]!)) {
      const rows: string[] = [line];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(lines[i]!);
        i++;
      }
      blank(out);
      out.push(...renderTable(rows, width).slice(1));
      continue;
    }

    // ── heading ────────────────────────────────────────────────────────────
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = inline(heading[2]!.replace(/\s*#+\s*$/, ''));

      blank(out);
      if (level === 1) {
        out.push(c.bold(text));
        // A rule under the title only. Underlining every heading turns a document into a
        // ladder and stops the top-level one meaning anything.
        out.push(c.dim('─'.repeat(Math.min(visibleLength(text), width))));
      } else {
        out.push(c.bold(text));
      }
      i++;
      continue;
    }

    // ── horizontal rule ────────────────────────────────────────────────────
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(c.dim('─'.repeat(Math.min(48, width))));
      i++;
      continue;
    }

    // ── blockquote ─────────────────────────────────────────────────────────
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      for (const text of wrap(inline(quoted.join(' ')), width - 2)) {
        out.push(`${c.dim('│')} ${c.dim(text)}`);
      }
      continue;
    }

    // ── list item ──────────────────────────────────────────────────────────
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);

    if (bullet || numbered) {
      const lead = (bullet?.[1] ?? numbered?.[1] ?? '').length;
      const depth = Math.floor(lead / 2);
      const marker = bullet ? c.dim('•') : c.dim(`${numbered![2]}.`);
      const text = inline(bullet?.[2] ?? numbered![3]!);

      const pad = '  '.repeat(depth);
      const wrapped = wrap(text, width - pad.length - 2);
      out.push(`${pad}${marker} ${wrapped[0] ?? ''}`);
      // Continuation lines align under the text, not under the bullet, so a wrapped item
      // still reads as one item.
      for (const rest of wrapped.slice(1)) out.push(`${pad}  ${rest}`);
      i++;
      continue;
    }

    // ── blank ──────────────────────────────────────────────────────────────
    if (!line.trim()) {
      // Collapsed: one blank line separates, several just waste a short screen.
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      i++;
      continue;
    }

    // ── paragraph ──────────────────────────────────────────────────────────
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) {
      paragraph.push(lines[i]!.trim());
      i++;
    }
    out.push(...wrap(inline(paragraph.join(' ')), width));
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.map((line) => `${indent}${line}`);
}

/**
 * A separating blank, at most one.
 *
 * Every block wants space before it, and each pushing its own without looking produced
 * three blank lines between a paragraph and the heading after it.
 */
function blank(out: string[]): void {
  if (out.length > 0 && out[out.length - 1] !== '') out.push('');
}

/** Whether a line begins a block, so a paragraph knows where to stop. */
function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s/.test(line) ||
    /^\s*```/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*+]\s/.test(line) ||
    /^\s*\d+[.)]\s/.test(line) ||
    /^\s*([-*_])\1{2,}\s*$/.test(line) ||
    isTableRow(line)
  );
}

/* ─────────────────────────────── inline ─────────────────────────────── */

/**
 * Emphasis, code and links within a line.
 *
 * Order matters. Code spans are extracted first and put back last, because a backtick span
 * is literal — `**not bold**` inside code is a pair of asterisks, and applying emphasis
 * first would eat them.
 */
export function inline(text: string): string {
  const codes: string[] = [];
  let work = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // Links: the text is what matters, the URL is context.
  work = work.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
    `${c.cyan(label)} ${c.dim(url)}`);

  // Bold before italic, or `**x**` is read as an italic wrapping an italic.
  work = work.replace(/\*\*([^*]+)\*\*/g, (_, inner: string) => c.bold(inner));
  work = work.replace(/__([^_]+)__/g, (_, inner: string) => c.bold(inner));
  work = work.replace(/(^|[^*])\*([^*\n]+)\*/g, (_, before: string, inner: string) =>
    `${before}${c.cyan(inner)}`);
  work = work.replace(/~~([^~]+)~~/g, (_, inner: string) => c.dim(inner));

  return work.replace(/\u0000(\d+)\u0000/g, (_, index: string) =>
    c.yellow(codes[Number(index)] ?? ''));
}

/* ──────────────────────────────── code ──────────────────────────────── */

function renderCode(body: string[], language: string, width: number): string[] {
  const out: string[] = [''];
  // The language as a small label rather than a line of its own, so a three-line snippet
  // does not cost five.
  if (language) out.push(c.dim(`  ${language}`));

  for (const line of body) {
    // No inline formatting inside code — an asterisk in a shell command is a glob, and
    // rendering it as emphasis would change what the reader thinks the command is.
    out.push(`${c.dim('│')} ${c.gray(clipVisible(line, width - 2))}`);
  }
  out.push('');
  return out;
}

/* ─────────────────────────────── tables ─────────────────────────────── */

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line) && line.includes('|');
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line) && line.includes('-');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * A markdown table as an aligned terminal table.
 *
 * Columns are sized to their widest cell, then shrunk proportionally if the total exceeds
 * the width — shrinking rather than dropping, because a table's columns are usually all
 * load-bearing and losing one silently is worse than truncating several.
 */
function renderTable(rows: string[], width: number): string[] {
  const header = splitRow(rows[0]!);
  const body = rows.slice(1).map(splitRow);
  const columns = header.length;

  const widths = header.map((cell, index) =>
    Math.max(
      visibleLength(cell),
      ...body.map((row) => visibleLength(row[index] ?? '')),
    ),
  );

  // Two spaces between columns.
  const gap = 2;
  const total = widths.reduce((sum, n) => sum + n, 0) + gap * (columns - 1);

  if (total > width) {
    const scale = (width - gap * (columns - 1)) / widths.reduce((sum, n) => sum + n, 0);
    for (let i = 0; i < widths.length; i++) {
      widths[i] = Math.max(4, Math.floor(widths[i]! * scale));
    }
  }

  const line = (cells: string[], style: (s: string) => string) =>
    cells
      .map((cell, index) => {
        const text = clipVisible(inline(cell), widths[index]!);
        const padding = ' '.repeat(Math.max(0, widths[index]! - visibleLength(text)));
        // No padding after the last column, or every row carries invisible trailing space.
        return index === columns - 1 ? style(text) : style(text) + padding;
      })
      .join(' '.repeat(gap));

  return [
    '',
    line(header, c.bold),
    c.dim('─'.repeat(Math.min(widths.reduce((s, n) => s + n, 0) + gap * (columns - 1), width))),
    ...body.map((row) => line(row, (s) => s)),
    '',
  ];
}

/* ──────────────────────────────── width ──────────────────────────────── */

/** Length as it appears, ignoring escape sequences. */
function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

/**
 * Wrap on word boundaries, measuring what is visible.
 *
 * Naive wrapping counts escape sequences as characters, so a line with two bold words
 * breaks eight characters early and the paragraph edge looks ragged for no visible reason.
 */
export function wrap(text: string, width: number): string[] {
  if (width < 8) return [text];

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (visibleLength(current) + 1 + visibleLength(word) <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Does this text look like markdown worth rendering, or is it plain output? */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /^\s*```/m.test(text) ||
    /^\s*\|.*\|\s*$/m.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text)
  );
}
