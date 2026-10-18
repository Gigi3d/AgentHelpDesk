#!/usr/bin/env node
// demo/run-live.mjs: drive ONE real case through a running AgentHelpDesk server, over HTTP.
//
//   node demo/run-live.mjs [--base http://127.0.0.1:8787] [--yes] [--allow-fake]
//
// Steps: preflight (/v1/runtime) -> report the failure the way an agent would -> run the loop
// -> wait at the approval gate -> approve -> re-run -> RETRY the original call using the fix
// the desk returned -> tell the desk the retry result -> show the bill.
// Preflight refuses to start unless sandbox, reproduction, resolver, vendor tests and the fresh
// agent are real, so the recording cannot quietly use a stand-in. --allow-fake overrides that.
import { createInterface } from 'node:readline/promises';
import { extractCurlCommands, parseCurl, runCall } from './sandbox-root/ahd/work/lib/docs-call.mjs';
import { createLedgerlyServer, DEFAULT_KEY } from './sandbox-root/ahd/work/server.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const base = (args[args.indexOf('--base') + 1] && args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:8787').replace(/\/+$/, '');
const REQUIRED = ['sandbox', 'reproduction', 'resolver', 'vendor_tests', 'fresh_agent'];

const say = (s = '') => process.stdout.write(`${s}\n`);
async function call(method, path, body, okStatuses = []) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok && !okStatuses.includes(res.status)) {
    say(`HTTP ${res.status} from ${method} ${path}: ${text.slice(0, 600)}`);
    process.exit(1);
  }
  return json;
}
async function ask(question) {
  if (flag('--yes')) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`${question} [Enter] `);
  rl.close();
}
function showProofs(result) {
  for (const p of result.proof_details ?? []) say(`   ${p.pass ? 'PASS' : 'FAIL'}  ${p.proof}: ${String(p.detail).replace(/\s+/g, ' ').slice(0, 200)}`);
}

// ---- 1. preflight ----
say('1. Preflight: what is real in this run');
let runtime;
try {
  runtime = await call('GET', '/v1/runtime');
} catch (err) {
  say(`cannot reach ${base}: ${err.message}`);
  process.exit(1);
}
for (const c of runtime.components) say(`   ${c.real ? 'REAL' : 'fake'}  ${c.name}: ${c.detail}`);
const notReal = runtime.components.filter((c) => REQUIRED.includes(c.name) && !c.real);
if (notReal.length > 0 && !flag('--allow-fake')) {
  say(`\nRefusing to run: ${notReal.map((c) => c.name).join(', ')} not real. Fix the environment (see RUNBOOK.md), or pass --allow-fake and do not describe the run as verified.`);
  process.exit(2);
}
const billingReal = runtime.components.find((c) => c.name === 'billing')?.real === true;

// ---- 2. the agent's failure ----
say('\n2. An agent follows the Ledgerly quickstart and fails');
const report = {
  agent_id: 'agent-demo-live',
  task: 'List my ledger entries',
  request: { method: 'GET', url: 'https://api.ledgerly.test/v1/entries', headers: { 'x-api-key': 'redacted' } },
  response: { status: 401, error: { code: 'unauthorized', message: 'Invalid or missing credentials.' } },
  channel: 'mcp',
  klass: 'knowledge',
  vendor_hint: 'ledgerly',
};
say(`   GET /v1/entries with the documented x-api-key header -> 401 unauthorized`);
const opened = await call('POST', '/v1/cases', report);
const id = opened.case_id;
say(`   case ${id} opened. Committed ack_by ${opened.ack_by}, resolve_by ${opened.resolve_by}`);

// ---- 3. first run ----
say('\n3. The desk reproduces, drafts, and proves (this makes real sandbox and model calls)');
const first = await call('POST', '/v1/cases/run', { id });
let result = first.result;
say(`   status: ${result.status} (${result.reason})`);
showProofs(result);
if (result.error) say(`   error ${result.error.code} @ ${result.error.stage}: ${result.error.message}`);

// ---- 4. approval ----
if (result.status === 'awaiting_approval') {
  const view = await call('GET', `/v1/cases?id=${encodeURIComponent(id)}`);
  const approval = view.approval;
  say('\n4. Approval gate: Ledgerly is approve_first, so a human decides');
  say(`   approval ${approval?.id}\n   change: ${approval?.change_summary}`);
  const diff = (view.attempt?.diff ?? view.diff ?? '').toString();
  if (diff) say(diff.split('\n').map((l) => `      ${l}`).join('\n'));
  await ask('   Approve this change?');
  await call('POST', '/v1/approvals/reply', { id: approval.id, decision: 'yes', approver: approval.approver || 'founder' });
  say('   approved. Re-running the case (it reuses the approved draft).');
  const second = await call('POST', '/v1/cases/run', { id });
  result = second.result;
  say(`   status: ${result.status} (${result.reason})`);
  showProofs(result);
}

if (!result.reply) {
  say('\nNo reply was shipped, so there is nothing to retry or bill. Stopping.');
  process.exit(3);
}

// ---- 5. the agent retries ----
say('\n5. The agent retries using the fix in the reply');
say(`   fix steps: ${JSON.stringify(result.reply.fix_steps ?? result.reply.steps ?? null)}`);
const snippet = result.reply.snippet ?? result.reply.example ?? '';
let retryOk = false;
if (snippet) {
  const server = createLedgerlyServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const cmds = extractCurlCommands('```sh\n' + snippet + '\n```');
    const callSpec = parseCurl(cmds[0] ?? snippet, { LEDGERLY_KEY: DEFAULT_KEY });
    const out = await runCall(callSpec, `http://127.0.0.1:${server.address().port}`);
    retryOk = out.status >= 200 && out.status < 300;
    say(`   retried: ${callSpec.method} ${callSpec.url} -> ${out.status}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
} else {
  say('   the reply carried no runnable snippet; counting the retry as failed');
}
const retried = await call('POST', '/v1/cases/retry', { id, ok: retryOk }, [402]);
say(`   desk recorded retry ok=${retryOk}. billable: ${retried.billable}, lane: ${retried.billing_lane ?? 'none'}`);
if (retried.billing_error) say(`   billing error: ${JSON.stringify(retried.billing_error).slice(0, 300)}`);
if (retried.payment_required) say('   The lane is agent-pays, so the desk answered 402 and withheld the answer. Set stripe_customer_id and payer_mode "vendor" in AHD_VENDOR_JSON for the Stripe meter lane.');

// ---- 6. the bill ----
say('\n6. Billing');
say(`   Stripe is ${billingReal ? 'REAL (test-mode meter events)' : 'NOT connected in this run: no money or meter event left this machine'}.`);
const final = await call('GET', `/v1/cases?id=${encodeURIComponent(id)}`);
say(`   final status: ${final.status ?? final.case?.status}`);
say(`\nDone. Case ${id}. Evidence is in the case's tool events (GET /v1/cases?id=${id}).`);
