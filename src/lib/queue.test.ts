import './test-scratch-home.js';
import './test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { enqueue, queued, dequeue, remove, conductorLive, startConductor, takeQueued, QUEUE_DIR } from './queue.js';
import { PID_FILE, RUNS } from './config.js';

test('enqueue is idempotent and queued() is oldest-first', () => {
  const a = enqueue(412, 'dashboard'); const b = enqueue(99); const again = enqueue(412);
  assert.equal(again.requestedAt, a.requestedAt);
  assert.deepEqual(queued().map((q) => q.iid), [412, 99]);
  assert.equal(b.by, 'cli');
});
test('dequeue removes the oldest; remove() deletes by iid', () => {
  assert.equal(dequeue()!.iid, 412);
  assert.equal(remove(99), true);
  assert.equal(remove(99), false);
  assert.equal(dequeue(), null);
});
test('a malformed queue file is skipped, not fatal', () => {
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(`${QUEUE_DIR}/notanumber.json`, '{');
  // A file that names another ticket than its own would never be removed by dequeue(): skipped too.
  writeFileSync(`${QUEUE_DIR}/5.json`, JSON.stringify({ iid: 7, requestedAt: 1, by: 'cli' }));
  assert.deepEqual(queued(), []);
  assert.equal(remove(5), true);
});
test('conductorLive reads the pid file', () => {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, `${process.pid}\n`);
  assert.deepEqual(conductorLive(), { live: true, pid: process.pid });
  writeFileSync(PID_FILE, '999999\n');
  assert.equal(conductorLive().live, false);
});
test('startConductor refuses while a conductor is live', () => {
  writeFileSync(PID_FILE, `${process.pid}\n`);
  // Asserted first: were the pid file misread, the call below would spawn a real conductor.
  assert.equal(conductorLive().live, true);
  assert.deepEqual(startConductor(), { started: false, why: `already running (pid ${process.pid})` });
  writeFileSync(PID_FILE, '999999\n');
});
test('takeQueued hands over the oldest ticket only when no run is live', () => {
  enqueue(31); enqueue(32);
  // The conductor's own run in flight, not yet journalled: the queue is left alone.
  assert.equal(takeQueued(true), null);
  // A run journalled as running under a live pid: left alone too.
  mkdirSync(join(RUNS, '3'), { recursive: true });
  const journal = { runId: 'r-3', iid: 3, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'running', pid: process.pid, phases: [] };
  writeFileSync(join(RUNS, '3', 'run.json'), JSON.stringify(journal));
  assert.equal(takeQueued(), null);
  assert.deepEqual(queued().map((q) => q.iid), [31, 32]);
  // That run over: the oldest is taken, and only it.
  writeFileSync(join(RUNS, '3', 'run.json'), JSON.stringify({ ...journal, status: 'done', stoppedAt: 2 }));
  assert.equal(takeQueued()!.iid, 31);
  assert.equal(existsSync(join(QUEUE_DIR, '31.json')), false);
  assert.deepEqual(queued().map((q) => q.iid), [32]);
});
