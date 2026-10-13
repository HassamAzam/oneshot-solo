/**
 * Per-ticket git worktrees, and the three things that make one actually usable.
 *
 * 1. SEED. A fresh worktree has none of the gitignored pieces a checkout needs
 *    to RUN — venv, node_modules, local_settings.py. A phase that cannot run
 *    the app writes code it cannot verify, so those are borrowed from an
 *    already-working repo: heavy read-mostly things symlinked, settings copied
 *    (so a worktree editing its settings does not edit the seed repo's).
 *
 * 2. SKILLS. `.claude/` is composed by ensureClaudeDir() so phases get the
 *    context repo's real, current skills with no vendoring and no sync step,
 *    plus the pipeline skills that live in the Oneshot repo. Note what the
 *    symlinks inside it imply: writes through one land in the context repo,
 *    which is exactly why hooks/write-scope.cjs realpath-resolves before
 *    comparing.
 *
 * 3. EXCLUDE. Those symlinks are untracked files in a real checkout, so they
 *    are written to .git/info/exclude — otherwise every `git status` a phase
 *    runs is noisy and `git add -A` would try to commit them.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureClaudeDir } from './claudedir.js';
import {
  CONTEXT_REPO, WORK_REPO, WT_ROOT, envOr, projectConfig, seedCopies, seedFrom, seedLinks,
} from './config.js';
import { retryRefLockRace } from './gitfetch.js';
import { log } from './log.js';

function git(args: string[], cwd = WORK_REPO): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 120_000,
    // Hygiene, not a load-bearing fix: whatever reads this stderr should read
    // it in one language. "cannot lock ref", the message gitfetch.ts matches
    // on, is NOT translated by git's files backend — run under
    // LC_ALL=fr_FR.UTF-8 it comes back byte-identical English — so nothing
    // today depends on this. It starts mattering the day a conductor runs on a
    // Linux box with the message catalogs installed, or the day these refs move
    // to the reftable backend, where that string IS in the translations.
    env: { ...process.env, LC_ALL: 'C' },
    // stderr is piped, not inherited: `rev-parse --verify` on a branch that
    // does not exist yet is an expected probe, and letting its `fatal:` reach
    // the console makes a normal worktree creation look like a failure.
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export interface Lease {
  worktree: string;
  branch: string;
  /** The base BRANCH the worktree was cut from (project.json branches.base). */
  base: string;
  runId: string;
}

/**
 * PIDs listening on a TCP port — empty when it is free.
 *
 * lsof is the probe: it is already on every macOS box this runs on and it tells
 * a LISTEN apart from a client connection. Any spawn error (no lsof, timeout)
 * returns [] — fail OPEN, because a lease that cannot probe must not refuse
 * every port. The cost of failing open is the bug this guards against; the cost
 * of failing closed is a run that can never lease a port at all.
 */
