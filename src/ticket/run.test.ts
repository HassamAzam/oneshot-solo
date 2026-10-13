import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../lib/test-project-env.js';
import '../lib/test-scratch-home.js';
import { attemptLoop, decideClaim, leaseFor, outcomeOf, CLAIM_COOLDOWN_MS, type LeaseDeps } from './run.js';
import { readJournal, ensureRunDirs, writeJournal, type RunJournal } from '../lib/journal.js';
import { foldFrame, newFrameFold } from './session.js';

const base = { iid: 7, runId: 'r-7', ticket: { iid: 7, title: 't', description: '', labels: [], notes: [], documents: [], externalDocs: [] }, worktree: '/wt', branch: 'b', port: 8000 };
const out = (status: string, extra: Record<string, unknown> = {}) => ({ status, result: null, turns: 1, sawActivity: 1, stderrTail: '', ...extra });

/** What runSession returns for a session that stalled mid-work: frames carrying its id, and no result frame. */
function diedWithoutResult(sessionId: string) {
  const f = newFrameFold();
  foldFrame(f, { type: 'system', subtype: 'init', session_id: sessionId } as never);
  foldFrame(f, { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'planning' }] } } as never);
  return { ...f.out, status: 'infra' as const, error: 'stalled: no stream message for 15m' };
}

