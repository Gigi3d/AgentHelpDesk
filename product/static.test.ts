import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isApiPath, serveStatic } from './static.ts';

const root = mkdtempSync(join(tmpdir(), 'ahd-static-'));
writeFileSync(join(root, 'index.html'), '<html>shell</html>');
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'assets', 'app-abcdef12.js'), 'console.log(1)');

test('serves a file with its type and long cache for hashed assets', async () => {
  const r = await serveStatic(root, '/assets/app-abcdef12.js');
  assert.equal(r?.status, 200);
  assert.match(r!.headers['content-type']!, /javascript/);
  assert.match(r!.headers['cache-control']!, /immutable/);
});

test('unknown route falls back to the app shell, unknown file is a 404', async () => {
  assert.equal((await serveStatic(root, '/app/tickets/abc'))?.body.toString(), '<html>shell</html>');
  assert.equal((await serveStatic(root, '/missing.js'))?.status, 404);
});

test('never reads outside the root', async () => {
  const r = await serveStatic(root, '/..%2f..%2fetc/passwd');
  assert.ok(r === null || r.status === 403 || r.status === 404 || r.body.toString() === '<html>shell</html>');
  assert.notEqual(r?.body.toString().includes('root:'), true);
});

test('API paths are never answered with the shell', async () => {
  assert.equal(isApiPath('/v1/cases'), true);
  assert.equal(await serveStatic(root, '/v1/cases'), null);
  assert.equal(await serveStatic(root, '/healthz'), null);
});
