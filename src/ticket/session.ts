/**
 * The one session: a single Agent SDK `query()` that ships the ticket.
 *
 * Lifted from oneshot's `runPhase` (src/conductor/phase.ts at 49899db) and
 * trimmed to one phase. What stays is the machinery that keeps an unattended
 * session honest: the hard deadline, the idle-stream watchdog, the
 * force-settle after any abort, the first-result-frame-settles rule, the
 * rate-limit short-circuit that parks for quota, and the `[ACTION REQUIRED]`
 * check on the CLI's stderr. Every SDK frame is teed to
 * state/runs/<iid>/transcripts/ticket-lap<n>.jsonl with a timestamp.
 *
 * Structured output is enforced by the SDK (`outputFormat: json_schema`), not
 * requested in a prompt: the session physically cannot end with prose where
 * the conductor expects `TicketResult`.
 *
 * This module records nothing in run.json — run.ts calls recordPhase with what
 * this returns.
 */
import { query, type McpStdioServerConfig, type Options } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BASE_ENV, DRY_RUN, ROOT, artifactDir, envOr, gitlabRepo, projectSessionEnv,
  sessionCaps, sessionModel, superpowersPath,
} from '../lib/config.js';
import { phaseEnv } from '../lib/ids.js';
import { transcriptPath } from '../lib/journal.js';
import { looksLikeUsageLimit, parkForQuota } from '../lib/quota.js';
import { accountActionRequired } from '../lib/accountgate.js';
import { resolveToken } from '../lib/token.js';
import { log } from '../lib/log.js';
import type { Ticket } from '../lib/ticket.js';
import { DENIED_TOOLS, RESULT_SCHEMA, parseTicketResult, type TicketResult } from './types.js';
import { hooksFor } from './hooks.js';
import { systemAppend, ticketPrompt, type PromptContext } from './prompt.js';

export interface SessionInput {
  iid: number; runId: string; lap: number; ticket: Ticket; worktree: string; branch: string; port: number;
  /** The previous attempt's session id: this attempt continues that conversation. */
  resume?: string;
  previousAttempt: boolean;
  /**
   * External cancellation, kept from runPhase. An abort through it is the
   * conductor withdrawing the session, which reports `aborted` — never a
   * timeout, never a verdict about the work.
   */
  signal?: AbortSignal;
}

export interface SessionOutput {
  status: 'ok' | 'failed' | 'infra' | 'parked' | 'aborted';
  result: TicketResult | null; resultSubtype?: string; error?: string;
  turns: number; sessionId?: string; durationMs?: number; apiDurationMs?: number; costUsd?: number; modelUsage?: Record<string, unknown>;
  sawActivity: number; stderrTail: string;
}

/** What runSession hands queryOptions: the session env and the abort/stderr plumbing. */
export interface SessionIO {
  env: Record<string, string>;
  abortController: AbortController;
  stderr: (data: string) => void;
  /** Appended to the system prompt; defaults to the ONESHOT_SUPERPOWERS_INJECT intro. */
  superpowersIntro?: string;
}

/** The error text of a session that settled `success` without the structured output its schema asked for. */
export const NO_STRUCTURED_OUTPUT = 'session produced no structured output despite a schema';

/** The error text of a session the caller's signal withdrew. */
export const CANCELLED_BY_CONDUCTOR = 'cancelled by the conductor';

/** A session killed by a signal — never a verdict about the work. */
const SIGNAL_DEATH_RE = /terminated by signal|SIGKILL|SIGTERM|SIGSEGV/i;

/**
 * How often a long session says it is still alive. A session is otherwise
 * silent for up to its whole timeout, which leaves no way to tell "working"
 * from "wedged" without reading the raw transcript.
 */
const PROGRESS_EVERY_MS = 60_000;

/**
 * After ANY abort, how long the stream gets to unwind before the session is
 * force-settled. A wedged CLI ignores ac.abort() — a hung MCP call, a child
 * that never returns — and the consume loop then never advances (observed
 * live: a session sat wedged 4h past its own timeout). The abandoned
 * subprocess is reaped separately; the invariant is that the conductor always
 * gets its session back.
 */
const FORCE_SETTLE_MS = 30_000;

/**
 * No stream frame for this long means the session is stalled, not slow.
 *
 * Observed live: a stream went silent mid-response — one ESTABLISHED socket,
 * 0% CPU, the API answering fresh requests in 0.1s — and the session waited out
 * its whole wall clock for a reply that was never coming. The only legitimate
 * frameless stretch is a single tool call in flight, and the CLI caps a Bash
 * call at 10 minutes, so 15 is past any real one. ONESHOT_IDLE_MIN overrides
 * it; 0 disables the check.
 */
