# Oneshot Solo — design

One conductor. One label. One session per ticket.

Oneshot Solo is a fork of [oneshot](https://github.com/HassamAzam/oneshot) (forked at
`49899db`, oneshot `main`, 2026-10-13). Oneshot drives a GitLab ticket through sixteen
fresh per-phase Claude sessions. Solo drives it through **one** session that plans with the
superpowers plugin and then builds, tests and raises the MR itself. The conductor still
exists, but it only claims the ticket, prepares the worktree, spawns the session, watches it,
records what happened, and finishes on GitLab.

## 1. Brief and intent

What was asked for, in the operator's words:

- "I don't want to limit the agent. I want it to do it all by itself." — no phase division
  imposed by the conductor.
- "Make it simple, check if hooks need to exist. Setup should be simple."
- "No Slack message for now. No telemetry to the oneshot board. But I would want telemetry
  on a different place." — "use already existing telemetric analysis; all I need is ticket
  status, how much time it took and an easier way to read transcripts."
- "We use superpowers for planning and then code."

Success looks like: `npm run setup`, `npm run doctor`, `npm start`, label a ticket `Loop`,
and later open `npm run dashboard` to see the ticket's status, how long it took, and a
readable transcript.

### Assumptions made in place of questions

The operator was not available while this was designed. These are the calls made; each is
a one-line change if wrong.

| # | Assumption | Where it lives |
|---|---|---|
| A1 | The fork is `oneshot-solo` at `~/Documents/oneshot-solo`, history kept, `upstream` = oneshot on GitHub. No GitHub remote is created by the harness work; the operator pushes when ready. | repo |
| A2 | "Telemetry in a different place" = the local filesystem journal already written per run, read by the local dashboard lifted from oneshot (`npm run dashboard`, `npm run status`, `npm run report`). No remote sink. | §6 |
| A3 | The session opens the MR. The conductor **merges** when a deterministic gate passes, because `Loop` is the standing consent to merge in oneshot's HANDOFF.md. `config/project.json` → `"merge": { "mode": "auto" }`; `"manual"` stops at `In Review`. | §5.4 |
| A4 | Superpowers runs headless by prompt: the session answers its own brainstorming questions from the ticket, writes the design and plan to the run's artifacts dir, treats them as approved, and executes inline. A doctor probe proves the plugin loads; vendored skill copies are the fallback, not the default. | §4.4 |
| A5 | Default model `claude-opus-5-5`, overridable with `ONESHOT_MODEL`. | §7 |
| A6 | The Agent SDK is bumped to `0.3.296` (bundled Claude Code 2.1.296) because superpowers 6.4.1 assumes 2.1.x hook behaviour and oneshot's pinned 0.1.77 bundles 2.0.77. | §7 |

## 2. What changes, in one table

| oneshot | solo |
|---|---|
| 17 phases in `config/phases.json`, each a fresh session with its own schema | one session, one output schema |
| `recall → research → design → plan → implement → testcases ∥ review → verify → ui-evidence ∥ mr → merge` | `brainstorm → plan → implement → test in browser → MR` inside the session; `merge` is conductor code |
| SQLite (`runs`, `phase_runs`, `quota_usage`, `events`, `conductors`, `port_leases`, `promotion_lock`) | none; the per-run `run.json` journal plus a pid is the whole state |
| cross-machine claim notes, settle windows, fleet heartbeats | one desk, `concurrency: 1`, a pid file |
| Slack cards, oneshot-board collector, Langfuse/OTel export | nothing leaves the machine |
| 17 hooks | 6 core guards (`churn-guard` added) + an optional per-project pack of 7 |
| human review gates (`Review`, `Design`, `TestCase Review` labels), MR-feedback loop, Ready-For-Automation mode | gone |
| `report.html` written at finish (9 MB per run) | rendered on demand by the dashboard |

## 3. Architecture

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

The conductor is code and never holds a model. The session is the only model and holds every
tool the ticket needs — Bash, Read/Write/Edit, the GitLab MCP server (MR tools allowed,
issue/label/merge/branch-protection tools denied), Playwright via the project's harness —
behind the six core guards.

## 4. The session

### 4.1 Spawn (lifted from `src/conductor/phase.ts` `runPhase`, trimmed)

