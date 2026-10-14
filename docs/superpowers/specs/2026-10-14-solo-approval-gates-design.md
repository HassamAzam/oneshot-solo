# Oneshot Solo — design & test-case approval gates

One ticket, two human gates: the **design** and the **test cases**. Both post to the GitLab
ticket, both are approved by a keyword reply, both reiterate on rejection.

This design extends [Oneshot Solo](./2026-10-13-oneshot-solo-design.md). It changes the
session lifecycle (§4), adds a gate subsystem (§5), and adds small, additive state (§6). No
ERP application code is involved — this is Solo's own conductor/session code
(`src/ticket/*`, `src/lib/*`).

## 1. Brief and intent

What was asked for, in the operator's words (2026-10-14):

- "If it has design, it needs to post design."
- "It needs to post qa issues and wait for them to be approved otherwise reiterate them."
- "It generates testcases and gets approved or disapproved."

Solo today ships a ticket end to end with **no human in the loop** — `src/ticket/prompt.ts`
states *"the written design file is the approval record; once it is written, continue to the
plan,"* and `src/lib/worktrees.ts` deliberately excludes the approval-stopping agents. This
change re-inserts two human approval gates:

1. a **design gate**, only for tickets that carry a `Design` label; and
2. a **test-case gate**, where the session generates the test cases and waits for sign-off.

Each gate posts to the ticket, stops the run, and resumes when the operator replies; a
rejection reiterates with the operator's feedback.

**Success looks like:** label a ticket `Loop` (and `Design` if it needs one). Solo posts the
design as a ticket note and stops. The operator replies `approved` or `changes: …`. Solo
continues or revises, then posts the test cases and stops. The operator replies. Solo builds,
verifies against the approved cases, and opens the MR exactly as it does today.

## 2. Lineage

This restores, in Solo's single-desk shape, two gates the parent oneshot had and Solo
removed. Solo's design doc (§2) lists as **gone**: *"human review gates (`Review`, `Design`,
`TestCase Review` labels), MR-feedback loop."* We bring back the **`Design`** and
**test-case** gates — **not** the `Review`/MR-feedback loop — adapted to Solo's stop-and-resume
model, one desk, `run.json` journal.

**Consequence:** a gated ticket is no longer "one session." It becomes **one session per
segment between gates**, each a fresh `query()` that re-reads the approved artifacts:

```
[design] ─gate─ [plan + test cases] ─gate─ [build + verify + MR]
```

This is closer to oneshot's per-phase sessions, and it is the right shape: a human wait must
never hold a live session (or its context window) open. Solo already treats
`<iid>-design.md` / `<iid>-plan.md` / `<iid>-cases.json` as cross-session memory
(`src/ticket/prompt.ts` re-reads them after compaction), so a fresh resuming session is a
solved problem.

## 3. Decisions (confirmed with the operator, 2026-10-14)