const IDLE_STALL_MS = Math.max(0, sessionCaps().idleMin) * 60_000;
const IDLE_CHECK_MS = 30_000;

/**
 * The CLI's stderr is kept so an account-action exit can be recognised after
 * the fact. Bounded at BOTH ends: the notice is printed first, so the head is
 * where it normally lands, but startup chatter can run to tens of kilobytes
 * and push it out of a tail-only buffer.
 */
const STDERR_KEEP = 8_000;

/**
 * The superpowers intro, read once at load, for when the plugin's own
 * SessionStart hook does not fire under the SDK (doctor's probe says so).
 * ONESHOT_SUPERPOWERS_INJECT=1 appends it to the system prompt instead, wrapped
 * exactly as the plugin's hooks/session-start wraps it.
 */
const SUPERPOWERS_INTRO: string | undefined = (() => {
  if (envOr('ONESHOT_SUPERPOWERS_INJECT') !== '1') return undefined;
  const sp = superpowersPath();
  if (!sp) return undefined;
  try {
    const text = readFileSync(join(sp, 'skills', 'using-superpowers', 'SKILL.md'), 'utf8').replace(/\n+$/, '');
    return '<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n'
      + "**Below is the full content of your 'superpowers:using-superpowers' skill - your introduction to using skills. "
      + "For all other skills, use the 'Skill' tool:**\n\n"
      + `${text}\n</EXTREMELY_IMPORTANT>`;
  } catch (err) {
    log.warn('ONESHOT_SUPERPOWERS_INJECT is set but using-superpowers/SKILL.md is unreadable', { error: (err as Error).message });
    return undefined;
  }
})();

/**
 * The session's environment: the BASE_ENV allowlist, the project as the
 * conductor resolved it, and the identity every guard hook reads.
 * ONESHOT_PHASE is the constant 'ticket' — hooks/_common.cjs exits 0 without
 * it, so leaving it out silently disables every guard. No GitLab token: that
 * reaches only the MCP server (sessionMcpServers).
 */
export function sessionEnv(input: SessionInput): Record<string, string> {
  return {
    ...BASE_ENV,
    ...projectSessionEnv(),
    ...phaseEnv(
      { runId: input.runId, ticket: input.iid, phase: 'ticket', lap: input.lap },
      { worktree: input.worktree, writeScopes: [input.worktree, artifactDir(input.iid)], port: input.port, branch: input.branch },
    ),
    ONESHOT_ARTIFACTS: artifactDir(input.iid),
    ONESHOT_TICKET_LABELS: input.ticket.labels.join(','),
    // Playwright lives in THIS repo's node_modules; the worktree's resolves
    // into the seed, which does not carry it. NODE_PATH is Node's fallback.
    NODE_PATH: join(ROOT, 'node_modules'),
    // git-guard denies every push under a dry run, but only if it is told.
    ...(DRY_RUN ? { ONESHOT_DRY_RUN: '1' } : {}),
    ...(envOr('ONESHOT_TEST_LOGIN') ? { ONESHOT_TEST_LOGIN: envOr('ONESHOT_TEST_LOGIN') } : {}),
    ...(envOr('ONESHOT_GIT_AUTHOR_NAME') ? { GIT_AUTHOR_NAME: envOr('ONESHOT_GIT_AUTHOR_NAME'), GIT_COMMITTER_NAME: envOr('ONESHOT_GIT_AUTHOR_NAME') } : {}),
    ...(envOr('ONESHOT_GIT_AUTHOR_EMAIL') ? { GIT_AUTHOR_EMAIL: envOr('ONESHOT_GIT_AUTHOR_EMAIL'), GIT_COMMITTER_EMAIL: envOr('ONESHOT_GIT_AUTHOR_EMAIL') } : {}),
  };
}

