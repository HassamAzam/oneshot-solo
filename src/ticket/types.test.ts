import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTicketResult, isBlocked, RESULT_SCHEMA, DENIED_TOOLS, SERVER_DENIED_TOOLS_REGEX } from './types.js';

test('parseTicketResult accepts the full shape and tolerates missing optionals', () => {
  const r = parseTicketResult({ summary: 'did it', mrIid: 12, mrUrl: 'https://g/!12', cases: [{ id: 'TC1', title: 'happy', verdict: 'pass' }], assumptions: ['x'] });
  assert.equal(r?.mrIid, 12);
  assert.equal(r?.cases?.[0]?.verdict, 'pass');
  assert.equal(parseTicketResult({ summary: 's' })?.cases, undefined);
  assert.equal(parseTicketResult(null), null);
  assert.equal(parseTicketResult({ nope: 1 }), null);
  assert.equal(parseTicketResult({ summary: 's', mrIid: 'twelve' })?.mrIid, undefined);   // wrong type dropped, not fatal
});

test('isBlocked treats missing, null and blank the same', () => {
  assert.equal(isBlocked(parseTicketResult({ summary: 's' })), null);
  assert.equal(isBlocked(parseTicketResult({ summary: 's', blocked: null })), null);
  assert.equal(isBlocked(parseTicketResult({ summary: 's', blocked: '   ' })), null);
  assert.equal(isBlocked(parseTicketResult({ summary: 's', blocked: 'needs a migration decision' })), 'needs a migration decision');
  assert.equal(isBlocked(null), null);
});

test('RESULT_SCHEMA requires only summary; blocked is optional on purpose', () => {
  assert.deepEqual((RESULT_SCHEMA as { required: string[] }).required, ['summary']);
});

test('DENIED_TOOLS holds AskUserQuestion and every issue/label/merge/branch-protection tool, not the MR tools', () => {
  assert.ok(DENIED_TOOLS.includes('AskUserQuestion'));
  for (const t of ['mcp__gitlab__merge_merge_request', 'mcp__gitlab__update_issue', 'mcp__gitlab__create_issue_note', 'mcp__gitlab__delete_branch', 'mcp__gitlab__push_files']) assert.ok(DENIED_TOOLS.includes(t), t);
  for (const t of ['mcp__gitlab__create_merge_request', 'mcp__gitlab__update_merge_request', 'mcp__gitlab__create_merge_request_note', 'mcp__gitlab__upload_markdown']) assert.ok(!DENIED_TOOLS.includes(t), t);
});

test('DENIED_TOOLS covers every write tool the installed GitLab MCP server exposes, except the four MR tools', async () => {
  const registry = await import(new URL('../../node_modules/@zereight/mcp-gitlab/build/tools/registry.js', import.meta.url).href) as {
    allTools: Array<{ name: string }>; advertisesReadOnly(name: string): boolean;
  };
  const names = registry.allTools.map((t) => t.name);
  const allowed = ['create_merge_request', 'update_merge_request', 'create_merge_request_note', 'upload_markdown'];
  for (const t of allowed) assert.ok(names.includes(t), `the server no longer exposes ${t}`);
  const open = names
    .filter((n) => !registry.advertisesReadOnly(n) && !allowed.includes(n))
    .filter((n) => !DENIED_TOOLS.includes(`mcp__gitlab__${n}`));
  assert.deepEqual(open, [], 'write tools the session could call');
});

test('the server-side deny regex, with modify mode, blocks every denied GitLab tool and nothing the session may call', async () => {
  const base = new URL('../../node_modules/@zereight/mcp-gitlab/build/tools/', import.meta.url).href;
  const registry = await import(`${base}registry.js`) as { allTools: Array<{ name: string }>; deleteTools: Set<string> };
  const { compileDeniedToolsRegex } = await import(`${base}denied-regex.js`) as {
    compileDeniedToolsRegex(p: string): { regex?: RegExp; error?: string };
  };
  // The server ignores, with only a log line, a pattern it will not compile — over 200 chars, say.
  const compiled = compileDeniedToolsRegex(SERVER_DENIED_TOOLS_REGEX);
  assert.equal(compiled.error, undefined);
  const rx = compiled.regex!;
  const denied = DENIED_TOOLS.filter((t) => t.startsWith('mcp__gitlab__')).map((t) => t.slice('mcp__gitlab__'.length));
  const open = denied.filter((n) => !rx.test(n) && !registry.deleteTools.has(n));
  assert.deepEqual(open, [], 'denied tools the server would still expose');
  const overreach = registry.allTools.map((t) => t.name).filter((n) => !denied.includes(n) && rx.test(n));
  assert.deepEqual(overreach, [], 'tools the regex would take from the session');
});