```ts
query({
  prompt: ticketPrompt(ticket, lease, labels),
  options: {
    model: ONESHOT_MODEL,                         // default claude-opus-5-5
    maxTurns: ONESHOT_MAX_TURNS,                  // default 600
    cwd: lease.worktree,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
    settingSources: ['project'],                  // never 'user' (oneshot lesson: npx statusLine wedge)
    plugins: [{ type: 'local', path: superpowersPath() }],
    hooks: hooksFor(env),
    mcpServers: { gitlab: { command: NODE, args: [MCP_GITLAB], env: { ...BASE_ENV, GITLAB_PERSONAL_ACCESS_TOKEN, GITLAB_API_URL } } },
    disallowedTools: DENY,                        // §4.3
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },   // §4.5
    env, abortController, stderr: tee,
  },
})
```

Watchdogs, all lifted: a hard deadline (`ONESHOT_TIMEOUT_MIN`, default 240), an idle-stream
watchdog (`ONESHOT_IDLE_MIN`, default 15), a 30 s force-settle after abort, the first `result`
frame settles, the rate-limit short-circuit parks for quota, and `[ACTION REQUIRED]` on stderr
is a hard stop. A progress line every 60 s prints turns and elapsed against the caps.

### 4.2 Environment handed to the session

`BASE_ENV` from `src/lib/config.ts` (the allowlist that strips every `ANTHROPIC_*`,
`CLAUDE_CODE_USE_*`, and the GitLab token; forwards `HOME`, `USER`, `PATH`, `TMPDIR`,
`CLAUDE_CODE_DISABLE_1M_CONTEXT=1`) plus the identity every hook reads:

```
ONESHOT_HOME ONESHOT_PHASE=ticket ONESHOT_RUN_ID ONESHOT_TICKET ONESHOT_LAP
ONESHOT_WRITE_SCOPES=<worktree>:<artifacts>  ONESHOT_WORKTREE ONESHOT_BRANCH ONESHOT_PORT
ONESHOT_ARTIFACTS=<state/runs/<iid>/artifacts>  ONESHOT_TICKET_LABELS=<comma list>
ONESHOT_SEED_FROM ONESHOT_SEED_LINKS ONESHOT_SEED_COPIES ONESHOT_TEST_LOGIN NODE_PATH
```

`ONESHOT_PHASE` stays and is the constant `ticket`: `hooks/_common.cjs` exits 0 without it, so
forgetting it silently disables every guard. Doctor asserts the env builder sets it.

`run.json` is **outside** the write scopes on purpose: the conductor never trusts a
session-written file for outcome, and nothing the session can do changes the record.

### 4.3 Tool policy

Denied for the whole session (one static list; `src/automation/runner.ts` already carried the
headless `AskUserQuestion` entry):

```
AskUserQuestion
mcp__gitlab__merge_merge_request  mcp__gitlab__delete_branch  mcp__gitlab__protect_branch
mcp__gitlab__unprotect_branch  mcp__gitlab__update_project  mcp__gitlab__update_default_branch
mcp__gitlab__update_issue  mcp__gitlab__create_issue  mcp__gitlab__create_issue_note
mcp__gitlab__update_issue_note  mcp__gitlab__create_note  mcp__gitlab__push_files
mcp__gitlab__create_or_update_file  mcp__gitlab__create_branch
mcp__gitlab__create_merge_request_discussion_note  every draft-note tool
```

Allowed, because the session owns the MR: `create_merge_request`, `update_merge_request`,
`create_merge_request_note`, `upload_markdown`. `hooks/mr-gate.cjs` enforces the title and
`[closes <url>]` contract on the first two, and the conductor re-checks the MR after the
session (§5.3).

### 4.4 Prompt (new `src/ticket/prompt.ts`, content lifted from `src/phases/prompts.ts`)

In order:

