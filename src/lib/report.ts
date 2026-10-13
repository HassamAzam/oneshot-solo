/**
 * One run, one page: what the dashboard serves at `/run/<iid>`, and what
 * `npm run report` writes to `<run dir>/report.html`.
 *
 * The questions this answers are the operator's, asked in their words — what
 * is the ticket's status, how long did it take, and what did the session
 * actually do. The header carries the first two (status, wall clock, attempts,
 * turns, tokens and cost — both labelled est., since a subscription bills
 * nothing per call — the MR and whether it merged, and the design and plan the
 * session wrote); one row per attempt and its readable transcript carry the
 * third. Checkpoint rows mark where the session reached a superpowers skill or
 * opened the MR, and compaction rows mark where its context was summarised —
 * the two things worth finding in a transcript several thousand entries long.
 *
 * Everything is read from one run directory — live (`state/runs/<iid>/`) or
 * archived (`state/runs-archive/<iid>-<runId>/`) — through the journal and the
 * transcript tee. They ARE the record of a run; there is no database.
 *
 * Two facts about the source data shape the reader.
 *
 * A transcript FILE is not a session. An attempt that resumes appends to its
 * own tee, and a run lifted from oneshot holds phase-named tees that re-entered
 * one lap number many times. So the file is counted rather than assumed: 'init'
 * frames are sessions and 'result' frames are results, kept beside the turn
 * count the journal declared. When those numbers disagree, that is how an
 * attempt recorded 'ok' with zero turns becomes legible as a session that
 * worked for ninety minutes and never got to say so.
 *
 * Subagent traffic is INLINE. A frame dispatched by a Task carries the Task's
 * tool_use id in `parent_tool_use_id`, so the agent that produced a turn is
 * recoverable and every turn is attributed rather than dropped into one flat
 * stream that reads as if the session did all of it itself.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { RUNS_ARCHIVE, envOr, runDir } from './config.js';
import { readJournalFrom, type PhaseRecord, type RunJournal } from './journal.js';
import { log } from './log.js';
import {
  checkpointOf, fmtDuration, fmtTokens, modelUsageTokens, runSummary, type RunSummary,
} from './telemetry.js';

/**
 * Per-string caps, applied while parsing rather than while rendering.
 *
 * The whole payload is inlined — a report that fetches its own data would not
 * open from file://, which is the only way anyone actually opens it — so the
 * only lever on size is how much of each string is worth keeping. A 12 MB
 * transcript is 12 MB because of Bash and Read results, not because of what the
 * model said, which is why assistant text keeps a budget an order of magnitude
 * larger than a tool result's.
 */
const TEXT_LIMIT = 20_000;
const RESULT_LIMIT = 4_000;
const ARG_LIMIT = 400;
const STDERR_LIMIT = 400;

/**
 * Agents this project dispatches on purpose, listed so they can be shown first:
 * ONESHOT_PROJECT_AGENTS, comma-separated, else the ERP context's agents.
 *
 * Explore and general-purpose still appear — they ran, and a page that hides
 * what ran is a page that has to be verified against the raw JSONL anyway — but
 * they sort below these, because "how many reviewer agents ran" should be
 * answerable without reading past the built-ins.
 */
function projectAgents(): Set<string> {
  return new Set(envOr('ONESHOT_PROJECT_AGENTS',
    'backend-agent,frontend-agent,backend-reviewer-agent,frontend-reviewer-agent,util-reuse-agent')
    .split(',').map((s) => s.trim()).filter(Boolean));
}

// ------------------------------------------------------------------ redaction

/**
 * Credential scrubbing, applied to EVERY string that reaches the payload.
 *
 * Transcripts are verbatim session records, and sessions read configuration:
 * one of these files contains a live Slack bot token because an MCP config was
 * printed into it. The report is the artifact most likely to be forwarded — it
 * is a single self-contained file, which is exactly what makes it shareable and
 * exactly what makes an unredacted one dangerous.
 *
 * Rules are ordered, and each one refuses to match a marker an earlier one
 * left. `GITLAB_TOKEN=glpat-…` is caught by the prefix rule and then offered to
 * the name rule, which would otherwise redact the redaction and leave half the
 * first marker dangling in the text — safe, and unreadable enough that a reader
 * assumes the page is broken.
 *
 * Deliberately anchored on names that are ACTUALLY credential names —
 * env-shaped uppercase identifiers and the handful of lowercase spellings that
 * are only ever credentials. A rule broad enough to catch `key: "the invoice
 * toast"` redacts the prose the page exists to show, and an operator who cannot
 * trust the text stops reading the page rather than tightening the regex.
 */
