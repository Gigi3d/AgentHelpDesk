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