function portListeners(port: number): number[] {
  try {
    const out = execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split('\n').map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

/**
 * Kill whatever is listening on a run's app port.
 *
 * Called from a run's terminal path: without it the dev server the run started
 * outlives the run, and the next ticket's session drives a stale server and
 * reports on the wrong code. Best-effort and never throws: a port with nothing
 * on it is the normal case.
 *
 * Only the run's own port is reaped, never the shared webpack port.
 */
export function reapPortServer(port: number | null | undefined): number {
  if (!port) return 0;
  let killed = 0;
  for (const pid of portListeners(port)) {
    try { process.kill(pid, 'SIGTERM'); killed += 1; } catch { /* already gone */ }
  }
  if (killed) log.info(`reaped ${killed} process(es) on port ${port}`);
  return killed;
}

/**
 * Copy a seed file by CONTENT, never with copyfile(3).
 *
 * cpSync() and copyFileSync() both go through copyfile(3), which replicates the
 * source's extended attributes. On macOS that is not a metadata nicety, it is a
 * failure mode: a file carrying `com.apple.provenance` — the TCC attribute the
 * OS stamps on files a sandboxed app has touched — cannot have that attribute
 * reproduced by a process without the matching entitlement, and the whole copy
 * fails EPERM. Nothing about the file is unreadable; only the xattr is
 * privileged.
 *
 * It is not fixable from the outside. Stripping the attribute works for exactly
 * as long as it takes something to read the file again, at which point macOS
 * puts it straight back, so any "clean the source once" repair is a repair that
 * un-does itself.
 *
 * Observed as four runs blocked at `recall` with
 * `EPERM: operation not permitted, copyfile '<seed>/frontend/src/constants/config.js'`
 * while hrdb/local_settings.py — same source repo, same process, same instant —
 * copied cleanly, because that one carries com.apple.macl instead. A whole
 * conductor stopped claiming tickets over an xattr on one config file.
 *
 * read + write moves the bytes and lets the destination take whatever
 * attributes the OS wants to give a newly created file, which is all a seeded
 * config was ever supposed to have. The mode is carried across because
 * local_settings.py and config.js are read by the app, not executed, but a seed
 * list is free to grow a script one day.
 */
function copyContents(src: string, dst: string): void {
  writeFileSync(dst, readFileSync(src));
  try { chmodSync(dst, statSync(src).mode & 0o777); } catch { /* mode is a nicety, content is not */ }
}

/**
 * Everything a leased or resumed worktree needs before a phase runs in it.
 *
 * `.claude` is composed FIRST and unconditionally, ahead of the seed-repo
 * check. The two have nothing to do with each other: the seed repo supplies an
 * installed `node_modules` and a venv so the APP can be brought up, while
 * `.claude` supplies the skills, rules and agents every phase reasons with.
 * They were in one function with one early return, so a machine with no seed
 * repo configured ran every phase with whatever `.claude` the work repo
 * happened to commit — the failure this composition exists to prevent, reached
 * by way of an unrelated setting.
 */
export function seedWorktree(worktree: string): void {
  const excluded: string[] = [];
  detachTrackedClaude(worktree);
  excluded.push(...ensureClaudeDir(worktree));

  // The work repo is itself an installed clone, so it is the seed unless
  // ONESHOT_SEED_FROM names another — the same rule projectSessionEnv() hands
  // the session's app.cjs, so both seed from one place.
  const from = seedFrom() || WORK_REPO;
  if (!from || !existsSync(from)) {
    log.warn('no seed repo — the worktree cannot run the app without npm ci / venv setup', {
      fix: 'set WORK_REPO (or ONESHOT_SEED_FROM) to an already-installed clone',
    });
    addExcludes(worktree, excluded);
    return;
  }

  const links = seedLinks();
  const copies = seedCopies();

  /**
   * A missing seed SOURCE is announced, not swallowed.
   *
   * This loop used to `continue` on both conditions together, so a seed entry whose
   * source did not exist produced no symlink and no message. That is exactly how
   * `staticfiles` was absent from every worktree for weeks: each fresh checkout then
   * 500'd on every {% static %} template and the bring-up died as E_DJANGO_DEAD, with
   * nothing anywhere naming the cause. An existing DESTINATION is still silent — that
   * one is the ordinary idempotent case.
   */
  for (const rel of [...links, ...copies]) {
    if (!existsSync(join(from, rel))) {
      log.warn(`seed source ${join(from, rel)} does not exist — ${rel} will be missing from ${worktree}`);
    }
  }

  for (const rel of links) {
    const src = join(from, rel);
    const dst = join(worktree, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst);
    excluded.push(rel);
  }

  for (const rel of copies) {
    const src = join(from, rel);
    const dst = join(worktree, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyContents(src, dst);
    excluded.push(rel);
  }

  addExcludes(worktree, excluded);
}

/**
 * Clear the work repo's own `.claude` out of the worktree, without deleting it.
 *
 * The work repo COMMITS `.claude/`, so `git worktree add` lays down a real
 * directory for every skill, rule and agent before this process gets a say.
 * ensureClaudeDir() then declines to overwrite any of them — relink() treats a
 * real directory as something a human put there — so the copies this repo
 * maintains under SKILLS_ROOT only ever filled the four GAPS, and every name
 * the work repo also ships resolved the work repo's file. That is invisible
 * from outside: the phase invokes the skill, gets an older file, and reports
 * success. It bit `frontend-accessibility`, where the rule about an open dialog
 * hiding the app-wide live region exists only in this repo's copy, and it
 * silently un-did EXCLUDED_SKILLS too, because a real directory is not a
 * symlink and unlinkExcluded() only removes symlinks.
 *
 * `--skip-worktree` rather than a delete: the files stay in the index and in
 * HEAD, so nothing about the branch changes and no deletion can reach a commit
 * or an MR diff. Git simply stops comparing those paths against the working
 * tree, which is what makes removing them invisible to `git status` — the same
 * job .git/info/exclude does for the seeded symlinks, for tracked paths.
 *
 * The whole directory goes rather than the tracked files alone: an emptied
 * `.claude/skills/<name>/` is still a real directory, and relink() would back
 * off from it exactly as before. A lease is a fresh compose either way.
 */
export function detachTrackedClaude(worktree: string): void {
  try {
    const tracked = git(['ls-files', '-z', '--', '.claude'], worktree);
    if (!tracked) return;
    execFileSync('git', ['update-index', '--skip-worktree', '-z', '--stdin'], {
      cwd: worktree, input: tracked, timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    rmSync(join(worktree, '.claude'), { recursive: true, force: true });
  } catch (err) {
    // A phase with the work repo's skills still runs; one with no worktree does
    // not. Warn and leave the checkout as git wrote it.
    log.warn('could not detach the work repo\'s .claude — its skills will shadow ours', {
      worktree, error: (err as Error).message,
    });
  }
}

/**
 * Keep seeded paths out of `git status`.
 *
 * .git/info/exclude rather than .gitignore: it is per-checkout and untracked,
 * so it cannot leak into a commit or an MR diff.
 */
function addExcludes(worktree: string, paths: string[]): void {
  if (!paths.length) return;
  try {
    // `--git-path info/exclude`, never `--git-dir` + join. In a LINKED worktree
    // those are different files: --git-dir is .git/worktrees/<name>/, while the
    // exclude git actually consults lives in the common dir. Oneshot wrote a
    // correct exclude file to the per-worktree path for months and git never
    // read a line of it, so every seeded symlink showed as untracked in the very
    // `git status` this function exists to keep quiet — and sat one `git add -A`
    // away from an MR. --git-path resolves whichever is right for the checkout.
    const resolved = git(['rev-parse', '--git-path', 'info/exclude'], worktree);
    const file = resolved.startsWith('/') ? resolved : join(worktree, resolved);
    mkdirSync(dirname(file), { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const missing = paths.filter((p) => !existing.includes(`\n${p}\n`));
    if (!missing.length) return;
    writeFileSync(file, `${existing}\n# oneshot seeded\n${missing.join('\n')}\n`);
  } catch (err) {
    log.warn('could not write .git/info/exclude', { error: (err as Error).message });
  }
}

/**
 * Give this worktree a committer identity WITHOUT touching the shared config.
 *
 * `git -C <worktree> config user.name` does not write a per-worktree setting —
 * it writes .git/config, the one file every worktree of the repo shares, and
 * concurrent worktree creations serialise on its lock and mostly lose. Two
 * escapes exist and the repository decides which:
 *
 *   extensions.worktreeConfig on  — `config --worktree` writes
 *                                   .git/worktrees/<name>/config, which nobody
 *                                   else has open, so it is safe and it is what
 *                                   the option is for.
 *   otherwise                     — no file is written at all. Identity reaches
 *                                   every commit through GIT_AUTHOR_* /
 *                                   GIT_COMMITTER_* in the phase environment
 *                                   (src/lib/config.ts, BASE_ENV), which git
 *                                   honours ahead of any config and which
 *                                   cannot contend with anything.
 *
 * Enabling the extension from here is deliberately not done: it is a repository
 * -wide change to a repo Oneshot only borrows.
 */
function pinIdentity(worktree: string): void {
  const perWorktree = (() => {
    try { return git(['config', '--bool', 'extensions.worktreeConfig'], worktree) === 'true'; } catch { return false; }
  })();
  if (!perWorktree) return;

  const author = envOr('ONESHOT_GIT_AUTHOR_NAME', 'Oneshot');
  const email = envOr('ONESHOT_GIT_AUTHOR_EMAIL');
  try {
    git(['config', '--worktree', 'user.name', author], worktree);
    if (email) git(['config', '--worktree', 'user.email', email], worktree);
  } catch (err) {
    log.warn('could not write the per-worktree identity — the environment carries it', {
      error: (err as Error).message,
    });
  }
}

/**
 * Create (or re-attach to) the worktree for a ticket.
 *
 * Idempotent: a run resumed after a crash finds its existing worktree and
 * branch and continues in them rather than starting over. The fetch happens
 * only on creation — re-attaching must not move origin/<base> under a run that
 * is already mid-flight.
 *
 * No port: Solo runs one ticket at a time on the fixed ONESHOT_PORT.
 */
export function leaseWorktree(runId: string, branch: string, name: string): Lease {
  const cfg = projectConfig();
  const base = cfg.branches.base;
  mkdirSync(WT_ROOT, { recursive: true });
  const worktree = join(WT_ROOT, name);

  if (!existsSync(worktree)) {
    // Two runs starting together fetch the same base in the same shared repo;
    // the loser of the ref lock is retried rather than blocked — see gitfetch.ts.
    retryRefLockRace(() => git(['fetch', 'origin', base]));
    const branchExists = (() => {
      try { git(['rev-parse', '--verify', `refs/heads/${branch}`]); return true; } catch { return false; }
    })();
    if (branchExists) git(['worktree', 'add', worktree, branch]);
    // --no-track is not about upstreams, it is about the lock. Creating a
    // branch that tracks origin/<base> writes two keys into the SHARED
    // .git/config, and several worktrees being created at the same moment
    // contend for that one file: most of them fail with "could not lock config
    // file" AFTER the local branch has already been created, leaving an orphan
    // branch and no worktree. Nothing here ever pushes to the base or pulls
    // from it — the MR is what moves work — so the tracking entry buys nothing
    // and costs the only serialising write in the whole operation.
    else git(['worktree', 'add', '--no-track', '-b', branch, worktree, `origin/${base}`]);
    log.ok(`worktree ${worktree}`, { branch, base: `origin/${base}` });
  } else {
    log.info(`re-attached to existing worktree ${worktree}`);
  }

  seedWorktree(worktree);
  pinIdentity(worktree);

  return { worktree, branch, base, runId };
}

/**
 * Delete a local branch in WORK_REPO — only ever one whose MR has merged, so
 * nothing is lost. True when the branch is gone afterwards (deleted, or never
 * there); false when git refused, typically because a worktree it could not
 * remove still has it checked out.
 */
export function deleteLocalBranch(branch: string): boolean {
  try { git(['rev-parse', '--verify', `refs/heads/${branch}`]); } catch { return true; }
  try {
    git(['branch', '-D', branch]);
    log.info(`deleted local branch ${branch} (its MR merged)`);
    return true;
  } catch (err) {
    log.warn(`could not delete local branch ${branch}`, { error: (err as Error).message.split('\n')[0] });
    return false;
  }
}

/** Remove the worktree. The BRANCH is deliberately left alone — it is pushed work. */
export function reapWorktree(worktree: string, runId: string): void {
  if (!existsSync(worktree)) return;
  try {
    git(['worktree', 'remove', '--force', worktree]);
    log.ok(`reaped worktree ${worktree}`, { runId });
  } catch (err) {
    log.warn('worktree remove failed — leaving it on disk', { error: (err as Error).message });
  }
}

export function contextRepoPresent(): boolean {
  return existsSync(CONTEXT_REPO);
}
