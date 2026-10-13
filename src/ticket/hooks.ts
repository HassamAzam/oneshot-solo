/**
 * Guardrail hooks for the ticket session, passed to the SDK in-process instead
 * of installed into ~/.claude/settings.json.
 *
 * In-process because `settingSources: ['user']` would drag in the operator's
 * whole personal config (a `statusLine: npx …` once hung every session before
 * its first turn), and because guards that travel with the repo protect a
 * fresh clone with no install step. Sessions load `settingSources: ['project']`
 * only; these hooks are the guard layer.
 *
 * The callbacks shell out to the SAME hooks/*.cjs files rather than
 * reimplementing the policy in TypeScript. One implementation, one test suite
 * (scripts/verify-hooks.sh), no chance of the two drifting apart — which for a
 * security guard is the failure that matters.
 *
 * Two sets are registered:
 *   - the five CORE guards in hooks/, always, because the session holds Bash,
 *     the write tools and the MR tools for hours under bypassPermissions;
 *   - a project PACK, hooks/packs/<name>/, named by config/project.json
 *     `hookPack` and described by that directory's pack.json manifest.
 *
 * A guard child gets guardEnv(): PATH, HOME, CONTEXT_REPO and ONESHOT_* only —
 * never the conductor's full environment, which can hold the GitLab token and
 * Anthropic credentials a guard has no use for.
 *
 * Every guard fails OPEN — timeout, spawn error, non-JSON — because a broken
 * guard must never wedge a session. FAIL_CLOSED is the escape hatch for a guard
 * whose promise is the opposite, and it is EMPTY. It is kept because the
 * asymmetry is the load-bearing part: a guard standing between a session and an
 * irreversible action must deny when it cannot run, and that belongs in one
 * place rather than being rediscovered by whoever adds the next one.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, envOr, projectConfig } from '../lib/config.js';
import { log } from '../lib/log.js';

type HookOutput = Record<string, unknown>;

const NODE = envOr('ONESHOT_NODE', process.execPath);

/**
 * The kill timeout for a guard that does not carry its own: every core guard.
 *
 * Deliberately short: a guard stands between the session and its next turn,
 * so every millisecond is paid on every tool call. A pack guard that needs
 * longer says so in its pack.json `timeoutMs` (py-lint's 60 s lives there,
 * beside the hook that needs it, so there is one table of timeouts and not two
 * that can drift).
 */
const HOOK_TIMEOUT_MS = 15_000;

/** Guards that must DENY rather than allow when they cannot run. */
const FAIL_CLOSED = new Set<string>();

/** The .cjs deny shape, mirrored exactly so a model reads one contract. */
function denyPayload(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function guardFailure(label: string, why: string): HookOutput {
  log.warn(`guard ${label} did not run`, { why });
  if (!FAIL_CLOSED.has(label)) return {};
  return denyPayload(
    `Denied: the ${label} guard could not run (${why}), and it fails closed. ` +
    'Report this in `blocked` — an operator has to fix the guard, and no retry of yours ' +
    'will change the answer.',
  );
}

/**
 * The environment a guard child runs with: PATH, HOME, CONTEXT_REPO and every
 * ONESHOT_* — from the conductor's own environment, overlaid by `env` (the
 * session's identity, which wins). Nothing else: no GitLab token, no Anthropic
 * key, no CLAUDE_CODE_USE_*.
 */
export function guardEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v === undefined) continue;
    if (k === 'PATH' || k === 'HOME' || k === 'CONTEXT_REPO' || k.startsWith('ONESHOT_')) out[k] = v;
  }
  return out;
}

/**
 * Run one .cjs guard at `absPath` with the hook payload on stdin. `label` names
 * it in logs and in FAIL_CLOSED.
 *
 * Fail-open by default, matching the .cjs contract; fail-closed for the labels
 * in FAIL_CLOSED. Either way the failure is logged loudly — a guard that is
 * silently not running is worse than one that is loudly broken.
 */
