import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../lib/test-project-env.js';
import { hooksFor, guardEnv, packManifest } from './hooks.js';

test('guardEnv forwards only PATH, HOME, CONTEXT_REPO and ONESHOT_*', () => {
  // guardEnv overlays the conductor's own process.env, and config.ts loads this
  // desk's .env into it on import; scrub what it could forward so the answer
  // does not depend on how the desk is configured.
  for (const k of Object.keys(process.env)) if (k.startsWith('ONESHOT_') || k === 'CONTEXT_REPO') delete process.env[k];
  const env = guardEnv({ ONESHOT_PHASE: 'ticket', GITLAB_TOKEN: 'glpat-x', ANTHROPIC_API_KEY: 'sk', PATH: '/bin', HOME: '/h', CONTEXT_REPO: '/c', FOO: 'bar' });
  assert.deepEqual(Object.keys(env).sort(), ['CONTEXT_REPO', 'HOME', 'ONESHOT_PHASE', 'PATH']);
});

test('hooksFor registers the six core guards and the erp pack from its manifest', () => {
  const h = hooksFor({ ONESHOT_PHASE: 'ticket' }) as Record<string, Array<{ matcher?: string; hooks: unknown[]; timeout: number }>>;
  const pre = h.PreToolUse!.map((m) => m.matcher ?? '*');
  assert.ok(pre.includes('^Bash$'));                                   // git-guard
  assert.ok(pre.includes('^Write$'));                                  // churn-guard
  // mr-gate sees every write the session may make on GitLab, so it can hold each one to the project.
  const mr = new RegExp(pre.find((m) => m.includes('merge_request'))!);
  for (const t of ['create_merge_request', 'update_merge_request', 'create_merge_request_note', 'upload_markdown']) assert.ok(mr.test(`mcp__gitlab__${t}`), t);
  assert.ok(!mr.test('mcp__gitlab__get_merge_request'));
  assert.equal(h.PreToolUse![0]!.matcher, undefined);                  // pause-check first, unmatched
  assert.ok(h.PostToolUse!.some((m) => m.timeout === 60));             // py-lint from the pack
  assert.equal(h.SessionStart!.length, 2);                             // traps-brief, repro-conditions
});

test('a pack manifest entry is {script, event, matcher?, timeoutMs}', () => {
  const m = packManifest('erp');
  assert.ok(m.every((e) => typeof e.script === 'string' && ['PreToolUse', 'PostToolUse', 'SessionStart'].includes(e.event)));
  assert.ok(m.some((e) => e.script === 'py-lint.cjs' && e.timeoutMs === 60000));
});

test('no pack means core only', () => {
  const h = hooksFor({ ONESHOT_PHASE: 'ticket' }, { pack: null }) as Record<string, unknown[]>;
  assert.equal(h.SessionStart, undefined);
  assert.equal(h.PostToolUse, undefined);
});

test('callbacks spawn the real guards: a core deny and a pack injection', async (t) => {
  type Cb = (input: unknown) => Promise<Record<string, Record<string, string> | undefined>>;
  // ONESHOT_HOME is a scratch dir so the guards' event log lands there, not in a real state/.
  const home = mkdtempSync(join(tmpdir(), 'oneshot-hooks-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ONESHOT_PHASE: 'ticket', ONESHOT_HOME: home, ONESHOT_BRANCH: 'oneshot/1-x', ONESHOT_WORKTREE: home };
  const h = hooksFor(env, { pack: 'erp' }) as Record<string, Array<{ matcher?: string; hooks: Cb[] }>>;

  const git = h.PreToolUse!.find((m) => m.matcher === '^Bash$')!.hooks[0]!;
  const denied = await git({ tool_name: 'Bash', tool_input: { command: 'git push origin dev' } });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  const allowed = await git({ tool_name: 'Bash', tool_input: { command: 'git status' } });
  assert.deepEqual(allowed, {});

  const traps = h.SessionStart![0]!.hooks[0]!;
  const brief = await traps({ hook_event_name: 'SessionStart' });
  assert.equal(brief.hookSpecificOutput?.hookEventName, 'SessionStart');
});