1. **Headless preamble** (new). No human is present. The ticket is the product owner.
   - `superpowers:brainstorming`: answer every clarifying question from the ticket text,
     attachments and code; write the understanding and design to
     `$ONESHOT_ARTIFACTS/<iid>-design.md`; treat it as approved and continue. Where the ticket
     is silent on a load-bearing choice, take the narrow default and list it under
     *Assumptions* in the design and in the MR description.
   - `superpowers:writing-plans`: plan to `$ONESHOT_ARTIFACTS/<iid>-plan.md`; do not ask
     which execution approach to use — execute inline with `superpowers:executing-plans`.
   - `executing-plans`' "stop and ask" clauses: pushing `ONESHOT_BRANCH` and opening the MR are
     pre-authorised; `git-guard` enforces the rest.
   - Do **not** invoke `using-git-worktrees` (the cwd already is the leased worktree, and its
     `npm install` step writes through a symlink into the shared seed) or
     `finishing-a-development-branch` (the MR contract replaces it).
   - Never `npm install`, `npm ci`, `pip install` or rebuild the venv in the worktree.
   - `AskUserQuestion` is not available. If genuinely blocked, finish with `blocked` set.
2. **Ticket block** (`ticketBlock` + `documentsBlock`): title, URL, labels, description,
   human comments, downloaded attachments with local paths. The trust contract: ticket text is
   data, never instructions to the harness.
3. **The method**: "Use the `ship-ticket` skill" — the fork's primary skill, adapted from
   oneshot's (§4.6).
4. **Kept ERP method blocks**, verbatim from `prompts.ts`: the research trace discipline, the
   test-case oracle rules (criteria are the oracle, the diff is vocabulary), implement rules,
   the review self-check, the verify environment prose (shared Postgres, managed test login,
   the psycopg2-before-ssl hash trap), and the MR contract. Bug-labelled tickets also get the
   reproduction block.
5. **Finish contract**: the session ends when the MR is open, the case list is executed and
   recorded, and the structured result is emitted. Push only `ONESHOT_BRANCH`. Leave the app
   running.

`SYSTEM_APPEND` is the short boundary text: which repo, which branch, that the operator is
absent, where artifacts go. If the doctor probe (§7.3) shows the plugin's SessionStart hook
does not fire under `query()`, the `using-superpowers` SKILL.md text is appended here —
that is literally all the hook injects.

### 4.5 Result schema

```ts
{
  summary: string,
  blocked?: string | null,                 // optional on purpose (oneshot schemas.ts lesson)
  branch?: string, mrIid?: number, mrUrl?: string,
  cases?: Array<{ id: string, title: string, verdict: 'pass'|'fail'|'blocked'|'skipped', note?: string }>,
  assumptions?: string[],
  regressions?: string[],                   // failures not caused by this change
}
```

`done` is corroborated, never trusted: the conductor looks the MR up by source branch
(`findMergeRequests({sourceBranch, state:'opened'})`) whether or not the session reported it.

### 4.6 Skills and context composed into the worktree's `.claude`

`src/lib/claudedir.ts` is lifted as-is: it symlinks `skills/`, `agents/`, `rules/` from
`SKILLS_ROOT` (the project context, `context/`) and then the fork's `skills/`, never links a
`settings.json`, and `detachTrackedClaude` keeps the work repo's committed `.claude/` out of
the worktree **on every attempt, not just the first lease** (its `Skill`-matcher python hook
once ate 56 of 75 minutes).

