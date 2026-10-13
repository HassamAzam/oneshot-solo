#!/usr/bin/env node
'use strict';
/**
 * PreToolUse: keep this machine's credential files out of a session — this
 * repo's .env and every .env.* copy of it (setup's .env.bak-<stamp> backups),
 * the desk's GitLab token file (~/.config/oneshot/gitlab-token), glab's
 * config (~/.config/glab-cli/config.yml), the macOS keychain item the token
 * may live in, and Claude Code's own ~/.claude.json.
 *
 * WHAT THIS IS NOT PROTECTING AGAINST. `GITLAB_TOKEN` is not in anything the
 * session starts or inherits. The session environment in src/lib/config.ts is
 * a WHITELIST — PATH, HOME, LANG, ONESHOT_HOME and the identity variables — so
 * `echo $GITLAB_TOKEN` prints an empty line; the app server the conductor
 * starts gets the same whitelist, and scripts/app.cjs strips the token from
 * the Django and webpack it spawns. The token reaches the GitLab MCP server's
 * own subprocess. The skills' "never print GITLAB_TOKEN" rule is already true
 * by construction for the environment.
 *
 * WHAT IT IS. The one path left is the file. `.env` is mode 600 and the session
 * runs as its owner, so `cat`, `grep`, a Read or Grep tool call or a
 * heredoc-free `sed -n` all reach it, and everything a phase prints goes into a
 * transcript that outlives the run. This closes that, and nothing else — a
 * guard that tried to catch every way a secret could be echoed would be a guard
 * nobody could reason about. It is best-effort against a session reaching for
 * the file, not a sandbox: `sudo cat`, `python -c open(...)` and friends are
 * not parsed, which is why the skills still carry "never print GITLAB_TOKEN".
 *
 * The token has other homes, every one of them src/lib/token.ts's sources:
 * ~/.config/oneshot/gitlab-token, the `oneshot-gitlab` keychain item
 * (`security find-generic-password`, denied as a command) and glab's
 * config.yml. ~/.claude.json carries the Claude account's OAuth state and
 * every MCP server's configured env; a session has no reason to read any.
 *
 * Writes are denied too, by redirect as much as by `sed -i`. A blind `>` over
 * one of these blanks the credential and every later session on the machine
 * starts without it; fixing a credential here is an operator's job.
 *
 * Scoped to these files. Under ONESHOT_HOME every `.env.*` but `.env.example`
 * (the tracked list of variable names) is a copy of the secrets; a work repo's
 * .env and .env.* belong to the app the session is there to run, and blocking
 * them would break bringing that app up.
 */
const os = require('node:os');
const path = require('node:path');
const C = require(path.join(__dirname, '_common.cjs'));

C.bailIfNotOneshot();

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Grep']);
const ENV_FILE = path.join(C.ONESHOT, '.env');
const HOME = os.homedir();

/** Every file this guard keeps a session away from, compared realpath to realpath. */
const DENIED = [
  ENV_FILE,
  path.join(HOME, '.config', 'oneshot', 'gitlab-token'),
  path.join(HOME, '.config', 'glab-cli', 'config.yml'),
  path.join(HOME, '.claude.json'),
];
const DENIED_REAL = DENIED.map((f) => C.realish(f));

/**
 * A `.env` variant under ONESHOT_HOME: `.env.<anything>` but `.env.example`, or
 * a glob starting `.env` (`cat .env*` reads the file itself).
 */
