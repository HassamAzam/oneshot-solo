import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import './test-project-env.js';

test('projectConfig parses the Solo shape and nothing else', async () => {
  const { projectConfig } = await import('./config.js');
  const cfg = projectConfig();
  assert.deepEqual(Object.keys(cfg).sort(), ['branches', 'bugReproduction', 'hookPack', 'labels', 'merge', 'preserveLabels', 'seed']);
  assert.equal(cfg.labels.entry, 'Loop');
  assert.equal(cfg.labels.inReview, 'In Review');
  assert.equal(cfg.merge.mode, 'auto');
  assert.deepEqual(cfg.seed.links, ['venv', 'node_modules', 'staticfiles']);
});

test('requiredLabels lists the four labels with a reason each', async () => {
  const { requiredLabels, projectConfig } = await import('./config.js');
  const names = requiredLabels(projectConfig()).map((l) => l.name);
  assert.deepEqual(names, ['Loop', 'Merged', 'In Review', 'Needs Human']);
});

test('sessionModel and sessionCaps read env with the documented defaults', async () => {
  delete process.env.ONESHOT_MODEL; delete process.env.ONESHOT_MAX_TURNS; delete process.env.ONESHOT_TIMEOUT_MIN; delete process.env.ONESHOT_IDLE_MIN;
  const { sessionModel, sessionCaps } = await import('./config.js');
  assert.equal(sessionModel(), 'claude-opus-5-5');
  assert.deepEqual(sessionCaps(), { maxTurns: 600, timeoutMin: 240, idleMin: 15 });
  process.env.ONESHOT_MAX_TURNS = '12'; process.env.ONESHOT_IDLE_MIN = '0';
  assert.deepEqual(sessionCaps(), { maxTurns: 12, timeoutMin: 240, idleMin: 0 });
});

test('seedLinks/seedCopies: env overrides project.json, empty env means the project list', async () => {
  const { seedLinks, seedCopies } = await import('./config.js');
  delete process.env.ONESHOT_SEED_LINKS;
  assert.deepEqual(seedLinks(), ['venv', 'node_modules', 'staticfiles']);
  process.env.ONESHOT_SEED_LINKS = 'venv';
  assert.deepEqual(seedLinks(), ['venv']);
  process.env.ONESHOT_SEED_COPIES = '';
  assert.deepEqual(seedCopies(), ['hrdb/local_settings.py', 'frontend/src/constants/config.js']);
});

test('projectSessionEnv carries the resolved seed lists so app.cjs reads env only', async () => {
  process.env.ONESHOT_SEED_LINKS = 'venv';
  const { projectSessionEnv } = await import('./config.js');
  const env = projectSessionEnv();
  assert.equal(env.ONESHOT_SEED_LINKS, 'venv');
  assert.equal(env.ONESHOT_SEED_COPIES, 'hrdb/local_settings.py,frontend/src/constants/config.js');
  assert.ok(env.ONESHOT_SEED_FROM);
});

test('superpowersPath: env wins, else installed_plugins.json, else null', async () => {
  const { superpowersPath } = await import('./config.js');
  process.env.ONESHOT_SUPERPOWERS_PATH = '/tmp/sp';
  assert.equal(superpowersPath(), '/tmp/sp');
  delete process.env.ONESHOT_SUPERPOWERS_PATH;
  const home = mkdtempSync(join(tmpdir(), 'solo-home-'));
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user', installPath: '/x/superpowers/6.4.1', version: '6.4.1' }] },
  }));
  assert.equal(superpowersPath(home), '/x/superpowers/6.4.1');
  assert.equal(superpowersPath(mkdtempSync(join(tmpdir(), 'solo-empty-'))), null);
});

test('BASE_ENV never forwards an API key and always pins ONESHOT_HOME', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
  const { BASE_ENV, ROOT } = await import('./config.js');
  assert.equal(BASE_ENV.ANTHROPIC_API_KEY, undefined);
  assert.equal(BASE_ENV.ONESHOT_HOME, ROOT);
  assert.equal(BASE_ENV.CLAUDE_CODE_DISABLE_1M_CONTEXT, '1');
});

test('mergeMode reads project.json and ONESHOT_MERGE overrides it', async () => {
  const { mergeMode } = await import('./config.js');
  delete process.env.ONESHOT_MERGE;
  assert.equal(mergeMode(), 'auto');
  process.env.ONESHOT_MERGE = 'manual';
  assert.equal(mergeMode(), 'manual');
});