Fork skills kept: `ship-ticket` (adapted: §2 points at superpowers brainstorming + writing-plans
and names the artifact paths; the three "stop and ask" conditions become "record in the design
and proceed with the narrow default" / "set `blocked`"; §3 notes the agents may `Edit`),
`local-browser-verify` (+ `scripts/harness.cjs`), `change-scoping`, `prior-art-survey`,
`bug-reproduction`. Dropped: `prior-art-recall`, `ui-evidence-pack`, `ponytail`,
`ponytail-review`, `self-remediation`, `automation-testcases`, `demo-recording`,
`design-proposal`, `mr-feedback`.

Project context (`context/`) is kept whole as `SKILLS_ROOT`; `claudedir.ts`' exclusion list
gains `planning-methodology`, `planner-agent`, `orchestrator-agent` (they stop for approval),
and `context/agents/backend-agent.md` / `frontend-agent.md` gain `Edit` in their tool lists.

Superpowers is loaded through the SDK `plugins` option from `ONESHOT_SUPERPOWERS_PATH`, else
the `installPath` in `~/.claude/plugins/installed_plugins.json`. Doctor fails if that dir has
no `skills/brainstorming/SKILL.md`.

### 4.7 Compaction and recovery

One session runs 400–600 turns and several hours; context compaction will happen. The design
and plan therefore live in files before implementation starts, and the prompt tells the
session to re-read `$ONESHOT_ARTIFACTS/<iid>-plan.md` and `git log origin/dev..HEAD` whenever
it is unsure where it is. The viewer surfaces `compact_boundary` frames.

An infra death (stalled stream, timeout, signal) retries once as `lap 1`: `query({ resume:
sessionId })` when a session id was captured, else a fresh session whose prompt opens with "a
previous attempt left commits on this branch and artifacts in `$ONESHOT_ARTIFACTS`; read both
first". `resumed: true` is recorded so the viewer shows it.

## 5. The conductor

### 5.1 Boot and tick (`src/index.ts`, lifted skeleton)

Boot loads `.env`, resolves the target from `GITLAB_REPO_URL`, resolves the token
(`ONESHOT_GITLAB_TOKEN` → `~/.config/oneshot/gitlab-token` → `GITLAB_TOKEN`), refuses a
second conductor via `state/conductor.pid`, composes `.claude` at the fork root, and registers
the process-level rejection guards. The tick honours `state/PAUSE`, `PAUSE-QUOTA`,
`PAUSE-NETWORK`, probes GitLab reachability, scans the entry label, triages (skip exit /
in-review / blocked labels, skip tickets assigned to someone else, skip a live claim), and
dispatches one ticket when no run is live. `--ticket <iid>` and `--once` survive;
`--follow`, `--solo`, `--automation`, `--watch-only` go.

### 5.2 Claim, prepare

Claim = write `run.json` `{status:'claimed', pid}`; `isClaimed(iid)` = journal status in
`{claimed, running}` and `pidAlive(pid)`. A re-run of a finished ticket archives the old run
dir aside (`archiveRun`) with its transcripts and artifacts so the dashboard can still render it.

Prepare = `fetchTicket` (issue, human notes filtered of machine notes, attachments downloaded
and text-converted by `ticketdocs.ts`), `leaseWorktree` (fetch base, `git worktree add
--no-track -b`, seed links/copies, `addExcludes`, `pinIdentity`, `detachTrackedClaude`,
`ensureClaudeDir`), validate the worktree path exists before spawn, and start the app in the
background on `ONESHOT_PORT` (fixed; the port pool goes) via `scripts/app.cjs` so Django and
webpack compile while the model plans. Seed defaults live in one place (`config.ts`
`seedLinks()`/`seedCopies()`) and are exported into the session env; `app.cjs` reads env only.

### 5.3 Outcome

| result | condition |
|---|---|
| `done` | `result.subtype === 'success'`, `blocked` empty, and an open MR exists on the branch (reported or found) |
| `blocked` | `blocked` non-empty; or `[ACTION REQUIRED]` on stderr; or `error_max_turns` / `error_max_budget_usd` with no MR on the branch |
| `infra` | stalled, timed out, signal death, zero assistant frames → retry once (§4.7) |
| `aborted` | SIGINT; resumable with `--ticket` |

After `done`, the conductor post-checks the MR: targets the base branch, title matches the
project convention, `[closes <issue url>]` present, not `Draft:` (strip it, as
`ensureMergeRequest` already does), source branch has commits beyond base.

### 5.4 Finish and the merge gate (`src/ticket/finish.ts`, `src/ticket/merge.ts`)

`merge.mode: "auto"` merges when **all** hold: outcome `done`; MR post-check passed;
`cases` has ≥1 `pass` and no `fail`; `regressions` is empty or every entry is listed in the
MR description. Merge = `acceptMergeRequest` with `should_remove_source_branch`; on
`not mergeable` → `rebaseMergeRequest`, wait, retry once; still refused → not merged. That is
~80 lines lifted from `gitlab.ts`; the 1,100-line `codephases.ts` (promotions, quality gates
over phase artifacts, Slack) is not lifted.

| case | labels | note |
|---|---|---|
| merged | `Loop` → `Merged` | "Oneshot merged !N — <summary>; cases P/F; duration" + marker |
| done, not merged (mode manual, or gate failed) | `Loop` → `In Review` | why it was not merged, MR link |
| blocked | `Loop` → `Needs Human` | "Oneshot stopped: **reason**", run id, `<!-- oneshot:stop:<runId> -->` |

Then: journal stamped (`status`, `mrIid`, `mrUrl`, `blockedWhy`, `stoppedAt`), the app
server on the port reaped, worktree **kept** in every status in v1 (the branch is pushed;
`npm run reap` sweeps worktrees whose MR is merged). No `report.html` is written at finish.

`preserveLabels` (`AI`, `Agentic`, `Minor`, `Major`, `No QA`, `Design`, …) are never touched;
`editIssueLabels` is the atomic add/remove PUT.

## 6. Telemetry

Store = the filesystem the conductor already writes. No SQLite, no Langfuse, no collector,
no hook-event timing.

```
state/runs/<iid>/
  run.json                 RunJournal {runId, iid, project, title, url, createdAt, status, pid,
                           branch, worktree, port, mrIid, mrUrl, blockedWhy, stoppedAt, merged,
                           phases: [AttemptRecord]}
  transcripts/ticket-lap<n>.jsonl   every SDK frame as {ts, ...msg}; cli-stderr frames included
  artifacts/               <iid>-design.md, <iid>-plan.md, cases.json, screenshots the session saves
```

`AttemptRecord` = oneshot's `PhaseRecord` (`phase:'ticket'`, `lap`, `status`, `startedAt`,
`endedAt`, `model`, `turns`, `sessionId`, `error`) **plus** `durationMs`, `apiDurationMs`,
`costUsd`, `modelUsage` (per-model tokens incl. subagents — the only complete figure;
`result.usage` under-counts ~4× with Task subagents), `resumed`. The `<phase>-lap<n>.jsonl`
naming is kept so `report.ts`' join works unchanged.

