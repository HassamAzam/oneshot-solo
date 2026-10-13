#!/usr/bin/env node
'use strict';
/**
 * PreToolUse on Write: a Write that replaces an existing file with far less
 * than it had is almost always a partial change done as a whole-file rewrite
 * — the Claude Code Insights report for this desk counted one pass that
 * net-deleted ~1,177 lines of actionTypes.js to change a single line, and
 * two sessions redoing that work. Edit is the tool for partial changes; this
 * guard says so at the moment it matters, before the file is gone.
 *
 * Rule: deny when the target exists with >= MIN_LINES lines and the new
 * content has fewer than KEEP of them. Below MIN_LINES, or for a new file,
 * or for Edit/NotebookEdit, it has no opinion.
 */
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const MIN_LINES = 40;
const KEEP = 0.5;

/** Line count as an editor shows it: a trailing newline ends the last line, it does not start one. */
function lines(s) { return s.length ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0; }

try {
  const data = C.readInput();
  if (data.tool_name === 'Write') {
    const input = data.tool_input || {};
    const file = typeof input.file_path === 'string' ? input.file_path : '';
    const content = typeof input.content === 'string' ? input.content : null;
    if (file && content !== null && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const before = lines(fs.readFileSync(file, 'utf8'));
      const after = lines(content);
      if (before >= MIN_LINES && after < before * KEEP) {
        C.event('denied_churn', { file, before, after });
        C.deny(
          `Denied: this Write would replace ${file} (${before} lines) with ${after} lines.\n` +
          'A whole-file Write that drops most of a file is how a one-line change once deleted ' +
          '~1,177 lines. Use Edit for a partial change (old_string → new_string), or, if the ' +
          'file really should shrink this much, delete the lines with Edit in steps so each ' +
          'removal is reviewable in the diff.',
        );
      }
    }
  }
} catch (err) {
  C.logFailure('churn-guard', err);
}

C.allow();
