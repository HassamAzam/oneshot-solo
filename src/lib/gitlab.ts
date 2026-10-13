/**
 * GitLab REST helpers used by the conductor itself. The ticket session talks to
 * GitLab through the MCP server instead; this is the conductor's code path, and
 * it is the only one that performs label writes and merges.
 *
 * Every call classifies its failure, because "the VPN is down" and "your token
 * is wrong" and "that issue does not exist" demand completely different
 * responses, and a caller that blurs them retries forever against a dead link.
 */
import { gitlabRepo, projectConfig, DRY_RUN } from './config.js';
import { resolveToken, setupHint } from './token.js';
import { log } from './log.js';

export type FailKind = 'ok' | 'network' | 'auth' | 'notfound' | 'server' | 'client';

export interface GitlabResult<T> {
  ok: boolean;
  kind: FailKind;
  status: number;
  data: T | null;
  error?: string;
}

/**
 * This desk's GitLab token, and the one place it is read. Every call this module
 * makes, read or write, is made as THIS DESK.
 *
 * The token comes from src/lib/token.ts, which prefers the operator's own
 * credential (ONESHOT_GITLAB_TOKEN, ~/.config/oneshot/gitlab-token) over the
 * shared GITLAB_TOKEN in .env. That is what makes the conductor act as the person
 * whose machine it runs on rather than as whoever's token was pasted into the
 * repo — and it is why the assignee gate and the acting identity cannot
 * disagree: they are the same credential. Throws, with the setup hint, when
 * the desk has none.
 */
export function readToken(): string {
  const t = resolveToken().token;
  if (!t) throw new Error(`No GitLab token for this desk. ${setupHint()}`);
  return t;
}

function base(): string { return gitlabRepo().apiUrl; }

/**
 * The `:id` every project endpoint takes: the URL-encoded path (`group%2Fproject`),
 * which GitLab accepts wherever it accepts the number. Using it means the project's
 * identity is exactly one fact — GITLAB_REPO_URL — with no numeric id configured
 * alongside it to go stale. The number, where something genuinely needs it, is
 * asked of GitLab: see resolvedProjectId().
 */
function projectId(): string { return encodeURIComponent(gitlabRepo().project); }

/**
 * Classify a failure. 5xx counts as "network" for circuit-breaker purposes:
 * GitLab answering 500, or a captive portal answering for it, means work
 * cannot proceed either way. 401/403 deliberately does NOT — the server
 * answered, so a bad token must not look like an outage.
 */
function classify(status: number): FailKind {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status >= 500) return 'server';
  return 'client';
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<GitlabResult<T>> {
  const url = `${base()}${path}`;
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': readToken(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const kind = classify(res.status);
    if (kind !== 'ok') {
      const text = await res.text().catch(() => '');
      return { ok: false, kind, status: res.status, data: null, error: text.slice(0, 300) };
    }
    // A DELETE answers 204 with no body; res.json() on nothing throws and would
    // report a successful delete as a network failure.
    const text = await res.text();
    return { ok: true, kind: 'ok', status: res.status, data: (text ? JSON.parse(text) : null) as T };
  } catch (err) {
    // Timeout, DNS failure, connection refused — the VPN case.
    return {
      ok: false, kind: 'network', status: 0, data: null,
      error: (err as Error).message.slice(0, 300),
    };
  } finally {
    clearTimeout(killer);
  }
}

export interface Issue {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  assignees: Array<{ username: string }>;
  state: string;
  web_url: string;
  updated_at: string;
}

export function getIssue(iid: number): Promise<GitlabResult<Issue>> {
  return call<Issue>('GET', `/projects/${projectId()}/issues/${iid}`);
}

/** Open issues carrying the entry label, oldest-updated first (rough FIFO), one page of 50. */
export async function issuesWithEntryLabel(): Promise<GitlabResult<Issue[]>> {
  const label = encodeURIComponent(projectConfig().labels.entry);
  return call<Issue[]>(
    'GET',
    `/projects/${projectId()}/issues?state=opened&labels=${label}&per_page=50&order_by=updated_at&sort=asc`,
  );
}

