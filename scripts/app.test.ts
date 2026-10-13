import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, 'app.cjs');

const CREDENTIALS = {
  GITLAB_TOKEN: 'glpat-a', ONESHOT_GITLAB_TOKEN: 'glpat-b', ONELOOP_GITLAB_TOKEN: 'glpat-c', GITLAB_PERSONAL_ACCESS_TOKEN: 'glpat-d',
  ONESHOT_TEST_LOGIN: 'qa@example.com:pw', ONELOOP_TEST_LOGIN: 'qa@example.com:pw',
  ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'https://proxy', CLAUDE_CODE_OAUTH_TOKEN: 'oat-x', CLAUDE_CODE_USE_BEDROCK: '1',
};

test('scrubEnv drops every credential key and keeps the rest, as a copy', () => {
  const { scrubEnv } = createRequire(import.meta.url)(APP) as { scrubEnv: (e: Record<string, string>) => Record<string, string> };
  const env = { PATH: '/bin', HOME: '/h', ONESHOT_PORT: '8000', ONESHOT_WORKTREE: '/wt', DJANGO_SETTINGS_MODULE: 'hrdb.settings', ...CREDENTIALS };
  assert.deepEqual(Object.keys(scrubEnv(env)).sort(), ['DJANGO_SETTINGS_MODULE', 'HOME', 'ONESHOT_PORT', 'ONESHOT_WORKTREE', 'PATH']);
  assert.equal(env.GITLAB_TOKEN, 'glpat-a', 'the input is not mutated');
});

test('app.cjs scrubs its own environment at load — the one Django and webpack inherit', () => {
  // Key names only: the probe never prints a value.
  const probe = `require(${JSON.stringify(APP)}); console.log(JSON.stringify(Object.keys(process.env).filter((k) => /TOKEN|TEST_LOGIN|^ANTHROPIC_|^CLAUDE_CODE_/.test(k))))`;
  const left = JSON.parse(execFileSync(process.execPath, ['-e', probe], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...CREDENTIALS },
  }).trim().split('\n').at(-1)!) as string[];
  assert.deepEqual(left, []);
});
