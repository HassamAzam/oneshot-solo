import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../lib/test-project-env.js';
import '../lib/test-scratch-home.js';
import { attemptLoop, decideClaim, outcomeOf, CLAIM_COOLDOWN_MS } from './run.js';
import { readJournal, ensureRunDirs, writeJournal, type RunJournal } from '../lib/journal.js';

const base = { iid: 7, runId: 'r-7', ticket: { iid: 7, title: 't', description: '', labels: [], notes: [], documents: [], externalDocs: [] }, worktree: '/wt', branch: 'b', port: 8000 };
const out = (status: string, extra: Record<string, unknown> = {}) => ({ status, result: null, turns: 1, sawActivity: 1, stderrTail: '', ...extra });

test('an infra death retries once with resume when a session id exists, and records both attempts', async () => {
  ensureRunDirs(7); writeJournal({ runId: 'r-7', iid: 7, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'running', pid: process.pid, phases: [] });
  const seen: Array<{ lap: number; resume?: string; previousAttempt: boolean }> = [];
  const final = await attemptLoop(base as never, async (input) => {
    seen.push({ lap: input.lap, resume: input.resume, previousAttempt: input.previousAttempt });
    return (input.lap === 0 ? out('infra', { sessionId: 's-0', error: 'stalled' }) : out('ok', { sessionId: 's-1' })) as never;
  });
  assert.equal(final.status, 'ok');
  assert.deepEqual(seen, [{ lap: 0, resume: undefined, previousAttempt: false }, { lap: 1, resume: 's-0', previousAttempt: true }]);
  const j = readJournal(7)!;
  assert.equal(j.phases.length, 2);
  assert.equal(j.phases[0]!.status, 'infra');
  assert.equal(j.phases[1]!.resumed, true);
});

test('two infra deaths end as infra; an aborted session does not retry', async () => {
  ensureRunDirs(8); writeJournal({ runId: 'r-8', iid: 8, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'running', pid: process.pid, phases: [] });
  const twice = await attemptLoop({ ...base, iid: 8, runId: 'r-8' } as never, async () => out('infra', { error: 'timed out' }) as never);
  assert.equal(twice.status, 'infra');
  assert.equal(readJournal(8)!.phases.length, 2);
  let n = 0;
  const ab = await attemptLoop({ ...base, iid: 8, runId: 'r-8' } as never, async () => { n += 1; return out('aborted') as never; });
  assert.equal(ab.status, 'aborted'); assert.equal(n, 1);
});

test('a resumed run continues from startLap with the recorded session, and still gets its own infra retry', async () => {
  ensureRunDirs(9); writeJournal({ runId: 'r-9', iid: 9, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'running', pid: process.pid, phases: [] });
  const ac = new AbortController();
  const seen: Array<{ lap: number; resume?: string; previousAttempt: boolean; signal?: AbortSignal }> = [];
  const final = await attemptLoop({ ...base, iid: 9, runId: 'r-9', resume: 's-old', signal: ac.signal } as never, async (input) => {
    seen.push({ lap: input.lap, resume: input.resume, previousAttempt: input.previousAttempt, signal: input.signal });
    return (input.lap === 2 ? out('infra', { error: 'stalled' }) : out('ok', { sessionId: 's-3' })) as never;
  }, 2);
  assert.equal(final.status, 'ok');
  assert.deepEqual(seen.map(({ lap, resume, previousAttempt }) => ({ lap, resume, previousAttempt })), [
    { lap: 2, resume: 's-old', previousAttempt: true },
    // No session id came back from lap 2, so lap 3 is a fresh session told about the previous attempt.
    { lap: 3, resume: undefined, previousAttempt: true },
  ]);
  assert.ok(seen.every((s) => s.signal === ac.signal), 'the conductor signal reaches every attempt');
  assert.deepEqual(readJournal(9)!.phases.map((p) => [p.lap, p.status, p.resumed]), [[2, 'infra', true], [3, 'ok', false]]);
});

