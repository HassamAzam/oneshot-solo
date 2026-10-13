/**
 * One ticket, end to end: claim → prepare → session → outcome → finish
 * (spec §5.2–§5.4).
 *
 * The claim is run.json `{status:'claimed', pid}` and nothing else; a ticket
 * whose conductor died is resumed from that journal, keeping its run id, its
 * branch, its worktree and its attempt history. The session runs at most
 * MAX_INFRA_ATTEMPTS times per invocation, and only an infra death (the
 * machinery, not the work) earns another attempt — resumed from the dead
 * attempt's session when it left an id.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { PROJECT_TARGET, appPort, projectConfig, sessionModel } from '../lib/config.js';
import { getIssue, issueUrl, resolvedProjectId } from '../lib/gitlab.js';
import {
  archiveRun, ensureRunDirs, pidAlive, readJournal, recordPhase, updateJournal, writeJournal, type RunJournal,
} from '../lib/journal.js';
import { deleteLocalBranch, detachTrackedClaude, leaseWorktree, reapWorktree, type Lease } from '../lib/worktrees.js';
import { assertComposed, ensureClaudeDir } from '../lib/claudedir.js';
import { startRunApp } from '../lib/appserver.js';
import { fetchTicket } from '../lib/ticket.js';
import { branchFor, newRunId, worktreeName } from '../lib/ids.js';
import { log } from '../lib/log.js';
import { runSession, type SessionInput, type SessionOutput } from './session.js';
import { classify, type Outcome } from './outcome.js';
import { finish } from './finish.js';

/** Attempts per invocation; only an infra death is re-attempted. */
export const MAX_INFRA_ATTEMPTS = 2;

/**
 * How long a blocked ticket is left alone. A human who re-labels it right away
 * has usually not changed anything yet, and a re-run would reproduce the block.
 */
export const CLAIM_COOLDOWN_MS = 30 * 60_000;

/** classify()'s reason when GitLab could not be asked about the MR — a blip, not a verdict. */
const LOOKUP_FAILED = 'could not look up the merge request';
const LOOKUP_RETRIES = 3;
const LOOKUP_RETRY_MS = 20_000;

/** Everything an attempt needs except which attempt it is. */
export type AttemptContext = Omit<SessionInput, 'lap' | 'previousAttempt'>;

export type ClaimDecision = 'fresh' | 'resume' | 'refuse';

/**
 * What an existing journal means for a new claim.
 *
 * A live conductor's claim, and a block younger than the cooldown, are
 * refused. A run that stopped without finishing — aborted (Ctrl-C, a quota
 * park), or claimed/running under a conductor that is gone — is resumed. A
 * finished run (done, or blocked past the cooldown) makes way for a fresh one.
 *
 * `force` is an operator naming the ticket (`--ticket <iid>`): the cooldown
 * exists to stop the scan re-claiming a block nobody has looked at, and an
 * explicit run is somebody having looked. It bypasses the cooldown only — a
 * claim held by a live conductor is refused regardless.
 */
export function decideClaim(existing: RunJournal | null, opts: { force?: boolean } = {}): ClaimDecision {
  if (!existing) return 'fresh';
  if (existing.status === 'claimed' || existing.status === 'running') return pidAlive(existing.pid) ? 'refuse' : 'resume';
  if (existing.status === 'aborted') return 'resume';
  if (existing.status === 'blocked' && !opts.force && Date.now() - (existing.stoppedAt ?? 0) < CLAIM_COOLDOWN_MS) return 'refuse';
  return 'fresh';
}

function refusal(j: RunJournal): string {
  if (j.status === 'blocked') {
    const left = Math.ceil((CLAIM_COOLDOWN_MS - (Date.now() - (j.stoppedAt ?? 0))) / 60_000);
    return `blocked ${Math.round((Date.now() - (j.stoppedAt ?? 0)) / 60_000)} min ago — re-claimable in ${left} min`;
  }
  return `${j.status} by live pid ${j.pid}`;
}

/**
 * The worktree's `.claude` must be the composed one when a session starts in
 * it. A session runs for hours, and one `git checkout -- .` or `git clean`
 * puts the work repo's committed `.claude` back (or none at all) — so this is
 * asserted before every attempt, not only at the lease. A worktree that does
 * not exist is left to the spawn to report.
 */
function recompose(iid: number, worktree: string): void {
  if (!existsSync(worktree)) return;
  const foreign = assertComposed(worktree);
  if (!foreign.length) return;
  log.warn(`#${iid} .claude drifted from the composition (${foreign.slice(0, 5).join(', ')}) — recomposing`);
  detachTrackedClaude(worktree);
  ensureClaudeDir(worktree);
}

/**
 * Run the session, re-attempting an infra death once per invocation. Every
 * attempt is recorded twice — 'running' at the start, its outcome at the end —
 * so a conductor that dies mid-attempt still leaves the attempt on record.
 * `startLap` continues a resumed run's numbering; `ctx.resume` is the session
 * the first attempt continues.
 */
