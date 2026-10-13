import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/test-project-env.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySessionEnd, foldFrame, newFrameFold, shouldPark, sessionEnv, queryOptions, sessionMcpServers, NO_STRUCTURED_OUTPUT } from './session.js';
import { SERVER_DENIED_TOOLS_REGEX } from './types.js';

process.env.ONESHOT_GITLAB_TOKEN = 'glpat-test';   // resolveToken() stops here: no desk file, no keychain lookup

const base = { sawActivity: 10, stalled: false, timedOut: false, cancelled: false, stderrTail: '' };

test('classifySessionEnd: success→ok, error_max_turns→failed, stalled/timeout/cancel/zero-activity/signal→infra', () => {
  assert.equal(classifySessionEnd({ ...base, subtype: 'success' }), 'ok');
  assert.equal(classifySessionEnd({ ...base, subtype: 'error_max_turns' }), 'failed');
  assert.equal(classifySessionEnd({ ...base, subtype: 'error_during_execution', error: 'boom' }), 'failed');
  assert.equal(classifySessionEnd({ ...base, stalled: true }), 'infra');
  assert.equal(classifySessionEnd({ ...base, timedOut: true }), 'infra');
  assert.equal(classifySessionEnd({ ...base, cancelled: true }), 'aborted');
  assert.equal(classifySessionEnd({ ...base, sawActivity: 0, error: 'exited with code 1' }), 'infra');
  assert.equal(classifySessionEnd({ ...base, error: 'Claude Code process exited with signal SIGKILL' }), 'infra');
  assert.equal(classifySessionEnd({ ...base, subtype: 'success', stderrTail: '[ACTION REQUIRED] accept the terms' }), 'ok'); // a finished session is not gated
  assert.equal(classifySessionEnd({ ...base, subtype: 'error_during_execution', stderrTail: '[ACTION REQUIRED] accept the terms' }), 'infra');
});

// ------------------------------------------------------------- the frame fold

const SID = '5f0c2a8e-0000-4000-8000-000000000001';
const init = { type: 'system', subtype: 'init', session_id: SID };
const say = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant', session_id: SID, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] }, ...extra });

test('foldFrame: the session id is taken from the first frame that carries one, with no result frame at all', () => {
  const f = newFrameFold();
  // A session that stalled (or was cancelled, or parked) mid-work: frames, then nothing.
  for (const msg of [init, say('reading the ticket'), say('writing the plan')]) assert.equal(foldFrame(f, msg as never), 'continue');
  assert.equal(f.out.sessionId, SID);
  assert.equal(f.settled, false);
  assert.equal(f.out.resultSubtype, undefined);
  assert.equal(f.turns, 2);
  assert.equal(f.out.sawActivity, 3);
});

test('foldFrame: the first result frame settles and its session id stands; a trailing one is ignored', () => {
  const f = newFrameFold();
  foldFrame(f, init as never);
  foldFrame(f, { type: 'result', subtype: 'success', session_id: 'from-result', num_turns: 9, structured_output: { summary: 's' }, result: '' } as never);
  foldFrame(f, { type: 'result', subtype: 'error_during_execution', session_id: 'late', num_turns: 0, errors: ['x'] } as never);
  assert.equal(f.out.sessionId, 'from-result');
  assert.equal(f.out.turns, 9);
  assert.equal(f.out.resultSubtype, 'success');
  assert.deepEqual(f.out.result, { summary: 's' });
});

test('model prose that reads like a reset time neither stops the session nor parks the conductor', () => {
  const f = newFrameFold();
  foldFrame(f, init as never);
  assert.equal(foldFrame(f, say('The leave balance resets at 12 am on 1 January, so the accrual job runs then.') as never), 'continue');
  assert.equal(foldFrame(f, say('Users who hit the session limit see a toast.') as never), 'continue');
  // A success without structured output: its prose is not a quota signal either.
  foldFrame(f, { type: 'result', subtype: 'success', session_id: SID, num_turns: 3, result: 'Done — the balance resets at 12 am.' } as never);
  assert.equal(f.out.error, NO_STRUCTURED_OUTPUT);
  assert.equal(f.rateLimited, false);
  assert.deepEqual(f.limitSignals, []);
  assert.equal(shouldPark(f), false);
});

