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
 * Nothing here writes to state/. Pages are rendered in memory from the live
 * run directory or an archived one alike, so opening a page can never race the
 * conductor writing the journal it reads.
 *
 * Importing this module starts nothing: the server is created and bound only
 * when the file is run as the entry point, so a test can import rows().
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNS_ARCHIVE, envOr, runDir } from '../src/lib/config.js';
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
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

function mrCell(r: RunSummary): string {
  if (!r.mrUrl || !/^https?:\/\//.test(r.mrUrl)) return '';
  const link = `<a href="${esc(r.mrUrl)}">${esc(r.mrUrl.replace(/^.*\//, '!'))}</a>`;
  return r.merged ? `${link} <span class="tag">merged</span>` : link;
}

function index(): string {
  const list = rows();
  const row = (r: RunSummary): string => `
    <tr>
      <td class="iid"><a href="/run/${r.iid}${r.archived ? `?archived=${encodeURIComponent(r.archived)}` : ''}">#${r.iid}</a></td>
      <td class="ttl">${esc(r.title)}${r.archived ? ' <span class="tag">archived</span>' : ''}</td>
      <td class="st"><span class="pill p-${esc(r.status)}">${esc(r.status)}</span>${r.live ? ' <span class="tag">live</span>' : ''}</td>
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
</style>
<h1>Oneshot runs</h1>
<p class="sub">${list.length} run${list.length === 1 ? '' : 's'} — click a ticket for its attempts, checkpoints and transcript. Tokens are estimates. Refresh for current state.</p>
${list.length ? `<table>
  <tr><th>#</th><th>Title</th><th>Status</th><th>Duration</th><th>Attempts</th><th>Turns</th><th>Tokens (est.)</th><th>MR</th><th>When</th></tr>
  ${list.map(row).join('')}
</table>` : '<p class="empty">No runs yet. Label a ticket <code>Loop</code> and start the conductor.</p>'}`;
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

function main(): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const send = (code: number, body: string, type = 'text/html; charset=utf-8'): void => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };

    try {
      if (url.pathname === '/') return send(200, index());

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
      return send(500, `<pre>${esc((err as Error).message)}</pre>`);
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
    console.log('  and transcript. Refresh for current state.');
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
