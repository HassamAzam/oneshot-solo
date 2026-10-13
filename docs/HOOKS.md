# Hooks

Oneshot Solo runs one Claude session per ticket, for hours, under `bypassPermissions`, holding
Bash, the write tools and the GitLab MR tools. Anything that must hold in that session has to hold
**without the model's cooperation**. This page says which guards do that, where they live, and how
a project adds its own.

## 1. The decision rule

For every constraint, use the cheapest layer that actually holds:

| Layer | Use when | Cost | Can the model evade it? |
|---|---|---|---|
| **Structure** | The constraint can be made *impossible* | free | No |
| **Hook** | The model has the tool, but must not use it this way | ~1–20 ms/call | No |
| **Schema** | The output shape is checkable | ~1 ms | No (retried until valid) |
| **Skill / prompt** | It's judgment, taste, or method | tokens | Yes — it's advice |

A hook is only correct for the second row. Structure does most of the work in Solo: the merge is
conductor code behind a deterministic gate, so no session holds a merge tool; the issue and
branch-admin GitLab tools are on the session's `disallowedTools` list; the session's `cwd` is the
leased worktree; and `run.json` sits outside every write scope, so nothing the session writes is
ever trusted as its outcome. What remains is the list below.

## 2. How hooks are wired

`src/ticket/hooks.ts` builds the SDK `hooks` option (`hooksFor(env)`). Each callback spawns the
matching `.cjs` file with the hook payload on stdin and returns its stdout — the guards are
plain Node scripts, dependency-free, tested offline by `scripts/verify-hooks.sh`, and there is
exactly one implementation of each policy. Nothing is installed into `~/.claude/settings.json`,
and sessions load `settingSources: ['project']` only.

- **Minimal child env.** A guard runs with `guardEnv(env)`: `PATH`, `HOME`, `CONTEXT_REPO` and
  every `ONESHOT_*` except the two that are credentials, `ONESHOT_GITLAB_TOKEN` and
  `ONESHOT_TEST_LOGIN` — nothing else. So the GitLab token (in any spelling), the managed test
  login, `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` never reach a guard; no guard reads any of them.
- **Bounded and fail-open.** A guard that times out (15 s by default; a pack entry carries its
  own), fails to spawn, exits non-zero with no output or prints non-JSON resolves to `{}` — allow
  — and is logged as `guard <name> did not run`. A broken guard must never wedge a run.
  `FAIL_CLOSED` in `hooks.ts` is the escape hatch for a guard standing in front of an
  irreversible action, which must deny when it cannot run. It is **empty** today and kept because
  that asymmetry belongs in one place.
- **Contract.** Exit 0 with empty stdout allows. A PreToolUse deny is
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}`; a
  PostToolUse block is `{"decision":"block","reason":…}`; a SessionStart injection is
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`. Helpers for
  all three live in `hooks/_common.cjs`. Denials are appended to `state/hook-events.jsonl` via
  `_common.event()`.

### The `ONESHOT_PHASE=ticket` invariant

`hooks/_common.cjs` `bailIfNotOneshot()` exits 0 — allow everything — when `ONESHOT_PHASE` is
unset. That is what keeps the guards inert in anyone's interactive session, and it means
**forgetting the variable silently disables every guard**. The session env therefore always
carries `ONESHOT_PHASE=ticket` (the literal; Solo has no other phase), and doctor asserts the env
builder sets it. No guard branches on the value any more — `git-guard`'s phase checks,
`traps-brief`'s `testcases` gate and `repro-conditions`' `research` gate are gone — it is purely
the on-switch.

## 3. Core guards — `hooks/`, always on

