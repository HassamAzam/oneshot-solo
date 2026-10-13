/**
 * The session's one structured result, and the tools it may never call.
 */

export interface TicketCase { id: string; title: string; verdict: 'pass' | 'fail' | 'blocked' | 'skipped'; note?: string }
export interface TicketResult {
  summary: string; blocked?: string | null; branch?: string; mrIid?: number; mrUrl?: string;
  cases?: TicketCase[]; assumptions?: string[]; regressions?: string[];
}

/** `blocked` is deliberately NOT required: a required field the model must emit as null is how a stray close-tag once ended up in it (oneshot schemas.ts). */
export const RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string', description: 'What was built and verified, 3-8 sentences, for the ticket note.' },
    blocked: { type: ['string', 'null'], description: 'Only for a ticket that cannot be built as written: say what is missing and what would unblock it. Omit or null otherwise.' },
    branch: { type: 'string' },
    mrIid: { type: 'integer' },
    mrUrl: { type: 'string' },
    cases: { type: 'array', items: { type: 'object', required: ['id', 'title', 'verdict'], additionalProperties: false, properties: {
      id: { type: 'string' }, title: { type: 'string' }, verdict: { type: 'string', enum: ['pass', 'fail', 'blocked', 'skipped'] }, note: { type: 'string' } } } },
    assumptions: { type: 'array', items: { type: 'string' } },
    regressions: { type: 'array', items: { type: 'string' }, description: 'Failures NOT caused by this change, each also listed in the MR description.' },
  },
};

const VERDICTS = new Set(['pass', 'fail', 'blocked', 'skipped']);
export function parseTicketResult(raw: unknown): TicketResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.summary !== 'string') return null;
  const r: TicketResult = { summary: o.summary };
  if (typeof o.blocked === 'string' || o.blocked === null) r.blocked = o.blocked as string | null;
  if (typeof o.branch === 'string') r.branch = o.branch;
  if (Number.isInteger(o.mrIid)) r.mrIid = o.mrIid as number;
  if (typeof o.mrUrl === 'string') r.mrUrl = o.mrUrl;
  if (Array.isArray(o.cases)) {
    r.cases = (o.cases as Array<Record<string, unknown>>)
      .filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string' && VERDICTS.has(String(c.verdict)))
      .map((c) => ({ id: c.id as string, title: c.title as string, verdict: c.verdict as TicketCase['verdict'], ...(typeof c.note === 'string' ? { note: c.note } : {}) }));
  }
  const strs = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined;
  const a = strs(o.assumptions); if (a) r.assumptions = a;
  const g = strs(o.regressions); if (g) r.regressions = g;
  return r;
}

export function isBlocked(r: TicketResult | null): string | null {
  const b = r?.blocked;
  return typeof b === 'string' && b.trim() ? b.trim() : null;
}

const gitlab = (...names: string[]): string[] => names.map((n) => `mcp__gitlab__${n}`);

/**
 * Denied for the whole session. The MR tools are allowed on purpose: the session opens the MR; mr-gate guards them.
 *
 * Allowed from the server's write side: create_merge_request, update_merge_request,
 * create_merge_request_note, upload_markdown. Every other tool @zereight/mcp-gitlab 2.2.4
 * does not advertise as read-only is here — `execute_graphql` included, because a GraphQL
 * mutation reaches everything the named tools are denied. types.test.ts re-derives the
 * write set from the installed server, so a version bump that adds one fails the suite.
 */
