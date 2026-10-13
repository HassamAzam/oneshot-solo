# Handoff — running Oneshot Solo

Takes a GitLab ticket from `Loop` to a merged (or reviewable) MR with nobody watching: one
conductor, one Claude session per ticket. The run ends at the merge; deploying stays a
person's job. [README.md](README.md) explains the design; this page is how to operate it.

## Standing authorization

A ticket labelled `Loop` is the operator's instruction to run it. A run writes to GitLab —
the branch, the MR, labels and a note — and with `merge.mode: "auto"` it merges into the
base branch. Labelling the ticket is the consent to all of that: `Loop` is the consent.
Whoever operates Solo, a person or an agent working from this page, preflights with
`npm run doctor`, launches, and reports; no menu of options goes to anyone first.

A human is asked only for what this page does not cover: a destructive action (deleting
data, rewriting published history, changing someone's credentials), or a change to any
system other than the GitLab project `GITLAB_REPO_URL` names and this repo. A run that stops
at `Needs Human` is not one of those: read the ticket note, fix the cause, carry on.

## Set it up on a new machine

1. **VPN.** GitLab is on a FortiClient-gated subnet; connect it. If `npm install` then
   hangs on `ETIMEDOUT` while `curl` to the registry works, Node is resolving to IPv6 the
   VPN black-holes: `NODE_OPTIONS="--require $PWD/scripts/ipv4-dns.cjs" npm install`.
2. **Sign in as yourself.** `claude login`. The session bills to whoever is signed in;
   `npm run doctor` prints the account's email under *Claude auth*.
3. **Superpowers.** `claude plugin install superpowers`. Boot refuses without it.
4. **Your clone of the project**, at the default `~/Documents/<name>` unless `.env` says
   otherwise: `git clone git@gitlab.arbisoft.com:arbisoft/erp.git ~/Documents/erp`. It must
   be installed (venv, `node_modules`, `collectstatic` done) — worktrees borrow from it.
5. **Solo itself:**

   ```sh
   git clone <this repo> ~/Documents/oneshot-solo && cd ~/Documents/oneshot-solo
   npm install
   npm run setup      # GITLAB_REPO_URL, token, clone path, optional test login → .env (0600)
   npm run doctor     # must end "0 failed"; the probe spends one turn
   ```

   Rather keep the token out of the repo? `npm run token:set` writes
   `~/.config/oneshot/gitlab-token` (0600) and doctor stops warning about `.env`.

## Run it

```sh
npm start                        # watch the board; one ticket at a time
npm start -- --ticket 8420       # exactly this ticket, then exit
npm start -- --once              # one tick, wait for what it dispatched, exit
```

Label a ticket `Loop` and the next tick (≤ 60 s) claims it, unless it carries `Merged`,
`In Review` or `Needs Human`, is assigned to someone other than this desk's GitLab user, or
was blocked less than 30 minutes ago. One conductor per checkout: a second `npm start`
refuses while `state/conductor.pid` is alive.

Or with no command at all: `npm run dashboard`, type the ticket number into the box at the
top and press **Run**. That queues it (`state/queue/<iid>.json`), and the conductor's next tick
runs it exactly as `--ticket` would — no `Loop` label needed — before anything on the board,
one at a time, never while a run is live. The page says whether the conductor is running and
starts it when it is not (detached, output in `state/conductor.log`; stop it with
`kill $(cat state/conductor.pid)`). The run in flight is listed first, marked `● running`.

## Read it

```sh
npm run status                   # every run, one line each
npm run dashboard                # http://localhost:8787 — click a ticket
npm run report -- 8420           # one run as a single HTML file
```

`state/runs/<iid>/` holds `run.json`, the transcripts (`transcripts/ticket-lap<n>.jsonl`)
and what the session wrote: `<iid>-design.md`, `<iid>-plan.md`, `cases.json`, screenshots.
The ticket note says how it ended: "Oneshot merged !N", "Oneshot opened !N — not merged:
<why>", or "Oneshot stopped: **<why>**".

## The three things that stop a run

| what you see | what it is | what to do |
|---|---|---|
| `Needs Human` on the ticket, journal `blocked` | the session set `blocked`, hit `[ACTION REQUIRED]`, ran out of turns without an MR, or the machinery failed twice | read the note's reason, fix it (ticket text, environment, config), then swap `Needs Human` back for `Loop` or `npm start -- --ticket <iid>` |
| `parked after a subscription usage limit until …` in the log; `state/PAUSE-QUOTA` | the subscription hit its limit; the run ended `aborted` | nothing. It clears at the reset time and the ticket resumes from its journal on the next tick |
| `GitLab unreachable — network breaker OPEN`, then `tick  holding — network …` in the log; `state/PAUSE-NETWORK` | GitLab unreachable — almost always the VPN | reconnect. The breaker probes with backoff and resumes by itself |

Your own brakes: `touch state/PAUSE` (stops claiming; a running session may only read and
then summarises; `rm state/PAUSE` to resume) and Ctrl-C (once: the session is withdrawn and
ends `aborted`, resumable with `--ticket`; twice: exit now, resumed on the next boot).
`npm run reap` removes worktrees whose MR merged.

## The first live run

No ticket has run live on Solo yet. Before the first one, set `merge.mode` to `"manual"` in
`config/project.json`, and keep it there until you have read one dashboard page end to end.
Pick a small ticket, then:

```sh
npm run doctor                     # 0 failed, the Superpowers section all PASS
npm start -- --ticket <small iid>
npm run dashboard                  # open /run/<iid>
```

Check, on that page and the ticket:

- [ ] **Checkpoints reached** — rows for `superpowers:brainstorming`,
      `superpowers:writing-plans`, and the MR being opened, in that order, with
      `<iid>-design.md` and `<iid>-plan.md` under `/artifacts/<iid>/`.
- [ ] **Turns against the cap** — the attempt header shows turns and duration; well under
      `ONESHOT_MAX_TURNS` (600) and `ONESHOT_TIMEOUT_MIN` (240). Note any context-compaction
      rows.
- [ ] **Brainstorming self-approved** — no long gap after the brainstorming checkpoint
      (the per-entry elapsed times show it), no idle-watchdog abort, and the design file
      lists its assumptions instead of asking questions.
- [ ] **MR post-check clean** — the MR targets the base branch, its title has no
      `feat:`-style prefix, its description carries `[closes <issue url>]`, and it is not a
      draft. A problem here is named in the ticket note.
- [ ] **Merge gate verdict** — with `manual` the note reads "not merged: merge.mode is
      manual". Read the rest of the gate yourself: at least one case passed, none failed,
      regressions listed in the MR. That is the verdict `auto` would have acted on.

Only then switch `merge.mode` back to `"auto"`.

## If the plugin hook does not fire

`npm run doctor`'s *Superpowers* section runs a one-turn probe session and reports whether
the plugin loaded, whether its skills appear as `superpowers:*`, and whether its
SessionStart hook injected "You have superpowers". When the hook did not fire, add

```
ONESHOT_SUPERPOWERS_INJECT=1
```

to `.env`: the session then appends the plugin's `using-superpowers` intro to its system
prompt, which is all the hook injects. Re-run `npm run doctor`; it reports the fallback as
on. If the plugin did not load at all, set `ONESHOT_SUPERPOWERS_PATH` to the plugin dir
(the one holding `skills/brainstorming/SKILL.md`).

## Status (2026-10-14)

- **Tests:** `npm test` 273/273; `bash scripts/verify-hooks.sh` 170 hook cases, 0 failed;
  `npm run check` clean.
- **Doctor on the operator desk:** 0 failed, 2 warnings — the GitLab token lives in `.env`
  (`npm run token:set` moves it out), and the protected branch `main` named in
  `config/project.json` is absent from the project.
- **Live probe:** the superpowers plugin loaded, its skills appear namespaced as
  `superpowers:*`, its SessionStart hook fired, on Claude Code CLI 2.1.296.
- **No ticket has run live yet.** The first live run is the ticket number typed into the
  dashboard, or `npm start -- --ticket <small iid>`, with `merge.mode: "manual"` until one
  dashboard page has been read end to end (*The first live run*, above).
- **Rotate the GitLab token** if the implementation transcripts are ever shared.
