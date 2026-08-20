import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { select, promptSecret, confirm } from '../src/cli/interactive.js';

const realStdin = process.stdin;
const realStderr = process.stderr;

/** A stand-in stdin that behaves like a terminal and replays scripted keystrokes. */
function fakeTty(inputs: string[], { raw = false } = {}) {
  const stdin = new EventEmitter() as any;
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = vi.fn((v: boolean) => {
    stdin.isRaw = v;
    return stdin;
  });
  stdin.resume = vi.fn();
  stdin.pause = vi.fn();
  stdin.setEncoding = vi.fn();
  stdin.off = stdin.removeListener.bind(stdin);

  /**
   * Replay the scripted keystrokes.
   *
   * `prompt` attaches a fresh `once` listener per line, while the arrow-key menu
   * attaches `on` once and reads many keys — so delivery has to keep going after the
   * first, or the arrow tests hang forever waiting for a second press.
   */
  let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    const next = () => {
      const value = inputs.shift();
      if (value === undefined) {
        pumping = false;
        return;
      }
      setTimeout(() => {
        stdin.emit('data', Buffer.from(value, 'utf8'));
        next();
      }, 1);
    };
    next();
  };

  const originalOn = stdin.on.bind(stdin);
  const originalOnce = stdin.once.bind(stdin);
  stdin.on = (event: string, fn: any) => {
    const r = originalOn(event, fn);
    if (event === 'data') pump();
    return r;
  };
  stdin.once = (event: string, fn: any) => {
    const r = originalOnce(event, fn);
    if (event === 'data') pump();
    return r;
  };

  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  return stdin;
}

/**
 * Swap out stderr entirely.
 *
 * Not just `process.stderr.write`: vitest wraps stderr and its `isTTY` cannot be
 * redefined, so the menu would quietly take the numbered path and the arrow tests
 * would hang waiting for a line that never arrives. Replacing the whole object is
 * the only way to control both halves.
 */
function captureStderr({ tty = false } = {}) {
  const written: string[] = [];
  const fake = {
    write: (chunk: any) => {
      written.push(String(chunk));
      return true;
    },
    isTTY: tty,
  };
  Object.defineProperty(process, 'stderr', { value: fake, configurable: true });
  return written;
}

