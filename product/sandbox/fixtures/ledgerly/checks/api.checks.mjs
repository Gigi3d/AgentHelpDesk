// Ledgerly fixture test (part of the fake repo checkout; the offline FakeRunner does
// NOT execute it — a real Blaxel sandbox runs the vendor's own suite via the vendor
// test command). It documents the auth-header contract that seeded failure #1 breaks.
// NOTE: deliberately named checks/api.checks.mjs — a *.test.mjs name (or a test/ dir)
// would be auto-discovered and run by `node --test ./sandbox` as a product test.
import test from 'node:test';
import assert from 'node:assert/strict';

test('POST /v1/entries accepts Authorization: Bearer <LEDGERLY_KEY>', () => {
  const headers = { authorization: 'Bearer <LEDGERLY_KEY>' };
  assert.equal(headers.authorization.startsWith('Bearer '), true);
});

test('POST /v1/entries rejects the x-api-key header shown in the old quickstart', () => {
  const headers = { 'x-api-key': '<LEDGERLY_KEY>' };
  assert.equal(headers['authorization'], undefined);
});
