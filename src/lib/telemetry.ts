/**
 * What a run cost and how far it got, read back from the files the conductor
 * already writes — the journal and the transcript tee. No database, no
 * collector: `npm run status`, the dashboard index and the report header all
 * call into here, so the three surfaces cannot disagree about one run.
 *
 * Tokens and dollars are ESTIMATES. A Max subscription bills nothing per call;
 * the figures are what the SDK reports the session would have cost, and every
 * surface labels them that way.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS, RUNS_ARCHIVE } from './config.js';
import { pidAlive, readJournalFrom, type RunJournal } from './journal.js';

export interface SessionStats {
  turns: number; durationMs: number;
  tokens: { main: number; subagent: number; byModel: Record<string, number> };
  costUsd: number; toolCounts: Record<string, number>; skills: string[];
  checkpoints: Array<{ name: string; ts: number | null }>;
  compactions: number; truncatedTail: boolean;
}

type Usage = { input: number; output: number; cr: number; cw: number };

/** Streaming repeats one API message per content block with the same usage: count each id once, max per field. */
export function mergeUsage(map: Map<string, Usage>, id: string, u: Record<string, number | undefined>): void {
  const cur = map.get(id) ?? { input: 0, output: 0, cr: 0, cw: 0 };
  map.set(id, {
    input: Math.max(cur.input, u.input_tokens ?? 0),
    output: Math.max(cur.output, u.output_tokens ?? 0),
    cr: Math.max(cur.cr, u.cache_read_input_tokens ?? 0),
    cw: Math.max(cur.cw, u.cache_creation_input_tokens ?? 0),
  });
}

const CHECKPOINT_TOOLS: Record<string, string> = { mcp__gitlab__create_merge_request: 'mr-opened' };

/**
 * The checkpoint a tool call marks, or null: a superpowers skill launched
 * (`superpowers:brainstorming`, `superpowers:writing-plans`, …) or the MR
 * opened. The report draws the same rows from the same rule.
 */
export function checkpointOf(toolName: string, input: unknown): string | null {
  const skill = (input as { skill?: unknown } | null | undefined)?.skill;
  if (toolName === 'Skill' && typeof skill === 'string' && skill.startsWith('superpowers:')) return skill;
  return CHECKPOINT_TOOLS[toolName] ?? null;
}

/**
 * Input + output tokens across a result's `modelUsage` — per model, subagents
 * included. `result.usage` covers the main thread only and under-counts a
 * session that dispatches Task subagents roughly fourfold.
 */
export function modelUsageTokens(modelUsage: Record<string, unknown> | undefined): number {
  return Object.values((modelUsage ?? {}) as Record<string, Record<string, number> | undefined>)
    .reduce((n, u) => n + (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0), 0);
}

/**
 * One transcript tee, summarised.
 *
 * The FIRST result frame settles turns, duration and cost: a session can emit a
 * `success` frame followed by an `error_during_execution` frame carrying zeroes,
 * and the conductor records the first (transcript.ts says why). Assistant usage
 * is merged per message id because streaming repeats it per content block.
 */
