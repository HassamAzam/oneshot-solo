#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: every write the session may make on GitLab — the MR create and
 * update, the MR note, the upload — is held to this run's project, and the MR
 * itself to this run's branches and the mr-metadata rules.
 *
 *   1. A `project_id`, when the call names one, is this run's project: its
 *      path (ONESHOT_PROJECT_PATH, plain or URL-encoded) or its numeric id
 *      (ONESHOT_PROJECT_ID), both handed over by the conductor. The token the
 *      GitLab server holds reaches every project the operator can; nothing
 *      but this rule and the server's own allowlist stops a note or an MR
 *      landing on another one. With neither variable set the call is allowed
 *      and logged as `mr_gate_no_project` — the server allowlist still holds.
 *   2. A create goes from ONESHOT_BRANCH into the base (config/project.json
 *      branches.base), and an update that sends a target sends the base. An MR
 *      from any other branch is not this run's MR: the conductor never finds
 *      it, and it is left open for a person to close.
 *   3. The title carries no conventional-commit prefix.
 *   4. The description carries a `[closes <url>]` line.
 *
 * WHY 3 AND 4 EXIST WHEN A GATE ALREADY DID. context/scripts/mr_metadata_gate.py
 * enforces exactly that policy and has since before Oneshot had phases. It has
 * never once run here, for two independent reasons: it is wired in
 * context/settings.json, which claudedir deliberately does not link, and it
 * matches `mcp__gitlab-mcp__*` while every tool in this repo is
 * `mcp__gitlab__*`. Either alone would be enough to make it dead. Fixing the
 * wiring would not have been enough, and neither would fixing the names.
 *
 * The regexes are lifted from that script deliberately rather than reinvented,
 * so the two agree by construction for as long as both exist. Collapsing them
 * into one implementation is worth doing and is a bigger question than this
 * hook — it spans two repos with different runtimes.
 *
 * An update validates only the fields it actually sends: an update that does
 * not touch title, description or target has no opinion to check, and
 * blocking it would stop the session adding a label.
 *
 * This is a PreToolUse deny rather than a PostToolUse block because the call is
 * the publication. A wrong title can be edited afterwards; the notification
 * that went to every reviewer cannot.
 */
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const CREATE = 'mcp__gitlab__create_merge_request';
const UPDATE = 'mcp__gitlab__update_merge_request';
/** Every GitLab write the session is allowed; src/ticket/hooks.ts MR_TOOLS matches the same four. */
const GUARDED = new Set([CREATE, UPDATE, 'mcp__gitlab__create_merge_request_note', 'mcp__gitlab__upload_markdown']);

const PREFIX_RE = /^(feat|fix|chore|refactor|test|docs|style|perf|ci|build|revert)(\(.+?\))?!?:\s*/i;
const CLOSES_RE = /\[closes\s+https?:\/\/\S+/i;

/** The server decodes a project_id before using it, so this does too. */
function decoded(v) {
  const s = String(v).trim();
  try { return decodeURIComponent(s); } catch { return s; }
}

/** This run's project, by path (GitLab paths route case-insensitively) or by numeric id. */
function isThisProject(projectId, wantPath, wantId) {
  const got = decoded(projectId);
  return (wantId !== '' && got === wantId) || (wantPath !== '' && got.toLowerCase() === wantPath.toLowerCase());
}

function baseBranch() {
  const cfg = C.loadConfig('project.json');
  return String((cfg && cfg.branches && cfg.branches.base) || 'dev');
}

try {
  const data = C.readInput();
  const tool = data.tool_name || '';
  if (GUARDED.has(tool)) {
    const input = data.tool_input || {};

    const projectId = input.project_id;
    if (projectId !== undefined && projectId !== null && String(projectId).trim() !== '') {
      const wantPath = (process.env.ONESHOT_PROJECT_PATH || '').trim();
      const wantId = (process.env.ONESHOT_PROJECT_ID || '').trim();
      if (!wantPath && !wantId) {
        C.event('mr_gate_no_project', { tool, project_id: String(projectId) });
      } else if (!isThisProject(projectId, wantPath, wantId)) {
        C.event('denied_mr_other_project', { tool, project_id: String(projectId) });
        C.deny(
          `Denied: project_id "${String(projectId).slice(0, 80)}" is not this run's project.\n` +
          `This run works on ${wantPath || `project ${wantId}`}` +
          `${wantPath && wantId ? ` (id ${wantId})` : ''} and writes to GitLab nowhere else — ` +
          'not an MR, not a note, not an upload. Use that project_id (or leave it out). ' +
          'If the ticket genuinely needs a change in another project, say so in `blocked`.',
        );
      }
    }
  }

  if (tool === CREATE || tool === UPDATE) {
    const input = data.tool_input || {};
    const isCreate = tool === CREATE;
    const title = typeof input.title === 'string' ? input.title : null;
    const description = typeof input.description === 'string' ? input.description : null;
    const base = baseBranch();
    const branch = process.env.ONESHOT_BRANCH || '';

    if (isCreate && branch && input.source_branch !== branch) {
      C.event('denied_mr_source_branch', { source_branch: input.source_branch });
      C.deny(
        `Denied: this run's MR goes from its own branch, \`${branch}\` — not ` +
        `\`${String(input.source_branch || '(none)').slice(0, 80)}\`.\n` +
        'An MR from any other branch is not this run\'s: the conductor never finds it, and it ' +
        `is left open for a person to close. Set source_branch to \`${branch}\`.`,
      );
    }
    if (isCreate && !branch) C.event('mr_gate_no_branch', {});
    const sendsTarget = isCreate || input.target_branch !== undefined;
    if (sendsTarget && input.target_branch !== base) {
      C.event('denied_mr_target_branch', { target_branch: input.target_branch });
      C.deny(
        `Denied: this run's MR targets \`${base}\` — not ` +
        `\`${String(input.target_branch || '(none)').slice(0, 80)}\`.\n` +
        `Set target_branch to \`${base}\`, this exact branch, not the project's GitLab default branch.`,
      );
    }

    if (title !== null && PREFIX_RE.test(title.trim())) {
      C.event('denied_mr_title_prefix', { title });
      C.deny(
        `Denied: the MR title starts with a conventional-commit prefix ` +
        `("${title.trim().slice(0, 60)}").\n` +
        'An MR title describes what the change delivers, in plain words a reviewer reads ' +
        'in a list — not what type of commit it was. Drop the prefix and say the thing: ' +
        '"Remove Unused Celery Task for Invoice Reminders", not "chore: remove unused ' +
        'celery task". On a multi-commit branch the last commit is usually misleading; ' +
        'title the branch\'s one deliverable. See the `mr-metadata` skill.',
      );
    }

    // On create the description is mandatory; on update it is only checked when sent.
    const needsCloses = isCreate || description !== null;
    if (needsCloses && !CLOSES_RE.test(description || '')) {
      C.event('denied_mr_no_closes', { hasDescription: description !== null });
      C.deny(
        'Denied: the MR description has no `[closes <ticket_url>]` line.\n' +
        'Every MR closes a ticket, and the link is what lets anyone reading the MR find ' +
        'out why the work happened. Add it on its own line:\n' +
        '  [closes https://gitlab.example.com/group/project/-/issues/412]\n' +
        'Use a ticket this diff actually addresses — never one that merely appeared in ' +
        'the session, and never a URL you have not confirmed exists. If there genuinely ' +
        'is no ticket, say so in `blocked` rather than inventing one. See the ' +
        '`mr-metadata` skill.',
      );
    }
  }
} catch (err) {
  C.logFailure('mr-gate', err);
}

C.allow();
