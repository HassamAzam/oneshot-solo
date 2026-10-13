/**
 * Oneshot Solo entry point. `npm start`.
 *
 * The conductor is code, never a model: it boots, then ticks. A tick probes
 * GitLab, honours the pause and quota switches, scans the entry label, and
 * dispatches ONE ticket when no run is live (spec §5.1). The run is not
 * awaited — the loop keeps ticking and logging while it works — and there is
 * only ever one, because one desk runs one ticket on one port.
 *
 *   npm start                     watch the board, one ticket at a time
 *   npm start -- --once           one tick; waits for the run it dispatched
 *   npm start -- --ticket <iid>   run exactly that ticket, then exit
 *
 * One conductor per checkout: state/conductor.pid holds its pid, and a second
 * start refuses while that pid is alive.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DRY_RUN, PAUSE, PID_FILE, ROOT, RUNS, TICK_MS, WORK_REPO,
  appPort, auditAuth, mergeMode, pathSources, projectConfig, repoIdentity, seedFrom, sessionModel, superpowersPath,
} from './lib/config.js';
import { resolveToken, setupHint } from './lib/token.js';
import { checkIdentity, describeIdentity } from './lib/identity.js';
import { checkoutFindings, identityFindings, relaxRepoChecks, repoCheckOverrideNotice } from './lib/repocheck.js';
import { ensureClaudeDir } from './lib/claudedir.js';
import { pidAlive } from './lib/journal.js';
import { netState, nextProbeDelayMs, probe } from './lib/reachability.js';
import { quotaParked } from './lib/quota.js';
import { log } from './lib/log.js';
import { describe, scan } from './ticket/scan.js';
import { runTicket } from './ticket/run.js';

/** `--ticket <iid>`: run exactly that ticket and exit. Null when absent or malformed (main refuses a malformed one). */
const ticketGiven = process.argv.includes('--ticket');
const ticketArg = (() => {
  const i = process.argv.indexOf('--ticket');
  if (i === -1) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : null;
})();

/**
 * One tick, then exit after the run it dispatched. `--ticket` is always one
 * pass: ticking again would re-claim a ticket its own run just finished.
 */
const once = process.argv.includes('--once') || ticketArg !== null;

/**
 * One controller for the whole process. The first signal aborts it: the
 * session ends `aborted`, which is resumable, and the next boot picks the
 * ticket up from its journal.
 */
const aborter = new AbortController();
let stopping = false;

/** The run in flight, if any — the in-process truth for "is a run live". */
let running: Promise<void> | null = null;
let runningIid: number | null = null;

/** Set while the tick loop is asleep, so a signal does not wait out the tick. */
let wake: (() => void) | null = null;

