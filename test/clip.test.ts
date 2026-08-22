import { describe, expect, it } from 'vitest';

import { clipVisible } from '../src/cli/ui.js';

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('clipVisible', () => {
  it('leaves a short string untouched', () => {
    expect(clipVisible('abc', 40)).toBe('abc');
  });

  it('cuts a plain string to the visible width', () => {
    expect(clipVisible('abcdefghij', 4)).toBe('abcd');
  });

  it('counts visible characters, not escape sequences', () => {
    // The whole point: a coloured row is far longer than it looks, and measuring the
    // raw string would clip it to a fraction of the terminal width.
    const styled = '\u001b[36m>\u001b[39m \u001b[1mBrowser code\u001b[22m';
    expect(strip(clipVisible(styled, 6))).toBe('> Brow');
  });

  it('keeps the escape sequences it passes over', () => {
    const styled = '\u001b[36mhello world\u001b[39m';
    expect(clipVisible(styled, 5)).toContain('\u001b[36m');
  });

  it('closes styling at the cut so colour cannot leak onto the next row', () => {
    const styled = '\u001b[31mred text here\u001b[39m';
    expect(clipVisible(styled, 3).endsWith('\u001b[0m')).toBe(true);
  });

  it('adds no reset to a string that had no styling', () => {
    expect(clipVisible('plain text', 5)).toBe('plain');
  });

  it('handles a zero or negative width', () => {
    expect(clipVisible('abc', 0)).toBe('');
    expect(clipVisible('abc', -1)).toBe('');
  });

  it('never returns more visible characters than asked for', () => {
    // A row wider than the terminal wraps to two physical lines, which desyncs the
    // "move up N lines" redraw and makes arrow keys appear to append entries.
    const row = '\u001b[36m>\u001b[39m ' + 'x'.repeat(200);
    for (const width of [1, 10, 40, 79, 120]) {
      expect(strip(clipVisible(row, width)).length).toBeLessThanOrEqual(width);
    }
  });
});
