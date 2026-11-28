import { describe, expect, it } from 'vitest';

import { cmdQuote, registerScript } from '../src/cli/later.js';

describe('later', () => {
  it('quotes .cmd arguments, doubling quotes and percent signs', () => {
    expect(cmdQuote('C:/a b/x.txt')).toBe('"C:/a b/x.txt"');
    expect(cmdQuote('say "hi" 100%')).toBe('"say ""hi"" 100%%"');
  });

  it('registers a one-time task at the local wall-clock time, locale-independent', () => {
    const at = new Date(2026, 10, 29, 18, 0, 0);
    const ps = registerScript('l_x', at, 'C:/node.exe', "C:/Users/o'neil/dv/index.js", 'C:/w');
    expect(ps).toContain("[datetime]'2026-11-29T18:00:00'");
    expect(ps).toContain("-TaskName 'dv later l_x'");
    expect(ps).toContain("o''neil");
    expect(ps).toContain('-StartWhenAvailable');
    expect(ps).toContain('later run l_x');
    expect(ps).toContain('-LogonType S4U');
    expect(registerScript('l_x', at, 'n', 'e', 'w', false)).not.toContain('S4U');
  });
});
