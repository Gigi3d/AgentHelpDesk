import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearerOk } from './http-auth.ts';

test('no token configured: open', () => {
  assert.equal(bearerOk(undefined, undefined), true);
  assert.equal(bearerOk('Bearer x', ''), true);
});

test('token configured: needs the exact bearer', () => {
  assert.equal(bearerOk(undefined, 's3cret'), false);
  assert.equal(bearerOk('Bearer nope', 's3cret'), false);
  assert.equal(bearerOk('Basic s3cret', 's3cret'), false);
  assert.equal(bearerOk('Bearer s3cret', 's3cret'), true);
  assert.equal(bearerOk('bearer s3cret', 's3cret'), true);
});
