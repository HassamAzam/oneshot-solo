import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/test-project-env.js';
import '../lib/test-scratch-home.js';
import { finish } from './finish.js';
import { mrPostCheck } from './outcome.js';
import { ensureRunDirs, writeJournal, readJournal } from '../lib/journal.js';
import { issueUrl } from '../lib/gitlab.js';

const mr = { iid: 9, title: 'T', description: '[closes https://gitlab.arbisoft.com/arbisoft/erp/-/issues/1]', target_branch: 'dev', source_branch: 'b', state: 'opened', web_url: 'https://g/!9', sha: 'abc', detailed_merge_status: 'mergeable' } as never;
const ok = { summary: 'built it', cases: [{ id: '1', title: 'a', verdict: 'pass' as const }] };
function fresh(iid: number) { ensureRunDirs(iid); writeJournal({ runId: 'r-1', iid, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'running', pid: process.pid, port: 8000, phases: [] }); }
function deps(over: Partial<Record<string, unknown>> = {}) {
  const calls: Array<[string, unknown]> = [];
  return { calls, d: {
    editIssueLabels: async (iid: number, p: unknown) => { calls.push(['labels', p]); return { ok: true, kind: 'ok', status: 200, data: null }; },
    addIssueNote: async (iid: number, body: string) => { calls.push(['note', body]); return { ok: true, kind: 'ok', status: 201, data: { id: 1 } }; },
    mergeNow: async () => { calls.push(['merge', null]); return { merged: true, why: 'merged' }; },
    mergeMode: () => 'auto' as const,
    reapPortServer: () => 0,
    updateMergeRequest: async () => ({ ok: true, kind: 'ok', status: 200, data: null }),
    ...over,
  } };
}

test('done + gate passed: merges, Loop→Merged, posts the merged note, journal merged', async () => {
  fresh(1); const { calls, d } = deps();
  await finish(1, 'r-1', { kind: 'done', mr, result: ok, problems: [] }, d as never);
  assert.ok(calls.some(([k]) => k === 'merge'));
  assert.deepEqual(calls.find(([k]) => k === 'labels')![1], { remove: ['Loop', 'Needs Human', 'In Review'], add: ['Merged'] });
  assert.match(String(calls.find(([k]) => k === 'note')![1]), /merged !9/);
  const j = readJournal(1)!; assert.equal(j.status, 'done'); assert.equal(j.merged, true); assert.equal(j.mrIid, 9); assert.ok(j.stoppedAt);
});

test('done + manual mode: no merge, Loop→In Review, note says why', async () => {
  fresh(2); const { calls, d } = deps({ mergeMode: () => 'manual' });
  await finish(2, 'r-1', { kind: 'done', mr, result: ok, problems: [] }, d as never);
  assert.ok(!calls.some(([k]) => k === 'merge'));
  assert.deepEqual(calls.find(([k]) => k === 'labels')![1], { remove: ['Loop', 'Needs Human'], add: ['In Review'] });
  assert.match(String(calls.find(([k]) => k === 'note')![1]), /merge\.mode is manual/);
  assert.equal(readJournal(2)!.merged, false);
});

test('done + gate failed (a case failed): In Review with the reason; merge refused: In Review too', async () => {
  fresh(3); const { calls, d } = deps();
  await finish(3, 'r-1', { kind: 'done', mr, result: { summary: 's', cases: [{ id: '1', title: 'a', verdict: 'fail' }] }, problems: [] }, d as never);
  assert.ok(!calls.some(([k]) => k === 'merge'));
  assert.match(String(calls.find(([k]) => k === 'note')![1]), /case\(s\) failed/);
  fresh(4); const r = deps({ mergeNow: async () => ({ merged: false, why: 'merge refused: conflict' }) });
  await finish(4, 'r-1', { kind: 'done', mr, result: ok, problems: [] }, r.d as never);
  assert.deepEqual(r.calls.find(([k]) => k === 'labels')![1], { remove: ['Loop', 'Needs Human'], add: ['In Review'] });
  assert.match(String(r.calls.find(([k]) => k === 'note')![1]), /conflict/);
});

test('blocked: Loop→Needs Human, stop note with the marker, journal blocked', async () => {
  fresh(5); const { calls, d } = deps();
  await finish(5, 'r-1', { kind: 'blocked', why: 'needs a schema decision' }, d as never);
  assert.deepEqual(calls.find(([k]) => k === 'labels')![1], { remove: ['Loop', 'In Review'], add: ['Needs Human'] });
  const note = String(calls.find(([k]) => k === 'note')![1]);
  assert.match(note, /Oneshot stopped: \*\*needs a schema decision\*\*/); assert.match(note, /<!-- oneshot:stop:r-1 -->/);
  assert.equal(readJournal(5)!.status, 'blocked'); assert.equal(readJournal(5)!.blockedWhy, 'needs a schema decision');
});

test('aborted: no GitLab calls, journal aborted and resumable', async () => {
  fresh(6); const { calls, d } = deps();
  await finish(6, 'r-1', { kind: 'aborted' }, d as never);
  assert.equal(calls.length, 0);
  assert.equal(readJournal(6)!.status, 'aborted');
});