const SECRET_RULES: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/((?:authorization|private-token|x-api-key|x-gitlab-token)\\?["']?\s*[:=]\s*\\?["']?)[^"'\n,;}]{6,}/gi,
    '$1[redacted: credential header]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted: bearer token]'],
  // Only what actually decodes to `user:password`. The shape alone ("Basic" and
  // eight base64 letters) is also the shape of ordinary English: "Basic
  // Information" is a Profile tab, and every test step that opened it was
  // posted as "Basic [redacted: basic credentials]".
  [/(Basic\s+)([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g,
    (match, lead, token) => (isBasicCredential(token) ? `${lead}[redacted: basic credentials]` : match)],
  [/xox[baprs]-[A-Za-z0-9-]{8,}/g, '[redacted: slack token]'],
  [/glpat-[A-Za-z0-9_-]{8,}/g, '[redacted: gitlab token]'],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted: anthropic api key]'],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted: github token]'],
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)(\\?["']?\s*[:=]\s*\\?["']?)(?!\[redacted)[^"'\s,;}\n]{4,}/g,
    '$1$2[redacted: $1]'],
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?token|client[_-]?secret|password|passwd)(\\?["']?\s*[:=]\s*\\?["']?)(?!\[redacted)[^"'\s,;}\n]{4,}/gi,
    '$1$2[redacted: $1]'],
];

/**
 * True when a `Basic` token decodes to printable UTF-8 `user:password` text,
 * which is what HTTP Basic carries (RFC 7617). UTF-8, not ASCII: a check for
 * bytes 0x20-0x7e alone let `user:pässwörd` and `svc:p@ss€` through
 * unredacted. A user-id before the colon is required, which keeps out most of
 * the ordinary words whose letters happen to decode to text with a colon.
 */
function isBasicCredential(token: string): boolean {
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  return decoded.indexOf(':') > 0 && !decoded.includes('\uFFFD') && !/[\u0000-\u001f\u007f]/.test(decoded);
}

/**
 * Shortest credential worth hiding. Below this a "secret" is a word first, and
 * blanking words out of the page costs more than it protects.
 */
const MIN_SECRET_LEN = 6;

/**
 * The literal secrets this desk actually holds.
 *
 * SECRET_RULES above is a denylist: it recognises a credential by the text
 * AROUND it, so it catches `password='hunter2'` and misses the identical value
 * written any other way. That is not a theoretical gap. A failing `verify`
 * quotes its own login into its error, and does it twice in one paragraph — as
 * `password='…'`, which gets marked, and in the `user@host:secret` form `.env`
 * pins it in, which does not. The page then shows one redaction and one
 * credential, which reads as though redaction worked.
 *
 * These values need no shape, because they are known exactly. Matching the
 * literal covers every spelling at once, including the spellings nobody has
 * thought of yet, and cannot redact prose by accident the way a broader pattern
 * would. Longest first so a secret containing another is replaced whole.
 */
function knownSecrets(): string[] {
  const out: string[] = [];
  for (const name of ['ONESHOT_TEST_LOGIN', 'ONESHOT_DEMO_LOGIN']) {
    const pin = envOr(name);
    const colon = pin.indexOf(':');
    if (colon < 0) continue;
    const secret = pin.slice(colon + 1).trim();
    if (secret.length >= MIN_SECRET_LEN) out.push(secret);
  }
  return out.sort((a, b) => b.length - a.length);
}

export function redact(value: string): string {
  let out = value;
  // Literals first: a shape rule that fires afterwards can only re-mark text
  // that is already a marker, and the ordering note above explains why that is
  // worse than leaving it alone.
  for (const secret of knownSecrets()) out = out.split(secret).join('[redacted: credential]');
  for (const [pattern, replacement] of SECRET_RULES) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}

function clean(value: unknown, limit: number): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const cut = raw.length > limit ? `${raw.slice(0, limit)}\n… ${raw.length - limit} more characters` : raw;
  return redact(cut);
}

// --------------------------------------------------------------------- model

export interface AgentDispatch {
  /** `input.subagent_type` — what the operator counts. */
  agent: string;
  description: string;
  /** Outcome read off the matching tool_result, or 'unknown' if none arrived. */
  status: string;
  durationMs: number | null;
  toolUses: number | null;
  project: boolean;
}

