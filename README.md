# dv

One CLI for GitHub, Gmail, Calendar, LinkedIn and Vercel — with OAuth built in.

```bash
npm install -g @abhishekvardanbotta/dv
dv auth login github
dv gh repo list
```

No runtime dependencies. Node 20+.

---

## Connecting

14 connectors ship built in, and you can add any HTTP API yourself.

```bash
dv connect list             # everything, and how each one connects
dv connect show notion      # base URL, auth style, setup steps
```

Each service is connected the way it actually allows — that is a constraint, not a
preference:

| Service | Ways in | Notes |
|---|---|---|
| GitHub | device, token, loopback | Device flow needs no port and works over SSH |
| Google | loopback + PKCE | No device flow exists for Gmail/Calendar scopes |
| LinkedIn | loopback, token | Needs a client secret — no PKCE support |
| Atlassian | basic, loopback | Email + API token, per your own site |
| Slack, Notion, Linear, Discord, Figma | token, loopback | |
| Vercel, Supabase, Stripe, OpenAI | token | No user-facing OAuth for CLIs |
| Anthropic | header | Uses `x-api-key`, not `Authorization` |

`dv auth login <service>` asks how, with arrow keys:

```
How would you like to connect to GitHub?
  up/down to move, Enter to select, Ctrl-C to cancel

  > Browser code     Shows a code to paste - no port, works over SSH  (recommended)
    Paste a token    A personal access token or API key
    Browser sign-in  Opens a browser and listens on 127.0.0.1
```

Arrows or `j`/`k` move, the list wraps at both ends, digits still select directly, and
Enter takes the recommended option. Picking "Paste a token" then tells you where to get
one and reads it without echoing it.

Skip the questions entirely when you already know:

```bash
dv auth login github --method token --token ghp_xxx
dv auth login atlassian --user you@example.com --token <api-token>
DV_TOKEN=ghp_xxx dv auth token github
```

Scripts are unaffected: with no terminal attached the menu never appears and the
recommended method is used, so nothing that worked before needs a new flag.

GitHub's device flow is the nicest of these: nothing listens on a port, there is no
redirect URI to register, and it works unchanged over SSH.

```bash
dv auth login github     # shows a code, you paste it in the browser
dv auth login google     # opens a browser, listens on 127.0.0.1
dv auth token vercel --token <token>
dv auth status           # what is connected, and for how long
```

### Bring your own OAuth app

There is no shared client id baked in — you register your own app, so the tokens are
yours and the rate limits are yours.

```bash
dv config set github.clientId Iv1.xxxxx          # enable "Device flow" on the app
dv config set google.clientId xxx.apps.googleusercontent.com
dv config set linkedin.clientSecret xxxxx        # LinkedIn requires this
dv config list                                    # shows the env var for each
```

Every key also reads from an environment variable (`DV_GITHUB_CLIENT_ID`, …), which
takes precedence — useful in CI where nothing should be written to disk.

For Google and LinkedIn, allow `http://127.0.0.1` as a redirect URI on the app. The
port is chosen at runtime, and Google accepts any port on the loopback address.

---

## Workflows

The reason this exists rather than being three thin API wrappers. Individual API calls
are easy; the *sequence* is not, because it spans git, GitHub, Vercel and the running
site, and each has a different idea of what "done" means.

```bash
dv ship
```

```
DevOS Ship
────────────────────────────

  ok Git status clean   main at 25f83ac
  -  Tests passed       no test script
  ok Build successful   99.4s
  ok Pushed to origin   1 commit
  ok Pull request open  #142 -> main
  ok CI passed          3 checks
  ok Deployment ready   https://myapp.vercel.app
  ok Health check       200 https://myapp.vercel.app

Pull request  https://github.com/you/myapp/pull/142
Deployment    https://myapp.vercel.app

✓ Ship: SUCCESS
```

Each step skips itself with a reason when it does not apply — no test script, no
GitHub remote, not linked to Vercel — so it degrades instead of failing.

```bash
dv ship --dry-run                 # show the plan, run nothing
dv ship --skip-tests --no-pr      # turn steps off
dv ship --project my-app          # name the Vercel project
dv ship --json                    # machine-readable result
```

The waits are the hard part, and are handled explicitly:

- **CI** — GitHub reports no check runs for a few seconds after a push, which reads
  identically to "all passed". The first 20 seconds of emptiness is treated as *still
  starting*.
- **Deployment** — Vercel builds from the git push, not from this CLI, so the step finds
  the deployment matching your commit SHA rather than creating one.
- **Health** — a deployment reporting READY means the build finished, not that the site
  serves. The URL is actually requested.

## What it does

### GitHub