test('the composed .claude is re-asserted before every attempt', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'oneshot-wt-'));
  try {
    execFileSync('git', ['init', '-q', wt]);
    ensureRunDirs(10); writeJournal({ runId: 'r-10', iid: 10, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'running', pid: process.pid, phases: [] });
    const composedAtSpawn: boolean[] = [];
    await attemptLoop({ ...base, iid: 10, runId: 'r-10', worktree: wt } as never, async (input) => {
      composedAtSpawn.push(existsSync(join(wt, '.claude', 'skills', 'ship-ticket')));
      // The session wipes the composition (a `git clean -fdx`, say) and then dies.
      if (input.lap === 0) { rmSync(join(wt, '.claude'), { recursive: true, force: true }); return out('infra', { error: 'stalled' }) as never; }
      return out('ok') as never;
    });
    assert.deepEqual(composedAtSpawn, [true, true]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

const journal = (over: Partial<RunJournal>): RunJournal => ({ runId: 'r-1', iid: 1, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'done', phases: [], ...over });
const DEAD_PID = 2 ** 22 + 12345; // above every default pid_max, so never a live process

test('decideClaim: refuse a live claim and a fresh block; resume an abort or a dead conductor; otherwise fresh', () => {
  assert.equal(decideClaim(null), 'fresh');
  assert.equal(decideClaim(journal({ status: 'running', pid: process.pid })), 'refuse');
  assert.equal(decideClaim(journal({ status: 'claimed', pid: process.pid })), 'refuse');
  assert.equal(decideClaim(journal({ status: 'running', pid: DEAD_PID })), 'resume');
  assert.equal(decideClaim(journal({ status: 'claimed' })), 'resume');
  assert.equal(decideClaim(journal({ status: 'aborted', pid: process.pid })), 'resume');
  assert.equal(decideClaim(journal({ status: 'blocked', stoppedAt: Date.now() - 60_000 })), 'refuse');
  assert.equal(decideClaim(journal({ status: 'blocked', stoppedAt: Date.now() - CLAIM_COOLDOWN_MS - 1 })), 'fresh');
  assert.equal(decideClaim(journal({ status: 'done' })), 'fresh');
});

test('outcomeOf: a parked session is aborted without classifying; a done verdict passes through', async () => {
  let classified = 0;
  const parked = await outcomeOf(out('parked', { error: 'rate_limit' }) as never, 'b', 1, {
    classify: async () => { classified += 1; return { kind: 'infra', why: 'x' }; }, sleep: async () => {},
  });
  assert.deepEqual(parked, { kind: 'aborted' });
  assert.equal(classified, 0);
  const done = { kind: 'done', mr: {}, result: { summary: 's' }, problems: [] } as never;
  assert.equal(await outcomeOf(out('ok') as never, 'b', 1, { classify: async () => done, sleep: async () => { throw new Error('no wait'); } }), done);
});

test('outcomeOf: a failed MR lookup is re-asked up to 3 times, 20 s apart, before it is accepted', async () => {
  const lookupFailed = { kind: 'blocked' as const, why: 'could not look up the merge request on b: network 0' };
  const done = { kind: 'done', mr: {}, result: { summary: 's' }, problems: [] } as never;

  const slept: number[] = []; let asks = 0;
  const recovered = await outcomeOf(out('ok') as never, 'b', 1, {
    classify: async () => { asks += 1; return asks < 3 ? lookupFailed : done; },
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(recovered, done);
  assert.deepEqual(slept, [20_000, 20_000]);

  const slept2: number[] = []; let asks2 = 0;
  const gaveUp = await outcomeOf(out('ok') as never, 'b', 1, {
    classify: async () => { asks2 += 1; return lookupFailed; },
    sleep: async (ms) => { slept2.push(ms); },
  });
  assert.deepEqual(gaveUp, lookupFailed);
  assert.equal(asks2, 4);
  assert.deepEqual(slept2, [20_000, 20_000, 20_000]);

  let asks3 = 0;
  const real = await outcomeOf(out('ok') as never, 'b', 1, {
    classify: async () => { asks3 += 1; return { kind: 'blocked', why: 'needs a schema decision' }; },
    sleep: async () => { throw new Error('a real verdict is not re-asked'); },
  });
  assert.deepEqual(real, { kind: 'blocked', why: 'needs a schema decision' });
  assert.equal(asks3, 1);
});