/**
 * Issues carrying `label` (exact name) — or, given several, carrying ALL of
 * them — newest-updated first, one page of 100.
 *
 * Unlike issuesWithEntryLabel this takes the label and the state as arguments,
 * and can exclude a label server-side with `not[labels]` so the page is not
 * filled by tickets the caller would skip anyway. `state` defaults to 'all'.
 * GitLab's `labels=` is an AND over a comma list, so each name is encoded on
 * its own and the commas are left as separators.
 */
export async function issuesWithLabel(
  label: string | readonly string[],
  opts: { state?: 'opened' | 'closed' | 'all'; notLabel?: string } = {},
): Promise<GitlabResult<Issue[]>> {
  const all = typeof label === 'string' ? [label] : label;
  const params = [`labels=${all.map((l) => encodeURIComponent(l)).join(',')}`, `state=${opts.state ?? 'all'}`];
  if (opts.notLabel) params.push(`not%5Blabels%5D=${encodeURIComponent(opts.notLabel)}`);
  params.push('per_page=100', 'order_by=updated_at', 'sort=desc');
  return call<Issue[]>('GET', `/projects/${projectId()}/issues?${params.join('&')}`);
}

export interface IssueNote {
  id: number;
  body: string;
  /** GitLab's own flag for a note it generated (a label swap, an assignment). */
  system?: boolean;
  /** Who typed it. Absent only when GitLab declines to name an author. */
  author?: { username?: string };
  /** ISO timestamp. */
  created_at?: string;
}

/**
 * A ticket's comments, OLDEST FIRST — but only the NEWEST hundred of them.
 *
 * The ordering matters and the direction is a trap. Every caller keeps a
 * bounded tail (`.slice(-25)`, the close-note marker scan) on the assumption
 * that the tail is the recent end. `sort=asc` seems to buy that, but GitLab
 * caps `per_page` at 100 and this makes ONE request with no pagination, so on a
 * ticket with more than 100 comments `sort=asc` returns page one — the OLDEST
 * hundred — and the recent comments are never fetched at all. A just-posted
 * close marker would fall outside the scanned set and be re-posted on resume.
 *
 * So fetch newest-first to get the genuinely recent hundred, then reverse to
 * hand callers the oldest-first order their `.slice(-25)` expects.
 *
 * `system` is GitLab's own flag for a note it generated itself — a label
 * change, an assignment, a "marked this issue as related to" — as opposed to
 * one a person typed, so a caller distinguishing human replies from board
 * noise does not have to guess from body text alone.
 */
export async function issueNotes(
  iid: number,
): Promise<GitlabResult<IssueNote[]>> {
  const res = await call<IssueNote[]>(
    'GET',
    `/projects/${projectId()}/issues/${iid}/notes?per_page=100&order_by=created_at&sort=desc`,
  );
  if (res.ok && res.data) return { ...res, data: [...res.data].reverse() };
  return res;
}

/**
 * One file somebody attached to a ticket, as raw bytes. `filename` is passed as
 * it appears in the markdown link — already URL-encoded — because that is the
 * path GitLab stored it under.
 */
export async function downloadUpload(
  secret: string, filename: string,
): Promise<GitlabResult<Buffer>> {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${base()}/projects/${projectId()}/uploads/${secret}/${filename}`, {
      headers: { 'PRIVATE-TOKEN': readToken() },
      signal: controller.signal,
    });
    const kind = classify(res.status);
    if (kind !== 'ok') {
      const text = await res.text().catch(() => '');
      return { ok: false, kind, status: res.status, data: null, error: text.slice(0, 300) };
    }
    return { ok: true, kind: 'ok', status: res.status, data: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    return {
      ok: false, kind: 'network', status: 0, data: null,
      error: (err as Error).message.slice(0, 300),
    };
  } finally {
    clearTimeout(killer);
  }
}

/** Enough for any real ticket; only here so a misbehaving API cannot loop forever. */
const MAX_NOTE_PAGES = 50;

/**
 * EVERY comment on a ticket, oldest first — for reading the ticket as
 * requirements (fetchTicket, src/lib/ticket.ts). issueNotes()'s newest-hundred
 * window is right for a caller looking for recent notes of its own, and wrong
 * here: an acceptance criterion amended in comment 3 of 140, or the link to a
 * recording, is exactly what a window drops without a trace.
 *
 * All or nothing. A page failing half-way returns the failure rather than the
 * pages already read, because a partial thread looks exactly like a whole one.
 */
export async function allIssueNotes(
  iid: number,
): Promise<GitlabResult<IssueNote[]>> {
  const all: IssueNote[] = [];
  for (let page = 1; page <= MAX_NOTE_PAGES; page++) {
    const res = await call<IssueNote[]>(
      'GET',
      `/projects/${projectId()}/issues/${iid}/notes?per_page=100&page=${page}&order_by=created_at&sort=asc`,
    );
    if (!res.ok || !res.data) return res;
    all.push(...res.data);
    if (res.data.length < 100) return { ...res, data: all };
  }
  log.warn(`#${iid}: notes exceed ${MAX_NOTE_PAGES * 100}; reading only the oldest ${all.length}`);
  return { ok: true, kind: 'ok', status: 200, data: all };
}