```bash
dv gh repo list --limit 50 --private
dv gh repo view my-project
dv gh repo create my-app --description "..." --clone      # private by default
dv gh repo create my-app --public                         # asks first
dv gh file ls my-app src
dv gh file read my-app src/index.ts > local.ts
dv gh search createKiln --repo my-app
dv gh issue list my-app --state all --label bug
dv gh issue create my-app --title "Crash on save" --body "..." --label bug
dv gh pr create my-app --head feature/x --title "Add x"
dv gh branch create my-app feature/x
dv gh file put my-app README.md --file ./README.md -m "docs: update"
dv gh run list my-app
dv gh workflow run my-app -w release.yml --ref main
dv gh repo clone my-app
```

A bare repo name is completed with your own login, so `dv gh issue list my-app` works;
`owner/repo` is accepted anywhere too.

### Gmail and Calendar

```bash
dv gmail search                        # defaults to your inbox
dv gmail search "from:github is:unread"
dv gmail read <id>
dv gmail send --to a@b.com --subject "Hi" --body "Hello"   # asks first
dv cal events --days 14
dv cal free --min 45                   # gaps in your working hours
dv cal add --title "Review" --start "2026-08-20T15:00" --minutes 45
```

### LinkedIn

```bash
dv li me
dv li post --text "Shipped the CLI today." --url https://example.com
```

`dv li me` returns name, email, locale and picture — that is the whole of what the
standard API tier exposes. Headline, connections, current position and your own posts
need a LinkedIn *partner* agreement, so the CLI says they are unavailable rather than
filling them in. `dv li posts` refuses outright instead of returning an empty list
that would read as "you have no posts".

### Vercel

```bash
dv vercel project list
dv vercel deploy list --project my-app
dv vercel deploy redeploy my-app              # asks first
dv vercel env list my-app                   # keys and targets; values are never fetched
```

### Anything else

`dv api` makes every connector usable without a bespoke command for it:

```bash
dv api github /user
dv api notion /v1/users
dv api slack /conversations.list
dv api stripe /v1/charges --query limit=5
dv api linear /graphql --method POST --data '{"query":"{ viewer { name } }"}'
```

And a service this CLI has never heard of needs one line to define:

```bash
dv connect add pagerduty   --api-base https://api.pagerduty.com   --auth-style "header:Authorization"   --header "Accept: application/vnd.pagerduty+json;version=2"   --whoami /users/me

dv auth token pagerduty --token <key>
dv connect test pagerduty
dv api pagerduty /incidents --query "statuses[]=triggered"
```

`--auth-style` covers how the credential attaches: `bearer`, `basic`, `token`,
`header:<Name>` or `query:<param>`. That is the axis most CLIs hardcode, and the
reason they only work with the services their author used.

For a service hosted per customer, set its base URL:

```bash
dv config set atlassian.apiBase https://your-site.atlassian.net
```

---

## Scripting

Everything supports `--json`, and **data goes to stdout while progress goes to
stderr** — so a redirect produces a clean file even while status lines are printing:

```bash
dv gh repo list --json > repos.json
dv gmail search "is:unread" --json | jq '.[] | .subject'
```

Exit codes are meaningful, so a wrapper can tell the cases apart:

| Code | Meaning |
|---|---|
| 0 | Fine |
| 1 | Something failed |
| 2 | The command line was wrong |
| 3 | Not signed in, or the credential is dead — run `dv auth login` |
| 4 | The provider refused: rate limit, missing scope, permission denied |
| 5 | Nothing matched |
| 6 | You declined a confirmation — nothing happened |

```bash
dv gh repo maybe-missing >/dev/null 2>&1
case $? in
  0) echo "exists" ;;
  3) dv auth login github ;;
  5) echo "no such repo" ;;
esac
```

Anything that writes, sends, publishes or deletes asks first. Pass `--yes` in scripts.
Deleting a repository is the exception: it makes you type the full name, because a
`y/N` prompt is too easy to fat-finger for something irreversible.

---

## Where your tokens live

`~/.dv/credentials.json`, written `0600` (owner read/write only) via a temp file
and an atomic rename, so a process killed mid-write cannot leave a truncated
credential file. `dv auth status` warns if the permissions ever loosen.

Client ids live separately in `~/.dv/config.json` — a client id is a public
identifier, a token is not, and they should not share a file.

Set `DV_HOME` to relocate both.

Secrets are never echoed. `dv config get github.clientSecret` prints a mask, and
`config set` confirms with a mask rather than the value you just typed.

Tokens are renewed **before** they expire, with a five-minute margin — a request that
starts with seconds left can still arrive after the token has died. Concurrent
commands share a single refresh rather than each spending the refresh token.

---

## Development

```bash
npm install
npm run dev -- gh repos     # run from source
npm test                    # 53 tests
npm run build
```

`DV_DEBUG=1` prints stack traces. `NO_COLOR=1` disables colour, as does piping.

### A Git Bash note

MSYS rewrites arguments that look like absolute POSIX paths, so on Git Bash
`dv api github /user` arrives as `C:/Program Files/Git/user`. `dv` detects and undoes
this using `EXEPATH`, so it just works. If you hit it in another tool, `//user` or
`MSYS_NO_PATHCONV=1` are the usual workarounds.
