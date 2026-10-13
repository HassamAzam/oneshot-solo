/**
 * How a run ends on GitLab and in its journal (spec §5.4).
 *
 * The outcome decides the label swap and the note; the merge gate decides
 * whether a `done` MR is merged here or left `In Review` with the reason.
 * Every GitLab write goes through `deps` so the label and note arithmetic is
 * testable without a GitLab. `preserveLabels` are never named: editIssueLabels
 * is the atomic add/remove PUT, so a label this code does not mention cannot
 * be dropped.
 *
 * The worktree is kept in every status (the branch is pushed; `npm run reap`
 * sweeps merged ones). The app server on the run's port is reaped in every
 * status — a resumed run starts its own again.
 */
import { addIssueNote, editIssueLabels, updateMergeRequest, type GitlabResult, type MergeRequest } from '../lib/gitlab.js';
import { DRY_RUN, mergeMode as mergeModeFn, projectConfig } from '../lib/config.js';
import { mdText } from '../lib/gitlabmd.js';
import { readJournal, updateJournal } from '../lib/journal.js';
import { reapPortServer } from '../lib/worktrees.js';
import { log } from '../lib/log.js';
import { mergeGate, mergeNow } from './merge.js';
import type { Outcome } from './outcome.js';
import type { TicketResult } from './types.js';

export interface FinishDeps {
  editIssueLabels: typeof editIssueLabels;
  addIssueNote: typeof addIssueNote;
  mergeNow: typeof mergeNow;
  mergeMode: typeof mergeModeFn;
  reapPortServer: typeof reapPortServer;
  updateMergeRequest: typeof updateMergeRequest;
}

const REAL: FinishDeps = { editIssueLabels, addIssueNote, mergeNow, mergeMode: mergeModeFn, reapPortServer, updateMergeRequest };

/** The problem outcome.ts mrPostCheck reports for a Draft MR — the one problem finish can fix itself. */
const DRAFT_PROBLEM = 'MR is still marked Draft';
/** Every title prefix GitLab reads as Draft (the same set mrPostCheck matches). */
const DRAFT_PREFIX_RE = /^\s*(draft:|\[draft\]|\(draft\))\s*/i;

function casesLine(r: TicketResult): string {
  const c = r.cases ?? [];
  const n = (v: string): number => c.filter((x) => x.verdict === v).length;
  return c.length ? `cases: ${n('pass')} pass, ${n('fail')} fail, ${n('blocked')} blocked, ${n('skipped')} skipped` : 'cases: none recorded';
}

const dur = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

const bullets = (title: string, items: string[] | undefined): string =>
  items?.length ? `${title}\n${items.map((a) => `- ${mdText(a)}`).join('\n')}` : '';

/** A failed label or note write does not change how the run ended; it is said, not thrown. */
function warnIfFailed(what: string, res: GitlabResult<unknown>): void {
  if (!res.ok) log.warn(`${what} failed — fix it on GitLab by hand`, { kind: res.kind, status: res.status, error: res.error?.slice(0, 120) });
}

/**
 * Take a Draft MR out of Draft before the gate looks at it (spec §5.3: "not
 * `Draft:` (strip it)"). On success the Draft problem goes, and so does a
 * `draft_status` merge status — that was GitLab describing the title this
 * call just changed, and the merge call itself is the check from here. On
 * failure the problem stays and keeps the gate shut.
 */
async function undraft(mr: MergeRequest, problems: string[], deps: FinishDeps): Promise<{ mr: MergeRequest; problems: string[] }> {
  if (!problems.includes(DRAFT_PROBLEM)) return { mr, problems };
  const title = mr.title.replace(DRAFT_PREFIX_RE, '');
  if (!title || title === mr.title) return { mr, problems };
  const res = await deps.updateMergeRequest(mr.iid, { title });
  if (!res.ok || res.data?.draft === true) {
    log.warn(`could not take !${mr.iid} out of Draft — it stays unmerged`, { kind: res.kind, error: res.error?.slice(0, 120) });
    return { mr, problems };
  }
  log.info(`took !${mr.iid} out of Draft`);
  return {
    mr: { ...mr, title, draft: false, detailed_merge_status: mr.detailed_merge_status === 'draft_status' ? undefined : mr.detailed_merge_status },
    problems: problems.filter((p) => p !== DRAFT_PROBLEM),
  };
}