| hook | event | guards |
|---|---|---|
| `git-guard.cjs` | PreToolUse `Bash` | No force push; push only `ONESHOT_BRANCH`; never a protected branch (`dev`/`stage`/`master`/`main` from `project.json`); no `branch -D` of a protected branch; no `remote set-url`; no `gh`/`glab`; no `reset --hard` onto a protected branch; no push under `ONESHOT_DRY_RUN`; no `git stash` (any form but `list`/`show`, including `git -C <dir> stash`) — a stash is state nothing else sees, and a leftover stash/pop once reverted a run's commits, so work is set aside as a WIP commit on the leased branch; git cwd (`cd`, `git -C`) fenced to the worktree. `checkConductorPhase` / `checkReadOnlyWorktreePhase` deleted — one session, in its own writable worktree, can reach neither. |
| `write-scope.cjs` | PreToolUse `Write\|Edit\|NotebookEdit` | Writes confined to `ONESHOT_WRITE_SCOPES` (worktree + artifacts), realpath-resolved so a symlinked `.claude/skills` cannot carry a write into the vendored skills; hard-denies the harness itself, `~/.claude` and the context repo. Empty scopes deny everything. |
| `churn-guard.cjs` | PreToolUse `Write` | Denies a `Write` that replaces an existing file of 40 or more lines with fewer than half of them — a partial change done as a whole-file rewrite (one pass once net-deleted ~1,177 lines of `actionTypes.js` to change one line). New files, files under 40 lines, and `Edit`/`NotebookEdit` are never judged; the denial points the model at Edit. Registered right after `write-scope`. |
| `secret-guard.cjs` | PreToolUse `Read\|NotebookRead\|Grep\|Bash` | Denies reading or writing this repo's `.env` and every other `.env.*` under `ONESHOT_HOME` but `.env.example` (setup's `.env.bak-<stamp>` backups; a `.env*` glob), the desk token file `~/.config/oneshot/gitlab-token`, glab's `~/.config/glab-cli/config.yml` and `~/.claude.json` — by tool path, and on Bash by reader/writer verb or redirect, with `~`, `$HOME`, `$ONESHOT_HOME` expanded and relative paths resolved against the session cwd — and denies `security find-generic-password` (the token's keychain home) and a Grep tool search rooted at `ONESHOT_HOME` or any directory above it (it walks `.env` whatever its glob; a Grep with no path runs in the worktree). `.env.example` and the work repo's own `.env`/`.env.*` stay readable. The token is in nothing the session starts or inherits: the session env is a whitelist, the conductor starts the app server with the same whitelist, and `scripts/app.cjs` strips credentials from the Django and webpack it spawns; it reaches the GitLab MCP server's subprocess. Best-effort, not a sandbox: `report.ts` `redact()` is the second layer. |
| `mr-gate.cjs` | PreToolUse `mcp__gitlab__(create_merge_request\|update_merge_request\|create_merge_request_note\|upload_markdown)` | Every GitLab write the session may make: a `project_id`, when sent, must be this run's project — `ONESHOT_PROJECT_PATH` (plain or URL-encoded) or `ONESHOT_PROJECT_ID`, set by the conductor; with neither in the env the call is allowed and logged `mr_gate_no_project`. A create must go from `ONESHOT_BRANCH` into the base (`project.json` `branches.base`), and an update that sends `target_branch` must send the base. Title convention (no conventional-commit prefix) and the `[closes <url>]` line on create and on any update that sends a description. The GitLab server holds the same line on its side: `GITLAB_PERMISSION_MODE=modify`, a deny regex mirroring `DENIED_TOOLS`, and a strict project allowlist (`src/ticket/session.ts`). |
| `pause-check.cjs` | PreToolUse, every tool | `state/PAUSE` or `state/PAUSE-QUOTA` present → deny writes, Bash and MCP, allow reads, "stop and summarise"; a fresh `state/PAUSE-NETWORK` → deny every `mcp__gitlab*` call. The only graceful brake on a run in flight. Registered first and unmatched so it sees every call. |

## 4. Project pack — `hooks/packs/erp/`, selected by `project.json` `hookPack`

Project-specific standards live in a pack, not in the core. `hooksFor` reads
`config/project.json` `hookPack` (today `"erp"`) and registers every entry of
`hooks/packs/<hookPack>/pack.json`; no `hookPack` means core only.

