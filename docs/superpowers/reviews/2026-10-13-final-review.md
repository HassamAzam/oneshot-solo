# Final whole-branch review — Oneshot Solo (`solo`, d00a993..9df8734)

Reviewed read-only, in passes: spec, plan, ledger; then every file in `final-review-files.txt` read in full from the working tree (the diff was used only to confirm which files were modified vs added); `git log`, `git diff --stat`, and the installed `@zereight/mcp-gitlab@2.2.4` / `@anthropic-ai/claude-agent-sdk@0.3.296` sources where a claim depended on them. No tests were run; no subagents were dispatched. Line numbers are from the working tree at 9df8734.

## Strengths

- **The env allowlist is real and tested at every layer.** `BASE_ENV` is built from a whitelist (`config.ts:402-449`), `sessionEnv` composes only named values (`session.ts:142-161`), the GitLab token reaches only the MCP server env (`session.ts:179-198`), `guardEnv` gives guard children four names (`hooks.ts:84-91`), and doctor asserts both `ONESHOT_PHASE=ticket` and the absence of any credential key or token *value* in the session env (`doctor.ts:364-371`).
- **`DENIED_TOOLS` is derived from the server, not guessed.** `types.test.ts:33-44` re-reads mcp-gitlab's registry and fails the suite if a write tool is exposed that is not denied — a genuine tripwire against a version bump.
- **Two layers on the MR contract and the merge**: `mr-gate.cjs` at the call, `mrPostCheck` after the session, and `mergeNow` merges at the evaluated sha with one rebase and no retry on a stale sha (`merge.ts:52-80`). The gate reads only data the conductor holds.
- **The session watchdogs survived the lift intact**: first-result-frame settles, force-settle after any abort, idle watchdog, the `[ACTION REQUIRED]` gate read only off a session that did not succeed (`session.ts:248-258`), the stderr buffer bounded at both ends.
- **The MCP shim is proven by a real stdio spawn** uploading a relative path to a fake GitLab (`session.test.ts:76-135`), which is exactly the failure class ("connected, zero tools") the design warns about.
- **Guards fail open loudly** with `FAIL_CLOSED` kept as a named, empty hatch; the bridge spawns the same `.cjs` files the suite tests, so there is one policy implementation.
- **Dashboard hygiene**: loopback bind, archived-name validation, realpath-inside-root for artifacts with `nosniff`, `<` escaped in the embedded payload, literal-secret redaction ahead of the shape rules (`report.ts:150-172`).
- **`run.json` outside every write scope**, atomic add/remove label PUTs, the `parked` → `aborted` → resume loop, and the lookup-failed retry all match their rulings.
- **The ledger is unusually honest**: every deviation has a ruling, every reviewer leftover is written down, and the three items deferred to a fix wave are named as such.

## Issues

### Critical

None found.

### Important

**I1. `resume` is never captured on the paths that need it — retry-with-resume and Ctrl-C resume always start a fresh session.**
`src/ticket/session.ts:380-381` is the only place `out.sessionId` is set, and it is inside the `msg.type === 'result'` branch. Every attempt that ends `infra` (stalled, timed out, signal death), `aborted` (Ctrl-C) or `parked` (quota) ends *without* a result frame, so `out.sessionId` is undefined, `attemptLoop` (`run.ts:109`) sets `resume = undefined`, and `lastSessionId` (`run.ts:157-159`) finds nothing on the next boot. The journal then records `resumed: false` for every real resume, so the dashboard cannot show the loss. README ("the same Claude conversation where a session id was recorded"), HANDOFF and spec §4.7 promise the opposite. `run.test.ts` cannot see this because its fake `runSession` returns `sessionId` on infra.
*Why it matters*: a 3-hour session that stalls at hour 3 restarts from the design/plan files with no conversation; a quota park mid-ticket does the same. The fallback works, so this is a silent 2× cost, not a wrong result.
*Fix*: every SDK frame carries `session_id` (`sdk.d.ts`: all `SDKMessage` variants). In the consume loop, `if (!out.sessionId && typeof (msg as {session_id?: string}).session_id === 'string') out.sessionId = msg.session_id;` before the result branch. Add a unit that folds a frame list with no result frame and asserts `sessionId` is set (extract the per-frame fold from `runSession` to make that testable).