/** Journal statuses a run ends in; finish() has already spoken for a run in one of them. */
const TERMINAL = new Set(['done', 'blocked', 'aborted']);

export async function finish(iid: number, runId: string, outcome: Outcome, deps: FinishDeps = REAL): Promise<void> {
  const L = projectConfig().labels;
  const j = readJournal(iid);
  // Re-entered after the run already ended — run.ts's catch-all re-runs finish
  // as blocked when the first finish threw part-way (after a merge, say). The
  // first verdict stands: relabelling a merged ticket Needs Human, or posting a
  // second note, would be wrong on GitLab and in the journal.
  if (j && TERMINAL.has(j.status)) {
    log.warn(`#${iid} finish called again on a ${j.status} run — leaving GitLab and the journal as they are`, { outcome: outcome.kind });
    return;
  }
  const elapsed = j ? Date.now() - j.createdAt : 0;
  if (j?.port) deps.reapPortServer(j.port);

  if (outcome.kind === 'aborted') {
    updateJournal(iid, { status: 'aborted', stoppedAt: Date.now() });
    log.warn(`■ #${iid} aborted — resumable with --ticket ${iid}`);
    return;
  }

  if (outcome.kind === 'infra' || outcome.kind === 'blocked') {
    updateJournal(iid, { status: 'blocked', blockedWhy: outcome.why, stoppedAt: Date.now() });
    const detail = outcome.kind === 'infra'
      ? `Run \`${runId}\`, ${dur(elapsed)}: it ended without a verdict — the machinery failed, not the work. `
        + `Check the machine, then swap \`${L.blocked}\` for \`${L.entry}\` or run \`npm start -- --ticket ${iid}\`.`
      : `Run \`${runId}\`, ${dur(elapsed)}.`;
    warnIfFailed(`#${iid} label swap`, await deps.editIssueLabels(iid, { remove: [L.entry, L.inReview], add: [L.blocked] }));
    warnIfFailed(`#${iid} stop note`, await deps.addIssueNote(iid,
      `Oneshot stopped: **${mdText(outcome.why)}**\n\n${detail}\n\n<!-- oneshot:stop:${runId} -->`));
    log.error(`■ #${iid} BLOCKED${outcome.kind === 'infra' ? ' (infra)' : ''} — ${outcome.why}`);
    return;
  }

  // done
  const { result } = outcome;
  const { mr, problems } = await undraft(outcome.mr, outcome.problems, deps);
  const gate = mergeGate(result, mr, problems, deps.mergeMode());
  let merged = false;
  let why = gate.why;
  // Guarded here and not only in gitlab.ts: a dry-run accept answers ok, and
  // the journal would record a merge that never happened.
  if (gate.merge && DRY_RUN) why = 'the gate passed, but DRY_RUN is on';
  else if (gate.merge) {
    const m = await deps.mergeNow(mr);
    merged = m.merged;
    why = m.why;
  }
  updateJournal(iid, { status: 'done', mrIid: mr.iid, mrUrl: mr.web_url, merged, stoppedAt: Date.now() });

  const head = merged ? `Oneshot merged !${mr.iid}` : `Oneshot opened !${mr.iid} — not merged: ${mdText(why)}`;
  const body = [
    head,
    mdText(result.summary),
    casesLine(result),
    bullets('Assumptions:', result.assumptions),
    bullets('Regressions (not caused by this change):', result.regressions),
    `Run \`${runId}\`, ${dur(elapsed)}.`,
    `<!-- oneshot:${merged ? 'merged' : 'note'}:${runId} -->`,
  ].filter((s) => s !== '').join('\n\n');
  warnIfFailed(`#${iid} label swap`, await deps.editIssueLabels(iid, merged
    ? { remove: [L.entry, L.blocked, L.inReview], add: [L.exit] }
    : { remove: [L.entry, L.blocked], add: [L.inReview] }));
  warnIfFailed(`#${iid} note`, await deps.addIssueNote(iid, body));
  if (merged) log.ok(`■ #${iid} merged — !${mr.iid}`);
  else log.warn(`■ #${iid} in review — !${mr.iid} (${why})`);
}