| hook | event | timeout | guards |
|---|---|---|---|
| `frontend-test-guard.cjs` | PreToolUse writes | 15 s | Denies authoring a Jest test under `frontend/src` (the app's own `testMatch`); Playwright drivers outside Jest's roots stay allowed. |
| `migration-standards.cjs` | PostToolUse writes | 20 s | Data migrations through `_base_manager`, no schema + `RunPython` mix outside a squash, `max_migration.txt` current. |
| `script-standards.cjs` | PostToolUse writes | 20 s | Under `scripts/` and `tmp_scripts/`: no Django bootstrap in a `tmp_scripts/` one-off (it is exec'd in a live shell); a fabricated email uses `@example.com`. |
| `py-lint.cjs` | PostToolUse writes | 60 s | flake8 + pylint (the worktree venv's first) on every `.py` write in the worktree, migrations exempt; no new inline comments, judged on the lines the write added. |
| `js-standards.cjs` | PostToolUse writes | 15 s | `axios` only in the allowlisted callers, `yup` only in `formValidations`, no new static inline styles; added lines only. |
| `traps-brief.cjs` | SessionStart | 15 s | Injects `erp-ticket-test-plan`'s `refs/traps.md`. Phase gate removed: the one session writes the cases. |
| `repro-conditions.cjs` | SessionStart | 15 s | Injects `bug-reproduction`'s `refs/why-it-did-not-reproduce.md` when `ONESHOT_TICKET_LABELS` contains `Bug` (case-insensitive) and `project.json` `bugReproduction` is not `false`. Keyed on the label instead of the old `research` phase. |

### Adding a pack

1. Create `hooks/packs/<name>/` and put the guard scripts in it. Load the shared helpers by the
   pack's depth: `require(path.join(__dirname, '..', '..', '_common.cjs'))`; the repo root is
   `path.join(__dirname, '..', '..', '..')`.
2. Write `hooks/packs/<name>/pack.json`, an array of entries:

   ```json
   [
     { "script": "my-guard.cjs", "event": "PostToolUse", "matcher": "^(Write|Edit|NotebookEdit)$", "timeoutMs": 20000 },
     { "script": "my-brief.cjs", "event": "SessionStart", "timeoutMs": 15000 }
   ]
   ```

   `event` is `PreToolUse`, `PostToolUse` or `SessionStart`; `matcher` is a tool-name regex and
   is omitted to match every tool; `timeoutMs` is the kill timeout (the SDK timeout is its
   ceiling in seconds). A pack entry registers after the core guards for its event.
3. Set `"hookPack": "<name>"` in `config/project.json`. A named pack without a manifest throws
   at session start — a misconfigured pack is a config fault, never a silent "no pack".
4. Add deny/allow cases to `scripts/verify-hooks.sh` (its `run` helper resolves a name in
   `hooks/` first, then `hooks/packs/erp/`; call another pack's script by its full path) and run
   `npm run hooks:verify`.

## 5. Dropped

| hook | why |
|---|---|
| `log-event.cjs` | Every SDK frame in the session transcript carries a `ts`, which replaces it; its 21 MB `hook-events.jsonl` stops growing. Guard denials still land there through `_common.event()`. |
| `artifact-guard.cjs` | It protected cross-phase handoffs and `run.json` inside a shared run directory. Solo has no handoffs, and `run.json` is outside the write scopes, so `write-scope` already refuses it. |
| `budget-gate.cjs` | Inert and coupled to the deleted SQLite store. The session's caps are `maxTurns` and the conductor's wall-clock and idle watchdogs. |
| `automation-ready.cjs` | Never a hook — the Ready For Automation mode's readiness script, gone with that mode. |

`context/settings.json` went too: it was never loaded and carried the wrong MCP prefix.

## 6. Verifying

```bash
bash scripts/verify-hooks.sh          # offline deny/allow suite; ends "N passed, 0 failed, M skipped"
npx tsx --test src/ticket/hooks.test.ts   # registration, pack manifest, guard env, live callbacks
npm run check                          # tsc + node --check on hooks/*.cjs and hooks/packs/*/*.cjs
```

The suite exports `ONESHOT_PHASE=ticket` and the rest of the identity itself, needs no network,
GitLab or Claude session, and uses `CONTEXT_REPO` (default `~/Documents/erp`) for the
context-repo cases.
