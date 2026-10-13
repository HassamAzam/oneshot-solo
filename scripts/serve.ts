/**
 * `npm run dashboard` — one URL that lists every run and opens any of them.
 *
 * The index answers the operator's three questions about every ticket at once
 * — its status, how long it took, what it cost (est.) — and turns each row into
 * a link to the run's page: the attempts, the agents each one dispatched,
 * checkpoint and compaction markers, and the readable transcript.
 *
 * Deliberately small. Node's own http module, no dependency, no build step, no
 * websocket and no polling — a page is rendered from the run directory at the
 * moment you ask for it, so a refresh is the whole update mechanism. That is
 * enough because a run takes hours and the interesting moment is when it ends.
 *
 * Pages are rendered in memory from the live run directory or an archived one
 * alike, so opening a page can never race the conductor writing the journal it
 * reads. The index is also where a ticket is started: type its number and the
 * dashboard queues it (src/lib/queue.ts — the one thing here that writes to
 * state/), and the conductor runs it next. The dashboard never runs a ticket
 * itself; when no conductor is up, the page says so and can start one.
 *
 * Only a POST changes anything, and only from this page: a POST whose Origin
 * or Referer names another site is refused, so a page elsewhere in the
 * operator's browser cannot queue work on this desk.
 *
 * Importing this module starts nothing: the server is created and bound only
 * when the file is run as the entry point, so a test can import rows().
 */
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNS_ARCHIVE, TICK_MS, envOr, runDir } from '../src/lib/config.js';
import { conductorLive, enqueue, queued, startConductor } from '../src/lib/queue.js';
import { buildReportModel, renderHtml } from '../src/lib/report.js';
import { allRuns, fmtDuration, fmtTokens, type RunSummary } from '../src/lib/telemetry.js';

const PORT = Number(envOr('ONESHOT_DASHBOARD_PORT', '8787'));

/** Every run we can show, live and archived, newest first — the list `npm run status` prints. */
export function rows(): RunSummary[] {
  return allRuns();
}

/**
 * The directory a page reads from: the live run, or with `?archived=<name>` that
 * archived run. The name comes off the URL, so it must be a direct child of
 * RUNS_ARCHIVE and belong to this iid (archiveRun names them `<iid>-<runId>`).
 */
function runDirFor(iid: number, archived: string | null): string | null {
  if (!archived) return runDir(iid);
  if (archived !== basename(archived) || !archived.startsWith(`${iid}-`)) return null;
  return join(RUNS_ARCHIVE, archived);
}