/**
 * The GitLab MCP server, started from THIS repo's node_modules through
 * scripts/mcp-gitlab.cjs, which runs it with $ONESHOT_ARTIFACTS as its cwd so
 * upload_markdown can take `screens/01-before.png`.
 *
 * Never `npx`: npx re-resolves against the registry on every spawn, and npm
 * traffic is blocked while the VPN GitLab needs is up — the server never
 * started and the session burned its whole timeout at zero turns.
 *
 * The key is `gitlab` because DENIED_TOOLS and hooks/mr-gate.cjs match
 * `mcp__gitlab__*`. BASE_ENV first, and it is load-bearing: this env REPLACES
 * the subprocess environment, and without PATH and HOME the server died at
 * spawn while the SDK still reported it `connected`. GITLAB_TOOLS adds the two
 * MR write tools the default toolset leaves out. No token, no server: one that
 * cannot authenticate would only exit at spawn.
 */
export function sessionMcpServers(iid: number): Record<string, McpStdioServerConfig> {
  const token = resolveToken().token;
  if (!token) return {};
  return {
    gitlab: {
      type: 'stdio',
      command: process.execPath,
      args: [join(ROOT, 'scripts', 'mcp-gitlab.cjs')],
      env: {
        ...BASE_ENV,
        ONESHOT_ARTIFACTS: artifactDir(iid),
        GITLAB_PERSONAL_ACCESS_TOKEN: token,
        // Already `<origin>/api/v4` (repourl.cjs), so the server and the
        // conductor's own calls can only ever reach the same instance.
        GITLAB_API_URL: gitlabRepo().apiUrl,
        GITLAB_TOOLS: 'create_merge_request_note,upload_markdown',
        GITLAB_PERMISSION_MODE: 'full',
      },
    },
  };
}

function promptContext(input: SessionInput): PromptContext {
  return {
    iid: input.iid, branch: input.branch, worktree: input.worktree, artifactsDir: artifactDir(input.iid),
    port: input.port, labels: input.ticket.labels, attempt: input.lap, previousAttempt: input.previousAttempt,
  };
}

/** The `query()` options for one attempt. Exported so doctor's probe spawns exactly what a run spawns. */
export function queryOptions(input: SessionInput, io: SessionIO): Options {
  const sp = superpowersPath();
  return {
    model: sessionModel(),
    maxTurns: sessionCaps().maxTurns,
    cwd: input.worktree,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(promptContext(input), io.superpowersIntro ?? SUPERPOWERS_INTRO) },
    // 'project' ONLY: CLAUDE.md and the composed .claude in the worktree. 'user'
    // drags in the operator's personal config, and a `npx ccusage` statusLine
    // there once wedged every session before its first turn.
    settingSources: ['project'],
    plugins: sp ? [{ type: 'local', path: sp }] : [],
    hooks: hooksFor(io.env) as Options['hooks'],
    mcpServers: sessionMcpServers(input.iid),
    disallowedTools: DENIED_TOOLS,
    permissionMode: 'bypassPermissions',
    // Required alongside bypassPermissions. The hook layer, not the permission
    // prompt, is the gate here.
    allowDangerouslySkipPermissions: true,
    outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
    env: io.env,
    abortController: io.abortController,
    stderr: io.stderr,
    ...(input.resume ? { resume: input.resume } : {}),
  };
}

/**
 * How an attempt ended, from what was observed. 'infra' is the machinery, not
 * the work — it is re-attempted; 'failed' is a session that ran and came back
 * without a result worth acting on.
 *
 * A signal death and a session that emitted nothing are both infra: an exit
 * code proves nothing (the SDK reports "exited with code 1" on sessions that
 * succeeded), and a session that never reached `system:init` holds no opinion
 * about the ticket. The `[ACTION REQUIRED]` gate is read only off a session
 * that did not succeed — a finished session is not blocked on anything,
 * whatever its stderr said on the way.
 */
export function classifySessionEnd(x: {
  subtype?: string; error?: string; sawActivity: number; stalled: boolean; timedOut: boolean; cancelled: boolean;
  signal?: string; stderrTail: string;
}): SessionOutput['status'] {
  if (x.cancelled) return 'aborted';
  if (x.stalled || x.timedOut) return 'infra';
  if (!x.subtype && (!!x.signal || SIGNAL_DEATH_RE.test(x.error ?? '') || x.sawActivity === 0)) return 'infra';
  if (x.subtype === 'success') return 'ok';
  if (accountActionRequired(x.stderrTail)) return 'infra';
  return 'failed';
}