export async function attemptLoop(ctx: AttemptContext, run: typeof runSession = runSession, startLap = 0): Promise<SessionOutput> {
  let lap = startLap;
  let resume = ctx.resume;
  for (;;) {
    recompose(ctx.iid, ctx.worktree);
    const startedAt = Date.now();
    const resumed = !!resume;
    recordPhase(ctx.iid, { phase: 'ticket', lap, status: 'running', startedAt, model: sessionModel(), resumed });
    const out = await run({ ...ctx, lap, resume, previousAttempt: lap > 0 });
    recordPhase(ctx.iid, {
      phase: 'ticket', lap, status: out.status, startedAt, endedAt: Date.now(), model: sessionModel(),
      turns: out.turns, sessionId: out.sessionId, error: out.error, durationMs: out.durationMs, apiDurationMs: out.apiDurationMs,
      costUsd: out.costUsd, modelUsage: out.modelUsage, resumed, resultSubtype: out.resultSubtype,
    });
    if (out.status !== 'infra' || lap + 1 - startLap >= MAX_INFRA_ATTEMPTS) return out;
    resume = out.sessionId;
    lap += 1;
    log.warn(`#${ctx.iid} attempt ${lap - 1} died (${out.error ?? 'infra'}) — retrying as attempt ${lap}${resume ? ' with resume' : ''}`);
  }
}

export interface OutcomeDeps {
  classify: typeof classify;
  sleep: (ms: number) => Promise<void>;
}

const REAL_OUTCOME: OutcomeDeps = { classify, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * The session's outcome, with two things classify() cannot know.
 *
 * A `parked` session hit the subscription limit and has already parked the
 * conductor: that is a pause, not a verdict, so it ends `aborted` — no label,
 * no note — and the ticket resumes once the park lifts. And a failed MR lookup
 * after a finished session is GitLab being briefly unreachable, so it is asked
 * again before it is allowed to put the ticket in front of a human.
 */
export async function outcomeOf(
  out: SessionOutput, branch: string, iid: number, deps: OutcomeDeps = REAL_OUTCOME, signal?: AbortSignal,
): Promise<Outcome> {
  if (out.status === 'parked') {
    log.warn(`#${iid} parked for quota — resumes when the park lifts`);
    return { kind: 'aborted' };
  }
  let o = await deps.classify(out, branch, iid);
  for (let i = 1; i <= LOOKUP_RETRIES && o.kind === 'blocked' && o.why.startsWith(LOOKUP_FAILED); i += 1) {
    // Shutting down mid-wait: stop asking, and leave the run resumable rather
    // than in front of a human over a blip.
    if (signal?.aborted) return { kind: 'aborted' };
    log.warn(`#${iid} ${o.why.slice(0, 120)} — asking again in ${LOOKUP_RETRY_MS / 1000}s (${i}/${LOOKUP_RETRIES})`);
    await deps.sleep(LOOKUP_RETRY_MS);
    o = await deps.classify(out, branch, iid);
  }
  return o;
}

/** One line for the journal and the note: git's own `fatal:` line when there is one, else the first. */
function oneLine(err: unknown): string {
  const lines = String((err as Error)?.message ?? err).split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? 'unknown error').slice(0, 300);
}

export interface LeaseDeps {
  leaseWorktree: typeof leaseWorktree;
  reapWorktree: typeof reapWorktree;
  deleteLocalBranch: typeof deleteLocalBranch;
  exists: (path: string) => boolean;
}

const REAL_LEASE: LeaseDeps = { leaseWorktree, reapWorktree, deleteLocalBranch, exists: existsSync };

/**
 * The worktree and branch a claim runs in. The worktree outlives its run
 * (spec §5.4), and it holds the ticket's branch, so:
 *
 * - The previous run MERGED: its branch is history — the MR merged and GitLab
 *   removed the remote. The old worktree is reaped, the local branch deleted
 *   (else leaseWorktree would re-attach it), and a fresh lease is cut from
 *   base under the same name. When git will not delete the branch, the lease
 *   takes `<branch>-<run id stamp>` instead: a ticket that comes back must
 *   never continue on merged commits.
 * - A resumed run, or a ticket that came back while its worktree still exists,
 *   re-attaches through leaseWorktree under the recorded branch and worktree
 *   name, so it is re-seeded and its identity re-pinned like any lease.
 *   (`git worktree add` would refuse the branch while that worktree has it.)
 * - Otherwise a fresh lease from base on the title's branch.
 */
