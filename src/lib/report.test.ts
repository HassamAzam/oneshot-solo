import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import './test-project-env.js';
import './test-scratch-home.js';
import { RUNS, RUNS_ARCHIVE } from './config.js';
import { buildReportModel, redact, renderHtml } from './report.js';

test('redact leaves the words "Basic Information" alone', () => {
  const step = 'Open Profile › **Basic Information** and click **Edit**';
  assert.equal(redact(step), step);
  assert.equal(redact('Basic Informationen, Basic Authentication'), 'Basic Informationen, Basic Authentication');
});

test('redact still hides a real HTTP Basic credential', () => {
  // base64 of "user:pass" and "user:password"
  assert.equal(redact('curl -H "X: Basic dXNlcjpwYXNz"'), 'curl -H "X: Basic [redacted: basic credentials]"');
  assert.equal(redact('Basic dXNlcjpwYXNzd29yZA== sent'), 'Basic [redacted: basic credentials] sent');
});

test('redact hides a Basic credential whose password is not ASCII', () => {
  for (const pair of ['user:pässwörd', 'svc:p@ss€']) {
    assert.equal(redact(`Basic ${Buffer.from(pair).toString('base64')}`), 'Basic [redacted: basic credentials]', pair);
  }
});

test('redact still hides an Authorization header whatever its scheme', () => {
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: [redacted: credential header]');
});

const line = (o: unknown): string => JSON.stringify(o);
const init = line({ ts: 1000, type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' });
const result = line({ ts: 61000, type: 'result', subtype: 'success', num_turns: 4, duration_ms: 60000, total_cost_usd: 1.25, session_id: 's-1',
  modelUsage: { 'claude-opus-5-5': { inputTokens: 35, outputTokens: 11, costUSD: 1.25 } } });

/** A run directory laid out the way journal.ts writes one: run.json, transcripts/, artifacts/. */
function runFixture(dir: string, iid: number, frames: string[]): void {
  mkdirSync(join(dir, 'transcripts'), { recursive: true });
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    runId: `r-${iid}`, iid, project: 'erp', title: `ticket ${iid}`, url: `https://gitlab.example.com/acme/erp/-/issues/${iid}`,
    createdAt: 1000, status: 'done', stoppedAt: 61000, mrIid: 3, mrUrl: 'https://gitlab.example.com/acme/erp/-/merge_requests/3', merged: true,
    phases: [{ phase: 'ticket', lap: 0, status: 'ok', startedAt: 1000, endedAt: 61000, model: 'claude-opus-5-5', turns: 4, sessionId: 's-1',
      durationMs: 60000, costUsd: 1.25, modelUsage: { 'claude-opus-5-5': { inputTokens: 35, outputTokens: 11, costUSD: 1.25 } }, resumed: false }],
  }));
  writeFileSync(join(dir, 'transcripts', 'ticket-lap0.jsonl'), `${frames.join('\n')}\n`);
}

test('buildReportModel takes a directory and renders an archived run', () => {
  const dir = join(RUNS_ARCHIVE, '7-r-7');
  runFixture(dir, 7, [init, result]);
  writeFileSync(join(dir, 'artifacts', '7-plan.md'), '# plan\n');

  const m = buildReportModel(dir);
  assert.ok(m, 'an archived run directory builds a model');
  assert.equal(m.iid, 7);
  assert.equal(m.merged, true);
  assert.equal(m.phases.length, 1);
  assert.equal(m.phases[0]!.attempts, 1);
  assert.equal(m.phases[0]!.results, 1);
  assert.equal(m.phases[0]!.tokens, 46);
  assert.equal(m.phases[0]!.costUsd, 1.25);
  assert.equal(m.summary?.durationMs, 60000);
  assert.equal(m.summary?.archived, '7-r-7');

  const html = renderHtml(m);
  assert.match(html, /ticket 7/);
  assert.match(html, /href="\/artifacts\/7\/7-plan\.md\?archived=7-r-7"/, 'the plan is linked through the archive');
  assert.doesNotMatch(html, /7-design\.md/, 'an artifact that does not exist is not linked');

  assert.equal(buildReportModel(join(RUNS, '7')), null, 'the live directory for the same iid does not exist');
});

test('report entries carry elapsed from ts and a checkpoint row for a Skill tool_use', () => {
  const dir = join(RUNS, '8');
  const assistant = (id: string, ts: number, content: unknown[]): string =>
    line({ ts, type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content } });
  runFixture(dir, 8, [
    init,
    assistant('m1', 3500, [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }]),
    line({ ts: 4000, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'loaded' }] } }),
    line({ ts: 5000, type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } }),
    assistant('m2', 9000, [{ type: 'tool_use', id: 't2', name: 'mcp__gitlab__create_merge_request', input: { title: 'X' } }]),
    result,
  ]);

  const p = buildReportModel(dir)!.phases[0]!;
  const at = p.entries.findIndex((e) => e.kind === 'checkpoint');
  assert.ok(at >= 0, 'a superpowers Skill call becomes a checkpoint row');
  assert.deepEqual({ kind: p.entries[at]!.kind, label: p.entries[at]!.label }, { kind: 'checkpoint', label: 'superpowers:brainstorming' });
  assert.equal(p.entries[at + 1]!.kind, 'tool');
  assert.equal(p.entries[at + 1]!.label, 'Skill');
  assert.equal(p.entries[at + 1]!.elapsedMs, 2500, 'elapsed is the ts delta from the previous frame (init at 1000)');
  assert.equal(p.entries[at + 1]!.ts, 3500);

  const result0 = p.entries.find((e) => e.kind === 'result')!;
  assert.equal(result0.elapsedMs, 500);
  const compaction = p.entries.find((e) => e.kind === 'compaction');
  assert.deepEqual({ label: compaction?.label, text: compaction?.text }, { label: 'context compacted', text: '150000 tokens' });
  assert.deepEqual(p.checkpoints, ['superpowers:brainstorming', 'mr-opened']);
});
