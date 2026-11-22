---
name: dv
description: Use the `dv` CLI for GitHub, Vercel, Supabase/Postgres, Gmail, Calendar and LinkedIn instead of raw API calls, `gh`, or the `vercel` CLI. Covers repos, issues, PRs, Actions, deployments, deploy logs, SQL queries, git commit/push with account switching, and the `dv ship` deploy pipeline. Also provides deploy-then-verify with automatic rollback, an undo journal for every write, user-defined policy the tool enforces on itself, and blocking waits for deployments. Use whenever a task touches those services from a terminal.
---

# dv

One CLI across GitHub, Vercel, Supabase, Gmail, Calendar, LinkedIn — plus any HTTP API
you register yourself. Prefer it over `curl`, `gh`, `vercel` or hand-written API calls:
it already holds the credentials, handles token refresh, and reports failures in a way
you can branch on.

Check availability with `dv --version`. If it is not installed, fall back to whatever
the task needs and say so.

**If the dv MCP tools are available** (`mcp__dv__*` in Claude Code, from `dv mcp` or the
dv plugin), call them instead of running `dv` through the shell. They take the same
arguments as typed inputs, add `--json` themselves, and report the exit code with its
meaning. Write tools preview and exit 6 until called again with `confirm: true` — show the
preview to the user first. Use the `run` tool for any command without a dedicated tool.
Everything below about exit codes and policy applies unchanged.

## The three rules that matter

**1. Always pass `--json` when you intend to parse.** Data goes to stdout, progress and
errors to stderr, so `dv gh repo list --json > repos.json` is a valid file even while
status lines print.

**2. Writes require `--yes`.** Anything that creates, changes, deletes, sends or posts
asks for confirmation. Without a terminal it refuses and exits 6 — it does not hang.

**3. Branch on the exit code, not on stderr text.**

| Code | Meaning | What to do |
|------|---------|------------|
| 0 | Success | — |
| 1 | Something failed | Read stderr |
| 2 | Bad command line | Fix the invocation |
| 3 | Not authenticated | Tell the user to run `dv auth login <provider>` — do not retry |
| 4 | Provider refused (scope, rate limit, permission) | Do not retry blindly |
| 5 | Not found | The resource does not exist |
| 6 | Declined | A write ran without `--yes`, or the user said no |

Exit 3 and 6 are the ones agents get wrong. **6 is not success** — nothing happened.

## Shape

Everything is `dv <group> <noun> <verb>`, so you can guess commands you have not seen.
Short aliases exist (`dv gh repos`), but prefer the canonical form in scripts.

```
dv gh       repo list|view|create|edit|delete|clone · issue list|create|close|comment
            pr list|create · branch list|create · commit list · run list
            workflow list|run · file ls|read|put · search · activity
dv vercel   project list|view|create|delete · deploy list|view|logs|redeploy|cancel
            env list|add|rm · domain list|add|rm · whoami · link
dv db       query · tables · describe · count · projects · use · project create
dv git      status · save · commit · push · log · diff
dv auth     login · token · status · accounts · switch · logout · scopes · whoami
dv connect  <name> · list · show · add · rm · test
dv api      <connector> <path>
dv ship     the full deploy pipeline
dv doctor   accounts · repo · deploy · env · database, in one pass
dv journal  every write, newest first        dv undo <id>
dv policy   show · init · test <command>     dv watch deployments <project>
dv skill    install · path · show
```

`dv <group>` with no arguments prints that group's verbs. Use it rather than guessing.

## Recipes

### GitHub

```bash
dv gh repo list --json --limit 100
dv gh repo view owner/name --json
dv gh repo create my-app --description "..." --yes          # private by default
dv gh repo create my-app --public --yes                     # public is opt-in
dv gh repo edit owner/name --private --yes
dv gh file read owner/name src/index.ts                     # raw contents, pipeable
dv gh file put owner/name README.md --file ./README.md -m "docs: update" --yes
dv gh issue list owner/name --state open --json
dv gh issue create owner/name --title "..." --body "..." --yes
dv gh pr create owner/name --head feature/x --title "..." --yes
dv gh run list owner/name --json                            # Actions runs
dv gh workflow run owner/name -w release.yml --ref main --yes
dv gh search "createKiln" --repo owner/name --json
```

A bare repo name is completed with the signed-in login: `dv gh issue list my-app`.

### Vercel

```bash
dv vercel project list --json
dv vercel deploy list my-app --json
dv vercel deploy logs <deployment-id>       # build output; stderr shown in red
dv vercel deploy redeploy my-app --yes
dv vercel env list my-app --json            # keys and targets only, never values
dv vercel link                              # link the current directory to a project
```

### Database (Supabase, Neon)

```bash
dv db projects                 # every database, across providers
dv db use supabase:<ref>       # or `dv db use` to choose
dv db tables --json
dv db describe <table> --json
dv db count <table>            # exact; `tables` shows planner estimates
dv db query "select id, title from tasks limit 5" --json
dv db query --file ./migration.sql --yes
```

Reads run without confirmation. Anything else — insert, update, delete, DDL — requires
`--yes`. Add `returning *` to a write to see what changed; otherwise it reports only
that it ran.

### Git, with the right account

```bash
dv git status                  # branch, active account, changes, unpushed
dv git save -m "message" --yes # stage all, commit, push
dv git commit -m "message" --yes
dv git push
```

