// Ledgerly demo API. An invented vendor, built so AgentHelpDesk has a real HTTP service to
// reproduce failures against. Zero dependencies.
//
// Authentication: every /v1 route requires `Authorization: Bearer <key>`.
// Anything else gets a 401 whose body does not say which header was expected. That is the
// realistic shape of the failure an agent hits when the quickstart is wrong.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_KEY = 'ledgerly_test_key';

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
  const entries = [{ id: 'ent_1', memo: 'Opening balance', amount_cents: 12500, currency: 'usd' }];
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

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