function noTty() {
  Object.defineProperty(process, 'stdin', { value: { isTTY: false }, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
  Object.defineProperty(process, 'stderr', { value: realStderr, configurable: true });
});

const METHODS = [
  { value: 'device', label: 'Browser code', detail: 'Shows a code to paste', recommended: true },
  { value: 'token', label: 'Paste a token', detail: 'A personal access token' },
  { value: 'loopback', label: 'Browser sign-in', detail: 'Listens on 127.0.0.1' },
];

describe('select', () => {
  it('returns the option the user picks by number', async () => {
    fakeTty(['2\n']);
    captureStderr();
    expect(await select('How?', METHODS)).toBe('token');
  });

  it('takes the recommended option when the user just presses Enter', async () => {
    fakeTty(['\n']);
    captureStderr();
    expect(await select('How?', METHODS)).toBe('device');
  });

  it('accepts the label as well as the number', async () => {
    fakeTty(['Browser sign-in\n']);
    captureStderr();
    expect(await select('How?', METHODS)).toBe('loopback');
  });

  it('re-asks on a number out of range rather than guessing', async () => {
    fakeTty(['9\n', '1\n']);
    const written = captureStderr();
    expect(await select('How?', METHODS)).toBe('device');
    expect(written.join('')).toMatch(/Pick a number between 1 and 3/);
  });

  it('shows every option with its explanation', async () => {
    fakeTty(['\n']);
    const written = captureStderr();
    await select('How would you like to connect?', METHODS);
    const screen = written.join('');
    for (const m of METHODS) {
      expect(screen).toContain(m.label);
      expect(screen).toContain(m.detail);
    }
    expect(screen).toContain('recommended');
  });

  it('does not ask when there is only one way in', async () => {
    // Asking a question with a single answer is just an extra keystroke.
    noTty();
    expect(await select('How?', [{ value: 'only', label: 'Only' }])).toBe('only');
  });

  it('falls back to the recommended option with no terminal', async () => {
    // A script cannot answer, and failing here would break every non-interactive
    // run that previously needed no flag.
    noTty();
    expect(await select('How?', METHODS)).toBe('device');
  });
});

describe('promptSecret', () => {
  it('returns what was typed', async () => {
    fakeTty(['ghp_secret\n']);
    captureStderr();
    expect(await promptSecret('Token:')).toBe('ghp_secret');
  });

  it('never echoes the secret itself', async () => {
    fakeTty(['ghp_secret\n']);
    const written = captureStderr();
    await promptSecret('Token:');
    const screen = written.join('');
    // Scrollback, screen shares and terminal recordings all capture stderr.
    expect(screen).not.toContain('ghp_secret');
    expect(screen).toContain('*');
  });

  it('handles backspace', async () => {
    fakeTty(['ab\u007fc\n']);
    captureStderr();
    expect(await promptSecret('Token:')).toBe('ac');
  });

  it('ignores stray control characters', async () => {
    fakeTty(['a\u0001b\u001bc\n']);
    captureStderr();
    expect(await promptSecret('Token:')).toBe('abc');
  });

  it('restores raw mode after finishing', async () => {
    const stdin = fakeTty(['x\n']);
    captureStderr();
    await promptSecret('Token:');
    // Leaving raw mode on would stop the shell echoing anything the user types next.
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('restores raw mode when cancelled with Ctrl-C', async () => {
    const stdin = fakeTty(['\u0003']);
    captureStderr();
    await expect(promptSecret('Token:')).rejects.toThrow(/Cancelled/);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('accepts CR as well as LF', async () => {
    fakeTty(['secret\r']);
    captureStderr();
    expect(await promptSecret('Token:')).toBe('secret');
  });
});

describe('confirm', () => {
  it('does not ask when --yes was given', async () => {
    noTty();
    expect(await confirm('Delete it?', true)).toBe(true);
  });

  it('refuses rather than assuming yes with no terminal', async () => {
    // The caller cannot see the question, so assuming consent would be wrong.
    noTty();
    expect(await confirm('Delete it?', false)).toBe(false);
  });

  it('accepts y and rejects anything else', async () => {
    fakeTty(['y\n']);
    captureStderr();
    expect(await confirm('Delete it?', false)).toBe(true);

    fakeTty(['\n']);
    captureStderr();
    expect(await confirm('Delete it?', false)).toBe(false);
  });
});

describe('select with arrow keys', () => {
  const ARROW_DOWN = '\u001b[B';
  const ARROW_UP = '\u001b[A';
  const ENTER = '\r';

  it('moves down and selects', async () => {
    fakeTty([ARROW_DOWN, ENTER]);
    captureStderr({ tty: true });
    expect(await select('How?', METHODS)).toBe('token');
  });

  it('moves up, wrapping past the top', async () => {
    // Wrapping means the last item is one keypress away, not three.
    fakeTty([ARROW_UP, ENTER]);
    captureStderr({ tty: true });
    expect(await select('How?', METHODS)).toBe('loopback');
  });

  it('wraps past the bottom too', async () => {
    fakeTty([ARROW_DOWN, ARROW_DOWN, ARROW_DOWN, ENTER]);
    captureStderr({ tty: true });
    expect(await select('How?', METHODS)).toBe('device');
  });

  it('accepts application-cursor-mode arrows', async () => {
    // Some SSH sessions send ESC O A instead of ESC [ A. Handling only one form
    // makes the arrow keys silently dead for those users.
    fakeTty(['\u001bOB', ENTER]);
    captureStderr({ tty: true });
    expect(await select('How?', METHODS)).toBe('token');
  });

  it('accepts j and k', async () => {
    fakeTty(['j', ENTER]);
    captureStderr({ tty: true });
    expect(await select('How?', METHODS)).toBe('token');
  });

  it('still accepts a digit, so old muscle memory works', async () => {
    fakeTty(['3']);
    captureStderr({ tty: true });
    expect(await select('How?', METHODS)).toBe('loopback');
  });

  it('starts on the recommended option', async () => {
    fakeTty([ENTER]);
    captureStderr({ tty: true });
    expect(await select('How?', METHODS)).toBe('device');
  });

  it('hides the cursor and puts it back', async () => {
    fakeTty([ENTER]);
    const written = captureStderr({ tty: true });
    await select('How?', METHODS);
    const screen = written.join('');
    expect(screen).toContain('\u001b[?25l');
    // A prompt that exits without this leaves the cursor invisible in the shell.
    expect(screen).toContain('\u001b[?25h');
  });

  it('restores raw mode when cancelled', async () => {
    const stdin = fakeTty(['\u0003']);
    captureStderr({ tty: true });
    await expect(select('How?', METHODS)).rejects.toThrow(/Cancelled/);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('falls back to the numbered list when stderr cannot be driven', async () => {
    // Redirected stderr and CI logs cannot take cursor movement; a repainting menu
    // would render as garbage there.
    fakeTty(['2\n']);
    const written = captureStderr({ tty: false });
    expect(await select('How?', METHODS)).toBe('token');
    expect(written.join('')).toMatch(/Choose/);
  });
});
