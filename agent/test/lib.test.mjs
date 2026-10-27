import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMessage, oneLine, sanitize, shouldWake } from '../src/lib.mjs';

const me = { id: 'me-id', name: 'researcher' };
const msg = (over = {}) => ({
  id: 'a1b2c3d4-0000', channel_id: 'c1', sender_id: 'other', sender_name: 'builder',
  recipient_name: null, kind: 'info', body: 'hello', payload: {}, from_owner: false,
  needs_reply: false, task_id: null, created_at: '2026-10-24T10:00:00Z', ...over,
});

test('own messages never wake', () => {
  assert.equal(shouldWake(msg({ sender_id: 'me-id', kind: 'done' }), me), false);
});

test('system and plain info/status are ignored', () => {
  assert.equal(shouldWake(msg({ kind: 'system' }), me), false);
  assert.equal(shouldWake(msg({ kind: 'info' }), me), false);
  assert.equal(shouldWake(msg({ kind: 'status' }), me), false);
});

test('done/question/blocker/approval_request wake', () => {
  for (const kind of ['done', 'question', 'blocker', 'approval_request']) {
    assert.equal(shouldWake(msg({ kind }), me), true, kind);
  }
});

test('owner, DM, needs_reply and @mention wake', () => {
  assert.equal(shouldWake(msg({ from_owner: true, sender_name: 'owner' }), me), true);
  assert.equal(shouldWake(msg({ recipient_name: 'Researcher' }), me), true);
  assert.equal(shouldWake(msg({ needs_reply: true }), me), true);
  assert.equal(shouldWake(msg({ body: 'hey @researcher can you look' }), me), true);
  assert.equal(shouldWake(msg({ body: 'email@researcherx.com' }), me), false);
});

test('formatMessage flags owner/DM and includes payload', () => {
  const line = formatMessage(msg({ from_owner: true, recipient_name: 'researcher', payload: { files: ['a.py'] } }), 'proj');
  assert.match(line, /^\[#proj\] builder \(info, OWNER,DM->researcher\)/);
  assert.match(line, /payload=\{"files":\["a\.py"\]\}/);
});

test('oneLine collapses whitespace and truncates', () => {
  assert.equal(oneLine('a\n\n b   c'), 'a b c');
  assert.equal(oneLine('x'.repeat(10), 5), 'xxxx…');
});

test('sanitize makes safe slugs', () => {
  assert.equal(sanitize('My Project!!', 'x'), 'my-project');
  assert.equal(sanitize('***', 'fallback'), 'fallback');
});
