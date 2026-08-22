/**
 * Asking the user things.
 *
 * Kept separate from `ui.ts` because these take over stdin and the cursor, which needs
 * careful teardown — a prompt that exits without restoring raw mode leaves the shell
 * unable to echo what you type, and one that exits without restoring the cursor leaves
 * it invisible.
 */

import { c, clipVisible, info, terminalWidth, warn } from './ui.js';
import { CliError, EXIT } from './errors.js';

/** Read a line from stdin. Used for confirmations, never for secrets. */
export async function prompt(question: string): Promise<string> {
  process.stderr.write(`${question} `);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(chunk.toString('utf8').trim());
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

/**
 * Confirm a destructive or outward-facing action.
 *
 * Returns true without asking when `--yes` was passed. A non-interactive run without
 * `--yes` is refused rather than assumed, because the caller cannot see the question.
 */
export async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return false;
  const answer = await prompt(`${question} ${c.dim('[y/N]')}`);
  return /^y(es)?$/i.test(answer);
}

export interface Choice<T> {
  value: T;
  label: string;
  /** One line on what this option means. */
  detail?: string;
  /** Starts highlighted, and is used when the user just presses Enter. */
  recommended?: boolean;
}

const ANSI = {
  up: (n: number) => `\u001b[${n}A`,
  clearLine: '\u001b[2K',
  hideCursor: '\u001b[?25l',
  showCursor: '\u001b[?25h',
};

/**
 * Keys, including both encodings terminals use for arrows.
 *
 * `\u001b[A` is the usual form; `\u001bOA` is what a terminal in application
 * mode sends, which some SSH sessions and older emulators switch on. Handling only the
 * first makes the arrow keys silently dead for those users.
 */
const KEY = {
  up: ['\u001b[A', '\u001bOA', 'k'],
  down: ['\u001b[B', '\u001bOB', 'j'],
  enter: ['\r', '\n'],
  cancel: ['\u0003', '\u001b'],
  home: ['\u001b[H', '\u001b[1~'],
  end: ['\u001b[F', '\u001b[4~'],
};

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
export async function select<T>(question: string, choices: Choice<T>[]): Promise<T> {
  if (choices.length === 0) throw new CliError('Nothing to choose from.');

  const recommended = choices.findIndex((ch) => ch.recommended);
  const defaultIndex = recommended === -1 ? 0 : recommended;

  if (choices.length === 1 || !process.stdin.isTTY) return choices[defaultIndex]!.value;

  const canDriveCursor =
    typeof process.stdin.setRawMode === 'function' && process.stderr.isTTY === true;

  return canDriveCursor
    ? selectWithArrows(question, choices, defaultIndex)
    : selectByNumber(question, choices, defaultIndex);
}

/** One rendered row of the menu. */
function row<T>(choice: Choice<T>, active: boolean, labelWidth: number): string {
  const pointer = active ? c.cyan('>') : ' ';
  const label = active ? c.cyan(c.bold(choice.label)) : choice.label;
  const pad = ' '.repeat(Math.max(0, labelWidth - choice.label.length));
  const detail = choice.detail ? `  ${c.dim(choice.detail)}` : '';
  const note = choice.recommended ? c.dim('  (recommended)') : '';
  return `  ${pointer} ${label}${pad}${detail}${note}`;
}

