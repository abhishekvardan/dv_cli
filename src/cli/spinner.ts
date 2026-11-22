/**
 * One line that updates in place, then gets out of the way.
 *
 * Progress on a terminal is a *state*, not a log. Printing "checking GitHub" then
 * "comparing repositories" as separate lines leaves the reader scrolling past a history
 * of things that already finished, and the one line that matters — the answer — arrives
 * at the bottom of a transcript nobody asked for.
 *
 * So this owns a single line: it redraws that line as the work moves on, and erases it
 * entirely when the work is done. What remains on screen afterwards is the result and
 * nothing else.
 */

import { isQuiet } from './ui.js';

/**
 * The pulse.
 *
 * Three bars rising and falling out of phase, like a level meter. Chosen over the usual
 * rotating glyph for two reasons: a rotation looks the same in every tool that has ever
 * shipped one, and a wave reads as *work happening* rather than as a clock ticking —
 * which is the honest impression, because dv really is doing several things at once.
 *
 * Eight heights and three bars, each a step behind the last, so the wave travels left to
 * right and loops seamlessly.
 */
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const BAR_COUNT = 3;
const INTERVAL_MS = 90;

/**
 * Blue to green, the two colours dv already means something by.
 *
 * Blue is action and green is healthy, everywhere else in the product. Running the pulse
 * between them says "working towards a good answer" without needing a legend, and it ties
 * the terminal to the app rather than picking a third colour for the sake of it.
 */
const GRADIENT: Array<[number, number, number]> = [
  [37, 99, 235],
  [56, 132, 222],
  [56, 189, 208],
  [45, 212, 160],
  [34, 197, 94],
];

const ESC = '\u001b';
const CLEAR_LINE = `\r${ESC}[2K`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

/**
 * What the terminal can actually show.
 *
 * Three tiers rather than two, because 256-colour terminals are still common enough that
 * falling straight from truecolour to no colour would leave a lot of people with a grey
 * spinner for no reason.
 */
function colourDepth(): 'truecolor' | 'ansi256' | 'none' {
  if (process.env.NO_COLOR) return 'none';
  if (!process.stderr.isTTY) return 'none';

  const term = process.env.COLORTERM ?? '';
  if (term === 'truecolor' || term === '24bit') return 'truecolor';
  if (/-256(color)?$/.test(process.env.TERM ?? '')) return 'ansi256';
  // Windows Terminal and modern PowerShell handle truecolour without advertising it.
  if (process.platform === 'win32' && process.env.WT_SESSION) return 'truecolor';
  return 'ansi256';
}

/** Paint one bar, at whatever depth this terminal supports. */
function paint(text: string, position: number, depth: ReturnType<typeof colourDepth>): string {
  if (depth === 'none') return text;

  const [r, g, b] = GRADIENT[position % GRADIENT.length]!;
  if (depth === 'truecolor') return `${ESC}[38;2;${r};${g};${b}m${text}${ESC}[39m`;

  // The nearest cube colour. Approximate by design — a spinner does not need to be exact,
  // and computing a true nearest match per frame would cost more than it shows.
  const cube = 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
  return `${ESC}[38;5;${cube}m${text}${ESC}[39m`;
}

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = '';
  private cleanup: (() => void) | null = null;

  /**
   * Whether to animate at all.
   *
   * Not a TTY means the output is being piped or captured, where escape codes become
   * literal rubbish in a file. Quiet mode means the caller asked for silence, and a
   * spinner is exactly the sort of noise they meant.
   */
  private get active(): boolean {
    return Boolean(process.stderr.isTTY) && !isQuiet();
  }

  start(label: string): void {
    this.label = label;
    if (!this.active || this.timer) return;

    process.stderr.write(HIDE_CURSOR);

    // Restored on the way out however the process ends. A cursor left hidden persists in
    // the user's shell long after this command is gone, which is a genuinely annoying
    // thing to inflict.
    this.cleanup = () => this.stop();
    process.once('exit', this.cleanup);
    process.once('SIGINT', this.cleanup);

    this.draw();
    this.timer = setInterval(() => {
      // Unbounded modulo of the wave period, so the colour cycle and the height cycle
      // drift against each other instead of locking into one short repeat.
      this.frame = (this.frame + 1) % (BARS.length * 2 - 2) || 0;
      this.draw();
    }, INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Change what it says without starting a new line. */
  update(label: string): void {
    this.label = label;
    if (this.active && this.timer) this.draw();
  }

  /** Erase the line completely. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cleanup) {
      process.removeListener('exit', this.cleanup);
      process.removeListener('SIGINT', this.cleanup);
      this.cleanup = null;
    }
    if (process.stderr.isTTY) process.stderr.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
  }

  private draw(): void {
    const depth = colourDepth();

    // Each bar sits a step behind the one before it, so the peak travels rather than the
    // three of them bouncing together.
    let pulse = '';
    for (let i = 0; i < BAR_COUNT; i++) {
      const phase = (this.frame + i * 2) % (BARS.length * 2 - 2);
      // Triangle wave: up through the heights, then back down, with no repeated frame at
      // either end — a plain modulo snaps from full height to empty and looks like a
      // dropped frame.
      const height = phase < BARS.length ? phase : BARS.length * 2 - 2 - phase;
      pulse += paint(BARS[height]!, this.frame + i, depth);
    }

    // Written to stderr so that piping a command's real output to a file never picks up
    // animation frames.
    process.stderr.write(`${CLEAR_LINE}  ${pulse} ${this.label}`);
  }
}

/**
 * Run something with a spinner, whatever happens.
 *
 * The `finally` matters more than it looks: a thrown error with a spinner still running
 * leaves the interval alive and the cursor hidden, so the error message prints into a
 * line that is being overwritten four times a second.
 */
export async function withSpinner<T>(
  label: string,
  work: (spinner: Spinner) => Promise<T>,
): Promise<T> {
  const spinner = new Spinner();
  spinner.start(label);
  try {
    return await work(spinner);
  } finally {
    spinner.stop();
  }
}
