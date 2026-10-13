/**
 * The dev app is the conductor's job to start, not the session's first task.
 *
 * WHY THIS FILE
 * -------------
 * Bringing this app up costs about two minutes on a cold start and about a second on a
 * reuse, and none of that work needs a model — paid inside a session it is turns and
 * wall clock spent waiting. So the conductor starts it, in the background, the moment the
 * worktree is leased: the app compiles while the session brainstorms, plans and
 * implements, and by the time the session first opens a browser it is already serving.
 *
 * Nothing here waits. `scripts/app.cjs` is idempotent and holds a per-target lock, so a
 * session that calls `ensure` itself either gets the finished instance back immediately
 * or waits for the bring-up already in flight. That is the whole handshake: no promise is
 * held, no state is kept in this process, and a conductor restart loses nothing.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_ENV, DRY_RUN, ROOT, projectSessionEnv } from './config.js';
import { log } from './log.js';

const APP_SCRIPT = join(ROOT, 'scripts', 'app.cjs');

/**
 * Fire and forget, deliberately.
 *
 * Detached with its own log fd and `unref`'d: the bring-up must outlive the tick that
 * started it, and it must not keep the event loop alive if the conductor is shutting
 * down. Failure is a warning, never a throw — an app that did not start is a slower
 * run, not a broken one, and the session that needs it will report the real error with
 * the harness's own named code.
 */
function spawnApp(args: string[], logName: string, env: Record<string, string>): number | null {
  if (!existsSync(APP_SCRIPT)) {
    log.warn('app       scripts/app.cjs is missing — the session will bring the app up itself');
    return null;
  }
  try {
    const dir = join(ROOT, 'state', 'apps');
    mkdirSync(dir, { recursive: true });
    const out = openSync(join(dir, logName), 'a');
    const child = spawn(process.execPath, [APP_SCRIPT, ...args], {
      cwd: ROOT, detached: true, stdio: ['ignore', out, out], env,
    });
    // The child holds its own dup of this fd for stdout/stderr; the parent's copy is done
    // the moment spawn returns. A long-lived conductor calls this on every run, so not
    // closing it here leaks one fd per bring-up.
    closeSync(out);
    child.unref();
    return child.pid ?? null;
  } catch (err) {
    log.warn('app       could not start the bring-up', { error: (err as Error).message });
    return null;
  }
}

/**
 * The bring-up's environment: what a session's own `app.cjs ensure` gets — the BASE_ENV
 * allowlist and the project as the conductor resolved it (spec §5.2: app.cjs reads env
 * only) — plus the run's three keys. Never the conductor's process.env, which holds the
 * GitLab token dotenv loaded; the Django and webpack this starts are long-lived, run
 * code the session edits, and inherit whatever app.cjs was given. No Claude Code
 * credential either: an app has no use for one.
 */
export function runAppEnv(opts: { iid: number; worktree: string; port: number }): Record<string, string> {
  const env: Record<string, string> = { ...BASE_ENV, ...projectSessionEnv() };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_')) delete env[k];
  return { ...env, ONESHOT_IID: String(opts.iid), ONESHOT_PORT: String(opts.port), ONESHOT_WORKTREE: opts.worktree };
}

/**
 * The app for ONE run, in that run's own leased worktree.
 *
 * `--worktree` is the mode that never moves the checkout's ref: once the session starts
 * implementing, the worktree carries the run's uncommitted work, and a bring-up that ran
 * `git checkout` there would destroy the thing it exists to serve. `ONESHOT_IID` puts
 * `app-env.json` under `state/runs/<iid>/harness/` — outside the session's write scopes
 * (worktree + artifacts), which is fine: app.cjs writes it from its own process.
 */
export function startRunApp(opts: {
  iid: number; runId: string; worktree: string; port: number;
}): number | null {
  if (DRY_RUN) return null;
  const pid = spawnApp(
    ['ensure', '--worktree', opts.worktree, '--port', String(opts.port)],
    `run-${opts.iid}.log`,
    runAppEnv(opts),
  );
  if (pid) {
    log.info(`app        starting for #${opts.iid} on ${opts.port} in the background ` +
      `(pid ${pid}; state/apps/run-${opts.iid}.log)`);
  }
  return pid;
}