export interface TranscriptEntry {
  /**
   * `checkpoint` marks a superpowers skill launched or the MR opened, and comes
   * just before the tool entry it was read from; `compaction` marks the
   * session's context being summarised.
   */
  kind: 'session' | 'text' | 'tool' | 'result' | 'outcome' | 'stderr' | 'checkpoint' | 'compaction';
  /** Tool name, result subtype, checkpoint name, or the model of a session start. */
  label: string;
  text: string;
  /** The agent that produced this turn, absent for the session's own turns. */
  agent?: string;
  /** The frame's tee timestamp (epoch ms), when the tee recorded one. */
  ts?: number;
  /**
   * Time since the previous timestamped frame — how long the model thought, or
   * the tool ran, before this. On the first non-checkpoint entry of a frame only.
   */
  elapsedMs?: number;
}

export interface PhaseReport {
  /** 'ticket' for a Solo attempt; a phase name in a run lifted from oneshot. */
  phase: string;
  /** The attempt number. */
  lap: number;
  status: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  model: string;
  /** What the journal declared. */
  turns: number;
  /** Input + output tokens from the record's `modelUsage`, subagents included (est.). */
  tokens: number;
  costUsd: number;
  /** The attempt resumed the previous attempt's session. */
  resumed: boolean;
  /** Checkpoint names in the order the transcript reached them. */
  checkpoints: string[];
  /** 'init' frames actually in the transcript. */
  attempts: number;
  /** 'result' frames actually in the transcript. */
  results: number;
  error: string;
  transcript: string;
  agents: AgentDispatch[];
  entries: TranscriptEntry[];
}

export interface ReportModel {
  iid: number;
  title: string;
  url: string;
  runId: string;
  status: string;
  createdAt: number;
  mrIid: number | null;
  mrUrl: string;
  merged: boolean;
  blockedWhy: string;
  /** Null for a directory holding transcripts but no journal. */
  summary: RunSummary | null;
  /** The design and plan the session wrote, as dashboard links; only files that exist. */
  artifacts: Array<{ name: string; href: string }>;
  phases: PhaseReport[];
  agentCount: number;
  generatedAt: number;
}

// -------------------------------------------------------------------- parsing

interface ParsedTranscript {
  attempts: number;
  results: number;
  agents: AgentDispatch[];
  entries: TranscriptEntry[];
}

const EMPTY: ParsedTranscript = { attempts: 0, results: 0, agents: [], entries: [] };

/**
 * One line standing in for a tool's whole input.
 *
 * Ordered by what identifies the call: a path, then a command, then the prose
 * fields. A Task's `prompt` is deliberately last and capped — those run to
 * thousands of words, and the operator's question about a Task is which agent
 * ran, which the chips already answer.
 */
function argSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const first = o.file_path ?? o.command ?? o.pattern ?? o.description ?? o.url
    ?? o.skill ?? o.prompt ?? o.query ?? o.path;
  if (typeof first === 'string') return clean(first, ARG_LIMIT);
  return clean(o, ARG_LIMIT);
}

/** tool_result content arrives as a string on some tools and as blocks on others. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .map((b) => {
      const block = b as Record<string, unknown>;
      if (typeof block.text === 'string') return block.text;
      if (block.type === 'image') return '[image]';
      return JSON.stringify(block);
    })
    .join('\n');
}

/**
 * Walk one JSONL file.
 *
 * Every line is parsed defensively. A transcript is a tee of a live stream, so
 * the last line of a session killed mid-write is routinely half a JSON object,
 * and one truncated line must never cost the other nine thousand.
 *
 * Each frame's tee timestamp is stamped on the entries it produced, and the gap
 * since the previous timestamped frame goes on the first of them that is not a
 * checkpoint bar. Frames written before the tee carried `ts` simply have none.
 */
function parseTranscript(path: string): ParsedTranscript {
  const out: ParsedTranscript = { attempts: 0, results: 0, agents: [], entries: [] };
  const dispatchOf = new Map<string, AgentDispatch>();
  const ours = projectAgents();
  let prevTs: number | null = null;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const from = out.entries.length;
    readFrame(frame, out, dispatchOf, ours);

    const ts = typeof frame.ts === 'number' ? frame.ts : null;
    if (ts === null) continue;
    let timed = false;
    for (const e of out.entries.slice(from)) {
      e.ts = ts;
      if (!timed && e.kind !== 'checkpoint' && prevTs !== null) e.elapsedMs = Math.max(0, ts - prevTs);
      if (e.kind !== 'checkpoint') timed = true;
    }
    prevTs = ts;
  }

  out.agents.sort((a, b) => Number(b.project) - Number(a.project));
  return out;
}

