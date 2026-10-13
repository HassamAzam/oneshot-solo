/**
 * What the session's end means for the ticket (spec §5.3).
 *
 * `done` is corroborated, never trusted: the MR is looked up by source branch
 * whether or not the session reported one, and a session-reported `mrIid` is
 * only compared against what the branch lookup found. The post-check applies
 * the same two rules hooks/mr-gate.cjs enforces on the session's MR writes,
 * plus the target branch and Draft; anything it finds becomes a `problem`,
 * which keeps the merge gate shut without hiding the MR.
 */
import type { SessionOutput } from './session.js';
import { isBlocked, type TicketResult } from './types.js';
import { findMergeRequests, getMergeRequest, issueUrl, type MergeRequest } from '../lib/gitlab.js';
import { projectConfig } from '../lib/config.js';

export type Outcome =
  | { kind: 'done'; mr: MergeRequest; result: TicketResult; problems: string[] }
  | { kind: 'blocked'; why: string }
  | { kind: 'infra'; why: string }
  | { kind: 'aborted' };

/**
 * The open MR whose source branch is `branch`, newest-updated first; null when
 * there is none. Throws when GitLab could not be asked, so "the lookup failed"
 * never reads as "the session opened no MR".
 *
 * The list endpoint answers "which iid"; the MR is read back in full so the
 * merge gate decides on GitLab's current detailed_merge_status (gitlab.ts,
 * findMergeRequests). A failed read-back keeps the listed MR.
 */
export async function findOpenMr(branch: string): Promise<MergeRequest | null> {
  const res = await findMergeRequests({ sourceBranch: branch, state: 'opened' });
  if (!res.ok) throw new Error(`${res.kind} ${res.status}${res.error ? `: ${res.error.slice(0, 120)}` : ''}`);
  const listed = (res.data ?? [])[0];
  if (!listed) return null;
  const full = await getMergeRequest(listed.iid);
  return full.ok && full.data ? full.data : listed;
}

const PREFIX_RE = /^(feat|fix|chore|refactor|test|docs|style|perf|ci|build|revert)(\(.+?\))?!?:\s*/i;   // same as hooks/mr-gate.cjs
const DRAFT_RE = /^\s*(draft:|\[draft\]|\(draft\))/i;                                                  // GitLab's draft title prefixes
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function mrPostCheck(mr: MergeRequest, iid: number, base: string): string[] {
  const problems: string[] = [];
  if (mr.target_branch !== base) problems.push(`MR targets ${mr.target_branch}, not ${base}`);
  if (mr.draft === true || DRAFT_RE.test(mr.title)) problems.push('MR is still marked Draft');
  if (PREFIX_RE.test(mr.title.trim())) problems.push('MR title carries a conventional-commit prefix');
  const closes = new RegExp(`\\[closes\\s+${escapeRe(issueUrl(iid))}\\]`, 'i');
  if (!closes.test(mr.description ?? '')) problems.push(`MR description lacks [closes ${issueUrl(iid)}]`);
  return problems;
}

export async function classify(
  out: SessionOutput, branch: string, iid: number, deps = { findOpenMr },
): Promise<Outcome> {
  if (out.status === 'aborted') return { kind: 'aborted' };
  if (out.status === 'infra' || out.status === 'parked') return { kind: 'infra', why: out.error ?? out.status };
  const blocked = isBlocked(out.result);
  if (blocked) return { kind: 'blocked', why: blocked };
  let open: MergeRequest | null;
  try {
    open = await deps.findOpenMr(branch);
  } catch (err) {
    return { kind: 'blocked', why: `could not look up the merge request on ${branch}: ${(err as Error).message}` };
  }
  if (!open) {
    return {
      kind: 'blocked',
      why: out.status === 'ok'
        ? 'the session finished but no merge request is open on its branch'
        : `the session ended with ${out.resultSubtype ?? out.status} and no merge request is open on its branch`,
    };
  }
  const problems = mrPostCheck(open, iid, projectConfig().branches.base);
  const reported = out.result?.mrIid;
  if (reported !== undefined && reported !== open.iid) {
    problems.push(`session reported !${reported} but the open MR on the branch is !${open.iid}`);
  }
  if (out.status !== 'ok') {
    problems.push(`the session ended with ${out.resultSubtype ?? out.status}${out.error ? `: ${out.error.slice(0, 200)}` : ''}`);
  }
  return { kind: 'done', mr: open, result: out.result ?? { summary: '(no structured result)' }, problems };
}