export function sessionStats(jsonlPath: string): SessionStats {
  const empty: SessionStats = { turns: 0, durationMs: 0, tokens: { main: 0, subagent: 0, byModel: {} }, costUsd: 0, toolCounts: {}, skills: [], checkpoints: [], compactions: 0, truncatedTail: false };
  if (!existsSync(jsonlPath)) return empty;
  const lines = readFileSync(jsonlPath, 'utf8').split('\n');
  const stats: SessionStats = { ...empty, tokens: { main: 0, subagent: 0, byModel: {} }, toolCounts: {}, skills: [], checkpoints: [] };
  const main = new Map<string, Usage>(); const sub = new Map<string, Usage>();
  let sawResult = false;
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    let d: Record<string, unknown>;
    // A tee killed mid-write leaves half a line at the end; anywhere else it is just skipped.
    try { d = JSON.parse(l) as Record<string, unknown>; } catch { if (i >= lines.length - 2) stats.truncatedTail = true; return; }
    const ts = typeof d.ts === 'number' ? d.ts : null;
    if (d.type === 'system' && d.subtype === 'compact_boundary') { stats.compactions += 1; return; }
    if (d.type === 'result') {
      if (sawResult) return;            // FIRST result frame settles
      sawResult = true;
      stats.turns = Number(d.num_turns ?? 0);
      stats.durationMs = Number(d.duration_ms ?? 0);
      stats.costUsd = Number(d.total_cost_usd ?? 0);
      const mu = (d.modelUsage ?? {}) as Record<string, Record<string, number>>;
      for (const [model, u] of Object.entries(mu)) stats.tokens.byModel[model] = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      return;
    }
    if (d.type !== 'assistant') return;
    const msg = d.message as { id?: string; usage?: Record<string, number>; content?: Array<Record<string, unknown>> } | undefined;
    if (!msg) return;
    const parent = (d.parent_tool_use_id as string | null | undefined) ?? null;
    if (msg.id && msg.usage) mergeUsage(parent ? sub : main, msg.id, msg.usage);
    for (const block of msg.content ?? []) {
      if (block.type !== 'tool_use') continue;
      const name = String(block.name);
      stats.toolCounts[name] = (stats.toolCounts[name] ?? 0) + 1;
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (name === 'Skill' && typeof input.skill === 'string' && !stats.skills.includes(input.skill)) stats.skills.push(input.skill);
      const checkpoint = checkpointOf(name, input);
      if (checkpoint) stats.checkpoints.push({ name: checkpoint, ts });
    }
  });
  const sum = (m: Map<string, Usage>) => [...m.values()].reduce((n, u) => n + u.input + u.output, 0);
  stats.tokens.main = sum(main); stats.tokens.subagent = sum(sub);
  return stats;
}

export interface RunSummary {
  iid: number; title: string; status: string; runId: string; createdAt: number; durationMs: number;
  attempts: number; turns: number; tokens: number; costUsd: number; mrUrl: string | null; merged: boolean;
  live: boolean; archived: string | null;
}

/**
 * One run, as the index row and the report header show it.
 *
 * Wall clock is `(stoppedAt ?? last endedAt) − createdAt`, and still ticking
 * only while the conductor that holds the run is alive. A run whose conductor
 * died before it recorded anything stops at the last moment the journal saw it
 * — the latest attempt start, else its creation — rather than growing forever.
 *
 * `dir` is accepted so a later version can fall back to sessionStats() when the
 * journal lacks `modelUsage`; v1 reads the journal only.
 */
export function runSummary(j: RunJournal, dir: string, archived: string | null = null): RunSummary {
  const phases = j.phases ?? [];
  const live = (j.status === 'running' || j.status === 'claimed') && pidAlive(j.pid);
  const lastEnd = phases.reduce((m, p) => Math.max(m, p.endedAt ?? 0), 0);
  const lastSeen = phases.reduce((m, p) => Math.max(m, p.startedAt ?? 0), j.createdAt);
  const end = j.stoppedAt ?? (live ? Date.now() : lastEnd || lastSeen);
  return {
    iid: j.iid, title: j.title ?? '', status: j.status, runId: j.runId, createdAt: j.createdAt,
    durationMs: Math.max(0, end - j.createdAt),
    attempts: phases.length,
    turns: phases.reduce((n, p) => n + (p.turns ?? 0), 0),
    tokens: phases.reduce((n, p) => n + modelUsageTokens(p.modelUsage), 0),
    costUsd: phases.reduce((n, p) => n + (p.costUsd ?? 0), 0),
    mrUrl: j.mrUrl ?? null, merged: j.merged === true, live, archived,
  };
}

/**
 * Every run on this desk, live and archived, newest first.
 *
 * Archived runs are included because a re-run of a ticket moves the previous
 * run's directory aside (archiveRun), and the run you want to read is often the
 * one that was moved. An unreadable journal is skipped, never fatal.
 */
export function allRuns(): RunSummary[] {
  const out: RunSummary[] = [];
  const scan = (root: string, archived: boolean, keep: (name: string) => boolean): void => {
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      if (!keep(name)) continue;
      const dir = join(root, name);
      const j = readJournalFrom(dir);
      if (j) out.push(runSummary(j, dir, archived ? name : null));
    }
  };
  scan(RUNS, false, (name) => /^\d+$/.test(name));
  scan(RUNS_ARCHIVE, true, () => true);
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** `45s`, `12m`, `3h05` — one spelling for every surface. */
export function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

/** `950`, `12k`, `3.4M`. */
export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
