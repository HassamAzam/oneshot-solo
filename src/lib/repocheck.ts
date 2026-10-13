/**
 * Is this machine actually pointed at the project GITLAB_REPO_URL names?
 *
 * The URL is the single source of truth for WHICH project, but two things on a
 * machine can still quietly disagree with it, and both are left over from
 * before it existed:
 *
 *   - a legacy selector line (ONESHOT_PROJECT and friends) still in .env. It
 *     selects nothing now, and a person reading .env would reasonably believe
 *     it does — so a disagreeing one refuses boot rather than being ignored.
 *
 *   - a WORK_REPO that is a clone of some other project. A plain WORK_REPO
 *     beats the derived default like any env var, so a line from the project
 *     this machine used to work on would cut every worktree from the wrong
 *     code while the tickets, labels and MRs went to the right project. The
 *     origin remote is the only fact on disk that says which project a
 *     checkout is, so it is compared, and a mismatch refuses boot. The same
 *     goes for ONESHOT_SEED_FROM when it is a different directory: at boot the
 *     conductor warms an app worktree cut from the seed, scripts/app.cjs
 *     fetches MR refs in it, and every run worktree links its node_modules and
 *     venv — a seed from another project serves that project's code.
 *
 * Boot (src/index.ts) and `npm run doctor` both call identityFindings() and
 * checkoutFindings(), so the two cannot disagree about what is wrong. The git
 * call (which follows a local clone to its own origin) is isolated in
 * readOrigin() and the decision in judgeOrigin() is pure, which is what the
 * tests exercise. Each consumer passes the findings through
 * relaxRepoChecks() before refusing on them, so ONESHOT_SKIP_REPO_CHECK turns
 * the same FAILs into WARNs everywhere, scripts/app.cjs included.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  REPO_URL_VAR, judgeOrigin as judgeOriginCjs, legacySelectors, originProject,
  readOrigin as readOriginCjs, redactUrl, relaxRepoChecks as relaxRepoChecksCjs,
  repoCheckOverrideNotice as overrideNoticeCjs, repoFromEnv,
  type Finding, type OriginProject, type OriginRead, type OriginSubject, type ResolvedPath,
} from './repourl.cjs';

export type { Finding } from './repourl.cjs';

/** repourl.cjs relaxRepoChecks() over this process's environment by default. */
export function relaxRepoChecks(findings: Finding[], env: NodeJS.ProcessEnv = process.env): Finding[] {
  return relaxRepoChecksCjs(findings, env);
}

/** The standing ONESHOT_SKIP_REPO_CHECK reminder, or null when the override is off. */
export function repoCheckOverrideNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  return overrideNoticeCjs(env);
}

/**
 * GITLAB_REPO_URL itself, then every legacy selector still set, from `env`.
 *
 * A missing URL is reported together with the legacy lines that are set,
 * because on a machine upgrading from the old overlay those lines are exactly
 * the information the person needs to write the one line that replaces them.
 */
export function identityFindings(env: NodeJS.ProcessEnv = process.env): Finding[] {
  const { repo, error } = repoFromEnv(env);
  const legacy = legacySelectors(env, repo);
  const out: Finding[] = [];

  if (!repo) {
    const stale = legacy.map((l) => `${l.key}=${l.value}`).join(', ');
    out.push({
      level: 'fail',
      label: REPO_URL_VAR,
      detail: (error ?? `${REPO_URL_VAR} is not set`)
        + (stale ? ` (${stale} ${legacy.length === 1 ? 'is set but selects' : 'are set but select'} nothing any more)` : ''),
    });
    return out;
  }

  out.push({
    level: 'pass',
    label: REPO_URL_VAR,
    detail: `${redactUrl(repo.url)} -> ${repo.project} on ${repo.host} (target '${repo.name}')`,
  });
  for (const l of legacy) {
    if (l.conflict) {
      out.push({
        level: 'fail',
        label: `${l.key} conflicts with ${REPO_URL_VAR}`,
        detail: `${l.key}=${l.value} but ${REPO_URL_VAR}=${redactUrl(repo.url)} gives ${l.derived}. `
          + `${l.key} selects nothing any more — delete that line from .env; `
          + `${REPO_URL_VAR} alone says which project.`,
      });
    } else {
      out.push({
        level: 'warn',
        label: `${l.key} is redundant`,
        detail: l.derived === null
          ? `${l.key}=${l.value} selects nothing any more (the numeric id is asked of GitLab) — remove it from .env`
          : `${l.key}=${l.value} matches ${REPO_URL_VAR} and selects nothing any more — remove it from .env`,
      });
    }
  }
  return out;
}

export type { OriginProject, OriginRead, OriginSubject } from './repourl.cjs';

/**
 * The git call — `git remote get-url` for origin's fetch and push URLs,
 * following a local clone to its own origin (repourl.cjs has the rules) —
 * shared with scripts/app.cjs, so the two runtimes read a remote the same way.
 * Kept apart from the judgement so the judgement is testable.
 */