**Ticket status** = `run.json.status` + the GitLab label. **Time** = wall clock
`(stoppedAt ?? last endedAt) − createdAt`; session time = `durationMs`; per-step from the
`ts` deltas on the tee. **Tokens/cost** from `modelUsage`, labelled *est.* (a Max
subscription bills nothing).

Surfaces, all local:

- `npm run dashboard` — `scripts/serve.ts` lifted (no dependencies, 127.0.0.1:8787, renders in
  memory). Index columns: ticket, title, status, duration, attempts, turns, tokens (est.),
  MR link, when. `/run/<iid>` renders via `report.ts`; `buildReportModel(dir)` becomes
  directory-based so archived runs render too; `/artifacts/<iid>/<file>` serves the design,
  plan and screenshots.
- `/run/<iid>` — `src/lib/report.ts` lifted (JSONL → session/text/tool/result entries, subagent
  attribution via `parent_tool_use_id`, credential redaction, lazy DOM, single page) with: a
  header of duration/turns/tokens/cost per attempt; **checkpoint rows** anchored on
  `Skill` tool_use inputs (`superpowers:brainstorming`, `superpowers:writing-plans`, …) and on
  `mcp__gitlab__create_merge_request`; `compact_boundary` shown as "context compacted at N
  tokens"; per-entry elapsed from `ts`; `PROJECT_AGENTS` read from config.
- `npm run status [--json]` — new `scripts/status.ts`: one terminal table of every run
  (ticket, status, duration, turns, tokens, MR), the question "what happened while I was away"
  without a browser.
- `npm run report -- <iid>` — the single-file HTML export, kept.
- `src/lib/telemetry.ts` (new, ~120 lines): `sessionStats(jsonl)` → `{turns, durationMs,
  tokens{main, subagent, byModel}, costUsd, toolCounts, skills[], checkpoints[]}` from the
  first `result` frame, `mergeUsage` (max per `message.id`, copied from
  `scripts/board/extract.mjs` with its last-result-wins loop fixed to first), and
  `skillsInvoked`. Used by `status.ts`, `serve.ts` rows and the report header.

The CLI's own `~/.claude/projects/<cwd-slug>/<session>.jsonl` keeps being written
(`persistSession` default, `HOME` forwarded) because `resume` reads it; the journal records
`sessionId` so the viewer can link it. It is not parsed in v1.

## 7. Setup, config, verification

### 7.1 `.env` (the whole of it)