function runGuard(
  absPath: string, label: string, input: unknown, env: Record<string, string>,
  timeoutMs: number = HOOK_TIMEOUT_MS,
): Promise<HookOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (out: HookOutput) => { if (!settled) { settled = true; resolve(out); } };

    // A missing guard file surfaces as a spawn error, which used to be
    // indistinguishable from a guard that ran and allowed.
    if (!existsSync(absPath)) {
      return done(guardFailure(label, 'the script is missing'));
    }

    const child = spawn(NODE, [absPath], {
      env: guardEnv(env),
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      done(guardFailure(label, 'it timed out'));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.on('error', (err) => {
      clearTimeout(killer);
      done(guardFailure(label, `it failed to spawn: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (!stdout.trim()) {
        // The .cjs contract is exit-0-always, so a non-zero exit means the
        // process died before it reached its own allow().
        if (code !== 0) return done(guardFailure(label, `it exited ${code}`));
        return done({});                            // empty stdout = allow
      }
      try {
        done(JSON.parse(stdout) as HookOutput);
      } catch {
        done(guardFailure(label, 'it emitted non-JSON'));
      }
    });

    try {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch { /* the close handler still resolves */ }
    return undefined;
  });
}

/** One entry of hooks/packs/<name>/pack.json. */
export interface PackHook { script: string; event: 'PreToolUse' | 'PostToolUse' | 'SessionStart'; matcher?: string; timeoutMs: number }

/** Read a pack's manifest. Throws when the pack has none: a named pack that cannot load is a config fault, not "no pack". */
export function packManifest(name: string): PackHook[] {
  const file = join(ROOT, 'hooks', 'packs', name, 'pack.json');
  if (!existsSync(file)) throw new Error(`hook pack '${name}' has no manifest at ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as PackHook[];
}

/** Tool-name matchers for the core guards. */
const WRITE_TOOLS = '^(Write|Edit|NotebookEdit)$';
const BASH = '^Bash$';
const MR_TOOLS = '^mcp__gitlab__(create|update)_merge_request$';
const READ_OR_BASH = '^(Read|NotebookRead|Grep|Bash)$';

/**
 * Build the SDK `hooks` option for one session.
 *
 * `env` carries the identity the guards read (ONESHOT_PHASE=ticket,
 * ONESHOT_WRITE_SCOPES, ONESHOT_WORKTREE, ONESHOT_BRANCH, ONESHOT_TICKET_LABELS,
 * …). `opts.pack` overrides config/project.json `hookPack`; `null` means core
 * only.
 */
export function hooksFor(env: Record<string, string>, opts: { pack?: string | null } = {}): Record<string, unknown[]> {
  const pack = opts.pack === undefined ? (projectConfig().hookPack ?? null) : opts.pack;
  const core = (script: string) => async (input: unknown) => runGuard(join(ROOT, 'hooks', script), script, input, env);
  const out: Record<string, Array<{ matcher?: string; hooks: unknown[]; timeout: number }>> = {
    PreToolUse: [
      // pause-check first and unmatched: the brake has to see every call.
      { hooks: [core('pause-check.cjs')], timeout: 15 },
      { matcher: WRITE_TOOLS, hooks: [core('write-scope.cjs')], timeout: 15 },
      { matcher: BASH, hooks: [core('git-guard.cjs')], timeout: 20 },
      { matcher: MR_TOOLS, hooks: [core('mr-gate.cjs')], timeout: 15 },
      { matcher: READ_OR_BASH, hooks: [core('secret-guard.cjs')], timeout: 15 },
    ],
  };
  if (pack) {
    for (const h of packManifest(pack)) {
      const fn = async (input: unknown) => runGuard(join(ROOT, 'hooks', 'packs', pack, h.script), h.script, input, env, h.timeoutMs);
      (out[h.event] ??= []).push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [fn], timeout: Math.ceil(h.timeoutMs / 1000) });
    }
  }
  return out;
}