function envCopy(target) {
  const base = path.basename(target);
  if (base === '.env.example') return false;
  if (!base.startsWith('.env.') && !(base.startsWith('.env') && /[*?[]/.test(base))) return false;
  return C.isInside(target, C.ONESHOT);
}

/** The denied file `target` resolves to, or '' when it is none of them. */
function deniedFile(target) {
  const i = DENIED_REAL.indexOf(C.realish(target));
  if (i !== -1) return DENIED[i];
  return envCopy(target) ? target : '';
}

/** The keychain item src/lib/token.ts may read the token from: `security [opts] find-generic-password`. */
const KEYCHAIN_READ = /(?:^|[\s;&|(`$/])security\s+(?:-\S+\s+)*find-generic-password\b/;

const denial = (file) =>
  `Denied: ${file} holds this machine's credentials, and everything a session prints ` +
  'lands in a transcript that outlives the run.\n' +
  'Nothing here needs it: the session environment is a whitelist, so the token is not in ' +
  'your environment either — it goes straight to the GitLab MCP server, which is how the ' +
  'mcp__gitlab__* tools are already authenticated for you. Use those tools.\n' +
  'Writing it is denied for the same reason: a credential in this file that is missing, ' +
  'wrong or expired is a human fix, not a session\'s.\n' +
  'If something genuinely cannot proceed without a credential, report that in `blocked` ' +
  '(the variable and what it should be, never its value); ' +
  'an operator resolves it, not you.';

/**
 * A candidate path is any word naming `.env` (with or without a suffix), a
 * token file, ~/.claude.json or a config.yml. Whether it is a denied file is
 * decided after expansion and resolution, by deniedFile() — so `.env.example`
 * and a work repo's `.env.local` are candidates that come back clean.
 */
const CANDIDATE = /(?:^|[\s'"<>|])([^\s'"<>|]*(?:\.env|gitlab-token|\.claude\.json|config\.yml)[^\s'"<>|]*)(?=$|[\s'"<>|])/g;
const READER = /^\s*(cat|bat|less|more|head|tail|grep|egrep|rg|awk|sed|cut|sort|strings|xxd|od|open|cp|scp|rsync|source|\.)\b/;
const WRITER = /^\s*(tee|dd|truncate|mv|ln|install)\b/;

/** Expand what the shell would: `~`, $HOME and $ONESHOT_HOME, braced or not. */
function expand(candidate) {
  return candidate
    .replace(/^[A-Za-z_]+=/, '') // dd's of=/if=
    .replace(/^~(?=\/|$)/, HOME)
    .replace(/\$(?:\{HOME\}|HOME(?![A-Za-z0-9_]))/g, HOME)
    .replace(/\$(?:\{ONESHOT_HOME\}|ONESHOT_HOME(?![A-Za-z0-9_]))/g, C.ONESHOT);
}

/** Split a command line on the separators a shell treats as a new command. */
function segments(command) {
  return command.split(/(?:\|\||&&|[;|\n])/g).map((s) => s.trim()).filter(Boolean);
}

try {
  const data = C.readInput();
  const tool = data.tool_name || '';
  const input = data.tool_input || {};

  if (READ_TOOLS.has(tool)) {
    const target = expand(input.file_path || input.notebook_path || input.path || '');
    const file = target && deniedFile(target);
    if (file) {
      C.event('denied_secret_read', { tool, target });
      C.deny(denial(file));
    }
  }

  if (tool === 'Bash' && typeof input.command === 'string') {
    if (KEYCHAIN_READ.test(input.command)) {
      C.event('denied_secret_keychain', { command: input.command.slice(0, 120) });
      C.deny(denial('the macOS keychain (`security find-generic-password`)'));
    }

    // Resolve against the session's cwd rather than matching the string, so a
    // bare `cat .env` is judged by where it would actually land: this repo's
    // file is denied, the work repo's is the app's own business.
    const cwd = data.cwd || process.env.ONESHOT_WORKTREE || C.ONESHOT;

    for (const segment of segments(input.command)) {
      // A bare mention is not a read. `grep -rn GITLAB_TOKEN src/` is a
      // legitimate thing for a session to do; it is the path that matters, and
      // only when the segment reads or writes it — by command or by redirect.
      const verb = READER.test(segment) || WRITER.test(segment);
      for (const m of segment.matchAll(CANDIDATE)) {
        const before = segment.slice(0, m.index + m[0].length - m[1].length);
        if (!verb && !/[<>]\s*['"]?$/.test(before)) continue;
        const candidate = expand(m[1]);
        const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
        const file = deniedFile(resolved);
        if (file) {
          C.event('denied_secret_bash', { segment: segment.slice(0, 120) });
          C.deny(denial(file));
        }
      }
    }
  }
} catch (err) {
  C.logFailure('secret-guard', err);
}

C.allow();
