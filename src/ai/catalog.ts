/**
 * What a question is allowed to turn into.
 *
 * The model does not write commands. It **picks one from this list** and fills in named
 * arguments, and anything it returns that is not in the list is rejected before it can
 * run. That is the whole safety design, and it is deliberate rather than cautious:
 *
 *  - A model that composes free-form shell reaches `dv db query "drop table users"` on a
 *    bad day, and the day it does is the day you were not watching.
 *  - Picking from a fixed list is also a much easier task than composing a command, which
 *    matters a great deal when the model doing the picking has three billion parameters.
 *
 * Every entry is a **read** unless `mutates` says otherwise, and mutating entries are
 * withheld unless the caller explicitly allows them. Read-only is the default because the
 * overwhelming majority of "what happened to X" questions never need to change anything.
 */

export interface AiParam {
  name: string;
  /** What to put in it, in the model's terms. */
  describe: string;
  required?: boolean;
  /** A default when the question does not say. */
  fallback?: string;
  /**
   * Passed as a bare word rather than a flag, in declaration order.
   *
   * Declared rather than inferred. An earlier version guessed from the parameter's name,
   * which worked until a command needed two — `gh file read <repo> <path>` — and quietly
   * sent the second one as `--path`, which dv does not accept there.
   */
  positional?: boolean;
}

export interface AiCommand {
  /** How the model refers to it. Also the dv command, space-separated. */
  id: string;
  /** What it answers, phrased as the question a person would ask. */
  purpose: string;
  params?: AiParam[];
  /**
   * Changes something. Always offered, never run without asking.
   *
   * These used to be withheld behind a flag, which meant a question like "redeploy the
   * college lms" reached a model that had no redeploy command and refused — accurately
   * and uselessly. Offering them and confirming at the moment one is reached asks the
   * question at the point where you have the information to answer it.
   */
  mutates?: boolean;

  /**
   * How much a mistake costs.
   *
   * `high` is for anything other people would notice — a deploy that changes what a site
   * serves, a deletion that does not come back. It changes what the confirmation says, so
   * that agreeing to open an issue and agreeing to replace production do not look alike.
   */
  danger?: 'normal' | 'high';

  /** What the confirmation says this will do, in the user's terms. */
  effect?: string;

  /**
   * The output *is* the answer, as a file's contents are.
   *
   * Declared rather than guessed from the shape of the reply. Inferring it from a long
   * model answer meant a table with no summary was rendered as though it were a document —
   * the rows printed bare, with no answer above them at all.
   */
  rendersContent?: boolean;
  /** Which connector must be connected for this to work. */
  needs?: string;
}

/**
 * The commands a question can reach.
 *
 * Curated rather than generated from the dispatcher. Every dv command exists, but most of
 * them are not answers to a question anyone asks in words — `dv config set` is a thing you
 * do deliberately, not something you ask for. A shorter list is also a better one here:
 * the model picks from it every time, and forty options make the choice harder than
 * twenty-five.
 */
