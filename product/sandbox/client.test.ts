import { test } from 'node:test';
import assert from 'node:assert/strict';

test('messageOf: plain API error objects do not print as [object Object]', async () => {
  const { messageOf } = await import('./client.ts');
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf({ message: 'quota exceeded', status: 429 }), 'quota exceeded (429)');
  assert.equal(messageOf({ error: 'bad region' }), 'bad region');
  assert.match(messageOf({ foo: 1 }), /foo/);
  assert.equal(messageOf(undefined), 'undefined');
});

test('isForkUnavailable recognises the 403 the workspace returns', async () => {
  const { isForkUnavailable } = await import('./client.ts');
  assert.equal(isForkUnavailable('Error 403: Sandbox snapshot/fork feature is not enabled for this workspace'), true);
  assert.equal(isForkUnavailable('quota exceeded'), false);
  assert.equal(isForkUnavailable('Unauthorized (401)'), false);
});