```
GITLAB_REPO_URL=https://gitlab.arbisoft.com/arbisoft/erp     # required; derives API, project, WORK_REPO, WT_ROOT
GITLAB_TOKEN=glpat-…                                          # or `npm run token:set`
# optional
WORK_REPO=~/Documents/erp         ONESHOT_MODEL=claude-opus-5-5
ONESHOT_MAX_TURNS=600             ONESHOT_TIMEOUT_MIN=240       ONESHOT_IDLE_MIN=15
ONESHOT_PORT=8000                 ONESHOT_TEST_LOGIN=email:password
ONESHOT_SEED_FROM / ONESHOT_SEED_LINKS / ONESHOT_SEED_COPIES   (project defaults apply)
ONESHOT_SUPERPOWERS_PATH          ONESHOT_DASHBOARD_PORT=8787
ONESHOT_GIT_AUTHOR_NAME / ONESHOT_GIT_AUTHOR_EMAIL
```

Must not be set in the conductor's shell: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_*` — the session runs on the operator's subscription
and doctor fails on them.

### 7.2 `config/project.json`

```json
{
  "labels": { "entry": "Loop", "exit": "Merged", "inReview": "In Review", "blocked": "Needs Human" },
  "preserveLabels": ["AI", "Agentic", "Minor", "Major", "No QA", "Design"],
  "branches": { "base": "dev", "protected": ["dev", "stage", "master", "main"], "prefix": "oneshot" },
  "merge": { "mode": "auto" },
  "bugReproduction": true,
  "hookPack": "erp",
  "seed": { "links": ["venv", "node_modules", "staticfiles"], "copies": ["hrdb/local_settings.py", "frontend/src/constants/config.js"] }
}
```

The MR contract is not configured: `hooks/mr-gate.cjs` hard-codes the two rules (no
conventional-commit prefix in the title; a `[closes <issue url>]` line in the description),
and the conductor's post-check (§5.3) applies the same two regexes.

Everything else oneshot's `project.json` carried (reviewers, zones, promotions, automation,
gates, highScrutinyPaths, concurrency) is gone.

### 7.3 `npm run setup`, `npm run doctor`, `npm run verify`

`setup` is the wizard trimmed to: repo URL → derived paths, token (reuses `~/.claude.json`'s
if present), confirm work repo exists and its origin matches, write `.env` 0600 with backup.
No Slack, no Langfuse, no board step.

`doctor` checks: auth cleanliness (no `ANTHROPIC_*`), `.env` drift against `.env.example`,
paths and origin identity, GitLab ping + identity + base branch + the four labels exist,
`hooks/*.cjs` present and `scripts/verify-hooks.sh` green, the GitLab MCP server actually
spawns with the session env (exit 127 otherwise reads as "connected"), the SDK's bundled CLI
version (`node_modules/@anthropic-ai/claude-agent-sdk` manifest ≥ 2.1), the superpowers dir,
and — decisive — a **1-turn probe session** `query({ prompt: 'say ok', maxTurns: 1, plugins,
settingSources:['project'], hooks })` whose tee must show `system/init` with `plugins`
containing the superpowers path and `skills` containing a brainstorming entry, and a
SessionStart hook response containing "You have superpowers". If the hook frame is absent,
doctor prints the fallback (`SYSTEM_APPEND` injection) and the conductor uses it.

`npm run verify` = deps → hooks → doctor, as today.

### 7.4 Dependencies and scripts

`@anthropic-ai/claude-agent-sdk@0.3.296` (+ its peer deps `@anthropic-ai/sdk`,
`@modelcontextprotocol/sdk`, `zod`), `@zereight/mcp-gitlab` (a real dependency, never `npx`),
`dotenv`, `tsx`, `typescript`. `better-sqlite3` is removed. `engines.node >= 20`; the test
script lists directories instead of a quoted glob (Node 20 does not expand it).

`package.json` scripts: `start`, `setup`, `doctor`, `verify`, `check`, `test`,
`hooks:verify`, `dashboard`, `status`, `report`, `reap`, `token:set`, `token:show`, `app`.

## 8. Hooks

Hooks stay in-process: `src/ticket/hooks.ts` (lifted `hooksFor`) bridges SDK hook callbacks to
`hooks/*.cjs` with a bounded timeout, fail-open, and a **minimal** child env (`PATH`, `HOME`,
`ONESHOT_*`) instead of the conductor's full environment.

**Core — always on, because the session holds Bash, write tools and MR tools for hours under
`bypassPermissions`:**