| # | Decision |
|---|---|
| D1 | Design and test cases post as **marked notes on the GitLab ticket**; the **operator (Hassam) approves**. This intentionally overrides the standing "tickets = demos only" rule, **scoped to Solo**. Nouman is not in this loop. |
| D2 | Approval is a **keyword reply** on the posted note. A human note matching `^\s*(approve|approved|lgtm|👍)` → **approved**; matching `^\s*(changes?:|reject|no:)` → **changes-requested**, remaining text captured as feedback. The **latest human** note under the marker wins; Solo never reads its own notes. |
| D3 | The **design gate fires only when the ticket carries the `Design` label.** No label → no design gate (today's self-approved behavior): the session writes `<iid>-design.md` and continues. |
| D4 | The **test-case gate** = the session generates the test cases (`<iid>-cases.json` + a human-readable list), posts them, and waits for approve/disapprove; disapprove reiterates the cases with the feedback. |
| D5 — default, reversible at review | The test-case gate runs **on every ticket that produces code**, and **before build** (approve the acceptance criteria, then build to satisfy them). Config can switch it to label-gated, after-build, or off. |
| D6 | **Wait model: stop-and-resume.** On reaching a gate Solo posts, sets the run journal to an `awaiting-*` status, swaps the ticket label to a waiting label, and the run **exits**. A later conductor tick polls the ticket and resumes with a **fresh session**. |
| D7 | After `maxGateIterations` (default **3**) changes-requested cycles without approval, Solo stops at `Needs Human` with a note. |

## 4. Architecture — the gated flow

```
tick (src/index.ts)
  scan `Loop`            → new work → runTicket(iid)
  scan local awaiting-*  → poll the ticket note → resume / reiterate / give up

runTicket(iid)                                              src/ticket/run.ts
  claim → prepare (worktree, .claude)         [unchanged]
  ┌─ segment DESIGN  (only if ticket has `Design` label)
  │   Session A: brainstorm → write <iid>-design.md → STOP at the design gate
  │     post design note (marker) · Loop→"Design Review" · journal awaiting-design · exit
  │     ── next tick ── reply "approved"  → continue to next segment
  │                     reply "changes:…" → reiterate (fresh session, re-reads design + feedback,
  │                                          revises <iid>-design.md, re-posts)  [cap N → Needs Human]
  ├─ segment CASES
  │   Session B: read approved design → write <iid>-plan.md → generate <iid>-cases.json → STOP
  │     post test-case note (marker) · →"QA Review" · journal awaiting-qa · exit
  │     ── next tick ── "approved" → continue ·  "changes:…" → reiterate the cases
  └─ segment BUILD
      Session C: read approved design/plan/cases → build → verify against cases → open MR
      outcome → finish: existing merge gate (merge | In Review | Needs Human)   [unchanged]
```

A ticket **without** the `Design` label skips segment DESIGN and starts at segment CASES. The
conductor is still code and never holds a model; each segment is one `query()`.

## 5. The gate mechanism

A **gate** is a small, well-bounded unit: given a run and a gate kind, it (a) posts an
artifact note, (b) parks the run, (c) on a later tick reads the operator's verdict, and (d)
returns one of `approved | changes(feedback) | waiting | exhausted`. It reuses the note and
marker machinery already in `src/ticket/finish.ts` and the deterministic-gate pattern of
`src/ticket/merge.ts`.

New module: `src/ticket/gate.ts` (pure logic + a thin `deps` seam for GitLab, mirroring
`finish.ts`). New prompt fragments in `src/ticket/prompt.ts` that tell a segment to **stop
after writing its artifact** rather than continue.

### 5.1 Posting the artifact note

- `deps.addIssueNote(iid, body)` with a per-kind HTML-comment marker:
  `<!-- oneshot:design-review:<runId>:<iter> -->` and `<!-- oneshot:qa-review:<runId>:<iter> -->`.
- Design note body: a short header ("Design for #<iid> — reply `approved` or `changes: …`"),
  the content of `<iid>-design.md` (or an excerpt + the dashboard artifact link if large), and
  the **Assumptions** block.
- Test-case note body: the same header, then the test cases rendered from `<iid>-cases.json`
  as a numbered list (id · scenario · expected), plus the dashboard link.
- The marker lets the conductor find its own note and scope the reply search to notes *after*
  it. `<iter>` disambiguates reiteration rounds.

### 5.2 Detecting the verdict (keyword reply)

Each tick, for every local run in `awaiting-design` / `awaiting-qa`:

1. Fetch the ticket's notes (`src/lib/gitlab.ts` note list).
2. Take notes authored by a **human** (not Solo's bot identity — reuse the own-note guard in
   `src/lib/identity.ts`) whose `created_at` is after the latest marker note for this run.
3. Of those, take the **most recent**. Match against the D2 patterns:
   - approve pattern → `approved`.
   - changes pattern → `changes`, with the text after the keyword as `feedback`.
   - neither → `waiting` (no action; try again next tick).

The parser is a pure function `readVerdict(notes, marker, botId) → Verdict` — unit-tested on
fixed note arrays, no live GitLab.

### 5.3 Reiterating

On `changes(feedback)`:

- Increment `gateIteration` in the journal. If it would exceed `maxGateIterations` → `Needs
  Human`, stop note naming the gate and the last feedback.
- Otherwise spawn a **fresh session** for the same segment, its prompt seeded with: "revise
  `<iid>-<artifact>`; the reviewer asked for: «feedback»; re-read your prior artifact and the
  code; then stop at the gate again." It rewrites the artifact and re-posts (new `<iter>`).

### 5.4 Where the gates sit

- **Design gate** fires when `<iid>-design.md` is written **and** the ticket has `Design`.
  How the session signals "I've written the design, stop now": the segment prompt instructs
  the session to **end its turn** after writing the file (no build), and the session's
  structured result carries `phase: "design-written"`. `src/ticket/outcome.ts` maps that to
  "park at design gate" instead of "finished." (Mirrors how `outcome.ts` already reads the
  result for MR/merge.)
- **Test-case gate** fires when `<iid>-cases.json` is written; segment result
  `phase: "cases-written"`.
- **Build** proceeds only once both applicable gates are `approved`; it ends by opening the MR
  and flows into the **unchanged** merge gate (`src/ticket/finish.ts` + `merge.ts`).

## 6. Data model changes (additive)

### 6.1 Journal (`src/lib/journal.ts`)

`RunJournal.status` gains `awaiting-design` and `awaiting-qa`:

```ts
status: 'claimed' | 'running' | 'awaiting-design' | 'awaiting-qa'
      | 'done' | 'blocked' | 'aborted';
gate?: {
  kind: 'design' | 'qa';
  iteration: number;          // 0-based; D7 cap
  markerNoteId: number;       // the note we posted; replies are scoped after it
  postedAt: string;
};
```

A later `finish()` on a terminal journal stays a no-op (existing guard). `awaiting-*` is a
**non-terminal, resumable** status: `pidAlive` is irrelevant (no process is held), so
`src/lib/telemetry.ts`/`report.ts` must treat `awaiting-*` as "alive, parked" in the dashboard
and `npm run status` (so a parked run is never shown as crashed).

### 6.2 Labels (`src/lib/config.ts`, `config/project.json`)

Add two **waiting** labels to the state machine, distinct from `Needs Human` (which stays
"stuck/needs a decision"):

| label | meaning |
|---|---|
| `Design` | **input**: operator marks the ticket to request the design gate (D3) |
| `Design Review` | Solo posted the design; waiting on the operator |
| `QA Review` | Solo posted the test cases; waiting on the operator |

On park: `Loop` → `Design Review` / `QA Review`. On approve: → `Loop` (the run resumes). The
`Loop` scan must **exclude** tickets currently on a waiting label so they are not re-dispatched
as new work; the awaiting runs are driven from local `run.json`, not the label.

### 6.3 Config (`config/project.json`, env overrides like `ONESHOT_MERGE`)

```jsonc
"gates": {
  "design": { "mode": "label" },          // "label" (needs `Design`) | "off"
  "qa":     { "mode": "always" },          // "always" | "label" | "off"   (D5)
  "qaTiming": "before-build",              // "before-build" | "after-build" (D5)
  "maxIterations": 3,                      // D7
  "labels":   { "designReview": "Design Review", "qaReview": "QA Review", "designTrigger": "Design" },
  "keywords": { "approve": "^\\s*(approve|approved|lgtm|👍)",
                "changes": "^\\s*(changes?:|reject|no:)" }
}
```

Env overrides: `ONESHOT_GATES=off` disables both (restores today's behavior);
`ONESHOT_QA_GATE=off`, `ONESHOT_DESIGN_GATE=off` toggle individually.

## 7. Conductor tick changes (`src/index.ts`)

The tick currently: pause files → GitLab reachability → scan `Loop` → triage → dispatch one.
It gains one step, before dispatching new `Loop` work:

```
for each local run with status awaiting-design | awaiting-qa:
    verdict = readVerdict(fetchNotes(iid), run.gate.markerNoteId, botId)
    approved → relabel → resume segment (fresh runTicket segment)
    changes  → reiterate (§5.3)   |   exhausted → Needs Human
    waiting  → leave it
```

Concurrency `1` still holds: a resumed/reiterated segment is a normal dispatch and counts
against the single slot; awaiting runs hold **no** slot (no process), so the desk stays free to
pick up other `Loop` work while a human thinks. `--ticket <iid>` resumes a parked run by the
same path (reads `run.json`, checks the verdict, continues).

## 8. Edge cases

- **Ambiguous reply** → `waiting`; no guess, no relabel.
- **Multiple replies** → latest human note wins (D2).
- **Bot's own notes** never count as approval (identity guard).
- **Operator edits the design file / pushes a commit directly** → out of scope; the artifact
  note is the contract. A later iteration overwrites the file.
- **Worktree pruned before resume** → re-lease under the same run id (existing prepare path).
- **Ticket moved off the waiting label by a human** → treated as `waiting` until a valid reply
  appears; a human removing `Loop` entirely pauses it (existing pause semantics).
- **Waits are indefinite** by design (waiting on a human); `status`/dashboard surface
  `awaiting-*` so nothing is invisible. No timeout in v1.
- **Crash while awaiting** is harmless: no process is held; the next tick re-reads `run.json`
  and the ticket.

## 9. Testing

Pure functions with a faked `deps`, exactly like `finish.test.ts` today — no live GitLab:

- **Note builders**: design/qa note bodies carry the right marker and `<iter>`; large design
  falls back to excerpt + link.
- **`readVerdict`**: approved / `changes:` + feedback captured / ambiguous→waiting /
  bot-authored ignored / latest-of-several wins / replies-before-marker ignored.
- **Gate state machine**: awaiting→approved→next segment; awaiting→changes→reiterate increments
  iteration; iteration cap → Needs Human with the right note/label.
- **Label arithmetic**: park swaps `Loop`→waiting; approve swaps back; `Loop` scan excludes
  waiting labels.
- **Journal**: `awaiting-*` shown as parked (not crashed) by `telemetry`/`report`.
- **Config**: `gates.*.mode` off restores today's single-session path (a Design-less,
  qa=off ticket runs exactly as the current spec).

## 10. Scope / non-goals

**In:** the design gate (label-triggered), the test-case gate (default-on, before-build), the
keyword-reply verdict, reiteration with feedback, the iteration cap, the new journal
statuses/labels/config, the tick poll, dashboard/status visibility of parked runs.

**Out (non-goals):** a plan-approval gate; an MR-feedback/code-review loop; approval via
label-swap, emoji, or MR approval (keyword reply only, per D2); Nouman/second approver;
Slack/Claude-Design routing for the design (D1 keeps it on the ticket); timeouts/auto-nudges on
a waiting gate.

## 11. Open items to confirm at spec review

1. **D5 — QA-gate timing.** Default is `before-build` (approve acceptance criteria, then
   build). Flip to `after-build` if you'd rather approve cases against existing code.
2. **D5 — QA default scope.** Default `always` (every code ticket). Switch to `label` if only
   some tickets should gate on test cases.
3. **Keyword set (D2).** Confirm the approve/changes keywords; they live in config and are easy
   to extend.
