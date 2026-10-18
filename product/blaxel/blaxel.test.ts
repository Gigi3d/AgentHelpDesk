import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleOf } from './register.ts';

test('sandbox roles are told apart by name', () => {
  assert.equal(roleOf('ahd-desk'), 'desk');
  assert.equal(roleOf('ahd-c-1234'), 'case');
  assert.equal(roleOf('ahd-c-1234-fresh'), 'fresh');
  assert.equal(roleOf('something-else'), 'other');
});
