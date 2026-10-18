// The docs are part of the product: every curl example in the quickstart must actually work
// against the API. This is the vendor's own guard against the failure AgentHelpDesk was
// called about: a quickstart that shows a call the server rejects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLedgerlyServer, DEFAULT_KEY } from '../server.mjs';
import { extractCurlCommands, parseCurl, runCall } from '../lib/docs-call.mjs';

const quickstart = readFileSync(new URL('../docs/quickstart.md', import.meta.url), 'utf8');

test('the quickstart documents at least one curl example', () => {
  assert.ok(extractCurlCommands(quickstart).length >= 1);
});

test('every curl example in the quickstart succeeds against the API', async () => {
  const server = createLedgerlyServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const command of extractCurlCommands(quickstart)) {
      const call = parseCurl(command, { LEDGERLY_KEY: DEFAULT_KEY });
      const result = await runCall(call, origin);
      assert.ok(result.status >= 200 && result.status < 300, `documented call failed with ${result.status}: ${command}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