/**
 * One note, by id — not "the newest hundred and hope it's in there".
 *
 * issueNotes()'s window is exactly the trap its own comment names: a note
 * posted long enough ago falls out of it once a busy ticket accrues more than
 * a hundred comments after it, and a caller scanning that list for something
 * of its own reads "gone" and re-posts. A direct lookup by id has no window to
 * fall out of: GitLab still has the note, this just asks for it by name
 * instead of finding it in a haystack sized by an unrelated caller's needs.
 */
export async function getIssueNote(
  iid: number, noteId: number,
): Promise<GitlabResult<IssueNote>> {
  return call<IssueNote>('GET', `/projects/${projectId()}/issues/${iid}/notes/${noteId}`);
}

/**
 * Remove one of our own notes. GitLab lets the author delete a note, and this
 * desk's token is the author of every note this conductor posts.
 */
export async function deleteIssueNote(iid: number, noteId: number): Promise<GitlabResult<null>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would delete note ${noteId} on #${iid}`);
    return { ok: true, kind: 'ok', status: 204, data: null };
  }
  return call<null>('DELETE', `/projects/${projectId()}/issues/${iid}/notes/${noteId}`);
}

export async function addIssueNote(
  iid: number, body: string,
): Promise<GitlabResult<{ id: number }>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would add note to #${iid}`, { chars: body.length });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  return call<{ id: number }>(
    'POST', `/projects/${projectId()}/issues/${iid}/notes`, { body },
  );
}

export interface Upload {
  url: string;
  markdown: string;
  full_path?: string;
}

/**
 * Attach a file to the project and get back the markdown that renders it.
 *
 * Multipart, so it cannot go through call() — and deliberately so: the JSON
 * helper sets its own Content-Type, while a multipart body needs fetch to
 * generate the boundary, which it only does when the header is ABSENT.
 *
 * The returned `markdown` is project-scoped: it renders in a note on this
 * project's issues or merge requests and nowhere else, which is exactly the
 * scope Oneshot posts into.
 */
export async function uploadFile(
  filename: string, content: Buffer | string, mime = 'application/octet-stream',
): Promise<GitlabResult<Upload>> {
  if (DRY_RUN) {
    log.warn('[dry-run] would upload', { filename, bytes: content.length });
    return {
      ok: true, kind: 'ok', status: 200,
      data: { url: '', markdown: `_(dry-run: ${filename} not uploaded)_` },
    };
  }
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);

  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${base()}/projects/${projectId()}/uploads`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': readToken() },
      body: form,
      signal: controller.signal,
    });
    const kind = classify(res.status);
    if (kind !== 'ok') {
      const text = await res.text().catch(() => '');
      return { ok: false, kind, status: res.status, data: null, error: text.slice(0, 300) };
    }
    return { ok: true, kind: 'ok', status: res.status, data: (await res.json()) as Upload };
  } catch (err) {
    return {
      ok: false, kind: 'network', status: 0, data: null,
      error: (err as Error).message.slice(0, 300),
    };
  } finally {
    clearTimeout(killer);
  }
}

/**
 * Swap the ticket's Oneshot label, preserving every other label.
 *
 * GitLab's `labels` field is a full replacement, so anything not carried
 * through here is silently dropped — which is exactly how a board loses its
 * Minor/Major/AI markers. Callers pass what to remove and what to add; the
 * rest of the array is copied unchanged.
 */
export async function swapLabel(
  iid: number,
  remove: string[],
  add: string[],
): Promise<GitlabResult<Issue>> {
  const current = await getIssue(iid);
  if (!current.ok || !current.data) return current;

  const removeSet = new Set(remove);
  const next = current.data.labels.filter((l) => !removeSet.has(l));
  for (const l of add) if (!next.includes(l)) next.push(l);

  if (DRY_RUN) {
    log.warn(`[dry-run] would set labels on #${iid}`, { from: current.data.labels, to: next });
    return { ok: true, kind: 'ok', status: 200, data: current.data };
  }
  return call<Issue>(
    'PUT', `/projects/${projectId()}/issues/${iid}`, { labels: next.join(',') },
  );
}

