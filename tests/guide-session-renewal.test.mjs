import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessions } from '../server/sessions.mjs';

const minute = 60_000;
const secret = 'renewal-tests-use-only-this-local-dummy-secret';

test('an active turn renews the signed token without changing its conversation or actor', () => {
  let now = Date.parse('2026-09-10T01:00:00Z');
  const sessions = createSessions({ secret, clock: () => now });
  const first = sessions.createConversation('actor-a');
  now += 13 * minute;
  const renewed = sessions.verifyConversation(first.token, 'actor-a');
  assert.equal(renewed.id, first.id);
  assert.notEqual(renewed.token, first.token, 'A valid active turn must advance the signed issue time');
  now += 2 * minute;
  assert.equal(sessions.verifyConversation(first.token, 'actor-a'), null, 'Old token still expires at its original 14-minute boundary');
  const continued = sessions.verifyConversation(renewed.token, 'actor-a');
  assert.equal(continued.id, first.id);
  assert.equal(sessions.verifyConversation(renewed.token, 'actor-b'), null);
  now += 14 * minute;
  assert.equal(sessions.verifyConversation(continued.token, 'actor-a'), null, 'Fourteen idle minutes still require a new conversation');
});

test('renewal rejects tampering, foreign actors and future issue times', () => {
  let now = Date.parse('2026-09-10T02:00:00Z');
  const sessions = createSessions({ secret, clock: () => now });
  const conversation = sessions.createConversation('actor-a');
  const [payload, signature] = conversation.token.split('.');
  const changed = JSON.parse(Buffer.from(payload, 'base64url'));
  changed.actor = 'actor-b';
  assert.equal(sessions.verifyConversation(`${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`, 'actor-b'), null);
  assert.equal(sessions.verifyConversation(`${conversation.token}x`, 'actor-a'), null);
  assert.equal(sessions.verifyConversation(conversation.token, 'actor-b'), null);
  now -= 1;
  assert.equal(sessions.verifyConversation(conversation.token, 'actor-a'), null);
});