export const AI_COMMANDS: AiCommand[] = [
  // ── overall ───────────────────────────────────────────────────────────────
  {
    id: 'doctor',
    purpose: 'Check everything at once — accounts, repository, deployment, environment, database. Use for "is anything broken", "what is wrong", "check my setup".',
  },
  {
    id: 'auth status',
    purpose: 'Which services are connected and whether their tokens are still valid.',
  },

  // ── git, local ────────────────────────────────────────────────────────────
  {
    id: 'git status',
    purpose: 'Branch, uncommitted changes and unpushed commits in the folder you are standing in.',
  },
  {
    id: 'git log',
    purpose: 'Commits in the folder you are standing in, read from local git. Only when the question is about THIS repo or the current directory — never when it mentions GitHub.',
    params: [{ name: 'limit', describe: 'how many commits', fallback: '10' }],
  },
  {
    id: 'git diff',
    purpose: 'What has changed in the working tree but is not committed.',
  },

  // ── github ────────────────────────────────────────────────────────────────
  {
    id: 'gh repo list',
    purpose: 'Every repository on the GitHub account, with when each was last pushed. Use for "my repos", "what have I got on GitHub", and for comparing repositories against each other.',
    needs: 'github',
  },
  {
    id: 'gh repo stats',
    // Exists so that "which repo has the most commits" is one command rather than a loop.
    // A small model can pick a command reliably; it cannot list repositories, count each
    // one and compare without losing its way, so the counting belongs in dv.
    purpose: 'Every repository ranked by commit count, most first. Use for "which repo has the most commits", "biggest repo", "most active repository", comparing repositories.',
    needs: 'github',
  },
  {
    id: 'gh repo view',
    purpose: 'Settings of one repository — its description, whether it is private, its language and stars. Not its commits, issues or builds.',
    params: [{ positional: true, name: 'repo', describe: 'repository name, or owner/name', required: true }],
    needs: 'github',
  },
  {
    id: 'gh file read',
    purpose: 'The contents of one file in a repository. Use for "show me the readme", "what is in package.json", "read src/index.ts".',
    rendersContent: true,
    params: [
      { positional: true, name: 'repo', describe: 'repository name', required: true },
      { positional: true, name: 'path', describe: 'path within the repository, e.g. README.md', required: true },
    ],
    needs: 'github',
  },
  {
    id: 'gh file ls',
    purpose: 'The files and folders in a repository, or in one folder of it. Use for "what files are in", "list the contents of".',
    params: [
      { positional: true, name: 'repo', describe: 'repository name', required: true },
      { positional: true, name: 'path', describe: 'folder within the repository, blank for the root' },
    ],
    needs: 'github',
  },
  {
    id: 'gh issue list',
    purpose: 'Open issues on a repository.',
    params: [{ positional: true, name: 'repo', describe: 'repository name', required: true }],
    needs: 'github',
  },
  {
    id: 'gh pr list',
    purpose: 'Open pull requests on a repository.',
    params: [{ positional: true, name: 'repo', describe: 'repository name', required: true }],
    needs: 'github',
  },
  {
    id: 'gh run list',
    purpose: 'Recent GitHub Actions runs — use for "did CI pass", "is the build green".',
    params: [{ positional: true, name: 'repo', describe: 'repository name', required: true }],
    needs: 'github',
  },
  {
    id: 'gh commit list',
    purpose: 'Commits on a named repository on GitHub. Use whenever the question says GitHub, or names a repository that is not the current folder.',
    params: [{ positional: true, name: 'repo', describe: 'repository name', required: true }],
    needs: 'github',
  },

  // ── vercel ────────────────────────────────────────────────────────────────
  {
    id: 'vercel project list',
    purpose: 'Every Vercel project.',
    needs: 'vercel',
  },
  {
    id: 'vercel deploy list',
    purpose: 'Recent deployments and their state. Use for "what did I deploy", "is it live".',
    params: [{ positional: true, name: 'project', describe: 'Vercel project name' }],
    needs: 'vercel',
  },
  {
    id: 'vercel deploy logs',
    purpose: 'The build log for one deployment. Use for "why did the build fail", "show me the logs".',
    params: [
      { positional: true, name: 'id', describe: 'deployment id, e.g. dpl_xxx', required: true },
      { name: 'build', describe: 'always "true"', fallback: 'true' },
    ],
    needs: 'vercel',
  },
  {
    id: 'vercel env list',
    purpose: 'Environment variable names on a project. Never shows values.',
    params: [{ positional: true, name: 'project', describe: 'Vercel project name', required: true }],
    needs: 'vercel',
  },
  {
    id: 'vercel env diff',
    purpose: 'Which variables are in your local .env but missing on Vercel, or the reverse.',
    params: [{ positional: true, name: 'project', describe: 'Vercel project name', required: true }],
    needs: 'vercel',
  },
  {
    id: 'vercel domain list',
    purpose: 'Custom domains on a project and whether they are verified.',
    params: [{ positional: true, name: 'project', describe: 'Vercel project name', required: true }],
    needs: 'vercel',
  },
  {
    id: 'vercel dns list',
    purpose: 'DNS records for a domain.',
    params: [{ positional: true, name: 'domain', describe: 'the domain name', required: true }],
    needs: 'vercel',
  },

  // ── database ──────────────────────────────────────────────────────────────
  {
    id: 'db tables',
    purpose: 'Every table in the selected database, with estimated row counts.',
    needs: 'supabase',
  },
  {
    id: 'db describe',
    purpose: 'The columns of one table.',
    params: [{ positional: true, name: 'table', describe: 'table name', required: true }],
    needs: 'supabase',
  },
  {
    id: 'db count',
    purpose: 'The exact number of rows in a table.',
    params: [{ positional: true, name: 'table', describe: 'table name', required: true }],
    needs: 'supabase',
  },
  {
    id: 'db projects',
    purpose: 'Every database project available.',
    needs: 'supabase',
  },

  // ── history ───────────────────────────────────────────────────────────────
  {
    id: 'journal',
    purpose: 'Every change dv has made, newest first, and which can be undone.',
  },

  // ── writes, withheld by default ───────────────────────────────────────────
  {
    id: 'git save',
    purpose: 'Stage everything, commit, and push.',
    params: [{ name: 'm', describe: 'the commit message', required: true }],
    mutates: true,
    effect: 'commit every change here and push it',
  },
  {
    id: 'vercel deploy redeploy',
    purpose: 'Deploy a project again, reusing the last build. Use for "redeploy", "ship it again", "roll it back".',
    params: [{ positional: true, name: 'project', describe: 'Vercel project name', required: true }],
    mutates: true,
    danger: 'high',
    effect: 'replace what the live site serves',
    needs: 'vercel',
  },
  {
    id: 'gh issue create',
    purpose: 'Open a new issue on a repository. Use for "file a bug", "create an issue", "track this".',
    params: [
      { positional: true, name: 'repo', describe: 'repository name', required: true },
      { name: 'title', describe: 'the issue title', required: true },
    ],
    mutates: true,
    effect: 'open a new issue',
    needs: 'github',
  },
];

/**
 * What the model may choose from.
 *
 * Everything by default, including writes — they are gated by a confirmation at the moment
 * one is reached rather than by being hidden. `readsOnly` remains for callers that genuinely
 * must not touch anything, such as a non-interactive run with nobody to ask.
 */
export function availableCommands(options: { readsOnly?: boolean } = {}): AiCommand[] {
  return AI_COMMANDS.filter((command) => !options.readsOnly || !command.mutates);
}

export function findCommand(id: string): AiCommand | undefined {
  const wanted = id.trim().toLowerCase();
  return AI_COMMANDS.find((command) => command.id === wanted);
}

/**
 * The catalogue as the model sees it.
 *
 * Compact on purpose. Every token here competes with the question for the model's
 * attention, and a 3B model given a page of JSON schema starts pattern-matching the
 * schema rather than reading the question.
 */
export function describeCatalog(commands: AiCommand[]): string {
  return commands
    .map((command) => {
      const params = (command.params ?? [])
        .map((p) => (p.required ? p.name : `${p.name}?`))
        .join(', ');
      return `- ${command.id}${params ? ` (${params})` : ''}: ${command.purpose}`;
    })
    .join('\n');
}