export function readOrigin(dir: string): OriginRead {
  return readOriginCjs(dir);
}

/**
 * Judge a checkout's origin against GITLAB_REPO_URL. Pure, and the same
 * function scripts/app.cjs refuses with (repourl.cjs).
 *
 * A proven mismatch — another project path — fails. Anything that cannot be
 * judged — no origin, not a git repository, git missing, a local-path origin
 * whose chain never reaches a GitLab URL, or the same path on another host —
 * only warns: it proves nothing either way, and a check that crashed or refused boot on an
 * unreadable remote would be blocking on its own blind spot rather than on the
 * danger it exists for. `subject` may be just the label; passing where the
 * path came from (`from`, a pathSources() entry) makes the fix-it text name
 * the line that actually has to change.
 */
export function judgeOrigin(subject: string | OriginSubject, repoUrl: string, read: OriginRead): Finding {
  return judgeOriginCjs(typeof subject === 'string' ? { label: subject } : subject, repoUrl, read);
}

/**
 * judgeOrigin() for `dir`, or null when there is nothing to judge: no usable
 * GITLAB_REPO_URL (reported on its own) or no directory (reported by the
 * caller's own existence check, which knows what to tell the person to set).
 */
export function originFinding(
  subject: string | Omit<OriginSubject, 'dir'>, dir: string, env: NodeJS.ProcessEnv = process.env,
  read: (d: string) => OriginRead = readOrigin,
): Finding | null {
  const { repo } = repoFromEnv(env);
  if (!repo || !dir || !existsSync(dir)) return null;
  const s = typeof subject === 'string' ? { label: subject } : subject;
  return judgeOrigin({ ...s, dir }, repo.url, read(dir));
}

/**
 * The origin findings for this machine's clones of the project: WORK_REPO,
 * then the seed when it is a directory of its own (an unset seed is seeding
 * off, and a seed that IS WORK_REPO has just been judged). Boot and doctor
 * both call this, so neither can skip the seed the other checks.
 */
export function checkoutFindings(
  p: { workRepo: string; seed: string; sources: Record<'WORK_REPO' | 'ONESHOT_SEED_FROM', ResolvedPath> },
  env: NodeJS.ProcessEnv = process.env, read: (d: string) => OriginRead = readOrigin,
): Finding[] {
  const out: Array<Finding | null> = [
    originFinding({ label: 'WORK_REPO', from: p.sources.WORK_REPO }, p.workRepo, env, read),
  ];
  if (p.seed && p.seed !== p.workRepo) {
    out.push(originFinding({ label: 'ONESHOT_SEED_FROM', from: p.sources.ONESHOT_SEED_FROM }, p.seed, env, read));
  }
  return out.filter((f): f is Finding => f !== null);
}

/** Where people keep checkouts, under the home directory; '' is home itself. */
const CHECKOUT_BASES = ['Documents', 'Desktop', 'code', 'work', 'repos', 'projects', 'src', ''];

/**
 * A checkout of `repoUrl`'s project on this machine, or '' when none is found.
 *
 * Exists so a missing WORK_REPO can be answered with the path the person
 * actually has, not only with advice to clone into the one they were told to
 * type. Matched by ORIGIN, never by directory name: a folder called `erp` that
 * is a clone of `erp-mobile` is not the project, and the layouts people really
 * use (~/Desktop/workstream-repo/erp) are not guessable from the name. Looks
 * for `<base>/<name>` and one level deeper, `<base>/<any>/<name>`, which covers
 * every layout seen so far without walking the whole home directory.
 */
export function findCheckout(
  repoUrl: string, name: string, home: string = homedir(), read: (d: string) => OriginRead = readOrigin,
): string {
  if (!repoUrl || !name) return '';
  const isClone = (dir: string): boolean =>
    existsSync(join(dir, '.git')) && checkoutProject(dir, repoUrl, read).kind === 'same';
  for (const b of CHECKOUT_BASES) {
    const base = b ? join(home, b) : home;
    if (!existsSync(base)) continue;
    if (isClone(join(base, name))) return join(base, name);
    let entries: string[] = [];
    try { entries = readdirSync(base); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const nested = join(base, entry, name);
      if (isClone(nested)) return nested;
    }
  }
  return '';
}

/**
 * Which project the checkout at `dir` is: originProject() of what its origin
 * says. A worktree answers with its clone's remotes, which it shares — so any
 * clone of this project, not only WORK_REPO, answers 'same'. 'unknown' when
 * there is no directory, or no GITLAB_REPO_URL to compare with.
 */
export function checkoutProject(
  dir: string | undefined, repoUrl: string | undefined, read: (d: string) => OriginRead = readOrigin,
): OriginProject {
  if (!dir || !repoUrl || !existsSync(dir)) return { kind: 'unknown' };
  return originProject(repoUrl, read(dir));
}