/**
 * Add and remove labels in ONE server-side step: PUT /projects/:id/issues/:iid with
 * `add_labels` / `remove_labels` (comma-joined). Unlike swapLabel (GET, then a full `labels` PUT),
 * a label a human changes between the two calls cannot be lost. Idempotent: adding a present label
 * or removing an absent one is a no-op. DRY_RUN logs `[dry-run] would edit labels on #<iid>` and
 * returns ok without a call.
 *
 * A change with nothing in it makes no call at all: a write that changes
 * nothing is still a write made as this desk.
 */
export async function editIssueLabels(
  iid: number,
  change: { add?: string[]; remove?: string[] },
): Promise<GitlabResult<Issue>> {
  const add = (change.add ?? []).filter((l) => l !== '');
  const remove = (change.remove ?? []).filter((l) => l !== '');
  if (DRY_RUN) {
    log.warn(`[dry-run] would edit labels on #${iid}`, { add, remove });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  if (add.length === 0 && remove.length === 0) return { ok: true, kind: 'ok', status: 200, data: null };
  const body: Record<string, string> = {};
  if (add.length) body.add_labels = add.join(',');
  if (remove.length) body.remove_labels = remove.join(',');
  return call<Issue>('PUT', `/projects/${projectId()}/issues/${iid}`, body);
}

export interface Label { name: string }

/**
 * Every label defined on the project.
 *
 * Oneshot never creates a label, and every label check it performs is by NAME
 * against whatever the ticket carries — so a name that is misspelled, renamed
 * on the board, or never created simply never matches. Nothing raises: a swap
 * writes a label the board does not show. This is the one call that can turn
 * that into a sentence.
 *
 * One page of 100. A project can define more than that (arbisoft/erp has over
 * 300, group labels included), so a caller asking about particular names
 * passes `search` — a substring match, which the caller then checks exactly.
 */
export function listLabels(search?: string): Promise<GitlabResult<Label[]>> {
  const q = search ? `&search=${encodeURIComponent(search)}` : '';
  return call<Label[]>('GET', `/projects/${projectId()}/labels?per_page=100${q}`);
}

export interface Branch { name: string; protected: boolean; commit: { id: string } }

export function getBranch(name: string): Promise<GitlabResult<Branch>> {
  return call<Branch>(
    'GET', `/projects/${projectId()}/repository/branches/${encodeURIComponent(name)}`,
  );
}

// ------------------------------------------------------------ merge requests

export type MergeState = 'opened' | 'closed' | 'locked' | 'merged';

/**
 * GitLab 15.6+. Older instances omit the field entirely, which is why every
 * caller must be able to fall back to `merge_status` + `has_conflicts`, and why
 * the union stays open: a status this code has never seen must survive the
 * round-trip so the caller can echo it rather than silently treat it as
 * mergeable.
 */
export type DetailedMergeStatus =
  | 'mergeable' | 'unchecked' | 'checking' | 'preparing' | 'approvals_syncing'
  | 'ci_must_pass' | 'ci_still_running' | 'conflict' | 'need_rebase'
  | 'discussions_not_resolved' | 'draft_status' | 'not_open' | 'not_approved'
  | 'requested_changes' | 'blocked_status' | 'broken_status' | 'commits_status'
  | 'status_checks_must_pass' | 'jira_association_missing'
  | 'security_policy_violations' | 'locked_paths' | 'locked_lfs_files'
  | (string & {});

export interface MergeRequest {
  iid: number;
  id: number;
  project_id: number;
  state: MergeState;
  title: string;
  description: string | null;
  web_url: string;
  source_branch: string;
  target_branch: string;
  /** Head of the source branch as GitLab last saw it — the accept guard. */
  sha: string | null;
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
  merge_status: 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'checking'
    | 'cannot_be_merged_recheck';
  detailed_merge_status?: DetailedMergeStatus;
  has_conflicts: boolean;
  merge_error: string | null;
  draft: boolean;
  squash: boolean;
  blocking_discussions_resolved: boolean;
  /** Only present with include_rebase_in_progress=true. */
  rebase_in_progress?: boolean;
  head_pipeline?: { id: number; status: string; web_url: string } | null;
  diverged_commits_count?: number;
}

/**
 * One merge request, in full.
 *
 * `include_rebase_in_progress` costs a Gitaly round-trip, so it is opt-in and
 * asked for only while a rebase is actually being waited on.
 */
export function getMergeRequest(
  mrIid: number,
  opts: { rebaseProgress?: boolean; divergedCount?: boolean } = {},
): Promise<GitlabResult<MergeRequest>> {
  const params: string[] = [];
  if (opts.rebaseProgress) params.push('include_rebase_in_progress=true');
  if (opts.divergedCount) params.push('include_diverged_commits_count=true');
  const q = params.length ? `?${params.join('&')}` : '';
  return call<MergeRequest>('GET', `/projects/${projectId()}/merge_requests/${mrIid}${q}`);
}

/**
 * Discover merge requests by branch, newest-updated first.
 *
 * The list endpoint omits merge_status, detailed_merge_status and diff_refs, so
 * this answers "which iid" and nothing else — read the iid back through
 * getMergeRequest() before deciding anything about mergeability.
 */
export function findMergeRequests(q: {
  sourceBranch?: string;
  targetBranch?: string;
  state?: 'opened' | 'merged' | 'closed' | 'all';
}): Promise<GitlabResult<MergeRequest[]>> {
  const params = ['order_by=updated_at', 'sort=desc', 'per_page=20',
    `state=${q.state ?? 'opened'}`];
  if (q.sourceBranch) params.push(`source_branch=${encodeURIComponent(q.sourceBranch)}`);
  if (q.targetBranch) params.push(`target_branch=${encodeURIComponent(q.targetBranch)}`);
  return call<MergeRequest[]>(
    'GET', `/projects/${projectId()}/merge_requests?${params.join('&')}`,
  );
}

/**
 * Merge one merge request.
 *
 * `sha` is optional to GitLab and mandatory here: it pins the merge to the head
 * this caller actually evaluated, so a branch that moved under us fails loudly
 * with a 409 instead of quietly merging code nobody looked at.
 *
 * `merge_when_pipeline_succeeds` is deliberately not exposed. It returns 200
 * immediately with the MR still open, which would let the pipeline report a
 * merge that has not happened and deploy a base branch without the change in it.
 */
export async function acceptMergeRequest(mrIid: number, opts: {
  sha: string;
  squash: boolean;
  removeSourceBranch?: boolean;
  mergeCommitMessage?: string;
  squashCommitMessage?: string;
}): Promise<GitlabResult<MergeRequest>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would merge !${mrIid}`, { sha: opts.sha.slice(0, 8), squash: opts.squash });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  return call<MergeRequest>('PUT', `/projects/${projectId()}/merge_requests/${mrIid}/merge`, {
    sha: opts.sha,
    squash: opts.squash,
    should_remove_source_branch: opts.removeSourceBranch === true,
    ...(opts.mergeCommitMessage ? { merge_commit_message: opts.mergeCommitMessage } : {}),
    ...(opts.squashCommitMessage ? { squash_commit_message: opts.squashCommitMessage } : {}),
  });
}

/** Returns 202 and rebases asynchronously — poll rebase_in_progress, never re-issue. */
export async function rebaseMergeRequest(
  mrIid: number, skipCi = false,
): Promise<GitlabResult<{ rebase_in_progress: boolean }>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would rebase !${mrIid}`);
    return { ok: true, kind: 'ok', status: 202, data: null };
  }
  return call<{ rebase_in_progress: boolean }>(
    'PUT',
    `/projects/${projectId()}/merge_requests/${mrIid}/rebase${skipCi ? '?skip_ci=true' : ''}`,
  );
}