/** The entries one frame contributes, appended to `out`. */
function readFrame(
  frame: Record<string, unknown>, out: ParsedTranscript, dispatchOf: Map<string, AgentDispatch>, ours: Set<string>,
): void {
  const parent = typeof frame.parent_tool_use_id === 'string' ? frame.parent_tool_use_id : '';
  const via = dispatchOf.get(parent)?.agent;
  const tag = via ? { agent: via } : {};

  if (frame.type === 'cli-stderr') {
    const text = clean(frame.text, STDERR_LIMIT).trim();
    if (text) out.entries.push({ kind: 'stderr', label: 'stderr', text });
    return;
  }

  if (frame.type === 'system' && frame.subtype === 'init') {
    out.attempts += 1;
    out.entries.push({
      kind: 'session',
      label: String(frame.model ?? ''),
      text: `session start — ${String(frame.session_id ?? 'no id')}`,
    });
    return;
  }

  if (frame.type === 'system' && frame.subtype === 'compact_boundary') {
    const meta = (frame.compact_metadata ?? {}) as Record<string, unknown>;
    out.entries.push({ kind: 'compaction', label: 'context compacted', text: `${String(meta.pre_tokens ?? '?')} tokens` });
    return;
  }

  if (frame.type === 'result') {
    out.results += 1;
    out.entries.push({
      kind: 'outcome',
      label: String(frame.subtype ?? 'result'),
      text: clean(frame.result ?? frame.errors ?? '', RESULT_LIMIT),
    });
    return;
  }

  const message = frame.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return;

  for (const raw of content) {
    const block = raw as Record<string, unknown>;

    if (block.type === 'text' && frame.type === 'assistant') {
      const text = clean(block.text, TEXT_LIMIT).trim();
      if (text) out.entries.push({ kind: 'text', label: 'assistant', text, ...tag });
      continue;
    }

    if (block.type === 'tool_use') {
      const name = String(block.name ?? 'tool');
      const checkpoint = checkpointOf(name, block.input);
      if (checkpoint) out.entries.push({ kind: 'checkpoint', label: clean(checkpoint, 80), text: '', ...tag });
      out.entries.push({ kind: 'tool', label: name, text: argSummary(block.input), ...tag });
      if (name !== 'Task') continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const dispatch: AgentDispatch = {
        agent: clean(input.subagent_type ?? 'unknown', 80) || 'unknown',
        description: clean(input.description ?? '', ARG_LIMIT),
        status: 'unknown',
        durationMs: null,
        toolUses: null,
        project: ours.has(String(input.subagent_type ?? '')),
      };
      out.agents.push(dispatch);
      if (typeof block.id === 'string') dispatchOf.set(block.id, dispatch);
      continue;
    }

    if (block.type === 'tool_result') {
      const id = String(block.tool_use_id ?? '');
      const dispatch = dispatchOf.get(id);
      if (dispatch) {
        const meta = (frame.tool_use_result ?? {}) as Record<string, unknown>;
        dispatch.status = clean(meta.status ?? (block.is_error ? 'error' : 'completed'), 40);
        const ms = meta.totalDurationMs;
        dispatch.durationMs = typeof ms === 'number' ? ms : null;
        const uses = meta.totalToolUseCount;
        dispatch.toolUses = typeof uses === 'number' ? uses : null;
      }
      out.entries.push({
        kind: 'result',
        label: dispatch ? `${dispatch.agent} returned` : (block.is_error ? 'error' : 'result'),
        text: clean(resultText(block.content), RESULT_LIMIT),
        ...tag,
      });
    }
  }
}

function readTranscript(path: string): ParsedTranscript {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return EMPTY;
    return parseTranscript(path);
  } catch (err) {
    log.warn(`report: unreadable transcript ${path}`, { error: (err as Error).message });
    return EMPTY;
  }
}

function transcriptFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

function checkpointsIn(parsed: ParsedTranscript): string[] {
  return parsed.entries.filter((e) => e.kind === 'checkpoint').map((e) => e.label);
}

/**
 * One journal record and its transcript. An attempt still 'running' has no end
 * yet; its clock runs only while the conductor holding the run is alive, so a
 * dead conductor's last attempt does not read as hours long.
 */
