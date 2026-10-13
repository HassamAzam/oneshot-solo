import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeVerdict } from './doctor.js';

test('probeVerdict reads the init frame and the SessionStart hook response', () => {
  const v = probeVerdict([
    { type: 'system', subtype: 'init', plugins: [{ name: 'superpowers', path: '/x/superpowers/6.4.1' }], skills: ['superpowers:brainstorming', 'ship-ticket'], claude_code_version: '2.1.296' },
    { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', output: 'hookSpecificOutput … You have superpowers …' },
    { type: 'result', subtype: 'success', num_turns: 1 },
  ]);
  assert.deepEqual(v, { pluginLoaded: true, skillsNamespaced: true, hookFired: true, cliVersion: '2.1.296' });
  const none = probeVerdict([{ type: 'system', subtype: 'init', plugins: [], skills: ['ship-ticket'] }]);
  assert.equal(none.pluginLoaded, false); assert.equal(none.hookFired, false); assert.equal(none.cliVersion, null);
});

test('probeVerdict trusts SessionStart hook responses over a stray mention, and falls back without any', () => {
  const init = { type: 'system', subtype: 'init', plugins: [{ name: 'superpowers', path: '/x' }], skills: [] };
  // A pack's SessionStart hook answered, superpowers' did not: an echo of the phrase elsewhere proves nothing.
  const packOnly = probeVerdict([
    init,
    { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', output: 'traps brief' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'You have superpowers? ok' }] } },
  ]);
  assert.equal(packOnly.hookFired, false);
  // A CLI that emits no hook_response frames at all: the phrase in any frame is the evidence.
  const noResponses = probeVerdict([init, { type: 'system', subtype: 'status', note: '<EXTREMELY_IMPORTANT>You have superpowers.' }]);
  assert.equal(noResponses.hookFired, true);
  assert.equal(noResponses.skillsNamespaced, false);
});
