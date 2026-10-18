import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerlyServer, DEFAULT_KEY } from '../server.mjs';

async function withServer(fn) {
  const server = createLedgerlyServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /v1/entries with a Bearer key returns the ledger', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/v1/entries`, { headers: { authorization: `Bearer ${DEFAULT_KEY}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
  });
});

test('a request without credentials gets 401', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/v1/entries`);
    assert.equal(res.status, 401);
  });
});

test('the x-api-key header is not an accepted credential', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/v1/entries`, { headers: { 'x-api-key': DEFAULT_KEY } });
    assert.equal(res.status, 401);
  });
});

test('POST /v1/entries creates an entry', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/v1/entries`, {
      method: 'POST',
      headers: { authorization: `Bearer ${DEFAULT_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ memo: 'Coffee', amount_cents: 450 }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).memo, 'Coffee');
  });
});

test('POST /v1/entries validates its body', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/v1/entries`, {
      method: 'POST',
      headers: { authorization: `Bearer ${DEFAULT_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ memo: 'no amount' }),
    });
    assert.equal(res.status, 422);
  });
});