const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const AGE = (ms: number): string => {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

function mrCell(r: RunSummary): string {
  if (!r.mrUrl || !/^https?:\/\//.test(r.mrUrl)) return '';
  const link = `<a href="${esc(r.mrUrl)}">${esc(r.mrUrl.replace(/^.*\//, '!'))}</a>`;
  return r.merged ? `${link} <span class="tag">merged</span>` : link;
}

/** A ticket number as typed: digits only, above zero. Null for anything else. */
function positiveIid(raw: string | null): number | null {
  const s = (raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * `POST /run` with a urlencoded `iid`: queue that ticket for the conductor and
 * send the browser back to the index, which says it is queued.
 */
export async function handleRun(body: string): Promise<{ code: number; location?: string; body?: string }> {
  const iid = positiveIid(new URLSearchParams(body).get('iid'));
  if (iid === null) return { code: 400, body: 'iid must be a positive ticket number' };
  enqueue(iid, 'dashboard');
  return { code: 303, location: `/?queued=${iid}` };
}

/**
 * Whether a POST came from this dashboard. A browser names the page a form was
 * sent from in Origin (or, failing that, Referer); it must be this server,
 * reached as 127.0.0.1 or localhost on its own port. No header at all is a
 * client on this machine that is not a browser page — curl, a script — and is
 * let through: the server is bound to loopback, so nothing else can reach it.
 */
export function sameOrigin(h: { origin?: string; referer?: string }, port: number = PORT): boolean {
  const from = h.origin ?? h.referer;
  if (from === undefined) return true;
  try {
    const u = new URL(from);
    if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) return false;
    return Number(u.port || 80) === port;
  } catch {
    return false;                                     // `null` (a sandboxed frame, file://) or junk
  }
}

const NOTICES = new Map<string, string>([
  ['started', 'Conductor starting — its pid shows here once it has booted; refresh in a few seconds. Its output goes to <code>state/conductor.log</code>.'],
  ['busy', 'Conductor not started again: one is already running or starting.'],
]);

/**
 * The index. `params` is the query string a POST redirected back with:
 * `?queued=<iid>` confirms a queued ticket, `?conductor=started|busy` a start.
 */
export function index(params: URLSearchParams = new URLSearchParams()): string {
  const all = rows();
  // The run in flight first: what the desk is working on now is the first question.
  const list = [...all.filter((r) => r.live), ...all.filter((r) => !r.live)];
  const waiting = queued();
  const conductor = conductorLive();
  const justQueued = positiveIid(params.get('queued'));
  const notices = [
    justQueued !== null ? `#${justQueued} queued — the conductor picks it up on its next tick (within ${TICK_MS / 1000} s)` : '',
    NOTICES.get(params.get('conductor') ?? '') ?? '',
  ].filter(Boolean);

  const row = (r: RunSummary): string => `
    <tr${r.live ? ' class="live"' : ''}>
      <td class="iid"><a href="/run/${r.iid}${r.archived ? `?archived=${encodeURIComponent(r.archived)}` : ''}">#${r.iid}</a></td>
      <td class="ttl">${esc(r.title)}${r.archived ? ' <span class="tag">archived</span>' : ''}</td>
      <td class="st">${r.live ? '<span class="pill p-running">● running</span>' : `<span class="pill p-${esc(r.status)}">${esc(r.status)}</span>`}</td>
      <td class="num">${esc(fmtDuration(r.durationMs))}</td>
      <td class="num">${r.attempts}</td>
      <td class="num">${r.turns}</td>
      <td class="num">${esc(fmtTokens(r.tokens))}</td>
      <td class="mr">${mrCell(r)}</td>
      <td class="dim">${esc(AGE(r.createdAt))}</td>
    </tr>`;

  return `<!doctype html><meta charset="utf-8"><title>Oneshot runs</title>
<style>
  :root { color-scheme: light dark }
  body { font: 14px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif; margin: 0; padding: 2rem;
         max-width: 72rem; background: Canvas; color: CanvasText }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem }
  p.sub { margin: 0 0 1.5rem; opacity: .6 }
  table { border-collapse: collapse; width: 100% }
  th { text-align: left; font-weight: 600; font-size: .75rem; text-transform: uppercase;
       letter-spacing: .04em; opacity: .55; padding: 0 .6rem .5rem; white-space: nowrap }
  td { padding: .55rem .6rem; border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent) }
  tr:hover td { background: color-mix(in srgb, CanvasText 4%, transparent) }
  .iid a { font-weight: 600; text-decoration: none; color: inherit }
  .iid a:hover { text-decoration: underline }
  .ttl { width: 45% }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap }
  .st, .mr, .dim { white-space: nowrap } .dim { opacity: .55 }
  .tag { font-size: .7rem; opacity: .6; border: 1px solid; border-radius: 3px; padding: 0 .25rem }
  .pill { font-size: .72rem; padding: .1rem .45rem; border-radius: 999px;
          background: color-mix(in srgb, CanvasText 10%, transparent) }
  .p-done { background: color-mix(in srgb, #16a34a 25%, transparent) }
  .p-blocked, .p-aborted { background: color-mix(in srgb, #dc2626 25%, transparent) }
  .p-running, .p-claimed { background: color-mix(in srgb, #2563eb 25%, transparent) }
  .empty { opacity: .6; padding: 2rem 0 }
  form { display: inline; margin: 0 }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1.5rem; margin: 0 0 1rem }
  input, button { font: inherit; color: inherit; padding: .3rem .6rem; border-radius: 6px;
                  border: 1px solid color-mix(in srgb, CanvasText 25%, transparent) }
  input { width: 9rem; background: Canvas }
  button { background: color-mix(in srgb, CanvasText 8%, transparent); cursor: pointer }
  button:hover { background: color-mix(in srgb, CanvasText 14%, transparent) }
  .on { color: #16a34a } .off { color: #dc2626 }
  .notice { margin: 0 0 1rem; padding: .5rem .75rem; border-radius: 6px;
            background: color-mix(in srgb, #2563eb 14%, transparent) }
  .queue { margin: 0 0 1.25rem } .queue ul { margin: .25rem 0 0; padding-left: 1.25rem }
  tr.live td { background: color-mix(in srgb, #2563eb 7%, transparent) }
</style>
<h1>Oneshot runs</h1>
<p class="sub">${list.length} run${list.length === 1 ? '' : 's'} — click a ticket for its attempts, checkpoints and transcript. Tokens are estimates. Refresh for current state.</p>
${notices.map((n) => `<p class="notice">${n}</p>`).join('\n')}
<div class="bar">
  <form method="post" action="/run"><input name="iid" inputmode="numeric" pattern="[0-9]+" placeholder="ticket number" aria-label="ticket number" required> <button>Run</button></form>
  ${conductor.live
    ? `<div><span class="on">●</span> conductor running (pid ${conductor.pid})</div>`
    : '<div><span class="off">●</span> conductor not running — <form method="post" action="/conductor/start"><button>Start it</button></form></div>'}
</div>
${waiting.length ? `<div class="queue"><b>queued</b>${conductor.live ? '' : ' — waiting for the conductor'}
  <ul>${waiting.map((q) => `<li>#${q.iid} · queued ${esc(AGE(q.requestedAt))} · from ${esc(q.by)}</li>`).join('')}</ul>
</div>` : ''}
${list.length ? `<table>
  <tr><th>#</th><th>Title</th><th>Status</th><th>Duration</th><th>Attempts</th><th>Turns</th><th>Tokens (est.)</th><th>MR</th><th>When</th></tr>
  ${list.map(row).join('')}
</table>` : '<p class="empty">No runs yet. Type a ticket number above and press Run, or label a ticket <code>Loop</code>.</p>'}`;
}

/**
 * A run's page, rendered on demand from its directory — live or archived — so
 * it is current even for a run still in flight.
 */
function runPage(iid: number, archived: string | null): { code: number; body: string } {
  const dir = runDirFor(iid, archived);
  const model = dir ? buildReportModel(dir) : null;
  if (!model) return { code: 404, body: `<p style="font:14px sans-serif">No run found for #${iid}${archived ? ` (${esc(archived)})` : ''}. <a href="/">All runs</a></p>` };
  return { code: 200, body: renderHtml(model) };
}

const ARTIFACT_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  mp4: 'video/mp4', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8',
};

/**
 * A file under a run's `artifacts/`, or null.
 *
 * The session writes that directory, and the name comes off the URL, so both
 * are resolved — symlinks included — and the file must still sit under the
 * artifacts dir afterwards. `..`, an encoded slash or a link pointing out of
 * the run all end up somewhere else and are refused.
 */
function artifactFile(iid: number, archived: string | null, name: string): string | null {
  const dir = runDirFor(iid, archived);
  if (!dir) return null;
  const root = resolve(dir, 'artifacts');
  const file = resolve(root, name);
  if (!file.startsWith(root + sep) || !existsSync(file)) return null;
  const real = realpathSync(file);
  if (!real.startsWith(realpathSync(root) + sep) || !statSync(real).isFile()) return null;
  return real;
}

/** A request body up to `limit` bytes, or null past it — a form with one number in it is a few bytes. */
function readBody(req: IncomingMessage, limit = 1024): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;                               // drained and dropped
      size += c.length;
      if (size > limit) { over = true; resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

type Reply = { code: number; location?: string; body?: string };

/** The two writes — queue a ticket, start the conductor — each answered with a redirect to the index. */
async function post(req: IncomingMessage, path: string): Promise<Reply> {
  if (!sameOrigin(req.headers)) return { code: 403, body: 'Refused: a POST must come from this dashboard.' };
  if (path === '/run') {
    const body = await readBody(req);
    return body === null ? { code: 413, body: 'Request body too large.' } : handleRun(body);
  }
  if (path === '/conductor/start') {
    const out = startConductor();
    if (out.started) return { code: 303, location: '/?conductor=started' };
    if (out.why?.startsWith('already')) return { code: 303, location: '/?conductor=busy' };
    return { code: 500, body: `Conductor not started: ${out.why ?? 'unknown'}` };
  }
  return { code: 404, body: 'Not found.' };
}

function main(): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const send = (code: number, body: string, type = 'text/html; charset=utf-8'): void => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const fail = (err: unknown): void => send(500, `<pre>${esc((err as Error).message)}</pre>`);

    // Only a POST changes anything; `GET /run` is not a route.
    if (req.method === 'POST') {
      post(req, url.pathname).then((out) => {
        if (!out.location) return send(out.code, out.body ?? '', 'text/plain; charset=utf-8');
        res.writeHead(out.code, { location: out.location, 'cache-control': 'no-store' });
        res.end();
      }).catch(fail);
      return;
    }

    try {
      if (url.pathname === '/') return send(200, index(url.searchParams));

      const m = url.pathname.match(/^\/run\/(\d+)$/);
      if (m) {
        const out = runPage(Number(m[1]), url.searchParams.get('archived'));
        return send(out.code, out.body);
      }

      // The design, plan and screenshots the session wrote, so a run page can link them.
      const a = url.pathname.match(/^\/artifacts\/(\d+)\/(.+)$/);
      if (a) {
        let name: string;
        try { name = decodeURIComponent(a[2]!); } catch { return send(400, 'Bad path', 'text/plain'); }
        const file = artifactFile(Number(a[1]), url.searchParams.get('archived'), name);
        if (!file) return send(404, 'Not found', 'text/plain');
        const ext = file.split('.').pop()?.toLowerCase() ?? '';
        res.writeHead(200, {
          'content-type': ARTIFACT_TYPES[ext] ?? 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        return res.end(readFileSync(file));
      }

      return send(404, '<p style="font:14px sans-serif">Not found. <a href="/">All runs</a></p>');
    } catch (err) {
      return fail(err);
    }
  });

  // Loopback, explicitly. `listen(PORT)` with no host binds every interface, so
  // the page was reachable from any machine on the network while the banner
  // promised localhost — and it renders run journals, which carry whatever a
  // failing session quoted into its own error text. Verified once from a LAN
  // address: 200, with the pinned ONESHOT_TEST_LOGIN password in the body.
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Oneshot dashboard  →  http://localhost:${PORT}\n`);
    console.log('  Lists every run. Click a ticket for its attempts, checkpoints');
    console.log('  and transcript. Type a ticket number and press Run to queue it');
    console.log('  for the conductor. Refresh for current state.');
    console.log('  Ctrl-C to stop.\n');
  });
}

/** True when this file is the entry point (`tsx scripts/serve.ts`), not an import. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(entry)).href; } catch { return false; }
}

if (isMain()) main();
