/**
 * Argument parsing.
 *
 * Hand-written rather than pulled from a dependency: the CLI has no runtime deps at
 * all, which means `npm i -g` cannot fail on a transitive install and there is no
 * supply-chain surface for a tool that holds OAuth tokens.
 */

import { UsageError } from './errors.js';

export interface ParsedArgs {
  /** Positional words before any flag, e.g. ["gh", "repos"]. */
  command: string[];
  /** Positional words after the command path is consumed. */
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/**
 * The argv this process was given, before parsing.
 *
 * `dv policy test db query --file x.sql` has a problem no parsed form can solve: by the
 * time `policy` sees its arguments, `--file` has been lifted out and the command being
 * asked about no longer exists as it was typed. Keeping the raw words lets that command
 * be re-parsed by the same function that parsed the outer one, which is the only way the
 * test can be asking about the same thing the enforcement path would see.
 */
let rawArgvValue: string[] = [];

export function setRawArgv(argv: string[]): void {
  rawArgvValue = [...argv];
}

export function rawArgv(): string[] {
  return rawArgvValue;
}

/**
 * Parse argv.
 *
 * Supports `--flag`, `--flag=value`, `--flag value`, `--no-flag`, short `-x`, and
 * `--` to stop parsing. A repeated flag collects into an array so `--label a
 * --label b` works without special-casing at each call site.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const rest: string[] = [];
  let sawFlag = false;
  let passthrough = false;

  const setFlag = (key: string, value: string | boolean) => {
    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      flags[key] = [String(existing), String(value)];
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (passthrough) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      continue;
    }

    if (arg.startsWith('--')) {
      sawFlag = true;
      const body = arg.slice(2);
      if (!body) throw new UsageError('Found a bare "--"-style flag with no name.');

      const eq = body.indexOf('=');
      if (eq !== -1) {
        setFlag(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith('no-')) {
        setFlag(body.slice(3), false);
        continue;
      }
      // A following token is this flag's value unless it is itself a flag.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        setFlag(body, next);
        i++;
      } else {
        setFlag(body, true);
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      sawFlag = true;
      const body = arg.slice(1);
      // Short flags take a value only when given alone: -n 5.
      if (body.length === 1) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          setFlag(body, next);
          i++;
        } else {
          setFlag(body, true);
        }
      } else {
        // -abc is three booleans, the conventional reading.
        for (const ch of body) setFlag(ch, true);
      }
      continue;
    }

    // Positional. Once a flag has been seen, later positionals are arguments to the
    // command rather than part of the command path.
    if (sawFlag) rest.push(arg);
    else command.push(arg);
  }

  return { command, positional: rest, flags };
}

/** A flag's string value, or undefined. Arrays collapse to the last value. */
export function str(flags: ParsedArgs['flags'], ...names: string[]): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (value === undefined) continue;
    if (Array.isArray(value)) return value[value.length - 1];
    if (typeof value === 'string') return value;
    // A boolean true means the flag was given with no value, which for a
    // value-taking flag is a mistake worth reporting rather than coercing.
    if (value === true) throw new UsageError(`--${name} needs a value.`);
  }
  return undefined;
}

/** A flag's value, or fail. */
export function require(flags: ParsedArgs['flags'], name: string, hint?: string): string {
  const value = str(flags, name);
  if (value === undefined || value === '') {
    throw new UsageError(`--${name} is required.`, hint);
  }
  return value;
}

export function bool(flags: ParsedArgs['flags'], ...names: string[]): boolean {
  for (const name of names) {
    const value = flags[name];
    if (value === undefined) continue;
    if (typeof value === 'boolean') return value;
    // --json=false should mean false, not "a non-empty string is truthy".
    if (typeof value === 'string') return value !== 'false' && value !== '0' && value !== 'no';
  }
  return false;
}

export function num(flags: ParsedArgs['flags'], name: string, fallback: number): number {
  const value = str(flags, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number, got "${value}".`);
  return parsed;
}

/** All flag names that are not in the allowed set — catches typos like --limmit. */
export function unknownFlags(flags: ParsedArgs['flags'], allowed: string[]): string[] {
  const ok = new Set([...allowed, 'help', 'h', 'json', 'quiet', 'q', 'verbose']);
  return Object.keys(flags).filter((f) => !ok.has(f));
}

/**
 * Undo Git Bash's POSIX-path conversion.
 *
 * MSYS rewrites any argument that looks like an absolute POSIX path into a Windows
 * one *before the program sees it*, so on Git Bash `dv api github /user` arrives as
 * `C:/Program Files/Git/user`. Nothing in the process can tell that happened by
 * looking at the string alone, and the result is a request against a nonsense path
 * that 404s for no visible reason.
 *
 * The install root is derived from `EXEPATH`, which Git Bash sets to `<root>\bin`,
 * so this is an exact match rather than a guess. Applied only to URL-path arguments —
 * never to file paths, where a real Windows path is what the user means.
 */
export function unmanglePath(value: string): string {
  if (process.platform !== 'win32' || !process.env.MSYSTEM) return value;

  const exePath = process.env.EXEPATH;
  if (!exePath) return value;

  const root = exePath
    .replace(/[\\/]bin[\\/]?$/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!root) return value;

  const normalized = value.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const rootLower = root.toLowerCase();

  if (lower.startsWith(`${rootLower}/`)) return normalized.slice(root.length);
  // A bare "/" becomes the root itself, with nothing after it.
  if (lower === rootLower) return '/';
  return value;
}

/**
 * Whether a `--no-x` style flag was given.
 *
 * The parser normalises `--no-push` into `push: false`, so asking for a flag literally
 * named "no-push" always answers false and the negation is silently ignored. Both
 * spellings are accepted here because both are natural to type.
 */
export function negated(flags: ParsedArgs['flags'], name: string): boolean {
  if (flags[name] === false) return true;
  const explicit = flags[`no-${name}`];
  return explicit === true || explicit === 'true';
}
