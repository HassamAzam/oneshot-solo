import './test-project-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTicket, ticketComments, isMachineNote } from './ticket.js';

const note = (body: string, extra: Partial<{ system: boolean; created_at: string }> = {}) =>
  ({ id: 1, body, system: false, created_at: '2026-10-01T00:00:00Z', author: { username: 'dev' }, ...extra }) as never;

test('ticketComments keeps human notes and drops system, machine and Oneshot notes', () => {
  const out = ticketComments([
    note('please also cover the boundary case'),
    note('changed the label', { system: true }),
    note('Oneshot claimed this ticket — run r-1'),
    note('<!-- oneshot:stop:r-1 -->\nOneshot stopped: foo'),
    note('ran it on dev, works'),
  ]);
  assert.deepEqual(out, ['please also cover the boundary case', 'ran it on dev, works']);
});

test('isMachineNote recognises the markers Solo writes', () => {
  assert.equal(isMachineNote('<!-- oneshot:stop:r-abc -->'), true);
  assert.equal(isMachineNote('<!-- oneshot:merged:r-abc -->'), true);
  assert.equal(isMachineNote('plain text'), false);
});

test('fetchTicket returns the issue with its human comments, the description alone when comments fail, null when the issue does', async () => {
  // Set rather than inherited, so this machine's token file or keychain is never read.
  process.env.ONESHOT_GITLAB_TOKEN = 'test-token';
  const issue = { iid: 7, title: 'Invoice reminder', description: 'As a user…', labels: ['Loop'] };
  let notes: () => Response = () => new Response(JSON.stringify([
    { id: 1, body: 'also cover the boundary', system: false },
    { id: 2, body: '<!-- oneshot:automation:r-1 -->\nplan', system: false },
  ]), { status: 200 });
  let issueAnswer: () => Response = () => new Response(JSON.stringify(issue), { status: 200 });
  globalThis.fetch = (async (input: string | URL | Request) =>
    (String(input).includes('/notes') ? notes() : issueAnswer())) as typeof fetch;

  assert.deepEqual(await fetchTicket(7), { ...issue, notes: ['also cover the boundary'], documents: [], externalDocs: [] });

  notes = () => new Response('boom', { status: 500 });
  assert.deepEqual((await fetchTicket(7))?.notes, []);

  issueAnswer = () => new Response('not found', { status: 404 });
  assert.equal(await fetchTicket(7), null);
});