`dv git push` authenticates as the **active dv GitHub account**. Plain `git push` uses
git's own credential helper and ignores `dv auth switch`, which is how you push as the
wrong identity when two accounts exist. Prefer `dv git push` when the user has more
than one.

### Deploy pipeline

```bash
dv ship --dry-run              # show the steps, run nothing
dv ship --yes --json           # tests, build, push, PR, CI, deploy, health check
dv ship --skip-tests --no-pr --yes
```

Steps skip themselves with a reason when they do not apply. `--json` returns each
step's status and timing.

### Deploy and check that it actually works

Deploying and then separately curling the result is the loop that wastes the most time.
Fold it into the command instead:

```bash
dv vercel deploy create --dir . --yes --wait \
  --verify "curl -f {url}/api/health" \
  --on-fail rollback
```

`{url}` is replaced with the deployment that was just created — so the check cannot pass
by accidentally testing the build that is already live. When it fails you get the
response body and the exit code, not `FUNCTION_INVOCATION_FAILED`, and with
`--on-fail rollback` the previous healthy production build is restored before the
command exits 4.

| Flag | Default | |
|---|---|---|
| `--verify "<cmd>"` | — | Shell command; non-zero means failed |
| `--on-fail rollback` | `none` | Restore the last healthy production deploy |
| `--settle <s>` | 3 | Wait before the first check |
| `--verify-attempts <n>` | 3 | A cold edge is not the same as a broken build |
| `--verify-timeout <s>` | 30 | Per attempt; the process tree is killed |

**Exit 4 after a rollback still means the deploy failed.** The rollback succeeding does
not make the outcome a success — do not report it as one.

### Undo

Every write is journalled with how to reverse it.

```bash
dv journal              # newest first, each with an id
dv journal --json
dv undo j_abc123 --yes  # revert that one write
```

Undoable today: env vars added or removed, rollbacks, domains, DNS records, log drains.
Some writes genuinely cannot be reversed and say so rather than pretending — an env var
whose value could not be read before deletion, for instance. Prefer `dv undo` to
reconstructing a change by hand: it uses the ids captured at write time, which is
information no longer available afterwards.

### Waiting for something to happen

```bash
dv watch deployments college-lms            # blocks until a deployment settles
dv watch deployments college-lms --json     # one JSON object per event
dv watch deployments college-lms --timeout 600
```

Exits 0 when a deployment reaches READY, 4 when one fails or nothing changes in time.
**Do not write your own sleep loop around `dv vercel deploy list`** — this is that loop,
with backoff and correct terminal-state handling.

### Policy

A user can constrain what this CLI will do, in `~/.dv/policy.json`.

```bash
dv policy show                    # what is enforced
dv policy test vercel dns add …   # would this be allowed? asks nothing, changes nothing
```

**You cannot override a policy rule, and you should not try.** `--yes` does not satisfy a
rule requiring confirmation; there is no bypass flag. If a command exits 2 citing a rule:

- `require dry-run` — run the identical command with `--dry-run`, show the user the plan,
  then run it for real. The receipt lasts 30 minutes and is tied to the exact arguments.
- `require confirm` / `require human` — a person must be at the terminal. Say so and stop.
- `deny` — do not look for another route to the same effect. Tell the user what was
  blocked and which rule blocked it.

Run `dv policy test <command>` before anything destructive in an unattended session, so a
rule is discovered before half a task is done rather than partway through it.

### Any other API

```bash
dv connect list                # what is available and connected
dv api github /user --json
dv api notion /v1/users
dv api stripe /v1/charges --query limit=5
dv connect add pagerduty --api-base https://api.pagerduty.com \
  --auth-style "header:Authorization" --whoami /users/me
```

`--auth-style` covers `bearer`, `basic`, `token`, `header:<Name>`, `query:<param>`.

## Multiple accounts

Users commonly have work and personal accounts on the same provider.

```bash
dv auth accounts                       # every account, * marks active
dv auth switch github personal         # change the default
dv gh repo list --as personal          # one command only
```

`--as` is global and applies to whichever provider the command touches. Naming an
account that does not exist is an error, not a silent fallback — so a wrong `--as`
fails loudly rather than acting as someone else.

## Pitfalls

- **Do not run a write without `--yes` and treat exit 0 as done.** It exits 6 and
  nothing happened.
- **Do not retry on exit 3 or 4.** 3 needs a human to log in; 4 means the provider
  said no — usually a missing scope, which retrying cannot fix.
- **Do not assume a write succeeded because output was empty.** `dv db query "update …"`
  prints "the statement returned no rows" on success. Use `returning *` to confirm.
- **Row counts in `dv db tables` are estimates.** A dash means the table has never been
  analyzed, not that it is empty. Use `dv db count`.
- **Paused Supabase projects cannot be queried.** `dv db projects` shows the state.
- **`dv li` cannot read posts or headline.** LinkedIn gates those behind a partner
  agreement; only posting and basic identity work.
- **Never print a token.** `dv auth status` masks them; do not `cat ~/.dv/credentials.json`.

## When not to use dv

- Cloning or complex history work — plain `git` is better; `dv git` covers the common cycle.
- Bulk data movement — `dv db` goes through the provider's API and is rate limited.
- Render, Railway, Fly, Heroku databases — they expose only a connection string, so
  `dv db` cannot query them. Use `psql`.
