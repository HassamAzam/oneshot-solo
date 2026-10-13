import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/test-project-env.js';
import '../lib/test-scratch-home.js';
import { describe, orderCandidates, triage } from './scan.js';
import { ensureRunDirs, writeJournal } from '../lib/journal.js';
import type { Issue } from '../lib/gitlab.js';

const issue = (iid: number, over: Partial<Issue> = {}): Issue => ({ iid, title: `t${iid}`, description: '', labels: ['Loop'], assignees: [], state: 'opened', web_url: '', updated_at: '', ...over });

test('triage skips exit, in-review and blocked labels, and a live claim, saying why', () => {
  ensureRunDirs(5); writeJournal({ runId: 'r-5', iid: 5, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'running', pid: process.pid, phases: [] });
  const r = triage([
    issue(1),
    issue(2, { labels: ['Loop', 'Merged'] }),
    issue(3, { labels: ['Loop', 'In Review'] }),
    issue(4, { labels: ['Loop', 'Needs Human'] }),
    issue(5),
  ], 'me');
  assert.deepEqual(r.candidates.map((c) => c.iid), [1]);
  assert.deepEqual(r.skipped.map((s) => s.iid), [2, 3, 4, 5]);
  assert.match(r.skipped.find((s) => s.iid === 3)!.why, /In Review/);
  assert.match(r.skipped.find((s) => s.iid === 5)!.why, /in flight/);
});

test('triage: assigned to this desk is claimable, to a teammate is dropped silently, with no identity is skipped', () => {
  const tickets = [issue(11, { assignees: [{ username: 'me' }] }), issue(12, { assignees: [{ username: 'teammate' }] }), issue(13)];
  const mine = triage(tickets, 'me');
  assert.deepEqual(mine.candidates.map((c) => c.iid), [11, 13]);
  assert.deepEqual(mine.skipped, []);
  const nobody = triage(tickets, '');
  assert.deepEqual(nobody.candidates.map((c) => c.iid), [13]);
  assert.deepEqual(nobody.skipped.map((s) => s.iid), [11, 12]);
  // The token is fine; GitLab has not answered yet — the hint must not send the operator to token:set.
  assert.match(nobody.skipped[0]!.why, /GitLab has not yet answered who this desk is \(will retry each tick\)/);
  assert.doesNotMatch(nobody.skipped[0]!.why, /token:set/);
});

test('orderCandidates puts a ticket whose last run blocked behind ready work, keeping order within each half', () => {
  const status: Record<number, string> = { 2: 'blocked', 3: 'aborted' };
  const ordered = orderCandidates([issue(1), issue(2), issue(3), issue(4)], (iid) => status[iid] ?? null);
  assert.deepEqual(ordered.map((c) => c.iid), [1, 3, 4, 2]);
});

test('describe says why nothing was dispatched', () => {
  assert.equal(describe({ candidates: [], skipped: [], held: 'network degraded' }), 'holding — network degraded');
  assert.equal(describe({ candidates: [], skipped: [] }), 'no tickets carry the entry label');
  assert.equal(describe({ candidates: [issue(1)], skipped: [{ iid: 2, why: 'x' }] }), '1 claimable, 1 skipped');
});
