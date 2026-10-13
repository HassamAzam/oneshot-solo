# Oneshot Solo

One conductor. One label. One session per ticket.

Oneshot Solo takes a GitLab ticket labelled `Loop` and ships it. The conductor is plain
code and never a model: it claims the ticket, cuts a worktree from your clone, and starts
**one** Claude session. That session plans with the
[superpowers](https://github.com/obra/superpowers) plugin (brainstorming, then a written
plan), builds, tests in a browser, and opens the merge request itself. The conductor then
checks the MR, merges it behind a deterministic gate or stops at `In Review`, labels the
ticket, and leaves a note on it.

Nothing leaves the machine but the GitLab work: no Slack, no telemetry board, no Langfuse.
Each run's status, duration and full transcript stay in `state/runs/<iid>/`, and
`npm run dashboard` reads them back. Solo is a fork of oneshot, which drives a ticket
through sixteen fresh per-phase sessions; Solo hands the whole job to one session and keeps
only the machinery that keeps an unattended session honest — watchdogs, guard hooks, the
merge gate (see [Lineage](#lineage)).

## How a ticket flows

```
npm start                                   src/index.ts
  boot ─ .env, GITLAB_REPO_URL → target, token, compose .claude, pid file, superpowers path
  tick (60s) ─ pause files → GitLab reachability → scan `Loop` → triage → dispatch
                                            src/ticket/run.ts
  runTicket(iid)
    claim      journal {status:'claimed', pid}        state/runs/<iid>/run.json
    prepare    fetch issue + human notes + attachments → Ticket
               lease worktree  WT_ROOT/t<iid>-<runId>  branch oneshot/ticket-<iid>-<slug>
               compose .claude (skills, agents, rules) ; start the app in the background
    session    ONE query()                             src/ticket/session.ts
                 prompt  = src/ticket/prompt.ts
                 plugins = [superpowers]
                 hooks   = src/ticket/hooks.ts → hooks/*.cjs
                 tee     → transcripts/ticket-lap<n>.jsonl  (every frame, + ts)
    outcome    structured_output + MR lookup by branch   src/ticket/outcome.ts
    finish     merge gate → merge | In Review | Needs Human ; labels ; note ; journal
                                                       src/ticket/finish.ts, src/ticket/merge.ts
npm run dashboard                           scripts/serve.ts → src/lib/report.ts
npm run status                              scripts/status.ts → src/lib/telemetry.ts
```

## Quick start

You need Node ≥ 20, `claude login` done (sessions run on that subscription), the superpowers
plugin installed (`claude plugin install superpowers`), your clone of the project (by
default `~/Documents/<name>`, where `<name>` is the project URL's last segment), and the
VPN if your GitLab sits behind one.

```sh
git clone <this repo> ~/Documents/oneshot-solo && cd ~/Documents/oneshot-solo
npm install
npm run setup     # GITLAB_REPO_URL, the token, your clone, an optional test login
npm run doctor    # everything a run needs, ending with a one-turn probe session
npm start         # then label a ticket `Loop`
```

| command | what it does |
|---|---|
| `npm start` | ticks every 60 s and dispatches one ticket at a time |
| `npm start -- --once` | one tick, waits for the run it dispatched, exits |
| `npm start -- --ticket <iid>` | runs exactly that ticket, resuming its journal when it stopped mid-run, then exits |
| `npm run doctor -- --no-probe` | doctor without the probe session (which spends one turn) |
| `npm run verify` | `deps:verify`, `hooks:verify`, then `doctor` |

`npm start` refuses to boot, and says why, when: there is no `.env` (in a terminal it runs
`npm run setup` instead); this desk has no GitLab token; `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` or a `CLAUDE_CODE_USE_*` flag is set in the shell; superpowers is
missing or has no `skills/brainstorming/SKILL.md`; another conductor is alive
(`state/conductor.pid`); `GITLAB_REPO_URL` is unset, invalid, or contradicted by a legacy
selector line; `WORK_REPO` does not exist; or `WORK_REPO` or the seed is a clone of a
different project. `ONESHOT_SKIP_REPO_CHECK=1` turns the origin refusals into warnings and
says so on every boot.

## Starting a ticket from the dashboard

Instead of a command: `npm run dashboard`, type the ticket number into the box at the top of
<http://localhost:8787> and press **Run**. The dashboard queues it as `state/queue/<iid>.json`
and the conductor's next tick (≤ 60 s) runs it exactly as `npm start -- --ticket <iid>` would:
no `Loop` label needed, the blocked cooldown waived, a run that stopped mid-way resumed from
its journal. Queued tickets go before the board, oldest first, and wait while a run is live
or GitLab is unreachable. A number GitLab cannot read leaves the queue with a
`cannot read #<iid>` line in the conductor's log and no run.

The conductor has to be running for anything to happen. The page says whether it is
(`npm run status` prints the same as its first line, and the queue under it); when it is not,
**Start it** launches one in the background — `tsx src/index.ts`, detached, so it outlives the
dashboard, with its output in `state/conductor.log`. Stop it with
`kill $(cat state/conductor.pid)`, which winds the run up like Ctrl-C. The index lists the run
in flight first, marked `● running`. To drop a queued ticket, delete its file from
`state/queue/`. Only a POST from the dashboard's own page is accepted.

## Reading a run

- `npm run status` — one line per run, archived runs included: ticket, title, status,
  duration, attempts, turns, tokens, MR. `--json` for a script.
- `npm run dashboard` — <http://localhost:8787> (loopback only; `ONESHOT_DASHBOARD_PORT`
  moves it). The index lists every run. `/run/<iid>` shows each attempt's duration, turns,
  tokens and cost; checkpoint rows where the session invoked `superpowers:brainstorming`,
  `superpowers:writing-plans` and opened the MR; where context was compacted; and the whole
  transcript, subagents attributed. `/artifacts/<iid>/<file>` serves the design, the plan
  and the screenshots.
- `npm run report -- <iid>` — the same page as one self-contained HTML file.

On disk:

```
state/runs/<iid>/
  run.json                          status, branch, worktree, MR, why it stopped, every attempt
  transcripts/ticket-lap<n>.jsonl   every SDK frame as {ts, ...frame}, CLI stderr included
  artifacts/                        <iid>-design.md, <iid>-plan.md, cases.json, screenshots
```

A ticket run again has its finished directory moved to `state/runs-archive/<iid>-<runId>/`,
where the dashboard still renders it. Tokens and cost are estimates: a Max subscription
bills nothing per run. `run.json` sits outside every directory the session may write, so
nothing a session does can change the record of what it did.

## Config

`.env` (`npm run setup` writes it at mode 600; `.env.example` documents every key):

| key | |
|---|---|
| `GITLAB_REPO_URL` | **required.** The project. Derives the API root, `WORK_REPO` (`~/Documents/<name>`) and `WT_ROOT` (`~/Documents/<name>-wt`) |
| `GITLAB_TOKEN` | scope `api`. `npm run token:set` keeps it in `~/.config/oneshot/gitlab-token` instead, outside the repo |
| `WORK_REPO` | your clone, when not at the derived default |
| `ONESHOT_MODEL` | default `claude-opus-5-5` |
| `ONESHOT_MAX_TURNS` / `ONESHOT_TIMEOUT_MIN` / `ONESHOT_IDLE_MIN` | 600 / 240 / 15 — turn cap, wall clock, and the silent-stream watchdog (0 disables it) |
| `ONESHOT_PORT` | the app's Django port, default 8000 |
| `ONESHOT_TEST_LOGIN` | `email:password` of the managed test account for browser checks |
| `ONESHOT_SEED_FROM` / `ONESHOT_SEED_LINKS` / `ONESHOT_SEED_COPIES` | the installed clone a worktree borrows from (default `WORK_REPO`), and overrides for `seed` below |
| `ONESHOT_SUPERPOWERS_PATH` | the plugin dir; default read from `~/.claude/plugins/installed_plugins.json` |
| `ONESHOT_SUPERPOWERS_INJECT` | `1` appends the superpowers intro to the system prompt — only when doctor says the plugin's hook does not fire |
| `ONESHOT_GIT_AUTHOR_NAME` / `_EMAIL` | the session's commit identity, set in its environment |
| `ONESHOT_MERGE` | `auto` or `manual`, overriding `merge.mode` for this shell |

Never set `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` or
`CLAUDE_CODE_USE_*` in the conductor's shell: the session runs on your subscription, the
session environment is an allowlist that strips them, and boot and doctor refuse them.

The app bring-up gets the same allowlisted environment as the session plus `app.cjs`'s own `.env` load; shell-only variables (for example `PG*`) do not reach Django — put them in `.env`.

`config/project.json` is everything about the project the URL does not say:

| field | |
|---|---|
| `labels` | `entry` (`Loop`), `exit` (`Merged`), `inReview` (`In Review`), `blocked` (`Needs Human`). Each must exist on the project; doctor checks |
| `preserveLabels` | never touched by a label swap |
| `branches` | `base` the MR targets, `protected` git-guard refuses to push to, `prefix` of run branches |
| `merge.mode` | `auto` or `manual`, below |
| `bugReproduction` | bug-labelled tickets get the reproduction method |
| `hookPack` | the project's guard pack under `hooks/packs/` |
| `seed` | `links` symlinked and `copies` copied from the seed into each worktree |

`merge.mode: "auto"` merges only when every gate condition holds: the session finished with
a result, nothing in `blocked`, and an open MR on its branch; the MR post-check passed — it
targets the base branch, its title has no conventional-commit prefix, its description
carries `[closes <issue url>]` (a `Draft:` prefix is stripped first); at least one test case
passed and none failed; every reported regression is listed in the MR description; and
GitLab says the MR can be merged. Anything else stops at `In Review` with the reason in the
ticket note. `"manual"` always stops there. Start with `manual` until you have read one run
on the dashboard end to end.

`seed.links` carries `staticfiles` for ERP on purpose: `local_settings.py` serves
`ManifestStaticFilesStorage` with `DEBUG=False`, so every `{% static %}` page fails until
`collectstatic` has run. It runs once in the seed and every worktree links the result,
like `venv` and `node_modules`.

## Guardrails

The session holds Bash, the write tools and the MR tools for hours under
`bypassPermissions`, so six core guards run on every tool call, in-process through the
SDK's `hooks` option and with nothing installed into `~/.claude`: `pause-check` (the
brake), `write-scope` (writes only in the worktree and the run's artifacts), `churn-guard`
(no whole-file rewrite of an existing file to change part of it), `git-guard` (push only
the run's branch, never a protected one, no force push, no `git stash`), `secret-guard`
(no reading `.env`, its backups or the token files), and `mr-gate` (the MR title and
`[closes …]` contract, this project only, the run's branch into the base). A project adds its own pack — ERP's lints Python and JS, checks migrations and
briefs the session on known traps. The issue, label, merge and branch-admin GitLab tools
are denied to the session outright; merging is conductor code.

[docs/HOOKS.md](docs/HOOKS.md) is the full account: which guard does what, how a pack is
declared, and how to add one. `npm run hooks:verify` runs the offline allow/deny suite.

## Stopping and resuming

- **`touch state/PAUSE`** stops claiming, and inside a running session `pause-check`
  denies every tool with side effects while reads still work, so the session writes up
  where it got to. `rm state/PAUSE` to carry on. `PAUSE-QUOTA` (a subscription usage limit;
  clears itself) and `PAUSE-NETWORK` (GitLab unreachable) are the conductor's own.
- **Ctrl-C once** stops claiming, withdraws the session — it ends `aborted`, which is
  resumable — and waits for the run to wind up. **Ctrl-C again** exits at once; the
  journal is left `running` under a dead pid, which the next boot resumes.
- **`npm start -- --ticket <iid>`** resumes a run that stopped mid-way: same run id,
  worktree and branch, and the same Claude conversation where a session id was recorded.
- **`Needs Human`** means the run stopped; the ticket note says why ("Oneshot stopped:
  **…**"). Fix the cause, then swap `Needs Human` back for `Loop`, or run
  `npm start -- --ticket <iid>`. The scan does not re-claim a blocked ticket within 30
  minutes of stopping; `--ticket` is the operator's say-so and bypasses that wait.
- **`npm run reap`** removes worktrees whose MR merged (`--all-done` also takes runs
  whose MR is still open; `--dry-run` only lists). Every run keeps its worktree until then.

## What it is not

Not in v1: Slack, the oneshot board, Langfuse/OTel, the Ready-For-Automation mode, human
review gates and the `Review` / `Design` / `TestCase Review` labels, the MR-feedback loop,
the design phase and design tokens, demo recording, memory and recall, cross-machine
claims, the port pool and the app warm pool, a fleet of conductors, promotions past `dev`,
the `DRY_RUN` shadow home, and run retention or archive sweeps.

## Lineage

Forked from [oneshot](https://github.com/HassamAzam/oneshot) at `49899db` (oneshot `main`,
2026-10-13), history kept; `upstream` is oneshot. The design, and why each thing was cut,
is in [docs/superpowers/specs/2026-10-13-oneshot-solo-design.md](docs/superpowers/specs/2026-10-13-oneshot-solo-design.md).

| oneshot | Solo |
|---|---|
| 17 phases in `config/phases.json`, each a fresh session with its own schema | one session, one output schema |
| `recall → research → design → plan → implement → testcases ∥ review → verify → ui-evidence ∥ mr → merge` | `brainstorm → plan → implement → test in browser → MR` inside the session; `merge` is conductor code |
| SQLite (`runs`, `phase_runs`, `quota_usage`, `events`, `conductors`, `port_leases`, `promotion_lock`) | none: the per-run `run.json` journal plus a pid is the whole state |
| cross-machine claim notes, settle windows, fleet heartbeats | one desk, one ticket at a time, a pid file |
| Slack cards, oneshot-board collector, Langfuse/OTel export | nothing leaves the machine |
| 17 hooks | 6 core guards + an optional per-project pack of 7 |
| human review gates (`Review`, `Design`, `TestCase Review`), the MR-feedback loop, Ready-For-Automation mode | gone |
| `report.html` written at finish (9 MB per run) | rendered on demand by the dashboard |

Removed wholesale: `src/conductor/`, `src/phases/`, `src/automation/`, `src/mrfeedback/`,
the SQLite, Slack, OTel/Langfuse, promotion, claims, fleet and memory modules,
`config/{phases,models,budgets,slack,otel,reviewers,risk-modules,mr-feedback}.json`,
`scripts/board/`, the Langfuse compose file, `pm-loop/`, `evals/` and `docs/gates`.
The reasons in one line each: phases cost a fresh context and a handoff file per step that
one planning session does not need; SQLite only ever held what `run.json` holds for one
desk; the claims and fleet machinery solved concurrency Solo does not have; and the
operator asked for nothing to leave the machine.
