// AgentHelpDesk replay proof (and reproduction check), run INSIDE the case sandbox.
//
//   node /ahd/replay.mjs [request.json]
//
// It replays the call exactly as the vendor's quickstart documents it, against the vendor's
// own server code running here, and exits 0 only if that call succeeds (2xx). So:
//   - on the UNFIXED docs it exits 1 with the real status: that is the reproduction;
//   - on the FIXED docs it exits 0: that is proof (a), the replayed failure now passes.
// The optional request.json argument is the failing request the agent reported; it is printed
// for the audit trail and never executed.
import { readFileSync } from 'node:fs';
import { createLedgerlyServer, DEFAULT_KEY } from './work/server.mjs';
import { extractCurlCommands, parseCurl, runCall } from './work/lib/docs-call.mjs';

const docPath = new URL('./work/docs/quickstart.md', import.meta.url);
const doc = readFileSync(docPath, 'utf8');
const commands = extractCurlCommands(doc);
if (commands.length === 0) {
  process.stderr.write('replay: no curl example found in docs/quickstart.md\n');
  process.exit(3);
}

const reported = process.argv[2];
if (reported) {
  try {
    const r = JSON.parse(readFileSync(reported, 'utf8'));
    process.stdout.write(`reported request: ${JSON.stringify(r)}\n`);
  } catch (err) {
    process.stdout.write(`reported request: unreadable (${err.message})\n`);
  }
}

const call = parseCurl(commands[0], { LEDGERLY_KEY: DEFAULT_KEY });
const shownHeaders = Object.fromEntries(Object.entries(call.headers).map(([k, v]) => [k, v.replace(DEFAULT_KEY, '<key>')]));

const server = createLedgerlyServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let status = 0;
let body = '';
try {
  ({ status, body } = await runCall(call, origin));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

process.stdout.write(`documented call: ${call.method} ${call.url} headers=${JSON.stringify(shownHeaders)}\n`);
process.stdout.write(`status ${status} body ${body.slice(0, 200)}\n`);
process.exit(status >= 200 && status < 300 ? 0 : 1);