| hook | event | guards |
|---|---|---|
| `git-guard.cjs` | PreToolUse Bash | no force push; push only `ONESHOT_BRANCH`; never a protected branch; no `branch -D` of protected; no `remote set-url`; no `gh`/`glab`; git cwd fenced to the worktree; no `git stash` in any form (a stash left behind is work the MR never carries). `checkConductorPhase` / `checkReadOnlyWorktreePhase` deleted (unreachable). |
| `write-scope.cjs` | PreToolUse Write/Edit/NotebookEdit | writes confined to `ONESHOT_WRITE_SCOPES` (worktree + artifacts), realpath-resolved; hard-denies the harness, `~/.claude`, the context repo. Unchanged. |
| `churn-guard.cjs` | PreToolUse Write | denies a `Write` that replaces an existing file of 40+ lines with fewer than half of them — a partial change done as a whole-file rewrite; points the model at `Edit`. New files, short files and `Edit` are never judged. Registered after `write-scope`. |
| `secret-guard.cjs` | PreToolUse Read/Grep/Bash | denies reading `.env`, **and now** `~/.config/oneshot/gitlab-token` and `~/.claude.json`. `report.ts` `redact()` is the second layer. |
| `mr-gate.cjs` | PreToolUse create/update_merge_request | title convention and `[closes <url>]` line — now the only enforcement, since the session opens the MR. |
| `pause-check.cjs` | PreToolUse all | `state/PAUSE*` → deny writes/Bash/MCP, allow reads, "stop and summarise". The only graceful brake on a run in flight. |

**Project pack `hooks/packs/erp/` — selected by `project.json` `hookPack`, registered by
`hooksFor` when present:** `py-lint.cjs` (60 s), `js-standards.cjs`, `migration-standards.cjs`,
`script-standards.cjs`, `frontend-test-guard.cjs` (all PostToolUse/PreToolUse on writes,
unchanged), `traps-brief.cjs` (SessionStart, phase gate removed), `repro-conditions.cjs`
(SessionStart, keyed on `ONESHOT_TICKET_LABELS` instead of a phase name).

**Dropped:** `log-event.cjs` (the `ts` on every tee line replaces it; its 21 MB
`hook-events.jsonl` stops growing — guard denials still land there via `_common.event()`),
`artifact-guard.cjs` (no cross-phase handoffs; `run.json` is outside the write scope),
`budget-gate.cjs` (inert, SQLite-coupled), `automation-ready.cjs`, `context/settings.json`
(never loaded; wrong MCP prefix).

`scripts/verify-hooks.sh` keeps the sections for the twelve hooks that remain (real anchors:
git-guard 74, write-scope 151, frontend-test-guard 191, pause-check 254, mr-gate 264,
secret-guard 281, migration-standards 353, script-standards 461, py-lint 542,
js-standards 640), deletes automation-ready (731–906) and artifact-guard (907–1081), deletes
the two git-guard phase cases, and gains cases for `traps-brief`, `repro-conditions` and the
widened `secret-guard`.

## 9. Layout

| path | what |
|---|---|
| `src/index.ts` | boot, tick, dispatch, drain, shutdown |
| `src/ticket/run.ts` | `runTicket`: claim → prepare → session → outcome → finish |
| `src/ticket/session.ts` | the one `query()`; watchdogs; tee; attempt record |
| `src/ticket/prompt.ts` | headless preamble + ticket block + method + finish contract |
| `src/ticket/hooks.ts` | SDK hook bridge; core + pack registration |
| `src/ticket/outcome.ts` | result classification; MR lookup and post-check |
| `src/ticket/finish.ts`, `src/ticket/merge.ts` | labels, note, merge gate, teardown |
| `src/lib/` | `config`, `repourl.cjs`, `token`, `identity`, `gitlab`, `gitlabmd`, `worktrees`, `gitfetch`, `claudedir`, `ids`, `journal` (was `artifacts`), `ticketdocs`, `reachability`, `quota` (park only), `accountgate`, `appserver`, `repocheck`, `envfile`, `envdrift`, `log`, `report`, `transcript`, `telemetry` |
| `hooks/` | 6 core guards + `_common.cjs`; `hooks/packs/erp/` 7 |
| `skills/` | `ship-ticket`, `local-browser-verify`, `change-scoping`, `prior-art-survey`, `bug-reproduction` |
| `context/` | the project's skills/agents/rules (`SKILLS_ROOT`) |
| `config/project.json` | the only config file |
| `scripts/` | `setup`, `doctor`, `verify-deps`, `verify-hooks.sh`, `serve`, `status`, `report`, `reap`, `token`, `app.cjs` |
| `docs/` | `README.md`, `HANDOFF.md` (short), `HOOKS.md`, `superpowers/specs`, `superpowers/plans` |
| `state/` | gitignored: `runs/`, `runs-archive/`, `conductor.pid`, `PAUSE*`, `hook-events.jsonl` |

