/**
 * The dashboard's hand-off to the conductor: `state/queue/<iid>.json`, one file
 * per ticket the operator asked for by number.
 *
 * The dashboard never runs a ticket itself. It drops a file here; the
 * conductor's next tick takes the oldest one, when no run is live, and runs it
 * exactly as `npm start -- --ticket <iid>` would (src/index.ts). A file per
 * ticket rather than one list, so two writers never rewrite each other's
 * entries and asking twice for one ticket is the same file.
 *
 * The conductor's liveness is its pid file, the same one a second `npm start`
 * refuses on; startConductor() launches it from the dashboard when that pid is
 * dead.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PID_FILE, ROOT, STATE } from './config.js';
import { pidAlive } from './journal.js';
import { allRuns } from './telemetry.js';

export const QUEUE_DIR: string = join(STATE, 'queue');

/** Where a conductor started from the dashboard writes its output. */
export const CONDUCTOR_LOG: string = join(STATE, 'conductor.log');

export interface QueueEntry { iid: number; requestedAt: number; by: 'dashboard' | 'cli' }

const fileFor = (iid: number): string => join(QUEUE_DIR, `${iid}.json`);

/**
 * One queue file, or null when it is missing, unreadable, or not an entry for
 * the ticket it is named after — dequeue() removes by name, so a file naming
 * another ticket would be handed out on every tick and never removed.
 */
function read(iid: number): QueueEntry | null {
  try {
    const e = JSON.parse(readFileSync(fileFor(iid), 'utf8')) as Partial<QueueEntry>;
    if (e.iid !== iid || typeof e.requestedAt !== 'number' || (e.by !== 'dashboard' && e.by !== 'cli')) return null;
    return { iid, requestedAt: e.requestedAt, by: e.by };
  } catch {
    return null;
  }
}

/** Every queued ticket, oldest first. A malformed file is skipped, never fatal. */
export function queued(): QueueEntry[] {
  if (!existsSync(QUEUE_DIR)) return [];
  const out: QueueEntry[] = [];
  for (const name of readdirSync(QUEUE_DIR)) {
    const m = name.match(/^(\d+)\.json$/);
    const e = m ? read(Number(m[1])) : null;
    if (e) out.push(e);
  }
  return out.sort((a, b) => a.requestedAt - b.requestedAt);
}

/**
 * Queue a ticket. Idempotent: a ticket already queued keeps its place and its
 * entry is returned. `requestedAt` is kept strictly increasing, so two requests
 * in one millisecond still come out in the order they were made.
 */
export function enqueue(iid: number, by: QueueEntry['by'] = 'cli'): QueueEntry {
  const existing = read(iid);
  if (existing) return existing;
  const last = queued().reduce((m, e) => Math.max(m, e.requestedAt), 0);
  const entry: QueueEntry = { iid, requestedAt: Math.max(Date.now(), last + 1), by };
  mkdirSync(QUEUE_DIR, { recursive: true });
  // Written aside and renamed in, so the conductor never reads half a file.
  const tmp = `${fileFor(iid)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry)}\n`);
  renameSync(tmp, fileFor(iid));
  return entry;
}

/** Remove a ticket from the queue. False when it was not queued. */
export function remove(iid: number): boolean {
  if (!existsSync(fileFor(iid))) return false;
  rmSync(fileFor(iid), { force: true });
  return true;
}

/** Take the oldest queued ticket off the queue, or null when it is empty. */
export function dequeue(): QueueEntry | null {
  const next = queued()[0];
  if (!next) return null;
  remove(next.iid);
  return next;
}

/**
 * What the conductor's tick dispatches from the queue: the oldest entry, taken
 * off it — or null, with the queue untouched, while a run is live. `inFlight`
 * is the conductor's own word (a run dispatched and not yet journalled); a
 * journal held by a live pid is the other, and the one every surface shows.
 */
export function takeQueued(inFlight = false): QueueEntry | null {
  if (inFlight || !queued().length) return null;
  if (allRuns().some((r) => r.live)) return null;
  return dequeue();
}

/** Whether the conductor is up: its pid file names a live process. */
export function conductorLive(): { live: boolean; pid: number | null } {
  let pid: number | null = null;
  try { pid = Number(readFileSync(PID_FILE, 'utf8').trim()) || null; } catch { /* no pid file: never started, or exited */ }
  return pid !== null && pidAlive(pid) ? { live: true, pid } : { live: false, pid: null };
}

/**
 * The launcher this process started and has not yet seen exit. The conductor
 * writes its pid file only after its boot checks, so for a moment after a start
 * the pid file says nothing; this is what stops a second click in that moment
 * from starting a second conductor.
 */
let launched: number | null = null;

/**
 * Start the conductor in the background: `tsx src/index.ts`, detached so it
 * outlives the dashboard, output appended to state/conductor.log. Refuses while
 * one is live or still starting.
 *
 * tsx's CLI directly, never `npm start`: a killed npm wrapper orphans the tsx
 * child under it, which keeps running and holding the desk. tsx relays SIGTERM
 * and SIGINT to the conductor, so `kill <pid>` of either stops it cleanly.
 */
export function startConductor(): { started: boolean; pid?: number; why?: string } {
  const c = conductorLive();
  if (c.live) return { started: false, why: `already running (pid ${c.pid})` };
  if (launched !== null) return { started: false, why: `already starting (pid ${launched})` };

  mkdirSync(STATE, { recursive: true });
  const fd = openSync(CONDUCTOR_LOG, 'a');
  try {
    const child = spawn(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'src/index.ts')], {
      cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], env: process.env,
    });
    const pid = child.pid;
    // Listened for before anything else: an unheard 'error' would take the dashboard down with it.
    const clear = (): void => { if (pid !== undefined && launched === pid) launched = null; };
    child.on('error', clear);
    child.once('exit', clear);
    child.unref();
    if (pid === undefined) return { started: false, why: 'the conductor could not be spawned' };
    launched = pid;
    return { started: true, pid };
  } finally {
    closeSync(fd);
  }
}