function phaseFrom(rec: PhaseRecord, dir: string, file: string, live: boolean): PhaseReport {
  const parsed = file ? readTranscript(join(dir, file)) : EMPTY;
  const end = rec.endedAt ?? (live && rec.status === 'running' ? Date.now() : rec.startedAt);
  return {
    phase: rec.phase,
    lap: rec.lap,
    status: rec.status,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt ?? 0,
    durationMs: Math.max(0, end - rec.startedAt),
    model: rec.model ?? '',
    turns: rec.turns ?? 0,
    tokens: modelUsageTokens(rec.modelUsage),
    costUsd: rec.costUsd ?? 0,
    resumed: rec.resumed === true,
    checkpoints: checkpointsIn(parsed),
    attempts: parsed.attempts,
    results: parsed.results,
    error: clean(rec.error ?? '', RESULT_LIMIT),
    transcript: file,
    agents: parsed.agents,
    entries: parsed.entries,
  };
}

/**
 * A transcript with no journal record behind it.
 *
 * Not a curiosity — it is what a run that died between the session ending and
 * recordPhase() looks like on disk, and it is the one case where the file is
 * the ONLY evidence the attempt ever happened. A run lifted from oneshot shows
 * its phase-named tees the same way whenever its journal lacks the record.
 */
function orphanPhase(dir: string, file: string): PhaseReport {
  const parsed = readTranscript(join(dir, file));
  const match = /^(.*)-lap(\d+)\.jsonl$/.exec(file);
  return {
    phase: match?.[1] ?? file.replace(/\.jsonl$/, ''),
    lap: Number(match?.[2] ?? 0),
    status: 'unrecorded',
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    model: '',
    turns: 0,
    tokens: 0,
    costUsd: 0,
    resumed: false,
    checkpoints: checkpointsIn(parsed),
    attempts: parsed.attempts,
    results: parsed.results,
    error: 'no journal record — the attempt never reported back',
    transcript: file,
    agents: parsed.agents,
    entries: parsed.entries,
  };
}

/** The design and plan the session wrote to the run's artifacts, linked through the dashboard. */
function artifactLinks(dir: string, iid: number, archived: string | null): ReportModel['artifacts'] {
  const query = archived ? `?archived=${encodeURIComponent(archived)}` : '';
  return [`${iid}-design.md`, `${iid}-plan.md`]
    .filter((name) => existsSync(join(dir, 'artifacts', name)))
    .map((name) => ({ name, href: `/artifacts/${iid}/${encodeURIComponent(name)}${query}` }));
}

function header(iid: number, j: RunJournal | null, summary: RunSummary | null): Omit<ReportModel, 'phases' | 'agentCount' | 'artifacts'> {
  const title = clean(j?.title ?? '', 300);
  const mrUrl = clean(j?.mrUrl ?? '', 300);
  return {
    iid,
    title,
    url: clean(j?.url ?? '', 300),
    runId: clean(j?.runId ?? '', 80),
    status: j?.status ?? 'unknown',
    createdAt: j?.createdAt ?? 0,
    mrIid: j?.mrIid ?? null,
    mrUrl,
    merged: j?.merged === true,
    blockedWhy: clean(j?.blockedWhy ?? '', RESULT_LIMIT),
    // Every string that reaches the payload goes through clean(), these two included.
    summary: summary && { ...summary, title, mrUrl: mrUrl || null },
    generatedAt: Date.now(),
  };
}

/**
 * Build the page's data from one run directory — `runDir(iid)` or an archived
 * `RUNS_ARCHIVE/<iid>-<runId>` — or null when there is no run to describe.
 *
 * The journal supplies the attempt rows because it is the only thing that
 * knows ORDER, status and wall clock; the transcripts supply everything else.
 * Neither is required: a directory holding only transcripts still reports (its
 * iid read off the directory name), and a journal record whose attempt never
 * wrote a tee still lists it.
 */
export function buildReportModel(dir: string): ReportModel | null {
  try {
    if (!existsSync(dir)) return null;

    const journal = readJournalFrom(dir);
    const transcripts = join(dir, 'transcripts');
    const files = transcriptFiles(transcripts);
    if (!journal && files.length === 0) return null;

    const archived = resolve(dirname(dir)) === resolve(RUNS_ARCHIVE) ? basename(dir) : null;
    const iid = journal?.iid ?? Number(/^\d+/.exec(basename(dir))?.[0] ?? 0);
    const summary = journal ? runSummary(journal, dir, archived) : null;

    const unused = new Set(files);
    const phases: PhaseReport[] = (journal?.phases ?? []).map((rec) => {
      const file = `${rec.phase}-lap${rec.lap}.jsonl`;
      const found = unused.delete(file) ? file : '';
      return phaseFrom(rec, transcripts, found, summary?.live ?? false);
    });
    for (const file of files) {
      if (unused.has(file)) phases.push(orphanPhase(transcripts, file));
    }

    return {
      ...header(iid, journal, summary),
      artifacts: artifactLinks(dir, iid, archived),
      phases,
      agentCount: phases.reduce((n, p) => n + p.agents.length, 0),
    };
  } catch (err) {
    log.warn(`report: could not build the model for ${dir}`, { error: (err as Error).message });
    return null;
  }
}

