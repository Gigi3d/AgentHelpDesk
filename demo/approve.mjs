#!/usr/bin/env node
// demo/approve.mjs <case-id>: approve a case that is parked at the approval gate on the HOSTED desk,
// then re-run it so the fix ships. Reads the desk URL and token from demo/.deploy.json.
//   demo/live.sh approve c-703b7a16661869429edc
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
if (!id) { console.error('usage: demo/live.sh approve <case-id>'); process.exit(2); }
const dep = JSON.parse(readFileSync(join(ROOT, 'demo/.deploy.json'), 'utf8'));
const call = async (method, path, body) => {
  const res = await fetch(`${dep.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${dep.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) { console.error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 500)}`); process.exit(1); }
  return json;
};

const view = await call('GET', `/v1/cases?id=${encodeURIComponent(id)}`);
const approval = view.approval;
console.log(`case ${id}: status ${view.status ?? view.case?.status ?? 'unknown'}`);
if (!approval) { console.log('No approval is pending for this case yet. If it was just filed, wait about a minute and try again.'); process.exit(0); }
console.log(`approval ${approval.id}\nchange: ${approval.change_summary}`);
const diff = String(view.attempt?.diff ?? view.diff ?? '');
if (diff) console.log(diff.split('\n').map((l) => `   ${l}`).join('\n'));
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Press Enter to approve this change (ctrl+c to cancel) ');
rl.close();
await call('POST', '/v1/approvals/reply', { id: approval.id, decision: 'yes', approver: approval.approver || 'founder' });
console.log('approved. Re-running the case (it reuses the approved draft)...');
const run = await call('POST', '/v1/cases/run', { id });
const r = run.result ?? run;
console.log(`status: ${r.status} (${r.reason ?? ''})`);
for (const p of r.proof_details ?? []) console.log(`  ${p.pass ? 'PASS' : 'FAIL'}  ${p.proof}`);
console.log('Now ask Claude to check the case status. It can retry the call and report the result.');