test('a frame the CLI tags error: rate_limit stops the session and parks; other error tags only when they read as a limit', () => {
  const f = newFrameFold();
  foldFrame(f, init as never);
  assert.equal(foldFrame(f, say("You've hit your limit · resets 4:30pm", { error: 'rate_limit' }) as never), 'stop');
  assert.equal(f.rateLimited, true);
  assert.match(f.out.error!, /^rate_limit: /);
  assert.equal(f.out.sessionId, SID, 'a parked session keeps its id for the resume');
  assert.equal(shouldPark(f), true);

  const g = newFrameFold();
  assert.equal(foldFrame(g, say('Output was cut off', { error: 'max_output_tokens' }) as never), 'continue');
  assert.equal(foldFrame(g, say('Usage limit reached · resets 9pm', { error: 'unknown' }) as never), 'stop');

  // The prose matcher still reads result errors.
  const h = newFrameFold();
  foldFrame(h, { type: 'result', subtype: 'error_during_execution', session_id: SID, num_turns: 1, errors: ["You've hit your usage limit"] } as never);
  assert.equal(shouldPark(h), true);
});

test('sessionEnv carries the identity, write scopes, artifacts and labels, and never a token or API key', () => {
  process.env.GITLAB_TOKEN = 'glpat-secret'; process.env.ANTHROPIC_API_KEY = 'sk-no';
  const env = sessionEnv({ iid: 1, runId: 'r-1', lap: 0, ticket: { iid: 1, title: 't', description: '', labels: ['Loop', 'Bug'], notes: [], documents: [], externalDocs: [] }, worktree: '/wt', branch: 'oneshot/ticket-1-t', port: 8000, previousAttempt: false });
  assert.equal(env.ONESHOT_PHASE, 'ticket');
  // harness.cjs and app.cjs read ONESHOT_IID; without it their files land in state/runs/adhoc.
  assert.equal(env.ONESHOT_IID, '1');
  assert.equal(env.ONESHOT_IID, env.ONESHOT_TICKET);
  assert.equal(env.ONESHOT_TICKET_LABELS, 'Loop,Bug');
  assert.ok(env.ONESHOT_WRITE_SCOPES!.startsWith('/wt:'));
  assert.ok(env.ONESHOT_ARTIFACTS!.endsWith('/state/runs/1/artifacts'));
  assert.equal(env.GITLAB_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('queryOptions pins the Solo contract', () => {
  process.env.ONESHOT_SUPERPOWERS_PATH = '/sp';
  const o = queryOptions({ iid: 1, runId: 'r-1', lap: 0, ticket: { iid: 1, title: 't', description: '', labels: [], notes: [], documents: [], externalDocs: [] }, worktree: '/wt', branch: 'b', port: 8000, previousAttempt: false }, { env: {}, abortController: new AbortController(), stderr: () => {} }) as Record<string, unknown>;
  assert.deepEqual(o.settingSources, ['project']);
  assert.deepEqual(o.plugins, [{ type: 'local', path: '/sp' }]);
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.ok((o.disallowedTools as string[]).includes('AskUserQuestion'));
  assert.equal((o.outputFormat as { type: string }).type, 'json_schema');
  assert.equal(o.cwd, '/wt');
  assert.equal(o.maxTurns, 600);
});

type Stdio = { command: string; args: string[]; env: Record<string, string> };

test('sessionMcpServers: one `gitlab` server through the shim, BASE_ENV underneath, the token only here', () => {
  process.env.ONESHOT_GITLAB_TOKEN = 'glpat-mcp-only';
  const gl = (sessionMcpServers(7) as Record<string, Stdio>).gitlab!;
  assert.deepEqual(Object.keys(sessionMcpServers(7)), ['gitlab']);   // DENIED_TOOLS and mr-gate.cjs match mcp__gitlab__*
  assert.equal(gl.command, process.execPath);
  assert.match(gl.args[0]!, /scripts\/mcp-gitlab\.cjs$/);
  assert.ok(gl.env.PATH && gl.env.HOME, 'the server env REPLACES the subprocess env, so PATH and HOME must be in it');
  assert.ok(gl.env.ONESHOT_ARTIFACTS!.endsWith('/state/runs/7/artifacts'));
  assert.equal(gl.env.GITLAB_PERSONAL_ACCESS_TOKEN, 'glpat-mcp-only');
  assert.equal(gl.env.GITLAB_API_URL, 'https://gitlab.example.com/api/v4');
  assert.deepEqual(gl.env.GITLAB_TOOLS!.split(','), ['create_merge_request_note', 'upload_markdown']);
  assert.equal(gl.env.GITLAB_PERMISSION_MODE, 'modify');
  assert.equal(gl.env.GITLAB_DENIED_TOOLS_REGEX, SERVER_DENIED_TOOLS_REGEX);
  assert.equal(gl.env.ENABLE_STRICT_PROJECT_SCOPE, 'true');
  const s = sessionEnv({ iid: 7, runId: 'r-7', lap: 0, ticket: { iid: 7, title: 't', description: '', labels: [], notes: [], documents: [], externalDocs: [] }, worktree: '/wt', branch: 'b', port: 8000, previousAttempt: false });
  assert.ok(!Object.values(s).includes('glpat-mcp-only'), 'the GitLab token never reaches the session env');
});

test('sessionMcpServers holds the server to the numeric project id alone: one allowlist entry, never the path', () => {
  process.env.ONESHOT_GITLAB_TOKEN = 'glpat-test';
  const scoped = (sessionMcpServers(7, 123) as Record<string, Stdio>).gitlab!;
  // 2.2.4's getEffectiveProjectId defaults a call that omits project_id only from a ONE-entry allowlist.
  assert.equal(scoped.env.GITLAB_ALLOWED_PROJECT_IDS, '123');
  assert.equal(scoped.env.GITLAB_PROJECT_ID, '123');
  const unknown = (sessionMcpServers(7) as Record<string, Stdio>).gitlab!;
  assert.equal(unknown.env.GITLAB_ALLOWED_PROJECT_IDS, undefined);
  assert.equal(unknown.env.GITLAB_PROJECT_ID, undefined);
  for (const env of [scoped.env, unknown.env]) {
    assert.ok(!(env.GITLAB_ALLOWED_PROJECT_IDS ?? '').includes(','), 'no multi-entry allowlist');
    assert.ok(!Object.values(env).includes('acme/erp'), 'the path is never a server project value');
  }
});

test('sessionEnv names the project for mr-gate: its path always, its numeric id when the conductor resolved one', () => {
  const input = { iid: 7, runId: 'r-7', lap: 0, ticket: { iid: 7, title: 't', description: '', labels: [], notes: [], documents: [], externalDocs: [] }, worktree: '/wt', branch: 'b', port: 8000, previousAttempt: false };
  const unknown = sessionEnv(input);
  assert.equal(unknown.ONESHOT_PROJECT_PATH, 'acme/erp');
  assert.equal(unknown.ONESHOT_PROJECT_ID, '', 'blank, so a retired ONESHOT_PROJECT_ID in .env cannot stand in for it');
  // ONESHOT_PROJECT is a retired selector that app.cjs judges against the project NAME; a path there would refuse every bring-up.
  assert.equal(unknown.ONESHOT_PROJECT, '');
  assert.equal(sessionEnv({ ...input, projectId: 304 }).ONESHOT_PROJECT_ID, '304');
});

/**
 * Speaks MCP over stdio to the configured server, spawned with EXACTLY the
 * configured env (the SDK replaces the subprocess env), and asks it to upload
 * `screens/01-before.png` — a path relative to ONESHOT_ARTIFACTS. A fake GitLab
 * records the multipart POST; the file's bytes arriving there is the proof that
 * the server ran with ONESHOT_ARTIFACTS as its cwd.
 */
test('the gitlab shim runs the server from ONESHOT_ARTIFACTS, so upload_markdown takes a relative path — on this project only', async () => {
  const artifacts = join(mkdtempSync(join(tmpdir(), 'solo-mcp-')), 'artifacts');   // not created: the shim must create it
  const uploads: string[] = [];
  const requests: string[] = [];
  const gitlab = createServer((req, res) => {
    const chunks: Buffer[] = [];
    requests.push(`${req.method} ${req.url}`);
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.startsWith('/api/v4/projects/1/merge_requests')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[]');
      } else if (req.method === 'POST' && req.url === '/api/v4/projects/1/uploads') {
        uploads.push(Buffer.concat(chunks).toString('latin1'));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 1, alt: '01-before', url: '/uploads/x/01-before.png', full_path: '/acme/erp/uploads/x/01-before.png', markdown: '![01-before](/uploads/x/01-before.png)' }));
      } else { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise<void>((r) => gitlab.listen(0, '127.0.0.1', r));
  const port = (gitlab.address() as { port: number }).port;

  process.env.ONESHOT_GITLAB_TOKEN = 'glpat-test';
  const gl = (sessionMcpServers(7, 1) as Record<string, Stdio>).gitlab!;
  const env = { ...gl.env, ONESHOT_ARTIFACTS: artifacts, GITLAB_API_URL: `http://127.0.0.1:${port}/api/v4`, GITLAB_DISABLE_VERSION_CHECK: 'true' };
  const child = spawn(gl.command, gl.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const replies = new Map<number, (v: Record<string, unknown>) => void>();
  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line) as { id?: number }; if (typeof m.id === 'number') replies.get(m.id)?.(m); } catch { /* not a JSON-RPC line */ }
    }
  });
  let next = 0;
  const call = (method: string, params: unknown): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const id = ++next;
    const t = setTimeout(() => reject(new Error(`${method} timed out; server stderr:\n${stderr.slice(-2000)}`)), 15_000);
    replies.set(id, (v) => { clearTimeout(t); resolve(v); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'session.test', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = ((await call('tools/list', {})).result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.ok(tools.includes('upload_markdown'), 'GITLAB_TOOLS adds upload_markdown to the default toolset');
    assert.ok(tools.includes('create_merge_request_note'), 'GITLAB_TOOLS adds create_merge_request_note to the default toolset');
    for (const t of ['create_merge_request', 'update_merge_request']) assert.ok(tools.includes(t), `${t} stays listed`);
    // The server's own limits: the deny regex and modify mode, whatever the SDK does.
    for (const t of ['merge_merge_request', 'create_issue_note', 'push_files', 'execute_graphql', 'delete_branch']) {
      assert.ok(!tools.includes(t), `${t} must not be listed`);
    }

    mkdirSync(join(artifacts, 'screens'), { recursive: true });
    writeFileSync(join(artifacts, 'screens', '01-before.png'), 'PNG-BYTES-FROM-ARTIFACTS');
    const res = await call('tools/call', { name: 'upload_markdown', arguments: { project_id: '1', file_path: 'screens/01-before.png' } });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.notEqual((res.result as { isError?: boolean }).isError, true, JSON.stringify(res.result));
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0]!.includes('PNG-BYTES-FROM-ARTIFACTS'));

    // Another project the token could reach is refused by the server before any request.
    const other = await call('tools/call', { name: 'upload_markdown', arguments: { project_id: '2', file_path: 'screens/01-before.png' } });
    assert.equal((other.result as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(other.result), /not in the allowed project list/);
    assert.equal(uploads.length, 1);

    // A call that omits project_id defaults to the one allowed project instead of failing "Multiple projects allowed".
    const mrs = await call('tools/call', { name: 'list_merge_requests', arguments: {} });
    assert.equal(mrs.error, undefined, JSON.stringify(mrs.error));
    assert.notEqual((mrs.result as { isError?: boolean }).isError, true, JSON.stringify(mrs.result));
    assert.ok(requests.some((r) => r.startsWith('GET /api/v4/projects/1/merge_requests')), requests.join('\n'));
  } finally {
    child.kill();
    gitlab.close();
    rmSync(join(artifacts, '..'), { recursive: true, force: true });
  }
});
