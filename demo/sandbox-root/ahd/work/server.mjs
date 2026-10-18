// Ledgerly demo API. An invented vendor, built so AgentHelpDesk has a real HTTP service to
// reproduce failures against. Zero dependencies.
//
// Authentication: every /v1 route requires `Authorization: Bearer <key>`.
// Anything else gets a 401 whose body does not say which header was expected. That is the
// realistic shape of the failure an agent hits when the quickstart is wrong.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_KEY = 'ledgerly_test_key';

// Premium report, paid per call over x402. SIMULATED: the facilitator is this file, the
// "signature" is not checked and nothing is charged. It exists so AgentHelpDesk has a paid,
// 402-gated endpoint whose documentation can be wrong in realistic ways.
//
// A paying request carries `X-PAYMENT: scheme=exact,network=base-sepolia,amount=10000,pay_to=0xLedgerlyTest,nonce=<unique>,quote=q-current`.
// Amounts are in USDC base units (6 decimals), so 10000 is one cent.
export const X402 = {
  scheme: 'exact',
  network: 'base-sepolia',
  amount: 10000,
  payTo: '0xLedgerlyTest',
  quote: 'q-current',
  header: 'x-payment',
};
const BURNED_NONCES = ['n-demo-0001']; // already settled before this server started

function requirement() {
  return { scheme: X402.scheme, network: X402.network, maxAmountRequired: String(X402.amount), asset: 'USDC', payTo: X402.payTo, quote: X402.quote, resource: '/v1/premium/report' };
}

function payRequired(res, code, message) {
  return send(res, 402, { x402Version: 1, error: { code, message }, accepts: [requirement()] });
}

function parsePayment(raw) {
  const out = {};
  for (const part of raw.split(',')) {
    const at = part.indexOf('=');
    if (at < 1) return null;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

function handlePremium(req, res, spent) {
  const raw = req.headers[X402.header];
  if (typeof raw !== 'string' || raw.length === 0) return payRequired(res, 'payment_header_missing', 'Send the payment in the X-PAYMENT header.');
  const p = parsePayment(raw);
  if (!p || !p.scheme || !p.network || !p.amount || !p.pay_to || !p.nonce || !p.quote) {
    return payRequired(res, 'payment_header_malformed', 'X-PAYMENT must carry scheme, network, amount, pay_to, nonce and quote.');
  }
  if (p.scheme !== X402.scheme) return payRequired(res, 'unsupported_scheme', `Only the ${X402.scheme} scheme is accepted.`);
  if (p.network !== X402.network) return payRequired(res, 'wrong_network', `This API settles on ${X402.network}.`);
  if (p.pay_to !== X402.payTo) return payRequired(res, 'wrong_recipient', 'The payment names a different recipient than the one in accepts.');
  if (!(Number(p.amount) >= X402.amount)) return payRequired(res, 'insufficient_amount', `The price is ${X402.amount} base units.`);
  if (p.quote !== X402.quote) return payRequired(res, 'quote_expired', 'That quote is no longer current. Use the quote from the latest 402.');
  if (BURNED_NONCES.includes(p.nonce) || spent.has(p.nonce)) return payRequired(res, 'nonce_reused', 'That nonce was already settled. Every payment needs a fresh nonce.');
  spent.add(p.nonce);
  const receipt = { settled: true, simulated: true, network: X402.network, amount: Number(p.amount), tx: `sim_tx_${p.nonce}` };
  res.setHeader('x-payment-response', Buffer.from(JSON.stringify(receipt)).toString('base64'));
  return send(res, 200, { data: { report: 'Q3 ledger summary: 1 entry, 12500 cents.' }, receipt });
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

export function createLedgerlyServer({ key = process.env.LEDGERLY_KEY || DEFAULT_KEY } = {}) {
  const spent = new Set();
  const entries = [{ id: 'ent_1', memo: 'Opening balance', amount_cents: 12500, currency: 'usd' }];
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/v1/premium/report') return handlePremium(req, res, spent);

    if (url.pathname.startsWith('/v1/')) {
      if (req.headers.authorization !== `Bearer ${key}`) {
        return send(res, 401, { error: { code: 'unauthorized', message: 'Invalid or missing credentials.' } });
      }
      if (url.pathname === '/v1/entries' && req.method === 'GET') return send(res, 200, { data: entries });
      if (url.pathname === '/v1/entries' && req.method === 'POST') {
        let body;
        try {
          body = await readJson(req);
        } catch {
          return send(res, 400, { error: { code: 'invalid_json', message: 'Body must be valid JSON.' } });
        }
        if (!body || typeof body.memo !== 'string' || !Number.isInteger(body.amount_cents)) {
          return send(res, 422, { error: { code: 'invalid_entry', message: 'memo (string) and amount_cents (integer) are required.' } });
        }
        const entry = { id: `ent_${entries.length + 1}`, memo: body.memo, amount_cents: body.amount_cents, currency: 'usd' };
        entries.push(entry);
        return send(res, 201, entry);
      }
    }
    return send(res, 404, { error: { code: 'not_found', message: 'No such route.' } });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4010);
  createLedgerlyServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(`ledgerly listening on 127.0.0.1:${port}\n`);
  });
}
