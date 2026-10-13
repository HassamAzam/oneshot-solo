import { test } from 'node:test';
import assert from 'node:assert/strict';
import './test-project-env.js';
import { runAppEnv } from './appserver.js';

test('runAppEnv: the allowlist, the project and the run keys — never the conductor\'s credentials', () => {
  process.env.GITLAB_TOKEN = 'glpat-conductor-only';
  process.env.ONESHOT_GITLAB_TOKEN = 'glpat-conductor-only';
  process.env.ANTHROPIC_API_KEY = 'sk-no';
  const env = runAppEnv({ iid: 4, worktree: '/wt/t4', port: 8000 });
  assert.equal(env.ONESHOT_IID, '4');
  assert.equal(env.ONESHOT_PORT, '8000');
  assert.equal(env.ONESHOT_WORKTREE, '/wt/t4');
  assert.ok(env.PATH && env.HOME && env.ONESHOT_HOME);
  assert.equal(env.GITLAB_REPO_URL, 'https://gitlab.example.com/acme/erp');
  for (const k of Object.keys(env)) assert.ok(!/TOKEN|ANTHROPIC|CLAUDE_CODE|TEST_LOGIN/.test(k), `${k} must not reach the app`);
  assert.ok(!Object.values(env).includes('glpat-conductor-only'));
});
