import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerlyServer, DEFAULT_KEY, X402 } from '../server.mjs';

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

const pay = (over = {}) => {
  const f = { scheme: X402.scheme, network: X402.network, amount: String(X402.amount), pay_to: X402.payTo, nonce: `n-${Math.random().toString(36).slice(2)}`, quote: X402.quote, ...over };
  return Object.entries(f).map(([k, v]) => `${k}=${v}`).join(',');
};

test('the premium report answers 402 with the payment terms when unpaid', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/v1/premium/report`);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error.code, 'payment_header_missing');
    assert.equal(body.accepts[0].network, 'base-sepolia');
  });
});

test('a correct simulated payment unlocks the premium report', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/v1/premium/report`, { headers: { 'x-payment': pay() } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).receipt.settled, true);
  });
});

for (const [code, over] of [
  ['unsupported_scheme', { scheme: 'upto' }],
  ['wrong_network', { network: 'base' }],
  ['wrong_recipient', { pay_to: '0xLedgerlyOld' }],
  ['insufficient_amount', { amount: '1000' }],
  ['quote_expired', { quote: 'q-2025-10-01' }],
  ['nonce_reused', { nonce: 'n-demo-0001' }],
]) {
  test(`premium report refuses a payment that trips ${code}`, async () => {
    await withServer(async (origin) => {
      const res = await fetch(`${origin}/v1/premium/report`, { headers: { 'x-payment': pay(over) } });
      assert.equal(res.status, 402);
      assert.equal((await res.json()).error.code, code);
    });
  });
}

test('a nonce cannot be spent twice', async () => {
  await withServer(async (origin) => {
    const h = { 'x-payment': pay({ nonce: 'n-once' }) };
    assert.equal((await fetch(`${origin}/v1/premium/report`, { headers: h })).status, 200);
    assert.equal((await fetch(`${origin}/v1/premium/report`, { headers: h })).status, 402);
  });
});