export async function runSession(input: SessionInput): Promise<SessionOutput> {
  const { iid, lap } = input;
  const caps = sessionCaps();
  const tee = transcriptPath(iid, lap);
  mkdirSync(dirname(tee), { recursive: true });
  const env = sessionEnv(input);

  // Two ways a session ends early, and they are not the same failure: the
  // timer is the session overrunning its own budget; the caller's signal is the
  // conductor withdrawing it.
  const ac = new AbortController();
  let timedOut = false;
  let stalled = false;
  let cancelled = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let forceSettle: (err: Error) => void = () => {};
  const hardDeadline = new Promise<never>((_, reject) => { forceSettle = reject; });
  hardDeadline.catch(() => { /* raced below; never unhandled */ });
  const armForce = (): void => {
    if (!forceTimer) {
      forceTimer = setTimeout(() => forceSettle(new Error('the session did not unwind within the abort grace window')), FORCE_SETTLE_MS);
    }
  };
  const killer = setTimeout(() => { timedOut = true; ac.abort(); armForce(); }, caps.timeoutMin * 60_000);
  let lastFrameAt = Date.now();
  const watchdog = IDLE_STALL_MS > 0
    ? setInterval(() => {
      if (stalled || timedOut || Date.now() - lastFrameAt < IDLE_STALL_MS) return;
      stalled = true;
      log.warn(`ticket #${iid}: no stream message for ${Math.round(IDLE_STALL_MS / 60_000)}m — aborting the stalled session`);
      ac.abort();
      armForce();
    }, IDLE_CHECK_MS)
    : undefined;
  const cancel = (): void => { cancelled = true; ac.abort(); armForce(); };
  if (input.signal) {
    if (input.signal.aborted) cancel();
    else input.signal.addEventListener('abort', cancel, { once: true });
  }

  const out: SessionOutput = { status: 'failed', result: null, turns: 0, sawActivity: 0, stderrTail: '' };
  // Bounded: only frames that could name a subscription limit.
  const limitSignals: string[] = [];
  let stderrHead = '';
  let stderrTail = '';
  let settled = false;
  let turnsSoFar = 0;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let thrown: string | undefined;
  let rateLimited = false;

  try {
    const q = query({
      prompt: ticketPrompt(input.ticket, promptContext(input)),
      options: queryOptions(input, {
        env,
        abortController: ac,
        stderr: (text: string) => {
          try { appendFileSync(tee, `${JSON.stringify({ ts: Date.now(), type: 'cli-stderr', text })}\n`); } catch { /* best effort */ }
          if (stderrHead.length < STDERR_KEEP) stderrHead += text;
          stderrTail = (stderrTail + text).slice(-STDERR_KEEP);
        },
      }),
    });

    // Manual iteration, not `for await`, so each pull can be raced against the
    // hard deadline: a wedged CLI leaves `next()` pending forever.
    const iterator = q[Symbol.asyncIterator]();
    for (;;) {
      const nextFrame = iterator.next();
      nextFrame.catch(() => { /* swallowed if the deadline wins and the pull is abandoned */ });
      const step = await Promise.race([nextFrame, hardDeadline]);
      if (step.done === true) break;
      const msg = step.value;
      out.sawActivity += 1;
      lastFrameAt = Date.now();
      if (msg.type === 'assistant') turnsSoFar += 1;
      try {
        appendFileSync(tee, `${JSON.stringify({ ts: Date.now(), ...msg })}\n`);
      } catch { /* the tee is best-effort; never fail a session over logging */ }

      // A subscription cap arrives as synthetic assistant frames tagged
      // `error: "rate_limit"` ("You've hit your limit · resets 4:30pm"). Read as
      // ordinary turns they burn the whole maxTurns cap before settling as
      // error_max_turns, hiding the real cause.
      if (msg.type === 'assistant' && !settled) {
        const errTag = typeof msg.error === 'string' ? msg.error : '';
        const content = (msg.message as { content?: Array<{ text?: string }> } | undefined)?.content ?? [];
        const texts = content.map((c) => c.text ?? '').join(' ');
        if (errTag === 'rate_limit' || looksLikeUsageLimit(texts)) {
          limitSignals.push(errTag, texts);
          rateLimited = true;
          out.error = `rate_limit: ${texts.slice(0, 200) || errTag}`;
          ac.abort();
          armForce();
          break;
        }
      }

      // Heartbeat. `turns` arrives only in the result frame, so counting
      // assistant frames is the only turn number available while it matters.
      if (Date.now() - lastProgressAt >= PROGRESS_EVERY_MS) {
        lastProgressAt = Date.now();
        const mins = Math.round((Date.now() - startedAt) / 60_000);
        log.info(`ticket #${iid} working turns=${turnsSoFar}/${caps.maxTurns} elapsed=${mins}m/${caps.timeoutMin}m messages=${out.sawActivity}`);
      }

      if (msg.type === 'result') {
        // The FIRST result frame settles the session, and only the first.
        // Observed live: a 'success' frame carrying the real turns and usage,
        // then an 'error_during_execution' frame carrying zero of each. Read as
        // the outcome, the trailing frame failed a passing session and pushed
        // its text into limitSignals, where one limit-shaped string parks the
        // conductor on an account that was never limited.
        if (settled) {
          log.warn(`ticket #${iid}: extra result frame ignored`, { subtype: msg.subtype });
          continue;
        }
        settled = true;
        out.turns = msg.num_turns;
        out.sessionId = msg.session_id;
        out.durationMs = msg.duration_ms;
        out.apiDurationMs = msg.duration_api_ms;
        out.costUsd = msg.total_cost_usd;
        out.modelUsage = msg.modelUsage;
        out.resultSubtype = msg.subtype;
        if (msg.subtype === 'success') {
          out.result = parseTicketResult(msg.structured_output);
          if (!out.result) {
            out.error = NO_STRUCTURED_OUTPUT;
            limitSignals.push(msg.result);
          }
        } else {
          out.error = `${msg.subtype}: ${(msg.errors ?? []).join('; ').slice(0, 300)}`;
          limitSignals.push(...(msg.errors ?? []));
        }
      }
    }
  } catch (err) {
    thrown = (err as Error).message ?? String(err);
  } finally {
    clearTimeout(killer);
    if (watchdog) clearInterval(watchdog);
    if (forceTimer) clearTimeout(forceTimer);
    input.signal?.removeEventListener('abort', cancel);
  }

  // Why the attempt ended, read off the flags rather than off the catch alone:
  // an aborted stream may end quietly instead of throwing.
  if (settled) {
    // The result frame already decided this attempt; a stream that would not
    // close afterwards is noise, not a verdict.
    if (thrown) log.warn(`ticket #${iid}: the stream failed after the result frame`, { error: thrown.slice(0, 200) });
  } else if (stalled) {
    // The model connection went quiet mid-session. Kept out of limitSignals:
    // it says nothing about the account.
    out.error = `stalled: no stream message for ${Math.round(IDLE_STALL_MS / 60_000)}m after `
      + `${out.sawActivity} message(s) — the model connection went silent mid-session, so it was `
      + 'aborted early rather than left to run out its wall clock';
  } else if (timedOut) {
    // Nothing at all means the spawn wedged; traffic means a session that was
    // working and simply never finished. Conflating them sends whoever reads
    // this at a healthy MCP server when the budget was too small.
    out.error = !out.sawActivity
      ? `timed out after ${caps.timeoutMin}m without a single message — the session never `
        + 'started. Almost always a wedged MCP server spawn: run `npm run deps:verify`.'
      : `timed out after ${caps.timeoutMin}m while still working (${out.sawActivity} stream `
        + 'messages, no final result). ONESHOT_TIMEOUT_MIN is too small for this ticket.';
    if (thrown) limitSignals.push(thrown);
  } else if (cancelled) {
    // Reports nothing about the account, so its text stays away from the
    // usage-limit detector.
    out.error = CANCELLED_BY_CONDUCTOR;
  } else if (thrown) {
    out.error = thrown;
    limitSignals.push(thrown);
  }

  out.stderrTail = stderrTail;
  // The short-circuit parks on its own say-so; any other path parks only when
  // what it collected reads as a subscription limit.
  const signalText = limitSignals.join('\n');
  if (rateLimited || looksLikeUsageLimit(signalText)) {
    parkForQuota(signalText);
    out.status = 'parked';
  } else {
    // A settled session is judged by its result frame: a watchdog or a cancel
    // that fired while the stream was closing afterwards decides nothing. The
    // account gate is read off both ends of stderr (see STDERR_KEEP).
    out.status = classifySessionEnd({
      subtype: out.resultSubtype,
      error: out.error,
      sawActivity: out.sawActivity,
      stalled: stalled && !settled,
      timedOut: timedOut && !settled,
      cancelled: cancelled && !settled,
      stderrTail: stderrHead.length < STDERR_KEEP ? stderrTail : `${stderrHead}\n${stderrTail}`,
    });
  }

  log.phase(`ticket #${iid} lap${lap} ${out.status}`, {
    model: sessionModel(), turns: out.turns,
    ...(out.error ? { error: out.error.slice(0, 120) } : {}),
  });
  return out;
}
