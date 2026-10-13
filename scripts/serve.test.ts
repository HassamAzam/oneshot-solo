import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import '../src/lib/test-scratch-home.js';
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
