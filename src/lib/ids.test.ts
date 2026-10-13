import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchFor, worktreeName, phaseEnv, newRunId } from './ids.js';

test('branchFor slugs the title under the prefix', () => {
  assert.equal(branchFor('oneshot', 412, 'Fix the Invoice reminder: Celery!'), 'oneshot/ticket-412-fix-the-invoice-reminder-celery');
});
test('phaseEnv emits the identity every hook reads, with ticket as the phase', () => {
  const env = phaseEnv({ runId: 'r-1', ticket: 412, phase: 'ticket', lap: 1 }, { worktree: '/wt', writeScopes: ['/wt', '/art'], port: 8000, branch: 'oneshot/ticket-412-x' });
  assert.equal(env.ONESHOT_PHASE, 'ticket');
  assert.equal(env.ONESHOT_LAP, '1');
  assert.equal(env.ONESHOT_WRITE_SCOPES, '/wt:/art');
  assert.equal(env.ONESHOT_BRANCH, 'oneshot/ticket-412-x');
});
test('newRunId is r- plus base36 time plus hex', () => {
  assert.match(newRunId(), /^r-[a-z0-9]+-[0-9a-f]{6}$/);
});
