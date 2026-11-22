/**
 * `dv skill install`
 *
 * SKILL.md ships inside the package, so a coding assistant does not need to fetch
 * anything to learn how to drive this CLI properly — the file is already on disk next to
 * the code. This copies it where Claude Code looks for skills.
 *
 * Worth doing rather than leaving to a documented `curl`: an assistant that has not read
 * the skill uses `dv` as a thin wrapper around provider APIs and misses the parts that
 * matter — the exit-code contract, that exit 6 is not success, `--json` for parsing, and
 * that a policy rule is not something to work around.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bool, str, type ParsedArgs } from '../cli/args.js';
import { CliError, EXIT, UsageError } from '../cli/errors.js';
import { c, confirm, info, out, success } from '../cli/ui.js';

/**
 * Find SKILL.md inside the installed package.
 *
 * `dist/` sits one level below the package root when installed, but running from source
 * puts the compiled entry somewhere else again, so both are tried rather than assuming a
 * layout that only holds in one of them.
 */
export function bundledSkill(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'SKILL.md'), // dist/commands -> package root
    join(here, '..', '..', '..', 'SKILL.md'), // src/commands -> package root
  ];

  try {
    // The authoritative answer when the package is installed normally.
    const require = createRequire(import.meta.url);
    candidates.unshift(join(dirname(require.resolve('../../package.json')), 'SKILL.md'));
  } catch {
    // Not resolvable when running from a build output that omits package.json.
  }

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new CliError(
      'Could not find SKILL.md inside the installed package.',
      EXIT.failure,
      'Reinstall with: npm install -g @abhishekvardanbotta/dv',
    );
  }
  return found;
}

/** Where Claude Code looks for skills. */
function skillTarget(): string {
  return join(homedir(), '.claude', 'skills', 'dv', 'SKILL.md');
}

export async function skillCommand(args: ParsedArgs): Promise<void> {
  const verb = args.command[1] ?? 'install';

  switch (verb) {
    case 'install': {
      const source = bundledSkill();
      const target = str(args.flags, 'to') ?? skillTarget();

      if (existsSync(target)) {
        // Overwriting is the normal case on upgrade, but it is still someone's file and
        // they may have edited it.
        const ok = await confirm(`Replace the skill at ${target}?`, bool(args.flags, 'yes', 'y'));
        if (!ok) return info('Left as it was.');
      }

      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);

      success(`Installed the dv skill.`);
      info(c.dim(`  ${target}`));
      out('');
      info('Start a new session for a coding assistant to pick it up.');
      return;
    }

    case 'path':
      out(bundledSkill());
      return;

    case 'show':
      out(readFileSync(bundledSkill(), 'utf8'));
      return;

    default:
      throw new UsageError(
        `Unknown skill command "${verb}".`,
        'dv skill install | path | show',
      );
  }
}
