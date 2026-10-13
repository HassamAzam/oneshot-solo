import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MergeRequest } from '../lib/gitlab.js';
import { mergeGate, mergeNow } from './merge.js';

const mr = { iid: 9, detailed_merge_status: 'mergeable' } as MergeRequest;
const ok = { summary: 's', cases: [{ id: '1', title: 'a', verdict: 'pass' as const }] };

test('mergeGate merges only when mode=auto, no problems, ≥1 pass, no fail, regressions listed', () => {
  assert.equal(mergeGate(ok, mr, [], 'auto').merge, true);
  assert.equal(mergeGate(ok, mr, [], 'manual').merge, false);
  assert.equal(mergeGate(ok, mr, ['Draft title'], 'auto').merge, false);
  assert.equal(mergeGate({ summary: 's' }, mr, [], 'auto').merge, false);                                   // no cases
  assert.equal(mergeGate({ summary: 's', cases: [{ id: '1', title: 'a', verdict: 'fail' }] }, mr, [], 'auto').merge, false);
  assert.equal(mergeGate({ ...ok, cases: [...ok.cases, { id: '2', title: 'b', verdict: 'skipped' }] }, mr, [], 'auto').merge, true);
  assert.equal(mergeGate({ ...ok, regressions: ['pre-existing flake'] }, { ...mr, description: 'no mention' } as never, [], 'auto').merge, false);
  assert.equal(mergeGate({ ...ok, regressions: ['pre-existing flake'] }, { ...mr, description: 'Regressions: pre-existing flake' } as never, [], 'auto').merge, true);
  assert.equal(mergeGate(ok, { ...mr, detailed_merge_status: 'conflict' } as never, [], 'auto').merge, false);
});

test('mergeGate: a lone failing case is reported as a failure, not as a missing pass', () => {
  const r = mergeGate({ summary: 's', cases: [{ id: '1', title: 'a', verdict: 'fail' }] }, mr, [], 'auto');
  assert.equal(r.merge, false);
  assert.match(r.why, /case\(s\) failed: 1/);
  assert.equal(mergeGate({ summary: 's', cases: [{ id: '1', title: 'a', verdict: 'skipped' }] }, mr, [], 'auto').why, 'no case recorded a pass');
});

test('mergeGate: need_rebase and ci_still_running pass the gate; an absent status is left to GitLab', () => {
  assert.equal(mergeGate(ok, { ...mr, detailed_merge_status: 'need_rebase' } as never, [], 'auto').merge, true);
  assert.equal(mergeGate(ok, { ...mr, detailed_merge_status: 'ci_still_running' } as never, [], 'auto').merge, true);
  assert.equal(mergeGate(ok, { iid: 9 } as never, [], 'auto').merge, true);
  const why = mergeGate(ok, { ...mr, detailed_merge_status: 'draft_status' } as never, [], 'auto').why;
  assert.match(why, /draft_status/);
});

// ------------------------------------------------------------------ mergeNow

type Call = [string, ...unknown[]];
const res = (over: Record<string, unknown> = {}) => ({ ok: true, kind: 'ok', status: 200, data: null, ...over });
const refused = (status: number, error = '') => res({ ok: false, kind: 'client', status, error });
const open = { iid: 9, sha: 'abc' } as never;

function deps(script: { accept: unknown[]; rebase?: unknown; polls?: unknown[] }) {
  const calls: Call[] = []; const warned: string[] = [];
  const accept = [...script.accept]; const polls = [...(script.polls ?? [])];
  return {
    calls, warned,
    d: {
      acceptMergeRequest: async (iid: number, opts: unknown) => { calls.push(['accept', iid, opts]); return accept.shift(); },
      rebaseMergeRequest: async (iid: number, skipCi?: boolean) => { calls.push(['rebase', iid, skipCi]); return script.rebase ?? res({ status: 202 }); },
      getMergeRequest: async (iid: number, opts?: unknown) => { calls.push(['get', iid, opts]); return polls.shift() ?? res({ data: { iid, sha: 'abc', rebase_in_progress: true } }); },
      sleep: async () => {},
      warn: (msg: string) => { warned.push(msg); },
    } as never,
  };
}

test('mergeNow merges at the evaluated sha and removes the source branch', async () => {
  const { calls, d } = deps({ accept: [res()] });
  assert.deepEqual(await mergeNow(open, d), { merged: true, why: 'merged' });
  assert.deepEqual(calls, [['accept', 9, { sha: 'abc', squash: false, removeSourceBranch: true }]]);
});

test('mergeNow: not mergeable → one rebase, waits for it with rebase progress, retries at the rebased sha', async () => {
  const { calls, d } = deps({
    accept: [refused(406, 'Branch cannot be merged'), res()],
    polls: [res({ data: { iid: 9, sha: 'abc', rebase_in_progress: true } }), res({ data: { iid: 9, sha: 'def', rebase_in_progress: false } })],
  });
  assert.deepEqual(await mergeNow(open, d), { merged: true, why: 'merged after rebase' });
  assert.deepEqual(calls.filter(([k]) => k === 'rebase'), [['rebase', 9, true]]);
  assert.ok(calls.filter(([k]) => k === 'get').every(([, , opts]) => (opts as { rebaseProgress?: boolean }).rebaseProgress === true));
  assert.deepEqual(calls.at(-1), ['accept', 9, { sha: 'def', squash: false, removeSourceBranch: true }]);
});

test('mergeNow: a rebase already running is waited for, never re-issued', async () => {
  const { calls, warned, d } = deps({
    accept: [refused(409, 'Rebase in progress'), res()],
    polls: [res({ data: { iid: 9, sha: 'def', rebase_in_progress: false } })],
  });
  assert.deepEqual(await mergeNow(open, d), { merged: true, why: 'merged after rebase' });
  assert.ok(!calls.some(([k]) => k === 'rebase'));
  assert.match(warned.join('\n'), /rebase running — waiting/);
});

test('mergeNow: a stale sha is refused outright (the branch moved under the gate)', async () => {
  const { calls, d } = deps({ accept: [refused(409, 'SHA does not match HEAD of source branch')] });
  const r = await mergeNow(open, d);
  assert.equal(r.merged, false);
  assert.match(r.why, /sha-stale/);
  assert.ok(!calls.some(([k]) => k === 'rebase' || k === 'get'));
});

test('mergeNow: refused rebase, a rebase that never finishes, a refusal after rebase, and no sha are all not merged', async () => {
  const a = deps({ accept: [refused(406)], rebase: refused(403, 'forbidden') });
  assert.match((await mergeNow(open, a.d)).why, /rebase refused/);

  const b = deps({ accept: [refused(406)] });
  const rb = await mergeNow(open, b.d);
  assert.deepEqual(rb, { merged: false, why: 'rebase did not finish within 60s' });
  assert.equal(b.calls.filter(([k]) => k === 'get').length, 12);

  const c = deps({
    accept: [refused(406), refused(406)],
    polls: [res({ data: { iid: 9, sha: 'def', rebase_in_progress: false, merge_error: 'Rebase failed: conflicts' } })],
  });
  const rc = await mergeNow(open, c.d);
  assert.equal(rc.merged, false);
  assert.match(rc.why, /merge refused after rebase: not-mergeable/);
  assert.match(rc.why, /Rebase failed: conflicts/);

  const n = deps({ accept: [] });
  assert.equal((await mergeNow({ iid: 9, sha: null } as never, n.d)).merged, false);
  assert.equal(n.calls.length, 0);
});
