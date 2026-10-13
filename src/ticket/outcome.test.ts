import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/test-project-env.js';
import { classify, mrPostCheck } from './outcome.js';

// test-project-env sets GITLAB_REPO_URL=https://gitlab.example.com/acme/erp, so issueUrl(412) is this.
const CLOSES_412 = '[closes https://gitlab.example.com/acme/erp/-/issues/412]';
const mr = (over: Partial<Record<string, unknown>> = {}) => ({ iid: 9, title: 'Remove Unused Celery Task', description: `x\n${CLOSES_412}\n`, target_branch: 'dev', source_branch: 'oneshot/ticket-412-x', state: 'opened', web_url: 'https://g/!9', sha: 'abc', detailed_merge_status: 'mergeable', ...over }) as never;
const out = (over: Partial<Record<string, unknown>> = {}) => ({ status: 'ok', result: { summary: 's', mrIid: 9 }, turns: 5, sawActivity: 5, stderrTail: '', ...over }) as never;

test('done needs success, not blocked, and an open MR on the branch (found even if unreported)', async () => {
  const o = await classify(out({ result: { summary: 's' } }), 'oneshot/ticket-412-x', 412, { findOpenMr: async () => mr() });
  assert.equal(o.kind, 'done');
  const none = await classify(out(), 'oneshot/ticket-412-x', 412, { findOpenMr: async () => null });
  assert.equal(none.kind, 'blocked');
  assert.match((none as { why: string }).why, /no merge request/i);
});

test('blocked wins over an MR; a missing structured output with an MR is still done', async () => {
  const b = await classify(out({ result: { summary: 's', blocked: 'needs a decision' } }), 'b', 412, { findOpenMr: async () => mr() });
  assert.equal(b.kind, 'blocked');
  const d = await classify(out({ result: null }), 'b', 412, { findOpenMr: async () => mr() });
  assert.equal(d.kind, 'done');
});

test('failed with an MR is done-with-problems; failed without is blocked; infra/aborted pass through', async () => {
  const f = await classify(out({ status: 'failed', resultSubtype: 'error_max_turns' }), 'b', 412, { findOpenMr: async () => mr() });
  assert.equal(f.kind, 'done'); assert.ok((f as { problems: string[] }).problems.some((p) => /error_max_turns/.test(p)));
  assert.equal((await classify(out({ status: 'failed', resultSubtype: 'error_max_turns' }), 'b', 412, { findOpenMr: async () => null })).kind, 'blocked');
  assert.equal((await classify(out({ status: 'infra', error: 'stalled' }), 'b', 412, { findOpenMr: async () => null })).kind, 'infra');
  assert.equal((await classify(out({ status: 'aborted' }), 'b', 412, { findOpenMr: async () => null })).kind, 'aborted');
  assert.equal((await classify(out({ status: 'parked' }), 'b', 412, { findOpenMr: async () => null })).kind, 'infra');
});

test('mrPostCheck flags the target, the title prefix, the closes line and Draft', () => {
  assert.deepEqual(mrPostCheck(mr(), 412, 'dev'), []);
  assert.ok(mrPostCheck(mr({ target_branch: 'master' }), 412, 'dev').some((p) => /target/.test(p)));
  assert.ok(mrPostCheck(mr({ title: 'feat: thing' }), 412, 'dev').some((p) => /prefix/.test(p)));
  assert.ok(mrPostCheck(mr({ description: 'no link' }), 412, 'dev').some((p) => /closes/.test(p)));
  assert.ok(mrPostCheck(mr({ description: '[closes https://gitlab.example.com/acme/erp/-/issues/999]' }), 412, 'dev').some((p) => /closes/.test(p)));
  assert.ok(mrPostCheck(mr({ title: 'Draft: x' }), 412, 'dev').some((p) => /Draft/.test(p)));
});

test('mrPostCheck: a closes line for #4120 does not count for #412; GitLab\'s own draft flag counts as Draft', () => {
  assert.ok(mrPostCheck(mr({ description: '[closes https://gitlab.example.com/acme/erp/-/issues/4120]' }), 412, 'dev').some((p) => /closes/.test(p)));
  assert.ok(mrPostCheck(mr({ draft: true }), 412, 'dev').some((p) => /Draft/.test(p)));
});

test('blocked absent, null, empty and whitespace are identical: all done', async () => {
  for (const blocked of [undefined, null, '', '   ']) {
    const o = await classify(out({ result: { summary: 's', blocked } }), 'b', 412, { findOpenMr: async () => mr() });
    assert.equal(o.kind, 'done', `blocked=${JSON.stringify(blocked)}`);
    assert.deepEqual((o as { problems: string[] }).problems, []);
  }
});

test('the MR comes from the branch lookup only; a different reported !N is a problem, not a fetch', async () => {
  const seen: string[] = [];
  const o = await classify(out({ result: { summary: 's', mrIid: 7 } }), 'oneshot/ticket-412-x', 412, { findOpenMr: async (b: string) => { seen.push(b); return mr(); } });
  assert.deepEqual(seen, ['oneshot/ticket-412-x']);
  assert.equal(o.kind, 'done');
  assert.equal((o as { mr: { iid: number } }).mr.iid, 9);
  assert.ok((o as { problems: string[] }).problems.some((p) => /reported !7 but the open MR on the branch is !9/.test(p)));
});

test('a failed MR lookup is blocked with the lookup error, not reported as a missing MR', async () => {
  const o = await classify(out(), 'b', 412, { findOpenMr: async () => { throw new Error('network: ECONNREFUSED'); } });
  assert.equal(o.kind, 'blocked');
  const why = (o as { why: string }).why;
  assert.match(why, /could not look up/i);
  assert.match(why, /ECONNREFUSED/);
  assert.doesNotMatch(why, /no merge request/i);
});
