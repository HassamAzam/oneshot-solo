#!/usr/bin/env node
'use strict';
/**
 * SessionStart: put the conditions that hide a real bug in front of a bug
 * ticket's session before it plans a reproduction.
 *
 * WHY A HOOK AND NOT A PROMPT LINE. `bug-reproduction/SKILL.md` already says to
 * read `refs/why-it-did-not-reproduce.md`, and that instruction has now been
 * measured: across two research laps on one bug ticket the phase made three
 * Read calls and not one was this file. It did not disobey — an instruction
 * to read a file is a request, and the first thing a session under turn
 * pressure drops is a read whose value it cannot see yet. Injecting the content
 * costs the phase zero turns and cannot be skipped.
 *
 * IT ALSO FIXES A GATE THAT IS ONE BRANCH TOO LATE. SKILL.md asks for the file
 * under "rules that keep `not-reproduced` honest" — i.e. after the verdict is
 * already being written. Two of the conditions cannot be applied there at all:
 * the ACCOUNT has to be the right one before you log in, and the OPTION has to
 * be enumerated while you are still choosing what to click. Read at verdict
 * time they are a post-mortem; read at planning time they change what gets run.
 * That is why this fires at SessionStart rather than on a write.
 *
 * SCOPE. Tickets labelled `Bug` only, read from ONESHOT_TICKET_LABELS (the
 * comma list the conductor puts in the session env). It used to self-gate on
 * the `research` phase; Solo has one `ticket` session, so the label is the only
 * thing left that says whether a reproduction is planned at all. A feature
 * ticket exits before reading anything. The brief still leads with its own
 * applicability, for the bug that turns out to need no reproduction.
 *
 * FAILS OPEN, loudly. A missing or unreadable reference must never wedge the
 * phase — the prompt still carries the method, and a reproduction attempted
 * without these conditions is worse than one with them but far better than a
 * research phase that will not start. The failure is recorded as an event so a
 * silently absent brief shows up in state/hook-events.jsonl instead of looking
 * like a phase that ignored its instructions.
 */
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '..', '..', '_common.cjs'));

C.bailIfNotOneshot();

const SKILL = 'bug-reproduction';
const REF = 'why-it-did-not-reproduce.md';

/** Above this a brief stops being a brief. Same ceiling as the traps list. */
const MAX_INLINE_BYTES = 24_000;

/**
 * Resolve the reference the way the conductor seeds skills — `claudedir.ts`
 * carries TWO roots, the vendored `context/skills` snapshot and the repo's own
 * `skills/`, and this skill currently lives only in the second. Both are
 * checked so moving it between them does not silently stop the injection.
 * Duplicated rather than imported because hooks stay dependency-free: they run
 * before `npm install` and must not be breakable by a bad node_modules.
 *
 * NOT off `ONESHOT_HOME`. Under a dry run that is `ROOT/state-dry`, which
 * symlinks only `config` and `.env`, so every skills path beneath it is absent
 * and the hook would log `repro_conditions_missing` and inject nothing — while
 * the session still resolves the skill fine through its composed `.claude`. The
 * mode you would rehearse this in is the one mode it would not fire in. The
 * hook lives at a fixed depth below the roots it is looking for
 * (hooks/packs/erp/), so `__dirname/../../..` is exact and independent of where
 * state happens to be pointed.
 */
const REPO = path.join(__dirname, '..', '..', '..');

function refPath() {
  const root = C.expandTilde(process.env.ONESHOT_SKILLS_ROOT || path.join(REPO, 'context'));
  const candidates = [
    path.join(root, 'skills', SKILL, 'refs', REF),
    path.join(REPO, 'skills', SKILL, 'refs', REF),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function inject(context) {
  C.emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
  process.exit(0);
}

const labels = String(process.env.ONESHOT_TICKET_LABELS || '').split(',').map((s) => s.trim().toLowerCase());
if (!labels.includes('bug')) C.allow();

/**
 * Project-level gate, after the label: with reproduction off, the prompt tells
 * the session to record `not-applicable` and never start the app, so a brief
 * about reading account flags and enumerating filter options would contradict
 * the prompt it arrives beside. Fails open: an unreadable config injects rather
 * than silently going quiet.
 */
const project = C.loadConfig('project.json');
if (project && project.bugReproduction === false) {
  C.event('repro_conditions_skipped', { why: 'bugReproduction is false for this project' });
  C.allow();
}

const file = refPath();
let ref = '';
try {
  ref = fs.readFileSync(file, 'utf8');
} catch (err) {
  C.event('repro_conditions_missing', { file, error: err.message });
  C.allow();
}

if (!ref.trim()) {
  C.event('repro_conditions_empty', { file });
  C.allow();
}

const bytes = Buffer.byteLength(ref, 'utf8');
const oversized = bytes > MAX_INLINE_BYTES;
C.event('repro_conditions_injected', { file, bytes, oversized });

if (oversized) {
  inject(
    `## Before you plan a reproduction — read this\n\n` +
    `If this ticket is a bug: \`${file}\` has outgrown an inline brief. READ IT NOW, before you ` +
    'choose an account or click an option, not when you come to write the verdict. It holds the ' +
    'conditions under which a bug that is really there comes back `not-reproduced`. ' +
    'If this ticket is a feature, ignore this and carry on.',
  );
}

inject(
  `## The conditions that hide a real bug\n\n` +
  '**Applies if this ticket is a bug.** If it is a feature and your reproduction is going to be ' +
  '`not-applicable`, stop reading here and carry on.\n\n' +
  'One principle: you ran it under different conditions than the reporter, and the difference is ' +
  'the bug. Injected now, before you plan, because two of these cannot be applied after the fact:\n' +
  '  - **The account** has to be the right one BEFORE you log in. Read its real flags and ' +
  'permissions and record them — `is_superuser`, `is_staff`, the specific permission the view ' +
  'requires. Do not assume what the test login is; that assumption has been wrong here before.\n' +
  '  - **The option** has to be enumerated while you are still choosing what to click. Where the ' +
  'input is one of a fixed set, the code behind it is ONE implementation shared by every option, ' +
  'so run them all — the ticket names the option the reporter used, not necessarily one whose ' +
  'data can expose the fault.\n\n' +
  'The remaining conditions — the record, the content, the order, the precision — are what a ' +
  '`not-reproduced` has to answer before you record it.\n\n' +
  `Source of truth, if you need to re-read it: \`${file}\`\n\n` +
  `---\n\n${ref}`,
);
