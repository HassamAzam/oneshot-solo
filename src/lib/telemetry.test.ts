import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionStats, mergeUsage, runSummary, attemptTokens } from './telemetry.js';

const line = (o: unknown) => JSON.stringify(o);
const assistant = (id: string, ts: number, usage: Record<string, number>, content: unknown[], parent: string | null = null) =>
  line({ ts, type: 'assistant', parent_tool_use_id: parent, message: { id, model: 'claude-opus-5-5', usage, content } });

function fixture(extra: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'solo-tel-'));
  const f = join(dir, 'ticket-lap0.jsonl');
  writeFileSync(f, [
    line({ ts: 1000, type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5', skills: ['superpowers:brainstorming'], plugins: [{ name: 'superpowers', path: '/sp' }] }),
    assistant('m1', 2000, { input_tokens: 10, output_tokens: 5 }, [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }]),
    assistant('m1', 2001, { input_tokens: 10, output_tokens: 7 }, [{ type: 'text', text: 'same message, streamed again' }]),
    line({ ts: 2500, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    assistant('m2', 3000, { input_tokens: 20, output_tokens: 3 }, [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }]),
    assistant('m3', 3500, { input_tokens: 4, output_tokens: 1 }, [{ type: 'text', text: 'sub' }], 't2'),
    line({ ts: 4000, type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } }),
    assistant('m4', 5000, { input_tokens: 1, output_tokens: 1 }, [{ type: 'tool_use', id: 't3', name: 'mcp__gitlab__create_merge_request', input: { title: 'X' } }]),
    line({ ts: 6000, type: 'result', subtype: 'success', num_turns: 4, duration_ms: 5000, duration_api_ms: 4000, total_cost_usd: 1.25, session_id: 's-1',
      usage: { input_tokens: 31, output_tokens: 9 }, modelUsage: { 'claude-opus-5-5': { inputTokens: 35, outputTokens: 11, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1.25 } },
      structured_output: { summary: 'done' } }),
    line({ ts: 7000, type: 'result', subtype: 'error_during_execution', num_turns: 0, duration_ms: 0, total_cost_usd: 0 }),
    ...extra,
  ].join('\n') + '\n');
  return f;
}

test('sessionStats: first result wins, usage is max-per-message-id, subagent split, checkpoints and compactions', () => {
  const s = sessionStats(fixture());
  assert.equal(s.turns, 4);
  assert.equal(s.durationMs, 5000);
  assert.equal(s.costUsd, 1.25);
  assert.equal(s.tokens.main, 10 + 7 + 20 + 3 + 1 + 1);       // m1 counted once at its max output (7)
  assert.equal(s.tokens.subagent, 4 + 1);
  assert.deepEqual(s.tokens.byModel, { 'claude-opus-5-5': 46 });  // from modelUsage: 35 + 11
  assert.deepEqual(s.toolCounts, { Skill: 1, Bash: 1, mcp__gitlab__create_merge_request: 1 });
  assert.deepEqual(s.skills, ['superpowers:brainstorming']);
  assert.deepEqual(s.checkpoints.map((c) => c.name), ['superpowers:brainstorming', 'mr-opened']);
  assert.equal(s.checkpoints[1]!.ts, 5000);
  assert.equal(s.compactions, 1);
  assert.equal(s.truncatedTail, false);
});

test('sessionStats tolerates a half-written last line and a missing result frame', () => {
  const f = fixture(['{"ts":8000,"type":"assistant","message":{"id":"m9","usage":{"input_tokens":1']);
  const s = sessionStats(f);
  assert.equal(s.truncatedTail, true);
  assert.equal(s.turns, 4);
});

test('mergeUsage keeps the max of each field per id', () => {
  const m = new Map();
  mergeUsage(m, 'a', { input_tokens: 5, output_tokens: 1 });
  mergeUsage(m, 'a', { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 100 });
  assert.deepEqual(m.get('a'), { input: 5, output: 9, cr: 100, cw: 0 });
});

test('runSummary derives wall clock, live flag and totals from the journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'solo-run-'));
  const j = { runId: 'r-1', iid: 7, project: 'erp', title: 'T', url: 'u', createdAt: 1000, status: 'running' as const, pid: process.pid, phases: [
    { phase: 'ticket' as const, lap: 0, status: 'infra' as const, startedAt: 1000, endedAt: 2000, turns: 3, modelUsage: { m: { inputTokens: 5, outputTokens: 5, costUSD: 0.1 } } },
    { phase: 'ticket' as const, lap: 1, status: 'running' as const, startedAt: 2000 },
  ] };
  const s = runSummary(j, dir);
  assert.equal(s.live, true);
  assert.equal(s.attempts, 2);
  assert.equal(s.turns, 3);
  assert.equal(s.tokens, 10);
  assert.ok(s.durationMs >= Date.now() - 1000 - 5);
  const done = runSummary({ ...j, status: 'done' as const, stoppedAt: 9000, mrUrl: 'https://x/!1', merged: true }, dir);
  assert.equal(done.durationMs, 8000);
  assert.equal(done.live, false);
  assert.equal(done.merged, true);
});

test('attemptTokens falls back to oneshot\'s legacy weighted count when modelUsage is absent', () => {
  assert.equal(attemptTokens({ weighted: 70303 }), 70303);
  assert.equal(attemptTokens({ modelUsage: { m: { inputTokens: 5, outputTokens: 5 } }, weighted: 70303 }), 10);
  assert.equal(attemptTokens({}), 0);
  const dir = mkdtempSync(join(tmpdir(), 'solo-legacy-'));
  const j = { runId: 'r-9', iid: 9, project: 'erp', title: 'legacy', url: 'u', createdAt: 1000, status: 'done' as const, stoppedAt: 5000,
    phases: [{ phase: 'ticket' as const, lap: 0, status: 'ok' as const, startedAt: 1000, endedAt: 4000, weighted: 461000 }] };
  assert.equal(runSummary(j, dir).tokens, 461000);
});
