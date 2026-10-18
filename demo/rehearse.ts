// demo/rehearse.ts: run the whole loop on this machine, no keys needed.
//
//   node --experimental-strip-types demo/rehearse.ts
//
// REAL here: the Ledgerly vendor, its test suite, the replay, the fresh-agent script, the
// Claude resolver code, the proofs, the gate and the loop. STAND-INS here: the sandbox (a temp
// directory, see local-runner.ts) and the Anthropic API (a local server that answers like the
// Messages API). So this proves the wiring and the logic. It does not prove Blaxel or Claude
// behave; only the live run with your keys does. Set REHEARSE_REAL_ANTHROPIC=1 with a real
// ANTHROPIC_API_KEY to point the resolver and fresh agent at the real API from this machine.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MemoryRepository } from '../product/store/memory.ts';
import { intake } from '../product/desk/intake.ts';
import { runLoop } from '../product/desk/loop.ts';
import { makeClaudeResolver } from '../product/desk/resolver-claude.ts';
import { makeProvisioner } from '../product/sandbox/provision.ts';
import { getProofRunner } from '../product/proofs/proofs.ts';
import { makeLocalRunner } from './local-runner.ts';
import type { Vendor } from '../product/shared/types.ts';

const here = resolve(import.meta.dirname ?? '.');
const realApi = process.env['REHEARSE_REAL_ANTHROPIC'] === '1';

// ---- stand-in Messages API (only used unless REHEARSE_REAL_ANTHROPIC=1) ----
const calls: string[] = [];
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (d: Buffer) => (raw += d.toString()));
  req.on('end', () => {
    const body = JSON.parse(raw) as { system: string; messages: Array<{ content: string }> };
    const user = body.messages[0]!.content;
    let text: string;
    if (body.system.includes('maintain a vendor')) {
      calls.push('resolver');
      const m = /<file path="docs\/quickstart.md" mode="to-correct">\n([\s\S]*?)\n<\/file>/.exec(user);
      const fixed = (m?.[1] ?? '').replaceAll('"x-api-key: $LEDGERLY_KEY"', '"Authorization: Bearer $LEDGERLY_KEY"').replace('`x-api-key` header', '`Authorization: Bearer <key>` header');
      text = `<fix_steps>\n- Send the key as Authorization: Bearer $LEDGERLY_KEY\n- Retry the original call\n</fix_steps>\n<snippet>\ncurl -H "Authorization: Bearer $LEDGERLY_KEY" https://api.ledgerly.test/v1/entries\n</snippet>\n<file>\n${fixed}\n</file>`;
    } else {
      calls.push('fresh_agent');
      const good = user.includes('Authorization: Bearer');
      text = JSON.stringify({
        method: 'GET',
        url: 'https://api.ledgerly.test/v1/entries',
        headers: good ? { Authorization: 'Bearer $LEDGERLY_KEY' } : { 'x-api-key': '$LEDGERLY_KEY' },
        body: null,
      });
    }
    res.setHeader('content-type', 'application/json');
    res.setHeader('request-id', 'req_rehearsal_stub');
    res.end(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } }));
  });
});
if (!realApi) {
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  const addr = stub.address();
  if (addr && typeof addr === 'object') process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${addr.port}`;
  process.env['ANTHROPIC_API_KEY'] = 'sk-rehearsal-not-a-real-key';
}

process.env['AHD_REPRO_COMMAND'] = 'node /ahd/replay.mjs';
process.env['AHD_REPRO_EXPECT'] = 'nonzero';
process.env['AHD_VENDOR_TEST_COMMAND'] = 'cd /ahd/work && node --test test/*.test.mjs';

const base = await mkdtemp(join(tmpdir(), 'ahd-rehearsal-'));
const repo = new MemoryRepository();
const vendor: Vendor = {
  id: 'ledgerly',
  name: 'Ledgerly',
  repo_url: '',
  sandbox_name: 'ahd-vendor-ledgerly',
  risk_policy: 'approve_first',
  stripe_customer_id: '',
  payer_mode: 'vendor',
  report_contacts: ['founder@example.test'],
  test_command: 'cd /ahd/work && node --test test/*.test.mjs',
};
await repo.putVendor(vendor);

const failure = await intake(
  {
    agent_id: 'agent-rehearsal',
    task: 'List my ledger entries',
    request: { method: 'GET', url: 'https://api.ledgerly.test/v1/entries', headers: { 'x-api-key': 'redacted' } },
    response: { status: 401, error: { code: 'unauthorized', message: 'Invalid or missing credentials.' } },
    channel: 'mcp',
    klass: 'knowledge',
    vendor_hint: 'ledgerly',
  },
  repo,
);

const deps = {
  runner: makeLocalRunner(base),
  proofs: getProofRunner(repo),
  draft: makeClaudeResolver(),
  provision: makeProvisioner({ dir: join(here, 'sandbox-root'), anthropicKey: process.env['ANTHROPIC_API_KEY'] ?? '' }),
  freshBaseline: true,
};

function show(label: string, r: Awaited<ReturnType<typeof runLoop>>): void {
  process.stdout.write(`\n== ${label}: ${r.status} (${r.reason})\n`);
  for (const p of r.proof_details) process.stdout.write(`   ${p.pass ? 'PASS' : 'FAIL'} ${p.proof}: ${p.detail.slice(0, 160).replace(/\s+/g, ' ')}\n`);
  if (r.error) process.stdout.write(`   error ${r.error.code} @ ${r.error.stage}: ${r.error.message}\n`);
}

let exitCode = 0;
try {
  const first = await runLoop(repo, failure.id, deps);
  show('first run', first);
  if (first.status === 'awaiting_approval') {
    const approval = (await repo.listApprovals?.())?.[0];
    process.stdout.write(`   parked for approval ${approval ? approval.id : '(look up in repo)'}\n`);
  }
  const baseline = (await repo.toolEvents({ ticket_id: failure.id, action: 'proof.fresh_agent_baseline' }))[0];
  const bp = baseline?.payload as { agent_succeeded_without_fix?: boolean; discriminates?: boolean } | undefined;
  process.stdout.write(`   baseline (fresh agent on the UNFIXED docs): ${bp ? (bp.agent_succeeded_without_fix ? 'agent succeeded without the fix, proof does not discriminate' : 'agent failed without the fix, so the proof discriminates') : 'not recorded'}\n`);
  process.stdout.write(`\ncalls to the model: ${realApi ? 'real Anthropic API' : calls.join(', ')}\n`);
} catch (err) {
  exitCode = 1;
  process.stderr.write(`rehearsal failed: ${err instanceof Error ? err.stack : String(err)}\n`);
} finally {
  stub.close();
  await rm(base, { recursive: true, force: true });
}
process.exit(exitCode);