test('infra: Loop→Needs Human with a stop note naming the machinery, journal blocked', async () => {
  fresh(7); const { calls, d } = deps();
  await finish(7, 'r-1', { kind: 'infra', why: 'stalled: no stream message for 15m' }, d as never);
  assert.deepEqual(calls.find(([k]) => k === 'labels')![1], { remove: ['Loop', 'In Review'], add: ['Needs Human'] });
  const note = String(calls.find(([k]) => k === 'note')![1]);
  assert.match(note, /Oneshot stopped: \*\*stalled: no stream message for 15m\*\*/);
  assert.match(note, /\n<!-- oneshot:stop:r-1 -->$/);
  assert.equal(readJournal(7)!.status, 'blocked');
});

/** A Draft MR that passes every other post-check rule, so the Draft problem is the only one. */
function draftMr(iid: number) {
  return { iid: 9, title: 'Draft: Add the export button', description: `Adds it.\n[closes ${issueUrl(iid)}]`, target_branch: 'dev', source_branch: 'b', state: 'opened', web_url: 'https://g/!9', sha: 'abc', draft: true, detailed_merge_status: 'draft_status' } as never;
}

test('a Draft: title is stripped before the gate; the problem goes and the merge goes ahead on the undrafted MR', async () => {
  fresh(8);
  const problems = mrPostCheck(draftMr(8), 8, 'dev');
  assert.equal(problems.length, 1, 'the fixture must fail the post-check on Draft alone');
  const updates: unknown[] = []; const mergedTitles: string[] = [];
  const { calls, d } = deps({
    updateMergeRequest: async (mrIid: number, patch: unknown) => { updates.push([mrIid, patch]); return { ok: true, kind: 'ok', status: 200, data: null }; },
    mergeNow: async (m: { title: string }) => { mergedTitles.push(m.title); return { merged: true, why: 'merged' }; },
  });
  await finish(8, 'r-1', { kind: 'done', mr: draftMr(8), result: ok, problems }, d as never);
  assert.deepEqual(updates, [[9, { title: 'Add the export button' }]]);
  assert.deepEqual(mergedTitles, ['Add the export button']);
  assert.deepEqual(calls.find(([k]) => k === 'labels')![1], { remove: ['Loop', 'Needs Human', 'In Review'], add: ['Merged'] });
  assert.equal(readJournal(8)!.merged, true);
});

test('a Draft: title GitLab refuses to update keeps the problem: no merge, In Review, the note says Draft', async () => {
  fresh(9);
  const problems = mrPostCheck(draftMr(9), 9, 'dev');
  const { calls, d } = deps({ updateMergeRequest: async () => ({ ok: false, kind: 'network', status: 0, data: null, error: 'ECONNRESET' }) });
  await finish(9, 'r-1', { kind: 'done', mr: draftMr(9), result: ok, problems }, d as never);
  assert.ok(!calls.some(([k]) => k === 'merge'));
  assert.deepEqual(calls.find(([k]) => k === 'labels')![1], { remove: ['Loop', 'Needs Human'], add: ['In Review'] });
  assert.match(String(calls.find(([k]) => k === 'note')![1]), /Draft/);
  assert.equal(readJournal(9)!.merged, false);
});

test('the done note escapes model prose and keeps the marker on its own line', async () => {
  fresh(10); const { calls, d } = deps({ mergeMode: () => 'manual' });
  await finish(10, 'r-1', { kind: 'done', mr, result: { summary: 'Fixed the <title> tag', cases: [], assumptions: ['kept <h1>'] }, problems: [] }, d as never);
  const note = String(calls.find(([k]) => k === 'note')![1]);
  assert.match(note, /Fixed the &lt;title&gt; tag/);
  assert.match(note, /- kept &lt;h1&gt;/);
  assert.match(note, /\n<!-- oneshot:note:r-1 -->$/);
});

test('finish is a no-op once the journal is terminal: a second call on a done run makes no GitLab call', async () => {
  fresh(11); const first = deps();
  await finish(11, 'r-1', { kind: 'done', mr, result: ok, problems: [] }, first.d as never);
  assert.equal(readJournal(11)!.status, 'done');
  // run.ts's catch-all re-runs finish as blocked when the first finish threw after the merge.
  const again = deps();
  await finish(11, 'r-1', { kind: 'blocked', why: 'the conductor failed mid-run: boom' }, again.d as never);
  assert.deepEqual(again.calls, []);
  const j = readJournal(11)!;
  assert.equal(j.status, 'done'); assert.equal(j.merged, true); assert.equal(j.blockedWhy, undefined);

  for (const status of ['blocked', 'aborted'] as const) {
    fresh(12); const { calls, d } = deps();
    writeJournal({ ...readJournal(12)!, status });
    await finish(12, 'r-1', { kind: 'blocked', why: 'again' }, d as never);
    assert.deepEqual(calls, [], `${status} journal`);
    assert.equal(readJournal(12)!.status, status);
  }
});