async function selectWithArrows<T>(
  question: string,
  choices: Choice<T>[],
  defaultIndex: number,
): Promise<T> {
  const stdin = process.stdin;
  const err = process.stderr;
  const labelWidth = Math.max(...choices.map((ch) => ch.label.length));
  let index = defaultIndex;

  info('');
  info(c.bold(question));
  info(c.dim('  up/down to move, Enter to select, Ctrl-C to cancel'));
  info('');

  /**
   * Paint the list, leaving the cursor on the LAST row.
   *
   * Deliberately no trailing newline. Writing one while the cursor sits on the
   * terminal's bottom line makes the terminal scroll: the content shifts up, so the
   * following "up N lines" lands one row too low and the next paint appends instead
   * of replacing. That is the duplication — it only shows up once the list reaches
   * the bottom of the window, which is why it looked intermittent.
   *
   * Ending on the last row means the redraw moves up N-1, and no newline is ever
   * written past the final line.
   */
  const draw = (first: boolean) => {
    if (!first && choices.length > 1) err.write(ANSI.up(choices.length - 1));
    choices.forEach((choice, i) => {
      const text = clipVisible(row(choice, i === index, labelWidth), terminalWidth() - 1);
      err.write(`\r${ANSI.clearLine}${text}`);
      if (i < choices.length - 1) err.write('\n');
    });
  };

  /** Blank the list and put the cursor back on its first row. */
  const erase = () => {
    if (choices.length > 1) err.write(ANSI.up(choices.length - 1));
    choices.forEach((_, i) => {
      err.write(`\r${ANSI.clearLine}`);
      if (i < choices.length - 1) err.write('\n');
    });
    if (choices.length > 1) err.write(ANSI.up(choices.length - 1));
    err.write('\r');
  };

  /**
   * Split a chunk into individual keys.
   *
   * A held or quickly repeated arrow arrives as several sequences in one chunk, and
   * comparing the chunk as a whole matches none of them, so the press is silently
   * dropped. This also tells a lone ESC apart from the start of a sequence.
   */
  const parseKeys = (chunk: string): string[] => {
    const keys: string[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (chunk[i] === '\u001b') {
        const seq = /^\u001b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(chunk.slice(i));
        if (seq) {
          keys.push(seq[0]);
          i += seq[0].length;
          continue;
        }
      }
      keys.push(chunk[i]!);
      i++;
    }
    return keys;
  };


  const wasRaw = stdin.isRaw;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      err.write(ANSI.showCursor);
    };

    /**
     * Replace the menu with one line recording the answer.
     *
     * Leaving the full list behind turns a multi-step setup into a wall of stale
     * menus; a single line keeps the transcript readable.
     */
    const finish = (chosen: Choice<T>) => {
      erase();
      err.write(`${ANSI.clearLine}\r  ${c.green('ok')} ${c.bold(chosen.label)}\n`);
      cleanup();
      resolve(chosen.value);
    };

    /** Act on one key. Returns true once the menu is finished with. */
    const handle = (key: string): boolean => {
      if (KEY.enter.includes(key)) {
        finish(choices[index]!);
        return true;
      }

      if (KEY.cancel.includes(key)) {
        erase();
        cleanup();
        reject(new CliError('Cancelled.', EXIT.usage));
        return true;
      }

      // Wrapping means you never have to change direction to reach the far end.
      if (KEY.up.includes(key)) {
        index = (index - 1 + choices.length) % choices.length;
        draw(false);
        return false;
      }
      if (KEY.down.includes(key)) {
        index = (index + 1) % choices.length;
        draw(false);
        return false;
      }
      if (KEY.home.includes(key)) {
        index = 0;
        draw(false);
        return false;
      }
      if (KEY.end.includes(key)) {
        index = choices.length - 1;
        draw(false);
        return false;
      }

      // Digits still work, so muscle memory from a numbered menu is not punished.
      if (/^[1-9]$/.test(key)) {
        const n = Number(key) - 1;
        if (n < choices.length) {
          index = n;
          finish(choices[index]!);
          return true;
        }
      }
      return false;
    };

    // One chunk can carry several keys when an arrow is held or pressed quickly.
    const onData = (chunk: Buffer) => {
      for (const key of parseKeys(chunk.toString('utf8'))) {
        if (handle(key)) return;
      }
    };

    err.write(ANSI.hideCursor);
    draw(true);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Plain numbered list, for terminals whose cursor cannot be driven. */
async function selectByNumber<T>(
  question: string,
  choices: Choice<T>[],
  defaultIndex: number,
): Promise<T> {
  info('');
  info(c.bold(question));
  info('');

  const labelWidth = Math.max(...choices.map((ch) => ch.label.length));
  choices.forEach((choice, i) => {
    const marker = i === defaultIndex ? c.green('>') : ' ';
    const pad = ' '.repeat(Math.max(0, labelWidth - choice.label.length));
    const detail = choice.detail ? `  ${c.dim(choice.detail)}` : '';
    const note = choice.recommended ? c.dim('  (recommended)') : '';
    info(`  ${marker} ${c.cyan(String(i + 1))}. ${choice.label}${pad}${detail}${note}`);
  });
  info('');

  for (;;) {
    const answer = await prompt(
      `Choose ${c.dim(`[1-${choices.length}, Enter for ${defaultIndex + 1}]`)}`,
    );
    if (answer === '') return choices[defaultIndex]!.value;

    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;

    // Someone who types "token" means the option labelled "token".
    const byLabel = choices.find((ch) => ch.label.toLowerCase() === answer.toLowerCase());
    if (byLabel) return byLabel.value;

    warn(`Pick a number between 1 and ${choices.length}.`);
  }
}

/**
 * Read a secret without echoing it.
 *
 * A pasted token that appears on screen ends up in scrollback, in screen shares and
 * in terminal recordings. Raw mode is restored on every exit path, Ctrl-C included,
 * so a cancelled prompt cannot leave the terminal unable to echo.
 */
export async function promptSecret(question: string): Promise<string> {
  const stdin = process.stdin;

  // No TTY means input is piped, where nothing is echoed anyway.
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return prompt(question);

  process.stderr.write(`${question} `);
  const wasRaw = stdin.isRaw;

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        // Enter finishes the entry.
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        // Ctrl-C. Raw mode swallows the signal, so it is handled here or not at all.
        if (ch === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new CliError('Cancelled.', EXIT.usage));
          return;
        }
        // Backspace and delete.
        if (ch === '\u0008' || ch === '\u007f') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        // Ignore any other control character rather than storing it in a secret.
        if (ch >= ' ') {
          value += ch;
          process.stderr.write('*');
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Ask for a value, with an optional default shown in the prompt. */
export async function ask(question: string, fallback?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (fallback !== undefined) return fallback;
    throw new CliError(`${question} — and there is no terminal to ask on.`, EXIT.usage);
  }
  const answer = await prompt(fallback ? `${question} ${c.dim(`[${fallback}]`)}` : question);
  return answer || fallback || '';
}