**I2. Three rulings "deferred to the final fix wave" are unimplemented, plus the doc items the ledger routed to the same wave.**
- `run.ts:204-210`: a fresh run over a ticket whose worktree still exists builds the lease by hand (no re-seed, no `pinIdentity`) and, when the previous run was `done` + `merged: true`, continues on the **merged** branch (remote-deleted by `should_remove_source_branch`). Ruling: re-attach through `leaseWorktree(runId, branch, basename(recorded))`; merged → reap and cut fresh from base. Note the fix must also handle `leaseWorktree`'s `branchExists → git worktree add <wt> <branch>` path (`worktrees.ts:331-334`): after `npm run reap` the local merged branch survives, so a fresh lease under the same name would re-attach it, and `-b` would fail "already exists". Either delete the local branch when its MR merged, or derive a new branch name (suffix the run id) for a re-run.
- `merge.ts:20-22`: "no case recorded a pass" is still reported ahead of failed cases; `finish.test.ts:44-47` still uses the pass+fail fixture with the comment explaining why. Ruling: swap, and restore the lone-fail fixture.
- `index.ts:164-168` / `run.ts:174-179`: `--ticket <iid>` is still refused inside the 30-minute blocked cooldown. Ruling: bypass for the explicit action.
- `README.md:154` ("five core guards") and `:205` ("5 core guards"); spec §2 table and §8 table lack `churn-guard`; `hooks/write-scope.cjs:52-56` and `skills/local-browser-verify/scripts/harness.cjs:112-120` still cite `config/phases.json`; `config.ts:266-271` `seedFrom()` comment contradicts the seed ruling; `hooks/_common.cjs:43-47` says hooks are "installed user-wide in ~/.claude/settings.json".
*Why it matters*: the branch is known-incomplete by the controller's own ledger; the merged-branch re-run is the one with a behavioural cost (a re-labelled merged ticket produces an MR from a stale, already-merged branch).

**I3. The GitLab token and the test login reach the Django/webpack process tree.**
`src/lib/appserver.ts:47-49` spawns `app.cjs` with `{ ...process.env, ...env }`; `process.env` holds `GITLAB_TOKEN` (dotenv at `config.ts:27`) and `ONESHOT_GITLAB_TOKEN` if set. Independently, `scripts/app.cjs:45` loads `ONESHOT_HOME/.env` itself and spawns Django/webpack with `{ ...process.env, ... }` (`app.cjs:557, 645`), so the token is in the environment of two long-lived processes the session drives and can list (`ps -E`/`ps eww <pid>` on macOS shows own-user process environments), and of the Django app under test, whose code the session edits. `hooks/secret-guard.cjs:8-13` and `docs/HOOKS.md` state the token "travels only into the MCP server's own subprocess", which is no longer true.
*Fix*: in `appserver.ts` build the child env from `BASE_ENV` + `projectSessionEnv()` + the three `ONESHOT_*` (app.cjs reads env only per spec §5.2); in `app.cjs`, delete the credential keys (`GITLAB_TOKEN`, `ONESHOT_GITLAB_TOKEN`, `ONESHOT_TEST_LOGIN`, `ANTHROPIC_*`, `CLAUDE_CODE_*`) from the env handed to Django and webpack after its own dotenv load. Doctor could assert the Django listener's env is clean the way it asserts the session env.

**I4. `secret-guard` misses three credential files the harness itself creates or reads.**
- `scripts/setup.ts:145` writes `.env.bak-YYYYMMDD-HHMMSS` (`envfile.ts:33-42`) holding `GITLAB_TOKEN` and `ONESHOT_TEST_LOGIN`. `secret-guard.cjs:47-52` compares realpaths against exactly `.env`, and `CANDIDATE` (`:77`) requires the path to *end* in `.env`, so `cat $ONESHOT_HOME/.env.bak-*` and a `Read` of it are allowed. `.gitignore` keeps them out of git, not out of a transcript.
- `~/.config/glab-cli/config.yml` is token source #4 in `token.ts:88-97` and is not in `DENIED`.
- The macOS keychain source (`token.ts:80-86`) is one Bash line away: `security find-generic-password -s oneshot-gitlab -w`.
*Why it matters*: these are the harness's own token locations; a session that reaches for "where is the token" finds them in `token.ts`'s docblock. `report.ts` `redact()` catches `glpat-` on the dashboard but not in the CLI's own `~/.claude/projects` jsonl.
*Fix*: deny any path whose basename starts with `.env.` except `.env.example` under `ONESHOT_HOME` (both the `Read` and the Bash branch), add the glab config file to `DENIED`, add a Bash rule for `security find-generic-password`. Add suite cases.

