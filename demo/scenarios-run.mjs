#!/usr/bin/env node
// demo/scenarios-run.mjs: run the simulated x402 failures through the hosted desk with no human step.
//   demo/live.sh scenarios [--only a,b] [--rounds 2] [--batch 4]
// Round 1 is agent "alpha": every scenario is a first sighting, so Claude drafts the fix.
// Round 2 is agent "beta" hitting the same failures: the desk reuses the proven fix (no model call)
// and still re-runs all three proofs. Exits 0 only if every case shipped or was answered with nobody approving.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const f = join(ROOT, 'demo/.deploy.json');
if (!existsSync(f)) { console.error('scenarios: run demo/live.sh deploy first'); process.exit(1); }
const { url, token } = JSON.parse(readFileSync(f, 'utf8'));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const only = arg('--only', '') ? arg('--only', '').split(',') : undefined;
const rounds = Number(arg('--rounds', '2'));
const batch = Number(arg('--batch', '4'));
const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (m, p, b) => {
  const r = await fetch(url + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t);
};
const WORKING = new Set(['opened', 'reproducing', 'fix_drafted', 'proving']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (ms) => (ms == null ? '   -' : `${(ms / 1000).toFixed(1)}s`.padStart(6));

let bad = 0;
let saved = 0;
for (let round = 1; round <= rounds; round += 1) {
  const agent = round === 1 ? 'alpha' : round === 2 ? 'beta' : `agent${round}`;
  console.log(`\nRound ${round}: agent ${agent} reports ${only ? only.length : 'all'} x402 failures${round > 1 ? ' (the desk has seen these before)' : ''}`);
  const ids = only ?? (await api('GET', '/v1/scenarios')).scenarios.map((s) => s.id);
  const caseIds = [];
  for (let i = 0; i < ids.length; i += batch) {
    const out = await api('POST', '/v1/scenarios/run', { ids: ids.slice(i, i + batch), agent });
    caseIds.push(...out.started.map((s) => s.case_id));
    // wait for this batch before opening more sandboxes
    for (;;) {
      await sleep(4000);
      const board = (await api('GET', '/v1/scenarios')).scenarios.flatMap((s) => s.runs);
      const mine = board.filter((r) => out.started.some((s) => s.case_id === r.case_id));
      if (mine.length === out.started.length && mine.every((r) => !WORKING.has(r.status))) break;
    }
  }
  const board = (await api('GET', '/v1/scenarios')).scenarios.flatMap((s) => s.runs.map((r) => ({ ...r, scenario: s.id })));
  for (const r of board.filter((x) => caseIds.includes(x.case_id))) {
    const p = r.proofs ? ['replay', 'vendor_tests', 'fresh_agent'].map((k) => (r.proofs[k] ? 'pass' : 'FAIL')).join('/') : 'no proofs';
    const ok = r.status === 'shipped' || r.status === 'answered' || r.status === 'closed';
    if (!ok) bad += 1;
    if (r.memory_hit) saved += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${r.scenario.padEnd(24)} ${r.status.padEnd(10)} ${secs(r.ms)}  ${r.memory_hit ? 'memory hit, no model call' : 'fresh draft              '}  proofs ${p}`);
  }
}
console.log(`\n${bad === 0 ? 'PASS' : `FAIL (${bad} not shipped)`}: no human approved anything. Model calls avoided by Fix Memory: ${saved}.`);
console.log(`Watch it: ${url}/app/scenarios   (desk key is in demo/.deploy.json)`);
process.exit(bad === 0 ? 0 : 1);
