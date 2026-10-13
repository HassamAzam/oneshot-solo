import { test } from 'node:test';
import assert from 'node:assert/strict';
import './test-project-env.js';
import { recheckIdentity, type IdentityCheck } from './identity.js';

const answered: IdentityCheck = { username: 'desk-bot', token: null, claudeUsername: null, warning: null };

test('recheckIdentity asks GitLab again only while nobody has answered and GitLab is reachable', async () => {
  let asked = 0;
  const check = async () => { asked += 1; return answered; };
  assert.equal(await recheckIdentity(false, { username: () => '', check }), null, 'unreachable: not asked');
  assert.equal(await recheckIdentity(true, { username: () => 'desk-bot', check }), null, 'already known: not asked');
  assert.equal(asked, 0);
  assert.equal(await recheckIdentity(true, { username: () => '', check }), answered);
  assert.equal(asked, 1);
});