export const DENIED_TOOLS: string[] = [
  'AskUserQuestion',
  // merging, approval and MR discussion: the session writes the MR itself and one plain note, nothing else
  ...gitlab('merge_merge_request', 'approve_merge_request', 'unapprove_merge_request',
    'create_merge_request_thread', 'resolve_merge_request_thread',
    'create_merge_request_discussion_note', 'update_merge_request_discussion_note', 'delete_merge_request_discussion_note',
    'update_merge_request_note', 'delete_merge_request_note',
    'create_merge_request_emoji_reaction', 'delete_merge_request_emoji_reaction',
    'create_merge_request_note_emoji_reaction', 'delete_merge_request_note_emoji_reaction',
    'create_draft_note', 'update_draft_note', 'delete_draft_note', 'publish_draft_note', 'bulk_publish_draft_notes'),
  // issues, work items and labels: the conductor owns the ticket
  ...gitlab('create_issue', 'update_issue', 'update_issue_description_patch', 'delete_issue',
    'create_issue_note', 'update_issue_note', 'create_note', 'create_issue_link', 'delete_issue_link',
    'create_issue_emoji_reaction', 'delete_issue_emoji_reaction', 'create_issue_note_emoji_reaction', 'delete_issue_note_emoji_reaction',
    'create_work_item', 'update_work_item', 'convert_work_item_type', 'move_work_item', 'create_work_item_note',
    'create_work_item_emoji_reaction', 'delete_work_item_emoji_reaction',
    'create_work_item_note_emoji_reaction', 'delete_work_item_note_emoji_reaction', 'create_timeline_event',
    'create_label', 'update_label', 'delete_label',
    'create_milestone', 'edit_milestone', 'delete_milestone', 'promote_milestone',
    'create_group_milestone', 'edit_group_milestone', 'delete_group_milestone',
    'mark_todo_done', 'mark_all_todos_done'),
  // repository, branches and tags: git-guard governs pushes; nothing writes the remote around it
  ...gitlab('push_files', 'create_or_update_file', 'create_branch', 'delete_branch',
    'protect_branch', 'unprotect_branch', 'update_default_branch',
    'create_tag', 'delete_tag', 'protect_tag', 'unprotect_tag', 'create_commit_status'),
  // projects, groups, settings
  ...gitlab('create_repository', 'fork_repository', 'update_project', 'create_group',
    'create_project_variable', 'update_project_variable', 'delete_project_variable',
    'create_group_variable', 'update_group_variable', 'delete_group_variable',
    'create_webhook', 'update_webhook', 'delete_webhook',
    'create_wiki_page', 'update_wiki_page', 'delete_wiki_page',
    'create_group_wiki_page', 'update_group_wiki_page', 'delete_group_wiki_page',
    'create_snippet', 'update_snippet', 'delete_snippet',
    'update_dependency_proxy_settings', 'purge_dependency_proxy_cache',
    'confirm_vulnerability', 'dismiss_vulnerability'),
  // CI, deployments, environments, releases
  ...gitlab('create_pipeline', 'trigger_pipeline', 'retry_pipeline', 'cancel_pipeline', 'delete_pipeline', 'update_pipeline_metadata',
    'retry_pipeline_job', 'cancel_pipeline_job', 'erase_pipeline_job', 'play_pipeline_job', 'play_pipeline_jobs',
    'create_pipeline_schedule', 'update_pipeline_schedule', 'delete_pipeline_schedule', 'play_pipeline_schedule',
    'take_ownership_pipeline_schedule',
    'create_pipeline_schedule_variable', 'update_pipeline_schedule_variable', 'delete_pipeline_schedule_variable',
    'create_pipeline_trigger', 'update_pipeline_trigger', 'delete_pipeline_trigger',
    'create_deployment', 'update_deployment', 'delete_deployment', 'approve_deployment',
    'update_environment', 'stop_environment', 'stop_stale_environments', 'delete_environment', 'delete_review_app_environments',
    'create_release', 'update_release', 'delete_release', 'create_release_evidence'),
  // a query language that can also mutate
  ...gitlab('execute_graphql'),
];

/**
 * DENIED_TOOLS again, on the GitLab server's side, as GITLAB_DENIED_TOOLS_REGEX:
 * a denied tool is then not listed, not callable, and not re-added by
 * `discover_tools`, whatever the SDK's disallowedTools does. Together with
 * GITLAB_PERMISSION_MODE=modify, which blocks every delete and teardown tool,
 * it covers the whole gitlab half of DENIED_TOOLS.
 *
 * Written by hand rather than joined from the list: the server ignores, with
 * only a log line, a pattern over 200 characters or one with a lookahead, and
 * the joined list is 2,700. So it names verb families — every tool whose name
 * starts with one of these is denied — and spells out the create_/update_
 * names around the three the session keeps (create_merge_request,
 * create_merge_request_note, update_merge_request). types.test.ts checks it
 * against the installed server: it compiles there, it plus modify mode blocks
 * every denied tool, and it takes nothing else.
 */
export const SERVER_DENIED_TOOLS_REGEX =
  '^((un|)approve|bulk|con(firm|vert)|dismiss|edit|execute|fork|m(ark|erge|ove)|p|re(solve|try)|t(ake|rigger)'
  + '|create_([a-ln-z]|mi|merge_request_([tde]|note_))|update_([a-ln-z]|merge_request_))';