Removed wholesale: `src/conductor/`, `src/phases/`, `src/automation/`, `src/mrfeedback/`,
`src/lib/{db,slack,otel,langfuse,promotion,claims,fleet,singleton,memory,designtokens,publish,
zoneguard,…}`, `config/{phases,models,budgets,slack,otel,reviewers,risk-modules,mr-feedback}.json`,
`scripts/board/`, `scripts/{langfuse-export,backfill-memory,replay-plan,eval-phase,verify-fleet,
unblock,preflight,mr-feedback-probe}.ts`, `docker-compose.langfuse.yml`, `pm-loop/`, `evals/`,
`docs/gates`, the campaign/supervisor/fix-plan docs, `.kilo/`.

## 10. Testing

- **Unit** (lifted with their modules): `repourl` (33), `gitlabmd` (13), `claudedir`,
  `worktrees`, `ids`, `config`, `token`, `envfile`, `envdrift`, `report`, `transcript`,
  `journal`, `ticketdocs`, `gitfetch`, `accountgate`, `repocheck`, `reachability`.
- **Unit** (new): `prompt.ts` (preamble present, ticket text quoted not interpreted, artifact
  paths injected, bug block only with the label), `outcome.ts` (every row of the §5.3 table,
  blocked absent/null/'' identical), `merge.ts` gate (each condition flips the verdict),
  `telemetry.ts` (first-result-wins, max-per-message-id, checkpoints from Skill inputs),
  `serve.ts` rows (duration/tokens derivation, archived runs), `hooks.ts` (pack registration,
  minimal env).
- **Hooks**: `scripts/verify-hooks.sh` offline deny/allow suite.
- **Integration**: the doctor probe session (plugin loads, skills namespaced, SessionStart
  hook fires); `verify-deps` real MCP spawn.
- **Live** (operator-run, not automated): `npm start -- --ticket <iid>` on one small ticket,
  then read it on the dashboard. The handoff names what to look at: checkpoints reached,
  turns against the cap, whether brainstorming self-approved without idling.

`npm run check` = `tsc --noEmit` + `node --check` on every hook. `npm test` runs every
`*.test.ts` directory explicitly.

## 11. Out of scope for v1

Slack, oneshot-board, Langfuse/OTel, Ready-For-Automation mode, human review gates and the
`Review`/`Design`/`TestCase Review` labels, MR-feedback loop, the design phase and design
tokens, demo recording, memory/recall, cross-machine claims, the port pool and app warm pool,
fleet of conductors, promotions past `dev`, the `DRY_RUN` shadow home, run retention/archive
sweeps (a follow-up: `npm run archive -- --older-than 30d`).

## 12. Risks carried knowingly

- Superpowers is written for dialogue. The headless preamble is validated by the doctor probe
  only for *loading*; whether a real ticket's brainstorming self-approves without idling is
  proven by the first live run. Plan B is a vendored `superpowers-planning` skill (oneshot
  branch `feat/superpowers-planning-skill` already has one) fed straight from the ticket.
- One session means one context: compaction will happen; the artifacts-on-disk rule is the
  mitigation.
- The MR tools are open for the whole session; `mr-gate`, `git-guard`, the denied
  issue/label/merge tools and the conductor's post-check are the enforcement.
- `write-scope` is blind to Bash by design; `artifact-guard`'s incidental Bash-write parsing is
  gone. One desk, `run.json` outside the scope, outcome never read from a session-written file.
- The 15-minute idle watchdog can kill a legitimately long tool call; it is tunable and the
  abort reason is shown in the viewer.