**I5. Usage-limit detection on model prose can abort a healthy session and park the conductor.**
`session.ts:346-357` runs `looksLikeUsageLimit` over every assistant text block; `:388-392` feeds the final prose of a no-structured-output success into `limitSignals`. `quota.ts:33-39` matches `resets at 12 am` and `hit the session limit`. On this project (HR/leave/payroll) an assistant writing "the leave balance resets at 12:00 am on 1 January" aborts the session, parks the conductor until midnight (`parseResetMs`), journals `aborted`, and — because of I1 — resumes as a fresh session. The comment at `:342-345` says the real cap arrives as frames tagged `error: "rate_limit"`, which is the reliable signal.
*Fix*: short-circuit only on `errTag === 'rate_limit'` (or a non-empty `msg.error`); keep the prose matcher for `thrown`/`result.errors[]`, never for model text. Add a test with an assistant frame containing "resets at 12 am" that must not park.

**I6. The session's GitLab reach is the whole token, not the project; mr-gate does not pin the branches.**
`session.ts:179-198` starts mcp-gitlab with `GITLAB_PERMISSION_MODE=full` and no project scope (2.2.4 has no `GITLAB_PROJECT_ID`; it has `GITLAB_DENIED_TOOLS_REGEX` and `ENABLE_STRICT_PROJECT_SCOPE`). Every allowed tool — `create_merge_request`, `update_merge_request`, `create_merge_request_note`, `upload_markdown`, and all read tools — takes a `project_id` the session chooses, so it can open an MR, comment, or upload on any project the operator's `api` token reaches, and read any private repo into the transcript. `hooks/mr-gate.cjs:35-78` checks title and the closes line only: a `create_merge_request` with `source_branch: dev, target_branch: master` on the right project passes the hook, is never found by `findOpenMr`, and is left open for a human to close.
*Fix*: export `ONESHOT_PROJECT=<group/project>` and `ONESHOT_PROJECT_ID=<numeric, from resolvedProjectId()>` in `sessionEnv` (ONESHOT_* reaches guards); mr-gate denies a `project_id` matching neither, denies `source_branch !== ONESHOT_BRANCH` and `target_branch !== base` on create, and matches `create_merge_request_note`/`upload_markdown` for the project check. Server side: `GITLAB_PERMISSION_MODE=modify` (drops delete/teardown even if `disallowedTools` is bypassed) and a `GITLAB_DENIED_TOOLS_REGEX` mirroring `DENIED_TOOLS` cost nothing.

**I7. Identity is resolved once at boot; GitLab down at boot means assigned tickets are skipped for the life of the conductor with the wrong hint.**
`index.ts:144` → `checkIdentity()` → `identity.ts:173` caches the username only on success; nothing re-asks. Boot does not require GitLab (`bootChecks` makes no call), the VPN "drops" (reachability.ts docblock), so a conductor started before the tunnel is up runs for hours logging `assigned ticket, but this desk has no GitLab identity (npm run token:set)` (`scan.ts:61-63`) for every assigned ticket, and the operator is told to fix a token that is fine.
*Fix*: in `tick()`, when `gitlabUsername() === ''` and `probe()` reports ok, call `checkIdentity()` again (cheap, once per tick until it resolves); change the skip reason to say GitLab has not yet answered who the desk is.

**I8. `ship-ticket` §0/§3 contradict the prompt on the one command the session runs most.**
`skills/ship-ticket/SKILL.md:131` says "After the change lands, `node scripts/app.cjs ensure --ref <your-branch>` again"; `:38` documents `--ref` as the interactive form ("checks the ref out into it"); `:65` gives `node skills/local-browser-verify/scripts/harness.cjs smoke`, a path that does not exist relative to the worktree. `src/ticket/prompt.ts:510-523` says the opposite: no arguments, "never `--ref`", and after a Python change `down --worktree $ONESHOT_WORKTREE` then `ensure`. The prompt declares the skill "the current version of the method" (`prompt.ts:756`). `--ref` from inside a leased worktree either moves a ref over uncommitted work or cold-starts a second app on another port, and the session then tests the wrong code.
*Fix*: rewrite §3's bullet to the prompt's `down` + `ensure` pair; drop the `--ref` paragraph from §0 or mark it "never inside a Oneshot run"; make the smoke path `$ONESHOT_HOME/skills/local-browser-verify/scripts/harness.cjs` (or the composed `.claude/skills/...` link).

