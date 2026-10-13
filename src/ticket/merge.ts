/**
 * The deterministic merge gate and the minimal merge behind it (spec §5.4).
 *
 * `Loop` is the standing consent to merge; the gate is what makes that consent
 * safe to act on. Every condition is checked from data the conductor holds —
 * the outcome's problems, the session's cases and regressions, and GitLab's own
 * mergeability — never from the session's say-so that it is done.
 */
import { acceptMergeRequest, rebaseMergeRequest, getMergeRequest, mergeRefusal, type MergeRequest } from '../lib/gitlab.js';
import { log } from '../lib/log.js';
import type { TicketResult } from './types.js';

/** GitLab statuses the gate lets through; mergeNow rebases once on need_rebase. */
const MERGEABLE = new Set(['mergeable', 'need_rebase', 'ci_still_running']);

export function mergeGate(result: TicketResult, mr: MergeRequest, problems: string[], mode: 'auto' | 'manual'): { merge: boolean; why: string } {
  if (mode !== 'auto') return { merge: false, why: 'merge.mode is manual' };
  if (problems.length) return { merge: false, why: problems.join('; ') };
  const cases = result.cases ?? [];
  // Failures first: a lone failing case is reported as the failure it is, not as a missing pass.
  const fails = cases.filter((c) => c.verdict === 'fail');
  if (fails.length) return { merge: false, why: `${fails.length} case(s) failed: ${fails.map((c) => c.id).join(', ')}` };
  if (!cases.some((c) => c.verdict === 'pass')) return { merge: false, why: 'no case recorded a pass' };
  const desc = (mr.description ?? '').toLowerCase();
  const unlisted = (result.regressions ?? []).filter((r) => !desc.includes(r.toLowerCase().slice(0, 40)));
  if (unlisted.length) return { merge: false, why: `regression(s) not listed in the MR: ${unlisted.join('; ')}` };
  // Absent on GitLab < 15.6: the merge call itself is then the check.
  const status = mr.detailed_merge_status;
  if (status && !MERGEABLE.has(status)) return { merge: false, why: `GitLab says ${status}` };
  return { merge: true, why: 'gate passed' };
}

export interface MergeDeps {
  acceptMergeRequest: typeof acceptMergeRequest;
  rebaseMergeRequest: typeof rebaseMergeRequest;
  getMergeRequest: typeof getMergeRequest;
  sleep: (ms: number) => Promise<void>;
  warn: (msg: string) => void;
}

const REAL: MergeDeps = {
  acceptMergeRequest, rebaseMergeRequest, getMergeRequest,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  warn: (msg) => log.warn(msg),
};

/**
 * Merge at the sha the gate evaluated. `not-mergeable` gets one rebase and one
 * retry; a rebase GitLab already has running is waited for, never re-issued.
 * A stale sha is not retried: the branch moved under the gate, and merging the
 * new head would merge code nobody evaluated.
 */
export async function mergeNow(mr: MergeRequest, deps: MergeDeps = REAL): Promise<{ merged: boolean; why: string }> {
  const accept = (sha: string) => deps.acceptMergeRequest(mr.iid, { sha, squash: false, removeSourceBranch: true });
  if (!mr.sha) return { merged: false, why: `!${mr.iid} has no head sha to merge at` };
  const res = await accept(mr.sha);
  if (res.ok) return { merged: true, why: 'merged' };
  const refusal = mergeRefusal(res);
  if (refusal !== 'not-mergeable' && refusal !== 'rebase-running') {
    return { merged: false, why: `merge refused: ${refusal} (${res.status})` };
  }
  if (refusal === 'not-mergeable') {
    deps.warn(`!${mr.iid} not mergeable — rebasing once`);
    const rb = await deps.rebaseMergeRequest(mr.iid, true);
    if (!rb.ok) return { merged: false, why: `rebase refused: ${rb.error ?? rb.kind}` };
  } else {
    deps.warn(`!${mr.iid} has a rebase running — waiting for it`);
  }
  for (let i = 0; i < 12; i += 1) {           // up to 60s
    await deps.sleep(5_000);
    const fresh = await deps.getMergeRequest(mr.iid, { rebaseProgress: true });
    if (fresh.ok && fresh.data && !fresh.data.rebase_in_progress) {
      if (!fresh.data.sha) return { merged: false, why: `!${mr.iid} has no head sha after the rebase` };
      const again = await accept(fresh.data.sha);
      if (again.ok) return { merged: true, why: 'merged after rebase' };
      const err = fresh.data.merge_error ? ` (${fresh.data.merge_error})` : '';
      return { merged: false, why: `merge refused after rebase: ${mergeRefusal(again)}${err}` };
    }
  }
  return { merged: false, why: 'rebase did not finish within 60s' };
}
