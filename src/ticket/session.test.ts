import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../lib/test-project-env.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySessionEnd, sessionEnv, queryOptions, sessionMcpServers } from './session.js';

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

test('sessionEnv carries the identity, write scopes, artifacts and labels, and never a token or API key', () => {
  process.env.GITLAB_TOKEN = 'glpat-secret'; process.env.ANTHROPIC_API_KEY = 'sk-no';
  const env = sessionEnv({ iid: 1, runId: 'r-1', lap: 0, ticket: { iid: 1, title: 't', description: '', labels: ['Loop', 'Bug'], notes: [], documents: [], externalDocs: [] }, worktree: '/wt', branch: 'oneshot/ticket-1-t', port: 8000, previousAttempt: false });
  assert.equal(env.ONESHOT_PHASE, 'ticket');
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
  assert.equal(gl.env.GITLAB_PERMISSION_MODE, 'full');
  const s = sessionEnv({ iid: 7, runId: 'r-7', lap: 0, ticket: { iid: 7, title: 't', description: '', labels: [], notes: [], documents: [], externalDocs: [] }, worktree: '/wt', branch: 'b', port: 8000, previousAttempt: false });
  assert.ok(!Object.values(s).includes('glpat-mcp-only'), 'the GitLab token never reaches the session env');
});

/**
 * Speaks MCP over stdio to the configured server, spawned with EXACTLY the
 * configured env (the SDK replaces the subprocess env), and asks it to upload
 * `screens/01-before.png` — a path relative to ONESHOT_ARTIFACTS. A fake GitLab
 * records the multipart POST; the file's bytes arriving there is the proof that
 * the server ran with ONESHOT_ARTIFACTS as its cwd.
 */
test('the gitlab shim runs the server from ONESHOT_ARTIFACTS, so upload_markdown takes a relative path', async () => {
  const artifacts = join(mkdtempSync(join(tmpdir(), 'solo-mcp-')), 'artifacts');   // not created: the shim must create it
  const uploads: string[] = [];
  const gitlab = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/v4/projects/1/uploads') {
        uploads.push(Buffer.concat(chunks).toString('latin1'));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 1, alt: '01-before', url: '/uploads/x/01-before.png', full_path: '/acme/erp/uploads/x/01-before.png', markdown: '![01-before](/uploads/x/01-before.png)' }));
      } else { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise<void>((r) => gitlab.listen(0, '127.0.0.1', r));
  const port = (gitlab.address() as { port: number }).port;

  process.env.ONESHOT_GITLAB_TOKEN = 'glpat-test';
  const gl = (sessionMcpServers(7) as Record<string, Stdio>).gitlab!;
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

    mkdirSync(join(artifacts, 'screens'), { recursive: true });
    writeFileSync(join(artifacts, 'screens', '01-before.png'), 'PNG-BYTES-FROM-ARTIFACTS');
    const res = await call('tools/call', { name: 'upload_markdown', arguments: { project_id: '1', file_path: 'screens/01-before.png' } });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    assert.notEqual((res.result as { isError?: boolean }).isError, true, JSON.stringify(res.result));
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0]!.includes('PNG-BYTES-FROM-ARTIFACTS'));
  } finally {
    child.kill();
    gitlab.close();
    rmSync(join(artifacts, '..'), { recursive: true, force: true });
  }
});