test('an infra death with no result frame still retries with resume on the id its frames carried, and records both attempts', async () => {
  ensureRunDirs(7); writeJournal({ runId: 'r-7', iid: 7, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'running', pid: process.pid, phases: [] });
  const seen: Array<{ lap: number; resume?: string; previousAttempt: boolean }> = [];
  const final = await attemptLoop(base as never, async (input) => {
    seen.push({ lap: input.lap, resume: input.resume, previousAttempt: input.previousAttempt });
    return (input.lap === 0 ? diedWithoutResult('s-0') : out('ok', { sessionId: 's-1' })) as never;
  });
  assert.equal(final.status, 'ok');
  assert.deepEqual(seen, [{ lap: 0, resume: undefined, previousAttempt: false }, { lap: 1, resume: 's-0', previousAttempt: true }]);
  const j = readJournal(7)!;
  assert.equal(j.phases.length, 2);
  assert.equal(j.phases[0]!.status, 'infra');
  assert.equal(j.phases[0]!.resultSubtype, undefined);
  assert.equal(j.phases[0]!.sessionId, 's-0', 'the journal keeps the id, so the next boot can resume it too');
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

test('decideClaim with force (--ticket): the blocked cooldown is bypassed; a live claim is still refused', () => {
  const force = { force: true };
  assert.equal(decideClaim(journal({ status: 'blocked', stoppedAt: Date.now() - 60_000 }), force), 'fresh');
  assert.equal(decideClaim(journal({ status: 'running', pid: process.pid }), force), 'refuse');
  assert.equal(decideClaim(journal({ status: 'claimed', pid: process.pid }), force), 'refuse');
  assert.equal(decideClaim(journal({ status: 'aborted' }), force), 'resume');
  assert.equal(decideClaim(journal({ status: 'blocked', stoppedAt: Date.now() - 60_000 }), { force: false }), 'refuse');
});

/** Injected lease machinery that records every call in order. `states` is what GitLab says of each MR iid. */
function leaseDeps(over: Partial<LeaseDeps> & { present?: string[]; states?: Record<number, 'merged' | 'opened' | 'closed' | 'unknown'> } = {}) {
  const calls: unknown[][] = [];
  const present = new Set(over.present ?? []);
  const { present: _p, states = {}, ...rest } = over;
  const d: LeaseDeps = {
    leaseWorktree: (runId, branch, name) => { calls.push(['lease', runId, branch, name]); return { worktree: `/wt/${name}`, branch, base: 'dev', runId }; },
    reapWorktree: (worktree, runId) => { calls.push(['reap', worktree, runId]); },
    deleteLocalBranch: (branch) => { calls.push(['delete', branch]); return true; },
    exists: (path) => present.has(path),
    mrState: async (mrIid) => { calls.push(['mrState', mrIid]); return states[mrIid] ?? 'unknown'; },
    ...rest,
  };
  return { calls, d };
}

test('leaseFor: a merged ticket that comes back reaps the old worktree, deletes its local branch, and cuts a run-stamped branch from base', async () => {
  const merged = journal({ runId: 'r-old', status: 'done', merged: true, mrIid: 5, branch: 'oneshot/ticket-1-t', worktree: '/wt/t1-r-old' });
  const { calls, d } = leaseDeps({ present: ['/wt/t1-r-old'] });
  const lease = await leaseFor(1, 'r-mgo3abcd-1a2b3c', 't', merged, false, d);
  // The delete succeeded, and the name is still stamped: GitLab may not have removed the merged remote branch.
  assert.deepEqual(calls, [
    ['reap', '/wt/t1-r-old', 'r-old'],
    ['delete', 'oneshot/ticket-1-t'],
    ['lease', 'r-mgo3abcd-1a2b3c', 'oneshot/ticket-1-t-mgo3ab', 't1-r-mgo3abcd-1a2b3c'],
  ]);
  assert.equal(lease.branch, 'oneshot/ticket-1-t-mgo3ab');
  assert.equal(lease.worktree, '/wt/t1-r-mgo3abcd-1a2b3c');
});

test('leaseFor: when git will not delete the merged branch, the fresh lease is the same run-stamped one', async () => {
  const merged = journal({ runId: 'r-old', status: 'done', merged: true, branch: 'oneshot/ticket-1-t', worktree: '/wt/t1-r-old' });
  const { calls, d } = leaseDeps({ deleteLocalBranch: (b) => { calls.push(['delete', b]); return false; } });
  const lease = await leaseFor(1, 'r-mgo3abcd-1a2b3c', 't', merged, false, d);
  assert.deepEqual(calls.at(-1), ['lease', 'r-mgo3abcd-1a2b3c', 'oneshot/ticket-1-t-mgo3ab', 't1-r-mgo3abcd-1a2b3c']);
  assert.equal(lease.branch, 'oneshot/ticket-1-t-mgo3ab');
});

test('leaseFor: a done run left In Review whose MR a person merged on GitLab takes the merged path too', async () => {
  const merged = journal({ runId: 'r-old', status: 'done', merged: false, mrIid: 42, branch: 'oneshot/ticket-1-t', worktree: '/wt/t1-r-old' });
  const { calls, d } = leaseDeps({ present: ['/wt/t1-r-old'], states: { 42: 'merged' } });
  const lease = await leaseFor(1, 'r-mgo3abcd-1a2b3c', 't', merged, false, d);
  assert.deepEqual(calls, [
    ['mrState', 42],
    ['reap', '/wt/t1-r-old', 'r-old'],
    ['delete', 'oneshot/ticket-1-t'],
    ['lease', 'r-mgo3abcd-1a2b3c', 'oneshot/ticket-1-t-mgo3ab', 't1-r-mgo3abcd-1a2b3c'],
  ]);
  assert.equal(lease.branch, 'oneshot/ticket-1-t-mgo3ab');
});

test('leaseFor: a merged run the catch-all finish left blocked is still merged history', async () => {
  const merged = journal({ runId: 'r-old', status: 'blocked', merged: true, mrIid: 5, branch: 'oneshot/ticket-1-t', worktree: '/wt/t1-r-old' });
  const { calls, d } = leaseDeps({ present: ['/wt/t1-r-old'] });
  assert.equal((await leaseFor(1, 'r-mgo3abcd-1a2b3c', 't', merged, false, d)).branch, 'oneshot/ticket-1-t-mgo3ab');
  assert.deepEqual(calls[0], ['reap', '/wt/t1-r-old', 'r-old']);
});

test('leaseFor: a merged ticket that comes back again stamps the title\'s branch, not the last stamped one', async () => {
  const merged = journal({ runId: 'r-mgo3abcd-1a2b3c', status: 'done', merged: true, branch: 'oneshot/ticket-1-t-mgo3ab', worktree: '/wt/t1-r-mgo3abcd-1a2b3c' });
  const { calls, d } = leaseDeps();
  assert.equal((await leaseFor(1, 'r-mh12cdef-4d5e6f', 't', merged, false, d)).branch, 'oneshot/ticket-1-t-mh12cd');
  assert.deepEqual(calls.find(([k]) => k === 'delete'), ['delete', 'oneshot/ticket-1-t-mgo3ab']);
});

test('leaseFor: an unmerged ticket whose worktree still exists re-attaches through leaseWorktree under the recorded name and branch', async () => {
  // Its MR is still open on GitLab: the same branch carries on.
  const inReview = journal({ runId: 'r-old', status: 'done', merged: false, mrIid: 42, branch: 'oneshot/ticket-1-old-title', worktree: '/somewhere/t1-r-old' });
  const a = leaseDeps({ present: ['/somewhere/t1-r-old'], states: { 42: 'opened' } });
  assert.equal((await leaseFor(1, 'r-new', 'a new title', inReview, false, a.d)).branch, 'oneshot/ticket-1-old-title');
  assert.deepEqual(a.calls, [['mrState', 42], ['lease', 'r-new', 'oneshot/ticket-1-old-title', 't1-r-old']]);

  // Resumed: same run id, same worktree, re-seeded through the lease; GitLab is not asked.
  const dead = journal({ runId: 'r-old', status: 'running', mrIid: 42, branch: 'oneshot/ticket-1-old-title', worktree: '/somewhere/t1-r-old' });
  const b = leaseDeps({ present: ['/somewhere/t1-r-old'], states: { 42: 'merged' } });
  await leaseFor(1, 'r-old', 't', dead, true, b.d);
  assert.deepEqual(b.calls, [['lease', 'r-old', 'oneshot/ticket-1-old-title', 't1-r-old']]);

  // No journal: a fresh lease on the title's branch.
  const c = leaseDeps();
  assert.equal((await leaseFor(1, 'r-new', 'Add Export', null, false, c.d)).branch, 'oneshot/ticket-1-add-export');
  assert.deepEqual(c.calls, [['lease', 'r-new', 'oneshot/ticket-1-add-export', 't1-r-new']]);
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
