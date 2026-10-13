import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureRunDirs, readJournal, writeJournal, updateJournal, recordPhase, archiveRun, transcriptPath,
  pidAlive, isClaimed, readJournalFrom,
} from './journal.js';
import { RUNS_ARCHIVE, runDir } from './config.js';

/**
 * iids no ticket will ever have. STATE is this checkout's own state/ (config.ts
 * derives it from ROOT, and nothing redirects it), so a real run's journal must
 * never be touched and whatever this file creates is removed again below.
 */
const T = 99_900_100;
const archived: string[] = [];
after(() => {
  for (const n of [1, 2, 3, 4]) rmSync(runDir(T + n), { recursive: true, force: true });
  for (const d of archived) rmSync(d, { recursive: true, force: true });
});

const base = (iid: number) => ({ runId: 'r-1', iid, project: 'erp', title: 't', url: 'u', createdAt: 1, status: 'claimed' as const, phases: [] });

test('recordPhase upserts by (phase, lap) and keeps order', () => {
  const iid = T + 1;
  ensureRunDirs(iid); writeJournal(base(iid));
  recordPhase(iid, { phase: 'ticket', lap: 0, status: 'running', startedAt: 5 });
  recordPhase(iid, { phase: 'ticket', lap: 0, status: 'infra', startedAt: 5, endedAt: 9, error: 'stalled' });
  recordPhase(iid, { phase: 'ticket', lap: 1, status: 'ok', startedAt: 10, endedAt: 20, turns: 3, durationMs: 10_000, costUsd: 1.5, resumed: true });
  const j = readJournal(iid)!;
  assert.equal(j.phases.length, 2);
  assert.equal(j.phases[0]!.status, 'infra');
  assert.equal(j.phases[1]!.resumed, true);
});

test('isClaimed is true only while the recorded pid is alive', () => {
  const iid = T + 2;
  ensureRunDirs(iid); writeJournal({ ...base(iid), status: 'running', pid: process.pid });
  assert.equal(isClaimed(iid), true);
  updateJournal(iid, { pid: 999999 });
  assert.equal(isClaimed(iid), false);
  updateJournal(iid, { pid: process.pid, status: 'done' });
  assert.equal(isClaimed(iid), false);
  assert.equal(pidAlive(undefined), false);
});

test('transcriptPath follows the <phase>-lap<n> convention the report joins on', () => {
  const iid = T + 3;
  assert.equal(transcriptPath(iid, 2), join(runDir(iid), 'transcripts', 'ticket-lap2.jsonl'));
});

test('archiveRun moves the whole run dir aside and readJournalFrom reads it there', () => {
  const iid = T + 4;
  ensureRunDirs(iid); writeJournal({ ...base(iid), status: 'done' });
  mkdirSync(join(runDir(iid), 'transcripts'), { recursive: true });
  writeFileSync(join(runDir(iid), 'transcripts', 'ticket-lap0.jsonl'), '{"ts":1,"type":"system","subtype":"init"}\n');
  const dest = archiveRun(iid, 'r-1')!;
  archived.push(dest);
  assert.ok(dest.startsWith(RUNS_ARCHIVE));
  assert.equal(existsSync(runDir(iid)), false);
  assert.ok(existsSync(join(dest, 'transcripts', 'ticket-lap0.jsonl')));
  assert.equal(readJournalFrom(dest)!.iid, iid);
});