export function leaseFor(
  iid: number, runId: string, title: string, existing: RunJournal | null, resuming: boolean, deps: LeaseDeps = REAL_LEASE,
): Lease {
  const titled = branchFor(projectConfig().branches.prefix, iid, title);
  if (!resuming && existing?.status === 'done' && existing.merged) {
    const merged = existing.branch ?? titled;
    if (existing.worktree) deps.reapWorktree(existing.worktree, existing.runId);
    const branch = deps.deleteLocalBranch(merged) ? merged : `${merged}-${runId.replace(/^r-/, '').slice(0, 6)}`;
    log.info(`#${iid} was merged by run ${existing.runId} — cutting a fresh branch ${branch} from base`);
    return deps.leaseWorktree(runId, branch, worktreeName(iid, runId));
  }
  const recorded = existing?.worktree && existing.branch && deps.exists(existing.worktree) ? existing.worktree : null;
  const branch = (resuming || recorded) && existing?.branch ? existing.branch : titled;
  return deps.leaseWorktree(runId, branch, recorded ? basename(recorded) : worktreeName(iid, runId));
}

/** The latest session id the journal recorded, for resuming its conversation. */
function lastSessionId(j: RunJournal): string | undefined {
  return [...j.phases].reverse().find((p) => p.sessionId)?.sessionId;
}

/**
 * Claim, prepare, run and finish one ticket. Returns the journal's final
 * status — or, when the ticket was not claimed, the status that stopped it.
 * `opts.signal` is the conductor's shutdown: it reaches the session, which
 * then ends `aborted` and stays resumable. `opts.force` is `--ticket`: it
 * bypasses the blocked cooldown (decideClaim).
 */
export async function runTicket(iid: number, opts: { signal?: AbortSignal; force?: boolean } = {}): Promise<RunJournal['status']> {
  const issue = await getIssue(iid);
  if (!issue.ok || !issue.data) {
    log.error(`cannot read #${iid} — not claiming`, { kind: issue.kind, status: issue.status });
    return 'aborted';
  }

  const existing = readJournal(iid);
  const decision = decideClaim(existing, { force: opts.force });
  if (decision === 'refuse') {
    log.warn(`#${iid} not claimed: ${refusal(existing!)}`);
    return existing!.status;
  }
  const resuming = decision === 'resume' && existing !== null;
  const runId = resuming ? existing.runId : newRunId();
  if (!resuming && existing) archiveRun(iid, existing.runId);
  ensureRunDirs(iid);
  writeJournal(resuming
    ? {
      ...existing, status: 'claimed', pid: process.pid, stoppedAt: undefined,
      // An attempt still 'running' belonged to the conductor that died.
      phases: existing.phases.map((p) => (p.status === 'running' ? { ...p, status: 'aborted' as const } : p)),
    }
    : { runId, iid, project: PROJECT_TARGET, title: issue.data.title, url: issueUrl(iid), createdAt: Date.now(), status: 'claimed', pid: process.pid, phases: [] });
  log.phase(`#${iid} ${resuming ? `resuming run ${runId} at attempt ${existing.phases.length}` : `claimed as run ${runId}`}  ${issue.data.title.slice(0, 60)}`);

  try {
    const ticket = await fetchTicket(iid);
    if (!ticket) {
      await finish(iid, runId, { kind: 'infra', why: 'could not fetch the ticket from GitLab' });
      return readJournal(iid)?.status ?? 'blocked';
    }

    let lease: Lease;
    try {
      lease = leaseFor(iid, runId, ticket.title, existing, resuming);
    } catch (err) {
      await finish(iid, runId, { kind: 'blocked', why: `worktree: ${oneLine(err)}` });
      return readJournal(iid)?.status ?? 'blocked';
    }

    const { branch } = lease;
    const port = appPort();
    updateJournal(iid, { status: 'running', branch, worktree: lease.worktree, port });
    // Compiles while the model plans; a failure here is a slower run, not a broken one.
    startRunApp({ iid, runId, worktree: lease.worktree, port });

    // Asked once, for mr-gate and the GitLab server's allowlist; the path alone holds both when GitLab cannot answer.
    const projectId = (await resolvedProjectId()) ?? undefined;
    const out = await attemptLoop(
      { iid, runId, ticket, worktree: lease.worktree, branch, port, signal: opts.signal, resume: resuming ? lastSessionId(existing) : undefined, projectId },
      runSession,
      resuming ? existing.phases.length : 0,
    );
    await finish(iid, runId, await outcomeOf(out, branch, iid, REAL_OUTCOME, opts.signal));
  } catch (err) {
    // The conductor's own failure. Left 'claimed' under this live pid, the
    // ticket would be skipped as in flight until the conductor restarts.
    const why = `the conductor failed mid-run: ${oneLine(err)}`;
    log.error(`#${iid} ${why}`);
    await finish(iid, runId, { kind: 'blocked', why }).catch((e: Error) => log.error(`#${iid} finish failed too`, { error: e.message }));
  }
  return readJournal(iid)?.status ?? 'blocked';
}
