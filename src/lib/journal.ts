/**
 * The run journal: `state/runs/<iid>/`.
 *
 * The whole of the conductor's state. There is no database: a run is its
 * `run.json` plus the pid written into it, and a claim is that pid still being
 * alive. Everything the dashboard, `npm run status` and the report show is read
 * back from this directory.
 *
 * Layout:
 *   state/runs/<iid>/run.json                     the journal (attempts, outcome)
 *   state/runs/<iid>/transcripts/ticket-lap<n>.jsonl   every SDK frame of attempt n
 *   state/runs/<iid>/artifacts/                   design, plan, cases.json, screenshots
 *
 * A ticket has ONE run directory, keyed by iid rather than by run id, because
 * that is what makes resumption a lookup instead of a search. A ticket that
 * comes back for a second run therefore has its finished directory moved aside
 * (`archiveRun`) rather than merged into — two runs' attempt records in one
 * journal would make every lap counter and every resume check lie.
 */
import {
  cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { RUNS_ARCHIVE, runDir, transcriptDir } from './config.js';

/** One attempt at the ticket's single session. `lap` is the attempt number. */
export interface PhaseRecord {
  phase: 'ticket';
  lap: number;
  /**
   * 'infra' is a failure of the MACHINERY, not a verdict about the work: a
   * stalled stream, a session killed by a signal, a wall-clock timeout. It is
   * kept apart from 'failed' because it wants the opposite response — the
   * attempt never got to say anything, so it is simply re-attempted.
   */
  status: 'running' | 'ok' | 'failed' | 'infra' | 'parked' | 'aborted';
  startedAt: number;
  endedAt?: number;
  model?: string;
  turns?: number;
  sessionId?: string;
  error?: string;
  durationMs?: number;
  apiDurationMs?: number;
  costUsd?: number;
  /** Per-model tokens including subagents — the only complete usage figure. */
  modelUsage?: Record<string, unknown>;
  /** oneshot's pre-Solo journals carried one weighted token count per phase; read, never written. */
  weighted?: number;
  /** True when the attempt resumed the previous attempt's session. */
  resumed?: boolean;
  resultSubtype?: string;
}

export interface RunJournal {
  runId: string;
  iid: number;
  /** repoKey(GITLAB_REPO_URL): iids are unique only within a project. */
  project: string;
  title: string;
  url: string;
  createdAt: number;
  status: 'claimed' | 'running' | 'done' | 'blocked' | 'aborted';
  /** The conductor that holds the claim — see isClaimed(). */
  pid?: number;
  branch?: string;
  worktree?: string;
  port?: number;
  mrIid?: number;
  mrUrl?: string;
  merged?: boolean;
  blockedWhy?: string;
  /** When the run reached its terminal status, whatever that status was. */
  stoppedAt?: number;
  phases: PhaseRecord[];
}

function journalPath(iid: number): string {
  return join(runDir(iid), 'run.json');
}

export function ensureRunDirs(iid: number): void {
  for (const d of ['', 'artifacts', 'transcripts']) {
    mkdirSync(d ? join(runDir(iid), d) : runDir(iid), { recursive: true });
  }
}

/** The journal in any run directory — a live one or an archived one. */
export function readJournalFrom(dir: string): RunJournal | null {
  const p = join(dir, 'run.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as RunJournal; } catch { return null; }
}

export function readJournal(iid: number): RunJournal | null {
  return readJournalFrom(runDir(iid));
}

export function writeJournal(j: RunJournal): void {
  ensureRunDirs(j.iid);
  writeFileSync(journalPath(j.iid), `${JSON.stringify(j, null, 2)}\n`);
}

export function updateJournal(iid: number, patch: Partial<RunJournal>): RunJournal | null {
  const j = readJournal(iid);
  if (!j) return null;
  Object.assign(j, patch);
  writeJournal(j);
  return j;
}

/**
 * Record an attempt, replacing the record of the same (phase, lap) in place.
 *
 * An attempt is written twice — 'running' when it starts, its outcome when it
 * ends — so a conductor that dies mid-attempt still leaves a record behind,
 * and one that finishes leaves exactly one.
 */
export function recordPhase(iid: number, rec: PhaseRecord): void {
  const j = readJournal(iid);
  if (!j) return;
  const at = j.phases.findIndex((p) => p.phase === rec.phase && p.lap === rec.lap);
  if (at >= 0) j.phases[at] = rec;
  else j.phases.push(rec);
  writeJournal(j);
}

/** Where attempt `lap`'s SDK frames are teed. The name is what report.ts joins on. */
export function transcriptPath(iid: number, lap: number): string {
  return join(transcriptDir(iid), `ticket-lap${lap}.jsonl`);
}

/**
 * Whether a process with this pid exists. EPERM means it exists and belongs to
 * someone else, which still counts — a claim is about liveness, not ownership.
 */
export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A ticket is claimed while its journal says claimed/running AND that conductor is alive. */
export function isClaimed(iid: number): boolean {
  const j = readJournal(iid);
  return !!j && (j.status === 'claimed' || j.status === 'running') && pidAlive(j.pid);
}

/**
 * Move a finished run's whole directory — journal, transcripts, artifacts — to
 * state/runs-archive/<iid>-<runId>.
 *
 * Called when a ticket carrying a COMPLETED journal is claimed again — a
 * re-labelled ticket is a new run, not a continuation of the one that already
 * shipped. Nothing is deleted: the previous run is the record of what was
 * delivered last time, and the dashboard still renders it from there.
 */
export function archiveRun(iid: number, runId: string): string | null {
  const from = runDir(iid);
  if (!existsSync(from)) return null;
  mkdirSync(RUNS_ARCHIVE, { recursive: true });

  let to = join(RUNS_ARCHIVE, `${iid}-${runId}`);
  if (existsSync(to)) to = `${to}-${Date.now().toString(36)}`;

  try {
    renameSync(from, to);
  } catch {
    // Rename fails across filesystems, which state/ on an external volume is.
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
  return to;
}
