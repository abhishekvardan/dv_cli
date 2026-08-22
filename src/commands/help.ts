import { createRequire } from 'node:module';

import { c, out } from '../cli/ui.js';

/**
 * Read from package.json rather than duplicated here.
 *
 * A hardcoded constant drifts the moment the package version is bumped, and a CLI
 * that misreports its own version makes every bug report ambiguous — this one was
 * already claiming 0.1.0 from a 1.0.0 package.
 *
 * Same relative depth from `src/commands/` and `dist/commands/`, so it resolves in
 * development and from an installed package alike.
 */
const VERSION_FALLBACK = '0.0.0';
export const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require('../../package.json') as { version?: string }).version ?? VERSION_FALLBACK;
  } catch {
    return VERSION_FALLBACK;
  }
})();

const SECTIONS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: 'Workflows',
    rows: [
      ['dv ship', 'Test, build, push, PR, wait for CI, deploy, verify'],
      ['dv ship --dry-run', 'Show the steps without running them'],
      ['dv ship --skip-tests --no-pr', 'Turn individual steps off'],
    ],
  },
  {
    title: 'Setup',
    rows: [
      ['dv auth login <provider>', 'Sign in, however that service allows'],
      ['dv auth login <p> --method token', 'Pick a different way in'],
      ['dv auth token <provider>', 'Save a personal access token instead'],
      ['dv auth status', 'What is connected, and for how long'],
      ['dv auth accounts', 'Every account, per provider'],
      ['dv auth switch <p> <account>', 'Change the active account'],
      ['dv auth login <p>', 'Add an account - named after who it is'],
      ['dv auth scopes <provider>', 'What the grant actually permits'],
      ['dv config list', 'OAuth client ids, and the env vars for them'],
      ['dv config set github.clientId <id>', 'Point at your own OAuth app'],
    ],
  },
  {
    title: 'GitHub',
    rows: [
      ['dv gh repo list', 'Your repositories'],
      ['dv gh repo view <repo>', 'One repository in detail'],
      ['dv gh repo create <name>', 'New repository (private unless --public)'],
      ['dv gh repo edit <repo>', 'Change visibility, description, settings'],
      ['dv gh repo clone <repo>', 'Clone it'],
      ['dv gh file ls <repo> [path]', 'Browse files'],
      ['dv gh file read <repo> <path>', 'Print a file - pipe it anywhere'],
      ['dv gh file put <repo> <path> --file', 'Commit a file'],
      ['dv gh issue list <repo>', 'Issues, with --state and --label'],
      ['dv gh issue create <repo> --title', 'Open an issue'],
      ['dv gh pr list <repo>', 'Pull requests'],
      ['dv gh pr create <repo> --head --title', 'Open a pull request'],
      ['dv gh branch list <repo>', 'Branches'],
      ['dv gh branch create <repo> <name>', 'Create a branch'],
      ['dv gh commit list <repo>', 'Recent commits'],
      ['dv gh run list <repo>', 'Recent Actions runs'],
      ['dv gh workflow run <repo> -w <file>', 'Trigger a workflow'],
      ['dv gh search <query>', 'Search your code'],
    ],
  },
  {
    title: 'Gmail & Calendar',
    rows: [
      ['dv gmail search [query]', 'Search mail (defaults to the inbox)'],
      ['dv gmail read <id>', 'Read one message in full'],
      ['dv gmail send --to … --subject …', 'Send mail (asks first)'],
      ['dv cal events', 'What is coming up'],
      ['dv cal free', 'Gaps in your working hours'],
      ['dv cal add --title … --start …', 'Create an event (asks first)'],
    ],
  },
  {
    title: 'LinkedIn',
    rows: [
      ['dv li me', 'Your LinkedIn identity'],
      ['dv li post --text ...', 'Post to LinkedIn (asks first)'],
    ],
  },
  {
    title: 'Vercel',
    rows: [
      ['dv vercel link', 'Link this folder to a project (asks which)'],
      ['dv vercel project list', 'Your projects'],
      ['dv vercel project view <name>', 'One project in detail'],
      ['dv vercel project create <name>', 'New project, optionally --repo owner/name'],
      ['dv vercel deploy list [project]', 'Deployments and their state'],
      ['dv vercel deploy logs <id>', 'Build output - stderr in red'],
      ['dv vercel deploy redeploy <project>', 'Redeploy the latest (asks first)'],
      ['dv vercel deploy cancel <id>', 'Stop a running build'],
      ['dv vercel env list <project>', 'Env var keys and targets'],
      ['dv vercel env add <project> --key --value', 'Add an env var'],
      ['dv vercel domain list <project>', 'Custom domains'],
    ],
  },
  {
    title: 'Database (Supabase)',
    rows: [
      ['dv db projects', 'Your databases, across providers'],
      ['dv db project create <name>', 'New Supabase project (asks first)'],
      ['dv db use <ref>', 'Pick which one queries run against'],
      ['dv db tables', 'Tables, with sizes'],
      ['dv db describe <table>', 'Columns, types, defaults'],
      ['dv db query "select ..."', 'Run SQL (writes ask first)'],
    ],
  },
  {
    title: 'Any other service',
    rows: [
      ['dv connect <name>', 'Guided setup - asks for what it needs'],
      ['dv connect list', 'Every connector and how to connect it'],
      ['dv connect show <id>', 'Base URL, auth style, setup steps'],
      ['dv connect add <id> --api-base …', 'Define a connector of your own'],
      ['dv connect test <id>', 'Prove a credential works'],
      ['dv api <id> <path>', 'Authenticated request to any connector'],
    ],
  },
  {
    title: 'Everything else',
    rows: [
      ['dv status', 'One view of every connection'],
      ['dv --version', 'Version'],
    ],
  },
];

const FLAGS: Array<[string, string]> = [
  ['--json', 'Machine-readable output on stdout'],
  ['--limit <n>', 'How many results'],
  ['--as <account>', 'Use, or nickname, a specific account'],
  ['--yes, -y', 'Skip confirmations — for scripts'],
  ['--quiet, -q', 'Data only, no commentary'],
  ['--help, -h', 'This help, or help for a command'],
];

export function printHelp(): void {
  out(`${c.bold('dv')} ${c.dim(VERSION)} — one CLI for GitHub, Gmail, Calendar, LinkedIn and Vercel.`);
  out('');

  for (const section of SECTIONS) {
    out(c.bold(section.title));
    const width = Math.max(...section.rows.map(([cmd]) => cmd.length));
    for (const [cmd, description] of section.rows) {
      out(`  ${cmd.padEnd(width)}  ${c.dim(description)}`);
    }
    out('');
  }

  out(c.bold('Common flags'));
  const fw = Math.max(...FLAGS.map(([f]) => f.length));
  for (const [flag, description] of FLAGS) {
    out(`  ${flag.padEnd(fw)}  ${c.dim(description)}`);
  }
  out('');
  out(c.dim('Start with:  dv auth login github     ·  see them all:  dv connect list'));
  out(c.dim('Tokens live in ~/.dv/credentials.json, readable only by you.'));
}