export async function createMergeRequest(opts: {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  removeSourceBranch?: boolean;
  labels?: string[];
}): Promise<GitlabResult<MergeRequest>> {
  if (DRY_RUN) {
    log.warn('[dry-run] would open a merge request', {
      from: opts.sourceBranch, to: opts.targetBranch, title: opts.title,
    });
    return { ok: true, kind: 'ok', status: 201, data: null };
  }
  return call<MergeRequest>('POST', `/projects/${projectId()}/merge_requests`, {
    source_branch: opts.sourceBranch,
    target_branch: opts.targetBranch,
    title: opts.title,
    description: opts.description,
    remove_source_branch: opts.removeSourceBranch === true,
    ...(opts.labels?.length ? { labels: opts.labels.join(',') } : {}),
  });
}

export async function updateMergeRequest(mrIid: number, patch: {
  title?: string;
  description?: string;
  targetBranch?: string;
  stateEvent?: 'close' | 'reopen';
}): Promise<GitlabResult<MergeRequest>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would update !${mrIid}`, { fields: Object.keys(patch) });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  return call<MergeRequest>('PUT', `/projects/${projectId()}/merge_requests/${mrIid}`, {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.targetBranch === undefined ? {} : { target_branch: patch.targetBranch }),
    ...(patch.stateEvent === undefined ? {} : { state_event: patch.stateEvent }),
  });
}

export async function addMergeRequestNote(
  mrIid: number, body: string,
): Promise<GitlabResult<{ id: number }>> {
  if (DRY_RUN) {
    log.warn(`[dry-run] would add note to !${mrIid}`, { chars: body.length });
    return { ok: true, kind: 'ok', status: 200, data: null };
  }
  return call<{ id: number }>(
    'POST', `/projects/${projectId()}/merge_requests/${mrIid}/notes`, { body },
  );
}

/**
 * Why a merge write was refused, at the resolution a caller can act on.
 *
 * A sibling of classify() rather than an extension of FailKind: the
 * reachability breaker decides "is the VPN down" from `network`/`server`, so a
 * merge-specific kind leaking into FailKind would let a refused merge trip the
 * network breaker. And classify() calls 405, 406, 409 and 422 all `client`,
 * which is the one distinction that matters here — "your sha is stale, re-read
 * and retry" and "this thing has conflicts" demand opposite responses.
 */
export type MergeRefusal =
  | 'sha-stale'
  | 'not-mergeable'
  | 'squash-policy'
  | 'rebase-running'
  | 'duplicate-mr'
  | 'auth'
  | 'network'
  | 'other';

export function mergeRefusal(res: GitlabResult<unknown>): MergeRefusal {
  if (res.kind === 'auth') return 'auth';
  if (res.kind === 'network' || res.kind === 'server') return 'network';
  const body = (res.error ?? '').toLowerCase();
  if (res.status === 409 && /already exists/.test(body)) return 'duplicate-mr';
  if (res.status === 409 && /rebase/.test(body)) return 'rebase-running';
  if (res.status === 409) return 'sha-stale';
  if (res.status === 422 && /squash/.test(body)) return 'squash-policy';
  if (res.status === 405 || res.status === 406) return 'not-mergeable';
  return 'other';
}

let numericId: number | null = null;

function remember(res: GitlabResult<{ id: number }>): void {
  if (res.ok && typeof res.data?.id === 'number') numericId = res.data.id;
}

/** Cheapest possible authenticated call — the reachability probe. */
export async function ping(): Promise<GitlabResult<{ id: number }>> {
  const res = await call<{ id: number }>('GET', `/projects/${projectId()}?statistics=false`);
  // The probe already carries the numeric id, so the first healthy tick
  // answers resolvedProjectId() for free.
  remember(res);
  return res;
}

/**
 * The project's NUMERIC id, asked of GitLab once and then remembered; null when
 * GitLab could not be asked.
 *
 * Only for what the API cannot do with a path: recognising this project's own
 * `/-/project/<id>/uploads/…` links in a ticket (src/lib/ticketdocs.ts). It is
 * deliberately not configuration — a configured id is a second statement of the
 * project's identity, and the one that silently goes stale when the first moves.
 * A failure is not remembered, so the next caller asks again.
 */
export async function resolvedProjectId(): Promise<number | null> {
  if (numericId === null) remember(await ping());
  return numericId;
}

/** The project's web URL, scheme and any explicit port included, as GITLAB_REPO_URL gives them. */
export function projectUrl(): string {
  return gitlabRepo().webUrl;
}

export function issueUrl(iid: number): string {
  return `${projectUrl()}/-/issues/${iid}`;
}

export function mergeRequestUrl(mrIid: number): string {
  return `${projectUrl()}/-/merge_requests/${mrIid}`;
}
