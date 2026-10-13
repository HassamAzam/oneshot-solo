/**
 * The dev app is the conductor's job to start, not a phase's first task.
 *
 * WHY THIS FILE
 * -------------
 * Bringing this app up costs about two minutes on a cold start and about a second on a
 * reuse, and until now every one of those two minutes was paid by a MODEL, inside a
 * phase's own turn and time budget — `verify` spent roughly half of every session on it
 * and three of six `ui-evidence` sessions died at their turn cap before taking a single
 * screenshot. None of that work needs a model. So the conductor starts it, in the
 * background, at the earliest moment it can: the app compiles during `research`, `plan`
 * and `implement` — two and a half hours of budget that were being spent anyway — and
 * the first phase that actually opens a browser finds it already serving.
 *
 * Nothing here waits. `scripts/app.cjs` is idempotent and holds a per-target lock, so a
 * phase that calls `ensure` itself either gets the finished instance back immediately or
 * waits for the bring-up already in flight. That is the whole handshake: no promise is
 * held across phases, no state is kept in this process, and a conductor restart loses
 * nothing.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DRY_RUN, ROOT } from './config.js';
import { log } from './log.js';

const APP_SCRIPT = join(ROOT, 'scripts', 'app.cjs');

/**
 * Fire and forget, deliberately.
 *
 * Detached with its own log fd and `unref`'d: the bring-up must outlive the tick that
 * started it, and it must not keep the event loop alive if the conductor is shutting
 * down. Failure is a warning, never a throw — an app that did not start is a slower
 * run, not a broken one, and the phase that needs it will report the real error with
 * the harness's own named code.
 */
function spawnApp(args: string[], logName: string, env: Record<string, string>): number | null {
  if (!existsSync(APP_SCRIPT)) {
    log.warn('app       scripts/app.cjs is missing — phases will bring the app up themselves');
    return null;
  }
  try {
    const dir = join(ROOT, 'state', 'apps');
    mkdirSync(dir, { recursive: true });
    const out = openSync(join(dir, logName), 'a');
    const child = spawn(process.execPath, [APP_SCRIPT, ...args], {
      cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...env },
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
 * The app for ONE run, in that run's own leased worktree.
 *
 * `--worktree` is the mode that never moves the checkout's ref: from `implement`
 * onward the worktree carries the run's uncommitted work, and a bring-up that ran
 * `git checkout` there would destroy the thing it exists to serve. `ONESHOT_IID` puts
 * `app-env.json` under `state/runs/<iid>/harness/`, which is inside the write scope of
 * every phase that needs it and exactly where they already look.
 */
export function startRunApp(opts: {
  iid: number; runId: string; worktree: string; port: number;
}): number | null {
  if (DRY_RUN) return null;
  const pid = spawnApp(
    ['ensure', '--worktree', opts.worktree, '--port', String(opts.port)],
    `run-${opts.iid}.log`,
    { ONESHOT_IID: String(opts.iid), ONESHOT_PORT: String(opts.port), ONESHOT_WORKTREE: opts.worktree },
  );
  if (pid) {
    log.info(`app        starting for #${opts.iid} on ${opts.port} in the background ` +
      `(pid ${pid}; state/apps/run-${opts.iid}.log)`);
  }
  return pid;
}
