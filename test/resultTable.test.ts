import { afterEach, describe, expect, it } from 'vitest';

import { printResult, renderValue } from '../src/cli/resultTable.js';

const lines: string[] = [];
const realWrite = process.stdout.write;

function capture(columns = 100) {
  lines.length = 0;
  process.stdout.write = ((chunk: any) => {
    lines.push(String(chunk));
    return true;
  }) as any;
  Object.defineProperty(process, 'stderr', {
    value: { write: () => true, isTTY: true, columns },
    configurable: true,
  });
}
const text = () => lines.join('').replace(/\u001b\[[0-9;]*m/g, '');

afterEach(() => {
  process.stdout.write = realWrite;
});

describe('renderValue', () => {
  it('distinguishes null from an empty string', () => {
    // An empty cell for null is indistinguishable from '', and in a database those
    // are very different things.
    expect(renderValue(null).replace(/\u001b\[[0-9;]*m/g, '')).toBe('null');
    expect(renderValue('')).toBe('');
  });

  it('serialises objects rather than printing [object Object]', () => {
    expect(renderValue({ a: 1 })).toBe('{"a":1}');
    expect(renderValue(['x'])).toBe('["x"]');
  });

  it('flattens newlines so one cell cannot break every row below it', () => {
    expect(renderValue('a\nb')).toBe('a b');
  });

  it('renders booleans and numbers plainly', () => {
    expect(renderValue(true)).toBe('true');
    expect(renderValue(0)).toBe('0');
  });
});

describe('printResult', () => {
  it('draws a bordered grid when the rows fit', () => {
    capture(100);
    const layout = printResult([{ title: 'a', done: true }], {});
    expect(layout).toBe('grid');
    expect(text()).toContain('┌');
    expect(text()).toContain('│');
    expect(text()).toContain('title');
  });

  it('shrinks long columns instead of abandoning the grid', () => {
    capture(60);
    const wide = {
      id: 'fff84ac8-24ba-4a35-a2f2-eaf423e3dee1',
      client_id: '45d00388-f9cc-48f4-92d8-3cd6380be4f5',
      status: 'confirmed',
    };
    // A truncated UUID is still recognisable, and a grid you can scan beats a wall
    // of one-field-per-line blocks.
    expect(printResult([wide], {})).toBe('grid');
    const output = text();
    expect(output).toContain('┌');
    expect(output).toContain('…');
    // A short column is left alone; only the widest are shrunk.
    expect(output).toContain('confirmed');
  });

  it('keeps every row inside the terminal width', () => {
    capture(60);
    printResult(
      [{ id: 'f'.repeat(36), client_id: '4'.repeat(36), note: 'x'.repeat(80) }],
      {},
    );
    for (const line of text().split('\n')) {
      expect(line.length, line).toBeLessThanOrEqual(60);
    }
  });

  it('drops columns that cannot fit and names them', () => {
    capture(50);
    const row: Record<string, string> = {};
    for (let i = 0; i < 20; i++) row[`col_${i}`] = `value_${i}`;
    // Twenty columns cannot fit fifty characters at any width. Showing the leading
    // ones and naming the rest beats silently hiding them or wrapping into mush.
    expect(printResult([row], {})).toBe('grid');
    expect(text()).toMatch(/more columns not shown/);
    expect(text()).toContain('col_19');
  });

  it('does not truncate when everything already fits', () => {
    capture(120);
    printResult([{ title: 'Tender for bananas', status: 'confirmed' }], {});
    expect(text()).toContain('Tender for bananas');
    expect(text()).not.toContain('…');
  });

  it('honours an explicit request for expanded', () => {
    capture(200);
    expect(printResult([{ a: 1 }], { expanded: true })).toBe('expanded');
  });

  it('does not truncate values in expanded mode', () => {
    capture(100);
    const uuid = 'fff84ac8-24ba-4a35-a2f2-eaf423e3dee1';
    printResult([{ id: uuid }], { expanded: true });
    // A truncated UUID is useless, and expanded mode exists to have room for it.
    expect(text()).toContain(uuid);
  });

  it('reports empty results as empty', () => {
    capture();
    expect(printResult([], {})).toBe('empty');
    expect(printResult([{}], {})).toBe('empty');
  });

  it('respects the row limit', () => {
    capture(100);
    printResult([{ a: 1 }, { a: 2 }, { a: 3 }], { limit: 2 });
    expect(text()).toContain('1');
    expect(text()).toContain('2');
    expect(text()).not.toContain('3');
  });

  it('handles rows with differing keys', () => {
    capture(100);
    printResult([{ a: 1 }, { b: 2 }], {});
    const output = text();
    expect(output).toContain('a');
    expect(output).toContain('b');
    // The missing value shows as null rather than silently blank.
    expect(output).toContain('null');
  });

  it('can be forced to plain, for pasting elsewhere', () => {
    capture(100);
    printResult([{ title: 'a' }], { plain: true });
    expect(text()).not.toContain('┌');
    expect(text()).toContain('TITLE');
  });
});
