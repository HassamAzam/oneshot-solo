import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import '../src/lib/test-scratch-home.js';
import '../src/lib/test-project-env.js';
import { RUNS, RUNS_ARCHIVE } from '../src/lib/config.js';
import { rows } from './serve.js';

test('rows lists live and archived runs newest first with summaries', () => {
  mkdirSync(join(RUNS, '5'), { recursive: true });
  writeFileSync(join(RUNS, '5', 'run.json'), JSON.stringify({ runId: 'r-5', iid: 5, project: 'erp', title: 'five', url: 'u', createdAt: 50, status: 'done', stoppedAt: 60, phases: [] }));
  mkdirSync(join(RUNS_ARCHIVE, '4-r-4'), { recursive: true });
  writeFileSync(join(RUNS_ARCHIVE, '4-r-4', 'run.json'), JSON.stringify({ runId: 'r-4', iid: 4, project: 'erp', title: 'four', url: 'u', createdAt: 40, status: 'blocked', stoppedAt: 45, phases: [] }));
  const r = rows();
  assert.deepEqual(r.map((x) => x.iid), [5, 4]);
  assert.equal(r[1]!.archived, '4-r-4');
  assert.equal(r[0]!.durationMs, 10);
});

test('POST /run queues a valid iid and rejects the rest', async () => {
  const { handleRun } = await import('./serve.js');
  assert.deepEqual(await handleRun('iid=412'), { code: 303, location: '/?queued=412' });
  assert.equal((await handleRun('iid=abc')).code, 400);
  assert.equal((await handleRun('iid=-1')).code, 400);
  assert.equal((await handleRun('')).code, 400);
  const { queued } = await import('../src/lib/queue.js');
  assert.deepEqual(queued().map((q) => q.iid), [412]);
});
test('the index shows queued tickets and the conductor state', async () => {
  const { index } = await import('./serve.js');
  const html = index();
  assert.ok(html.includes('name="iid"'));                 // the ticket box
  assert.ok(html.includes('#412') && html.includes('queued'));
  assert.ok(/conductor (running|not running)/.test(html));
});
test('the index lists the live run first, marked running, and confirms a queued ticket', async () => {
  const { index } = await import('./serve.js');
  mkdirSync(join(RUNS, '6'), { recursive: true });
  writeFileSync(join(RUNS, '6', 'run.json'), JSON.stringify({ runId: 'r-6', iid: 6, project: 'erp', title: 'six', url: 'u', createdAt: 10, status: 'running', pid: process.pid, phases: [] }));
  const html = index(new URLSearchParams('queued=412'));
  assert.ok(html.indexOf('/run/6"') < html.indexOf('/run/5"'), 'the live run comes before newer finished ones');
  assert.ok(html.includes('● running'));
  assert.ok(html.includes('#412 queued — the conductor picks it up on its next tick (within 60 s)'));
});
test('a POST is refused from any origin but the dashboard itself', async () => {
  const { sameOrigin } = await import('./serve.js');
  assert.equal(sameOrigin({}, 8787), true);                                              // curl: no header
  assert.equal(sameOrigin({ origin: 'http://localhost:8787' }, 8787), true);
  assert.equal(sameOrigin({ referer: 'http://127.0.0.1:8787/?queued=4' }, 8787), true);
  assert.equal(sameOrigin({ origin: 'https://evil.example' }, 8787), false);
  assert.equal(sameOrigin({ origin: 'http://localhost:9999' }, 8787), false);
  assert.equal(sameOrigin({ origin: 'null' }, 8787), false);                              // sandboxed frame, file://
  assert.equal(sameOrigin({ referer: 'https://evil.example/x' }, 8787), false);
});
