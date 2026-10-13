/**
 * The scan: which tickets carrying the entry label this desk may claim now.
 *
 * Lifted from oneshot's watcher (src/conductor/watcher.ts at 49899db) minus
 * everything a single desk does not need — cross-machine claim notes, the
 * automation mode's routing, the token-budget gate. "Is this claimed" is the
 * run journal: status claimed/running under a live pid (isClaimed).
 */
import { gitlabUsername, projectConfig } from '../lib/config.js';
import { issuesWithEntryLabel, type Issue } from '../lib/gitlab.js';
import { isClaimed, readJournal } from '../lib/journal.js';
import { isReachable, netState } from '../lib/reachability.js';
import { log } from '../lib/log.js';

export interface WatchResult {
  candidates: Issue[];
  skipped: Array<{ iid: number; why: string }>;
  held?: string;
}

/**
 * One scan. Returns what is claimable right now and why everything else was
 * passed over — the "why" matters, because a queue that silently drops work
 * looks identical to a queue with nothing to do.
 */
export async function scan(): Promise<WatchResult> {
  if (!isReachable()) return { candidates: [], skipped: [], held: `network ${netState()}` };

  const res = await issuesWithEntryLabel();
  if (!res.ok || !res.data) {
    // An auth failure is a config problem the operator must fix, not
    // something to retry against forever.
    if (res.kind === 'auth') log.error('GitLab refused the token — check its scope (needs api)', { status: res.status });
    return { candidates: [], skipped: [], held: `gitlab ${res.kind}` };
  }
  return triage(res.data);
}

/**
 * The scan's verdict on each ticket it read: claimable, skipped with a reason,
 * or dropped silently (a teammate's). Split from scan() so a test can hand it
 * tickets without the network in front. `me` is this desk's GitLab username,
 * resolved from its own token at boot, or by a later tick when GitLab was not
 * reachable at boot (recheckIdentity).
 */
export function triage(issues: Issue[], me: string = gitlabUsername()): WatchResult {
  const L = projectConfig().labels;
  const candidates: Issue[] = [];
  const skipped: Array<{ iid: number; why: string }> = [];

  for (const issue of issues) {
    // A human has to act on each of these first; re-claiming would only
    // repeat a run that already ended.
    const stop = [L.exit, L.inReview, L.blocked].find((l) => issue.labels.includes(l));
    if (stop) {
      skipped.push({ iid: issue.iid, why: `carries ${stop}` });
      continue;
    }
    if (issue.assignees.length > 0) {
      // The account that claims the ticket is the account that will comment,
      // push and merge on it, so an assigned ticket must be assigned to it.
      if (!me) {
        skipped.push({ iid: issue.iid, why: 'assigned ticket, but GitLab has not yet answered who this desk is (will retry each tick)' });
        continue;
      }
      // A teammate's ticket is not this desk's board at all: dropped silently,
      // because one line per teammate's ticket every tick buries this desk's own.
      if (!issue.assignees.some((a) => a.username === me)) continue;
    }
    if (isClaimed(issue.iid)) {
      skipped.push({ iid: issue.iid, why: 'run already in flight' });
      continue;
    }
    candidates.push(issue);
  }

  return { candidates: orderCandidates(candidates, (iid) => readJournal(iid)?.status ?? null), skipped };
}

/**
 * Last-run statuses that mean the ticket waits on a PERSON, not on capacity:
 * a block that was re-labelled before anything changed is refused by
 * runTicket for the cooldown, and at the head of the list it would hold the
 * one dispatch slot every tick.
 */
const STALLED_STATUSES = new Set(['blocked']);

/**
 * A stable partition — ready first, stalled last, original order kept within
 * each half — so the dispatcher, which takes the head of this list, reaches
 * fresh and resumable work before a ticket that will only be refused again.
 */
export function orderCandidates(candidates: Issue[], statusOf: (iid: number) => string | null): Issue[] {
  const ready: Issue[] = [];
  const stalled: Issue[] = [];
  for (const issue of candidates) (STALLED_STATUSES.has(statusOf(issue.iid) ?? '') ? stalled : ready).push(issue);
  return [...ready, ...stalled];
}

/** Human-readable one-liner for the console on every tick. */
export function describe(r: WatchResult): string {
  if (r.held) return `holding — ${r.held}`;
  if (!r.candidates.length && !r.skipped.length) return 'no tickets carry the entry label';
  const parts = [`${r.candidates.length} claimable`];
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
  return parts.join(', ');
}