function nap(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

/** TICK_MS ordinarily; backed off along the breaker's ladder while GitLab is unreachable. */
function tickDelayMs(): number {
  return netState() === 'ok' ? TICK_MS : Math.max(TICK_MS, nextProbeDelayMs());
}

function refuse(reason: string): never {
  log.error(reason);
  process.exit(1);
}

function readPid(): number | null {
  try { return Number(readFileSync(PID_FILE, 'utf8').trim()) || null; } catch { return null; }
}

/** Only our own pid file: a refused second conductor must not delete the first one's. */
function removePid(): void {
  try { if (readPid() === process.pid) rmSync(PID_FILE, { force: true }); } catch { /* best effort on the way out */ }
}

/**
 * Refuse to start on a misconfiguration that would otherwise surface as a
 * confusing failure hours into a ticket. Each refusal exits 1 and says why;
 * nothing here writes state or calls GitLab.
 */
function bootChecks(): void {
  const token = resolveToken();
  if (!token.token) refuse(`no GitLab token for this desk.\n${setupHint()}`);

  const auth = auditAuth();
  for (const n of auth.notes) log.warn(`auth       ${n}`);
  if (!auth.clean) {
    for (const p of auth.problems) log.error(`auth       ${p}`);
    refuse('a metered credential is set in this shell — unset it and re-run; sessions run on the subscription only');
  }

  const sp = superpowersPath();
  if (!sp) refuse('superpowers is not installed — `claude plugin install superpowers`, or set ONESHOT_SUPERPOWERS_PATH');
  if (!existsSync(join(sp, 'skills', 'brainstorming', 'SKILL.md'))) {
    refuse(`superpowers dir ${sp} has no skills/brainstorming/SKILL.md — fix ONESHOT_SUPERPOWERS_PATH or \`claude plugin install superpowers\``);
  }

  const held = readPid();
  if (held && held !== process.pid && pidAlive(held)) refuse(`another conductor is running (pid ${held}) — stop it first`);

  // Which project, and whether this machine's clone is a clone of it: a
  // WORK_REPO left over from another project would cut every worktree from
  // the wrong code (src/lib/repocheck.ts). ONESHOT_SKIP_REPO_CHECK relaxes
  // the origin judgement to a warning, and says so.
  const override = repoCheckOverrideNotice();
  if (override) log.warn(override);
  const say = (findings: ReturnType<typeof identityFindings>): void => {
    for (const f of relaxRepoChecks(findings)) {
      if (f.level === 'fail') refuse(`${f.label}: ${f.detail}`);
      if (f.level === 'warn') log.warn(`${f.label}: ${f.detail}`);
    }
  };
  say(identityFindings());
  if (!WORK_REPO || !existsSync(WORK_REPO)) {
    refuse(`WORK_REPO does not exist: ${WORK_REPO || '(no path)'} — clone the project there, or set WORK_REPO in .env`);
  }
  say(checkoutFindings({ workRepo: WORK_REPO, seed: seedFrom(), sources: pathSources() }));
}

async function banner(): Promise<void> {
  const cfg = projectConfig();
  log.banner('Oneshot Solo');
  log.info(`project    ${repoIdentity().repo?.project ?? '?'}  (work repo ${WORK_REPO})`);
  log.info(`labels     "${cfg.labels.entry}" in  ->  "${cfg.labels.exit}" merged / "${cfg.labels.inReview}" / "${cfg.labels.blocked}"`);
  log.info(`base       ${cfg.branches.base}   merge ${mergeMode()}   model ${sessionModel()}   port ${appPort()}`);
  log.info(`superpowers ${superpowersPath()}`);
  // The assignee rule reads this desk's username from the same token every
  // GitLab write is made with; resolved once, here.
  const idc = await checkIdentity();
  log.info(describeIdentity(idc));
  if (idc.warning) log.warn(idc.warning);
  if (DRY_RUN) log.warn('DRY_RUN is on — GitLab writes and merges are refused');
}

async function tick(): Promise<void> {
  await probe();

  if (existsSync(PAUSE)) {
    log.warn('paused (state/PAUSE) — not claiming');
    return;
  }
  const parkedUntil = quotaParked();
  if (parkedUntil) {
    log.warn(`parked after a subscription usage limit until ${new Date(parkedUntil).toLocaleTimeString()} — not claiming`);
    return;
  }

  // The one awaited path: it exists to run exactly one ticket and exit.
  if (ticketArg !== null) {
    log.phase(`targeting #${ticketArg}`);
    log.info(`#${ticketArg} ended ${await runTicket(ticketArg, { signal: aborter.signal })}`);
    return;
  }

  const result = await scan();
  log.info(`tick  ${describe(result)}${runningIid !== null ? `  (in flight: #${runningIid})` : ''}`);
  for (const s of result.skipped) log.info(`skip       #${s.iid}  ${s.why}`);
  if (running || stopping || !result.candidates.length) return;

  // Dispatched, not awaited: the loop keeps ticking while the run works.
  const c = result.candidates[0]!;
  runningIid = c.iid;
  running = runTicket(c.iid, { signal: aborter.signal })
    .then((status) => log.info(`#${c.iid} ended ${status}`))
    .catch((err: Error) => log.error(`#${c.iid} run threw`, { error: err.message }))
    .finally(() => { running = null; runningIid = null; });
}

/**
 * Wait out the run in flight. The shutdown signal has already reached its
 * session, so this is the session unwinding and the journal being written —
 * not the ticket finishing.
 */
async function drain(): Promise<void> {
  if (!running) return;
  const iid = runningIid;
  log.warn(`waiting on #${iid} to wind up`);
  const progress = setInterval(() => log.info(`still winding up #${iid}`), 15_000);
  progress.unref();
  await running;
  clearInterval(progress);
}

async function main(): Promise<void> {
  if (ticketGiven && ticketArg === null) refuse('--ticket needs a positive ticket iid, e.g. --ticket 8420');

  if (!existsSync(join(ROOT, '.env'))) {
    if (!process.stdin.isTTY) refuse('no .env — run `npm run setup` in a terminal first');
    log.banner('No .env found — starting first-run setup.');
    execFileSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'scripts/setup.ts')], { stdio: 'inherit' });
    log.info('Setup complete — re-run: npm start');
    process.exit(0);
  }

  bootChecks();

  // The conductor root gets the same composed .claude a worktree does.
  ensureClaudeDir(ROOT);
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(PID_FILE, `${process.pid}\n`);
  process.on('exit', removePid);

  await banner();
  log.banner(ticketArg !== null ? `Single run: ticket #${ticketArg}.`
    : once ? 'Single pass, then exit.' : `Watching every ${TICK_MS / 1000}s. Ctrl-C to stop.`);

  // First signal: stop claiming, withdraw the session (it ends `aborted`,
  // resumable), and wait for the run to wind up. Second signal: the operator
  // has decided the wait is not worth it.
  const shutdown = (sig: string): void => {
    if (stopping) {
      log.error(`${sig} again — hard exit${runningIid !== null ? `, #${runningIid} abandoned mid-run` : ''}`);
      process.exit(1);
    }
    stopping = true;
    log.warn(`${sig} — no longer claiming${runningIid !== null ? `; letting #${runningIid} wind up` : ''}`);
    aborter.abort();
    if (wake) wake();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A signal wakes the nap; the loop condition, not another tick, is what sees it.
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      log.error('tick failed', { error: (err as Error).message });
    }
    if (once) break;
    await nap(tickDelayMs());
  }

  await drain();
  process.exit(0);
}

// A session the conductor aborts can still throw from the SDK's transport
// AFTER runSession has returned — an async write against a dead process
// rejecting with AbortError. The conductor never dies for a session's corpse:
// log it and keep conducting. A genuinely fatal error still surfaces, loudly,
// in the log it would have crashed into anyway.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection (conductor continues)', {
    error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
  });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception (conductor continues)', { error: `${err.name}: ${err.message}` });
});

main().catch((err) => {
  log.error('fatal', { error: (err as Error).message });
  process.exit(1);
});