### Minor

**M1.** `hooks/git-guard.cjs:154-183` cwd fence misses `(cd ~/Documents/erp && git commit …)` (first token is `(cd`), `$(cd …)`, `pushd`, `env -C`; `:212-215` denies `remote set-url` but not `git config --global url.<x>.insteadOf` (repoints origin around every rule); `git push origin --delete <own branch>` is allowed. Strip leading `(`/`{` in `tokens()`, add `pushd`, deny `config --global|--system` and any `insteadOf` key.

**M2.** `src/ticket/hooks.ts:84-91` `guardEnv` forwards every `ONESHOT_*`, which includes `ONESHOT_GITLAB_TOKEN` (token source #1) and `ONESHOT_TEST_LOGIN`, contradicting the docblock at `:22-24`. Exclude `ONESHOT_GITLAB_TOKEN`; doctor's credential check (`doctor.ts:367-371`) could cover `guardEnv(sessionEnv(...))` too.

**M3.** `src/lib/journal.ts:97-100` writes `run.json` in place. The dashboard reads it concurrently (a torn read → `readJournalFrom` null → "No run found" until refresh), and a crash mid-write loses the only state: the next boot sees no journal, claims fresh, and `transcriptPath(iid, 0)` *appends* the new attempt to the old lap-0 tee. Write to `run.json.tmp` and `renameSync`.

**M4.** `src/ticket/prompt.ts:565-567` "`/admin` is available if you need to reset a password" sits forty lines below the block that says a password write is the trap that poisons login and "NEVER reset, change, or re-pin". Delete the clause. (Ledger deferred minor; one line.)

**M5.** `.env.example` lacks `ONESHOT_SUPERPOWERS_INJECT` and `ONESHOT_MERGE` (both documented in README and HANDOFF), `CONTEXT_REPO` and `ONESHOT_SKILLS_ROOT` (read by `config.ts:243, 251` and the hooks). `envDrift` reports them as `unknown` and doctor does not print `unknown`, so there is no false warning, but the template is the documented contract.

**M6.** `src/ticket/prompt.test.ts:18` asserts `!p.includes('reproduce the bug')` against a heading that reads "Reproduce the bug first" — case-sensitive, so it can never fail. Assert the heading.

**M7.** `ONESHOT_TEST_LOGIN` travels twice: in the session env (`session.ts:157`, spec §4.2) and verbatim in the prompt (`prompt.ts:87-98`). The prompt copy lands in the CLI's own `~/.claude/projects/<slug>/<session>.jsonl` and is replayed on every `resume`. The prompt could say "read `$ONESHOT_TEST_LOGIN`" and keep the value out of the text.

**M8.** `src/index.ts:113-114`: a pid file whose pid was reused after a reboot (or belongs to another user — `pidAlive` counts EPERM) refuses boot, and neither README nor HANDOFF says `rm state/conductor.pid`. Add the hint to the refusal text.

**M9.** `session.ts:188` hands the MCP server the whole `BASE_ENV`, which carries `CLAUDE_CODE_OAUTH_TOKEN` when the desk is headless. The GitLab server has no use for it; pick `PATH`, `HOME`, `LANG`, `TMPDIR` explicitly.

**M10.** `types.ts:18` schema description ("ONLY when no retry would help") vs prompt (`blocked` = "cannot be built as written", also the not-reproduced verdict at `prompt.ts:136-138`). Align the schema text with the prompt; the schema is what the model reads last.

**M11.** `src/ticket/run.ts:227-233`: `finish()` throwing after `mergeNow` succeeded re-runs `finish` as `blocked`, relabelling a merged ticket `Needs Human`. Guard: skip the second finish when the journal is already terminal (`done`). (Ledger deferred minor.)

**M12.** `src/lib/report.ts:67-71` reads `ONESHOT_PROJECT_AGENTS` from env with an ERP default; spec §6 says "`PROJECT_AGENTS` read from config". Either add `agents` to `config/project.json` or amend the spec.

**M13.** `preserveLabels` (`config/project.json:4`, `config.ts:62,83`) is parsed and never read; it is true by construction (add/remove PUT), but the README row "never touched by a label swap" implies enforcement. Say so, or drop the key.

**M14.** `scripts/app.cjs:1010-1013` writes `app-env.json` to `state/runs/<iid>/harness/`, which is outside the session's write scopes (worktree + `artifacts/`). It works because app.cjs writes it from Bash, but `harness.cjs:112-120` and `local-browser-verify/SKILL.md:22` still describe it as inside the scope; a session that tries to `Write` beside it will be denied with a message about phases.

**M15.** After a force-settle the SDK sends SIGTERM and escalates to SIGKILL after 5 s (`sdk.mjs`), so the wedged CLI does die — but a long Bash child of the dead session (a Playwright run) is orphaned and keeps executing in the worktree while the retry attempt starts in the same directory. Worth a sentence in HOOKS/HANDOFF; a `pkill -P` of the CLI's children before the retry is the full fix.

**M16.** `src/lib/telemetry.ts:55-58, 88-89` counts input + output tokens and ignores cache read/creation tokens; the index says "Tokens (est.)" so it is honest, but the per-model figure will read low next to the SDK's own cost. Document which tokens are counted.

**M17.** Docs/comments left stale by the lift (beyond I2): `hooks/git-guard.cjs:32-34` ("enforced as a phase gate"), `hooks/_common.cjs:43-47`, `hooks/packs/erp/py-lint.cjs:43`, `frontend-test-guard.cjs:65,88`, `scripts/verify-hooks.sh` phase comment, `src/lib/claudedir.ts:4-13` (recall/qa/demo phases), `src/lib/appserver.ts:9-13` (verify/ui-evidence), `src/lib/accountgate.ts:60` (`npm run unblock`, a script Solo does not have).

## Deferred-minor triage

| ledger line | verdict |
|---|---|
| T1: .gitignore no longer lists state-dry/ | leave (nothing references it) |
| T1: skills/beta-version-toggle still present | leave (ruled; deleted in 0898f7e) |
| T2: config.test.ts BASE_ENV test asserts nothing | leave (test quality; note for a follow-up) |
| T2: sessionCaps accepts whitespace/negative values | leave (doctor fails non-positive caps) |
| T2: superpowersPath does not check the dir exists | leave (boot and doctor check) |
| T2: superpowersPath test leaks two tmp dirs | leave |
| T3: readToken() inside call()'s try reports missing token as network | leave (unreachable after boot) |
| T3: quota park untested | leave |
| T3: `parsed_reset` naming | leave |
| T3: log.info('network_degraded') duplicates | leave |
| T3: ticket.test.ts does not restore fetch/env | leave |
| T4: journal.test.ts writes live state/ | leave (resolved by the STATE ruling) |
| T4: worktrees exclusion tests depend on real SKILLS_ROOT | leave |
| T4: warn lines in test output | leave |
| T4: assertComposed covers skills only | leave |
| T4: config.ts seedFrom() doc comment stale | must-fix (docs; part of the fix-wave sweep, I2) |
| T5: dead-run wall clock lastEnd||lastSeen vs Math.max | leave |
| T5: ReportModel.summary nullable | leave |
| T5: runId/status not re-cleaned in summary | leave |
| T5: isMain adds realpathSync | leave |
| T5: report.ts grew to 881 lines | leave |
| T5: fmtDuration shows seconds | leave |
| T5: ONESHOT_STATE_DIR not read by hooks | leave (doctor warns, as ruled) |
| T6: stale comments in moved pack hooks | leave (fold into the M17 sweep if convenient) |
| T6: SDK timeout == kill timeout race | leave (fail-open either way) |
| T6: hooks.test.ts deletes ONESHOT_* without restore | leave |
| T6: packManifest unvalidated shape | leave |
| T6: stdin EPIPE listener | leave |
| T6: verify-hooks.sh stale phase comment | leave (M17) |
| T8: prompt.test 'reproduce the bug' assertion cannot fail | must-fix (one line, M6) |
| T8: `blocked` has competing definitions | leave (M10, recommend aligning) |
| T8: '/admin is available to reset a password' contradicts managed login | must-fix (one line, M4) |
| T8: ONESHOT_TEST_LOGIN password lands in prompt/transcript | leave (inherited; M7 recommends env-only) |
| T8: types.test imports the server registry by internal path | leave (it is the tripwire) |
| T9: loop keeps pulling frames after the settling result | leave |
| T9: rate_limit-tagged frames always park | leave |
| T9: free prose on a no-structured-output success feeds looksLikeUsageLimit | must-fix (folded into I5) |
| T9: no test for the `signal` infra branch | leave |
| T9: session.test.ts leaks env | leave |
| T9: heartbeat only on frames | leave |
| T10: findOpenMr read-back failure falls back silently | leave (sha pin protects) |
| T10: ci_still_running + 405 → pointless skip_ci rebase | leave |
| T10: empty regression string counts as listed | leave |
| T10: merge.test deps cast as never | leave |
| T11: abort check before (not during) 20 s sleeps | leave |
| T11: finish() throwing midway re-runs finish as blocked | leave (M11 recommends the terminal guard) |
| T11: three extra boot checks | leave (accepted) |
| T11: getIssue failure returns 'aborted' without a journal | leave |
| T11: log noise in test output | leave |
| T12: app.cjs per-variable seed fallback | leave (accepted) |
| T12: doctor scrapes core guards from hooks.ts by regex | leave |
| T12: setup reconfigure keeps a stale ONESHOT_SEED_FROM | leave |
| T12: reap.ts untested | leave |
| T12: setup always writes the token into .env | leave — but the `.env.bak-*` it creates is I4 (must-fix) |
| T14: `git -c k=v stash` evades | leave |
| T14: `git -C stash stash list` false positive | leave |
| T14: no boundary cases at MIN_LINES | leave |
| T14: relative file_path theoretical | leave |
| Post-merge: README '5 core guards'; spec §8 lacks churn-guard; write-scope.cjs:54 and harness.cjs:117 cite config/phases.json | must-fix (I2) |

## Ruling check

| ruling | implemented | verdict |
|---|---|---|
| Pre-flight: wave order T1→T2; {3,4,6,7}; {5,8}; 9→13 | yes (process) | agree |
| Pre-flight: T8 runs tests without scripts/*.test.ts if absent | yes (process) | agree |
| Pre-flight: `classify` looks the MR up by branch only through `deps.findOpenMr`; `mrIid` is a cross-check | yes — `outcome.ts:61-79` | agree |
| Pre-flight: branch `solo`, merged to `main` at finish | yes | agree |
| Pre-flight: `.superpowers/` stays gitignored | yes — `.gitignore` | agree |
| T1: `@zereight/mcp-gitlab` → `^2.2.4` | yes — `package.json` | agree (upload_markdown CVE was load-bearing) |
| T1: SDK/CLI version read via fs | yes — `verify-deps.ts:151-167` | agree |
| T1: delete skills/beta-version-toggle in Task 7 | yes — 0898f7e | agree |
| T2: `TARGET.apiUrl` → `gitlabRepo().apiUrl` | yes — `session.ts:193` | agree |
| T2: seed = `seedFrom() \|\| WORK_REPO` | yes — `config.ts:331`, `worktrees.ts:152` | agree; the `seedFrom()` docblock still says the old thing (I2) |
| T3: `TicketDoc` keeps the 49899db shape | yes — `ticket.ts:9-19` | agree |
| T4: `ONESHOT_STATE_DIR` + `test-scratch-home` | yes | agree; doctor warns when set (as ruled) |
| T4: `startRunApp({ worktree, port, runId, iid })` | yes — `appserver.ts:71` | agree |
| T7: headless text as operating facts with a named authority | yes — `prompt.ts:17-28`, ship-ticket §2 | agree |
| T8: DENIED_TOOLS = AskUserQuestion + all non-read-only server tools minus four, re-derived by test | yes — `types.ts`, `types.test.ts:33-44` | agree |
| T8→T9: server named `gitlab`; env = BASE_ENV + token + API URL + GITLAB_TOOLS + PERMISSION_MODE=full; shim chdir to ONESHOT_ARTIFACTS | yes — `session.ts:179-198`, `scripts/mcp-gitlab.cjs` | agree on the shim and naming; **disagree in part**: `full` is looser than needed (`modify` denies delete/teardown server-side for free) and the ruling omits project scoping (I6) |
| T7: beta-version-toggle deletion re-applied by the controller | yes | agree |
| T11 (a): conductor signal threaded → `aborted`, never infra | yes — `index.ts:178`, `run.ts:167,222`, `session.ts:294-298` | agree |
| T11 (b): `parked` → `{kind:'aborted'}`, no labels/note; re-dispatched after the park | yes — `run.ts:133-137` | agree; note that with I1 the "resume" after a park is a fresh session |
| T11 (c): lookup-failed retried 3× at 20 s | yes — `run.ts:138-147` | agree |
| T11 (d): Draft stripped via injectable `updateMergeRequest` before the gate | yes — `finish.ts:67-81` | agree |
| T11 (e): `startRunApp` takes `{iid, runId, worktree, port}` | yes | agree |
| T11 (f): `attemptLoop(ctx, run, startLap)` from `existing.phases.length` | yes — `run.ts:94, 224` | agree |
| T11 (g): `assertComposed` before every attempt | yes — `run.ts:78-85, 98` | agree |
| Plan amendment: Task 14 (stash denial, churn-guard, two Do-not bullets) | yes — `git-guard.cjs:142-152`, `churn-guard.cjs`, ship-ticket §Do not | agree |
| T11 (deferred): mergeGate reports failed cases before "no pass"; finish.test fixture restored | **no** — `merge.ts:20-22`, `finish.test.ts:44-47` | agree with the ruling (I2) |
| T11 (deferred): re-attach via `leaseWorktree`; merged → reap and cut fresh | **no** — `run.ts:204-210` | agree, and the fix must also cover the surviving local branch (I2) |
| T11 (deferred): `--ticket` bypasses the cooldown | **no** — `run.ts:176` | agree (I2) |
| T12: README "5 core guards" → fix wave | **no** — `README.md:154,205` | agree (I2) |
| T14: spec §8 lacks churn-guard → fix wave | **no** | agree (I2) |
| Post-merge: two stale `config/phases.json` comments → fix wave | **no** | agree (I2) |

No ruling is wrong in substance. The one I would amend is the T8→T9 MCP ruling (permission mode and project scope, I6).

## Declined to judge

- The lifted ERP method prose in `prompt.ts` (research, plan, test-case, review, verify blocks) — spec §4.4 says "verbatim"; judged only for internal contradictions (M4, I8).
- `scripts/app.cjs` internals beyond the seed-list and `PROJECT` change (1,162 lines, pre-existing); read only where the token path (I3) and `app-env.json` location (M14) depended on it.
- The bodies of the ERP pack lints (`py-lint`, `js-standards`, `migration-standards`, `script-standards`, `frontend-test-guard`) — spec §8 says unchanged.
- `context/` skills, agents and rules beyond the two `Edit` additions.
- Whether superpowers' brainstorming self-approves headless — spec §12 names it as proven by the first live run.
- The ~53k lines of deletions, per the brief.
- `repourl.cjs`, `repocheck.ts`, `envfile.ts`, `gitlabmd.ts`, `gitfetch.ts`, `identity.ts` internals — lifted; read only at the call sites that mattered (I4, I7).
- Whether `disallowedTools` applies to tools the server adds at runtime via `discover_tools` — SDK behaviour not verifiable offline; I6's server-side regex makes the question moot.
- Playwright install and browser cache — environment; `verify-deps` warns.
- Commit trailers and authorship — the controller verified each.
- `package-lock.json` beyond confirming the two pins.

## Recommendations

1. Run the fix wave the ledger already planned (I2) and add I1, I3, I4, I5, I6, I7, I8, M4, M6 to it; every one is small and none changes an interface.
2. Make `runSession`'s frame handling a pure fold (`foldFrame(state, msg)`) so the resume capture, the rate-limit short-circuit and the first-result rule get unit tests on real frame shapes instead of being reachable only through a live session.
3. Before the first live run, set `merge.mode: "manual"` as HANDOFF says, and watch the three things this review could not: whether brainstorming idles, whether the 15-minute idle watchdog fires on a long plan write, and whether `superpowers:executing-plans` tries to dispatch subagents that `AskUserQuestion`.
4. Consider denying `blocked` cases that are not `pre-existing:`-noted *and* not listed in `regressions` from the gate; today one trivial pass beside four `blocked` cases merges.
5. A `scripts/env-audit.ts` (or a doctor section) that lists every long-lived process on the desk and flags `GITLAB_TOKEN` in its environment would have caught I3 and will catch the next one.

## Assessment

**Ready to merge: With fixes.** The architecture is sound and the lift is careful — the dangerous surfaces (session env, denied tools, merge gate, dashboard) are guarded in depth and tested — but the branch is incomplete by the ledger's own account (three deferred rulings and the doc sweep), and the review found one silent functional bug (resume never captures a session id) and three credential/scope gaps (token in the app process tree, `.env.bak-*` and the glab/keychain sources readable, MCP server unscoped to the project) that an unattended operator would reasonably expect closed before `Loop` is applied to a real ticket.