// -------------------------------------------------------------------- writing

/**
 * Inline the payload into a <script type="application/json"> tag.
 *
 * Every '<' becomes a \\u003c escape because transcripts contain the literal '</script>' — an
 * agent that read an HTML file put one there — and the browser ends the tag at
 * the first one it sees, silently, leaving a page that renders a header and
 * nothing else. U+2028/U+2029 go the same way: legal in JSON, fatal in a script
 * body, and invisible in every editor that would be used to debug it.
 */
function embed(model: ReportModel): string {
  return JSON.stringify(model)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f6f7f9;color:#1c2024;
 font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:#0b5fbf}
header{background:#fff;border-bottom:1px solid #dfe3e8;padding:20px 24px}
h1{margin:0 0 6px;font-size:19px;font-weight:600}
h1 .iid{color:#6b7480;font-weight:400}
.meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:#5b636d;font-size:13px}
.meta b{color:#1c2024;font-weight:600}
main{padding:20px 24px 60px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dfe3e8;border-radius:6px}
th{text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b7480;
 padding:9px 10px;border-bottom:1px solid #dfe3e8;font-weight:600}
td{padding:8px 10px;border-top:1px solid #eceff2;vertical-align:top}
tr.row{cursor:pointer}
tr.row:hover td{background:#f2f6fb}
tr.row.open td{background:#eef4fc}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.phase{font-weight:600;white-space:nowrap}
td.err{color:#a3341f;max-width:340px;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.warnnum{background:#fdf1cf;border-radius:3px;padding:0 5px;font-weight:600}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;
 background:#e6e9ed;color:#3c444d}
.pill.ok,.pill.done{background:#dff3e2;color:#20603a}
.pill.running,.pill.claimed{background:#dde9f9;color:#1d4f8a}
.pill.failed,.pill.refused,.pill.blocked,.pill.aborted{background:#fadfd9;color:#8f2c17}
.pill.warned,.pill.unrecorded,.pill.infra{background:#fdf1cf;color:#7a5606}
.pill.skipped,.pill.parked{background:#e6e9ed;color:#5b636d}
.est{color:#8a929c;font-size:11px}
td.cps{color:#4a6f9e;font-size:12px}
.hidden{display:none}
.detail td{background:#fbfcfd;padding:0}
.pad{padding:14px 16px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chip{background:#fff;border:1px solid #cfd6de;border-radius:14px;padding:3px 10px;font-size:12px}
.chip.project{border-color:#7fa8dc;background:#eef4fc}
.chip b{font-weight:600}
.chip span{color:#6b7480}
.none{color:#6b7480;font-size:13px;margin-bottom:12px}
.e{border-top:1px solid #eceff2;padding:7px 0}
.e:first-child{border-top:0}
.k{display:inline-block;min-width:78px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
 color:#6b7480;font-weight:600;vertical-align:top}
.e.sub{border-left:3px solid #c3d4ea;padding-left:10px}
.who{font-size:11px;color:#4a6f9e;font-weight:600;margin-right:6px}
pre{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#2b3138}
.e.text pre{color:#1c2024;font-family:inherit;font-size:13.5px}
.e.tool .arg{color:#4b5560;font-family:ui-monospace,Menlo,monospace;font-size:12px;
 overflow-wrap:anywhere}
.e.tool .tn{font-weight:600}
.e.stderr pre{color:#8a6d3b}
.e.outcome{background:#f4f6f8}
.el{display:inline-block;min-width:58px;color:#9aa3ad;font-size:11px;font-variant-numeric:tabular-nums;
 vertical-align:top}
.bar{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;margin:6px -16px;padding:6px 16px;font-size:12.5px}
.bar.checkpoint{background:#e8f1fb;border-top:1px solid #b9d0ec;border-bottom:1px solid #b9d0ec;color:#1d4f8a}
.bar.compaction{background:#fbf3e2;border-top:1px dashed #e2c58a;border-bottom:1px dashed #e2c58a;color:#7a5606}
.bar .k{color:inherit;opacity:.75}
.bar .at{margin-left:auto;color:#6b7480;font-variant-numeric:tabular-nums}
button.more{margin-top:4px;border:1px solid #cfd6de;background:#fff;border-radius:4px;
 padding:1px 8px;font-size:11px;cursor:pointer;color:#3c444d}
`;

/**
 * The viewer.
 *
 * Rows are built on FIRST EXPAND and never before. Run 5's verify phase holds
 * around 2,300 entries; building every phase's DOM up front stalls the page for
 * seconds on the one run anybody wants to look at. The data is all present from
 * the start — nothing is fetched, because nothing can be from file:// — so this
 * is purely about when nodes are created.
 *
 * Written without template literals on purpose: it lives inside one.
 */
const VIEWER = `
(function(){
var D=JSON.parse(document.getElementById('payload').textContent);
var PREVIEW=600;
function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n;}
function dur(ms){
  if(!ms)return '';
  if(ms<1000)return ms+'ms';
  var s=Math.round(ms/1000);
  if(s<60)return (ms/1000).toFixed(1)+'s';
  if(s<3600)return Math.floor(s/60)+'m '+(s%60)+'s';
  return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
}
function since(ms){return '+'+(ms<1000?(ms/1000).toFixed(1)+'s':dur(ms));}
function k(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1000?Math.round(n/1000)+'k':String(n);}
function clock(ts){return new Date(ts).toTimeString().slice(0,8);}
function cell(row,cls,txt){var td=el('td',cls,txt);row.appendChild(td);return td;}
function num(row,value,warn){
  var td=cell(row,'num','');
  var span=el('span',warn?'warnnum':null,String(value));
  td.appendChild(span);return td;
}
function chips(box,p){
  if(!p.agents.length){box.appendChild(el('div','none','No agents dispatched.'));return;}
  var wrap=el('div','chips');
  p.agents.forEach(function(a){
    var c=el('div','chip'+(a.project?' project':''));
    c.appendChild(el('b',null,a.agent));
    var bits=[];
    if(a.description)bits.push(a.description);
    if(a.status&&a.status!=='unknown')bits.push(a.status);
    if(a.durationMs)bits.push(dur(a.durationMs));
    if(a.toolUses)bits.push(a.toolUses+' tools');
    if(bits.length)c.appendChild(el('span',null,' — '+bits.join(' · ')));
    wrap.appendChild(c);
  });
  box.appendChild(wrap);
}
function body(e){
  if(e.kind==='tool'){
    var t=el('span','tn',e.label);
    var line=document.createElement('span');
    line.appendChild(t);
    if(e.text){line.appendChild(el('span','arg',' '+e.text));}
    return line;
  }
  var pre=el('pre',null,e.text.length>PREVIEW?e.text.slice(0,PREVIEW)+'…':e.text);
  if(e.text.length<=PREVIEW)return pre;
  var box=document.createElement('div');
  box.appendChild(pre);
  var b=el('button','more','show all '+e.text.length+' characters');
  b.addEventListener('click',function(){pre.textContent=e.text;b.remove();});
  box.appendChild(b);
  return box;
}
function bar(e){
  var d=el('div','bar '+e.kind);
  if(e.elapsedMs!=null)d.appendChild(el('span','el',since(e.elapsedMs)));
  d.appendChild(el('span','k',e.kind==='checkpoint'?'checkpoint':'compaction'));
  d.appendChild(el('b',null,e.kind==='checkpoint'?e.label:e.label+' at '+e.text));
  if(e.agent)d.appendChild(el('span','who',e.agent));
  if(e.ts)d.appendChild(el('span','at',clock(e.ts)));
  return d;
}
function turns(box,p){
  if(!p.entries.length){box.appendChild(el('div','none','No transcript for this attempt.'));return;}
  p.entries.forEach(function(e){
    if(e.kind==='checkpoint'||e.kind==='compaction'){box.appendChild(bar(e));return;}
    var d=el('div','e '+e.kind+(e.agent?' sub':''));
    if(e.elapsedMs!=null)d.appendChild(el('span','el',since(e.elapsedMs)));
    d.appendChild(el('span','k',e.kind==='tool'?'tool':e.label||e.kind));
    if(e.agent)d.appendChild(el('span','who',e.agent));
    d.appendChild(body(e));
    box.appendChild(d);
  });
}
var tbody=document.getElementById('rows');
D.phases.forEach(function(p){
  var row=el('tr','row');
  cell(row,'phase',p.phase==='ticket'?String(p.lap):p.phase+' / '+p.lap);
  var st=cell(row,null,'');
  st.appendChild(el('span','pill '+p.status,p.status));
  cell(row,null,dur(p.durationMs));
  cell(row,'mono',p.model);
  num(row,p.turns,p.turns===0&&p.attempts>0);
  cell(row,'num',p.tokens?k(p.tokens):'');
  cell(row,null,p.resumed?'yes':'');
  var cps=cell(row,'cps',p.checkpoints.map(function(c){return c.replace(/^superpowers:/,'');}).join(', '));
  cps.title=p.checkpoints.join(', ');
  cell(row,'err',p.error);
  var detail=el('tr','detail hidden');
  var host=cell(detail,null,'');
  host.colSpan=9;
  var built=false;
  row.addEventListener('click',function(){
    if(!built){
      built=true;
      var pad=el('div','pad');
      chips(pad,p);
      turns(pad,p);
      host.appendChild(pad);
    }
    detail.classList.toggle('hidden');
    row.classList.toggle('open');
  });
  tbody.appendChild(row);
  tbody.appendChild(detail);
});
})();
`;

/**
 * Status, how long it took, what it cost, where it landed. Tokens and cost are
 * the SDK's figures for a subscription that bills nothing per call, hence est.
 */
function headerHtml(m: ReportModel): string {
  const bits: string[] = [];
  const s = m.summary;
  bits.push(`<span><b class="pill ${escapeHtml(m.status)}">${escapeHtml(m.status)}</b>${s?.live ? ' live' : ''}</span>`);
  if (s) {
    bits.push(`<span><b>${fmtDuration(s.durationMs)}</b> wall clock</span>`);
    bits.push(`<span><b>${s.attempts}</b> attempt${s.attempts === 1 ? '' : 's'}</span>`);
    bits.push(`<span><b>${s.turns}</b> turns</span>`);
    bits.push(`<span><b>${fmtTokens(s.tokens)}</b> tokens <span class="est">est.</span></span>`);
    bits.push(`<span><b>$${s.costUsd.toFixed(2)}</b> <span class="est">est.</span></span>`);
  }
  if (m.mrUrl) bits.push(`<span><a href="${escapeHtml(m.mrUrl)}">MR !${m.mrIid ?? ''}</a></span>`);
  bits.push(`<span>merged <b>${m.merged ? 'yes' : 'no'}</b></span>`);
  for (const a of m.artifacts) bits.push(`<span><a href="${escapeHtml(a.href)}">${escapeHtml(a.name)}</a></span>`);
  if (m.url) bits.push(`<span><a href="${escapeHtml(m.url)}">ticket #${m.iid}</a></span>`);
  bits.push(`<span><b>${m.agentCount}</b> agents</span>`);
  if (m.runId) bits.push(`<span>${escapeHtml(m.runId)}</span>`);
  if (m.blockedWhy) bits.push(`<span>blocked: ${escapeHtml(m.blockedWhy.slice(0, 200))}</span>`);
  return `<header>
<h1><span class="iid">#${m.iid}</span> ${escapeHtml(m.title || 'untitled run')}</h1>
<div class="meta">${bits.join('')}</div>
</header>`;
}

export function renderHtml(m: ReportModel): string {
  const cols = ['attempt', 'status', 'duration', 'model', 'turns', 'tokens', 'resumed', 'checkpoints', 'error'];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>oneshot run #${m.iid}</title>
<style>${STYLE}</style></head>
<body>
${headerHtml(m)}
<main>
<table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
<tbody id="rows"></tbody></table>
</main>
<script type="application/json" id="payload">${embed(m)}</script>
<script>${VIEWER}</script>
</body></html>
`;
}

/**
 * Write `state/runs/<iid>/report.html` — the single-file export behind
 * `npm run report` — returning its path or null.
 *
 * The conductor does not call this at finish; the dashboard renders the same
 * page in memory. It is still built so it CANNOT fail a caller: a malformed
 * transcript, a directory archived out from under it, a file too large to read
 * — every one of those is a warning and a null.
 */
export function writeRunReport(iid: number): string | null {
  try {
    const model = buildReportModel(runDir(iid));
    if (!model) return null;
    const path = join(runDir(iid), 'report.html');
    writeFileSync(path, renderHtml(model));
    return path;
  } catch (err) {
    log.warn(`report: could not write the report for #${iid}`, { error: (err as Error).message });
    return null;
  }
}
