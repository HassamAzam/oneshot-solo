/**
 * `npm run status [--json]` — every run, one line each, no browser.
 *
 * The question "what happened while I was away", answered in the terminal: the
 * same list the dashboard index shows (src/lib/telemetry.ts allRuns), newest
 * first, archived runs included, under whether the conductor is up and which
 * tickets wait in the dashboard's queue. Tokens are estimates. `--json` prints
 * the run summaries as they are, for a script to read.
 */
import { conductorLive, queued } from '../src/lib/queue.js';
import { allRuns, fmtDuration, fmtTokens } from '../src/lib/telemetry.js';

const runs = allRuns();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(runs, null, 1));
  process.exit(0);
}

// The last column (the MR) is never cut: it is the one a reader copies.
const W = [7, 44, 9, 7, 3, 6, 7];
const row = (c: string[]): string => c.map((s, i) => (i < W.length ? s.padEnd(W[i]!).slice(0, W[i]) : s)).join('  ');

const conductor = conductorLive();
console.log(conductor.live ? `conductor: running (pid ${conductor.pid})` : 'conductor: not running');
const waiting = queued();
if (waiting.length) console.log(`queued: ${waiting.map((q) => `#${q.iid}`).join(', ')}`);
console.log('');

if (runs.length === 0) {
  console.log('no runs yet');
  process.exit(0);
}
console.log(row(['ticket', 'title', 'status', 'time', 'att', 'turns', 'tokens', 'mr']));
for (const r of runs) {
  const status = r.live ? `${r.status}*` : r.merged ? 'merged' : r.status;
  console.log(row([
    `#${r.iid}`, r.title, status, fmtDuration(r.durationMs), String(r.attempts), String(r.turns), fmtTokens(r.tokens),
    r.mrUrl ? r.mrUrl.replace(/^.*\//, '!') : '-',
  ]));
}
if (runs.some((r) => r.live)) console.log('\n* still running');
