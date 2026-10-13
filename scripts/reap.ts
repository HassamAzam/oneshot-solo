/**
 * `npm run reap [-- --dry-run] [--all-done]` — remove worktrees nobody needs any more.
 *
 * Every run keeps its worktree, whatever its status (spec §5.4): the branch is
 * pushed, but the directory is where a person looks first when a run stopped.
 * This sweeps WT_ROOT/t<iid>-r-… whose ticket's journal says `done` and
 * `merged: true`; `--all-done` also takes `done` runs whose MR is still open.
 * A worktree is matched to the journal that recorded it, so one left by an
 * earlier run of the same ticket is kept. `--dry-run` only lists. The branch is
 * never touched (reapWorktree).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WT_ROOT } from '../src/lib/config.js';
import { readJournal } from '../src/lib/journal.js';
import { reapWorktree } from '../src/lib/worktrees.js';

const dryRun = process.argv.includes('--dry-run');
const allDone = process.argv.includes('--all-done');

/** Why a worktree stays, or null when it goes. */
function keepReason(dir: string, iid: number, runId: string): string | null {
  const j = readJournal(iid);
  if (!j) return `no journal for #${iid}`;
  if (j.worktree !== dir && j.runId !== runId) return `#${iid}'s journal is run ${j.runId} in ${j.worktree ?? '(no worktree)'}`;
  if (j.status !== 'done') return `#${iid} is ${j.status}`;
  if (!j.merged && !allDone) return `#${iid} is done but not merged — --all-done takes it`;
  return null;
}

const names = existsSync(WT_ROOT) ? readdirSync(WT_ROOT).sort() : [];
let removed = 0;
for (const name of names) {
  const m = /^t(\d+)-(r-.+)$/.exec(name);
  if (!m) continue;
  const dir = join(WT_ROOT, name);
  const why = keepReason(dir, Number(m[1]), m[2]!);
  if (why) { console.log(`keep    ${name}  ${why}`); continue; }
  if (dryRun) { console.log(`would remove  ${name}`); continue; }
  reapWorktree(dir, m[2]!);
  if (existsSync(dir)) console.log(`kept    ${name}  git worktree remove failed (see above)`);
  else { removed += 1; console.log(`removed ${name}`); }
}
console.log(names.length ? `\n${dryRun ? 'dry run — nothing removed' : `${removed} removed`}` : `no worktrees under ${WT_ROOT || '(no WT_ROOT)'}`);
