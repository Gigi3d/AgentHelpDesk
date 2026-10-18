#!/usr/bin/env node
// demo/persist-check.mjs: prove the hosted desk keeps its state and data on Blaxel.
//
//   node demo/persist-check.mjs record            run one real case, save a fingerprint of it
//   node demo/persist-check.mjs verify            read the case back and compare to the fingerprint
//   node demo/persist-check.mjs restart           record, restart the desk process, verify
//   node demo/persist-check.mjs standby [secs]    record, sit idle so the sandbox can suspend, verify
//   node demo/persist-check.mjs wipe              record, DELETE the sandbox, redeploy, verify
//
// What each proves:
//   restart  the desk's state is on disk (/app/data/cases.json), not only in memory
//   standby  a suspended and resumed sandbox answers with the same case
//   wipe     the Blaxel volume (ahd-data) holds the data after the whole sandbox is gone
// Exit 0 only if every check passed. Needs demo/.env.live and demo/.deploy.json (run deploy first).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FP = join(ROOT, 'demo/.persist.json');
const DEPLOY = join(ROOT, 'demo/.deploy.json');
const say = (s = '') => process.stdout.write(`${s}\n`);
const die = (s) => { say(`\nFAIL: ${s}`); process.exit(1); };

// ---- env (same file the other demo scripts use) ----
const env = {};
try {
  for (const line of readFileSync(join(ROOT, 'demo/.env.live'), 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
} catch { /* only needed for restart and wipe */ }
const bl = { BL_API_KEY: env.BL_API_KEY || env.BLAXEL_API_KEY || process.env.BL_API_KEY, BL_WORKSPACE: env.BL_WORKSPACE || env.BLAXEL_WORKSPACE || process.env.BL_WORKSPACE };

function deploy() {
  if (!existsSync(DEPLOY)) die('no demo/.deploy.json. Run demo/live.sh deploy first.');
  return JSON.parse(readFileSync(DEPLOY, 'utf8'));
}
async function api(method, path, body) {
  const d = deploy();
  const res = await fetch(`${d.url.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${d.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}
async function health(tries = 40) {
  const d = deploy();
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${d.url.replace(/\/+$/, '')}/healthz`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return await r.json();
    } catch { /* waking up */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  die('the desk did not answer /healthz in time');
}
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const sha = (v) => createHash('sha256').update(canon(v)).digest('hex');

// ---- record ----
async function record() {
  say('Recording: one real Ledgerly case on the hosted desk');
  const h = await health();
  if (!h.persisted) die('the desk is running without AHD_DATA_FILE, so nothing would survive a restart. Redeploy with demo/live.sh deploy.');
  const opened = await api('POST', '/v1/cases', {
    agent_id: 'agent-persist-check', task: 'List my ledger entries',
    request: { method: 'GET', url: 'https://api.ledgerly.test/v1/entries', headers: { 'x-api-key': 'redacted' } },
    response: { status: 401, error: { code: 'unauthorized', message: 'Invalid or missing credentials.' } },
    channel: 'mcp', klass: 'knowledge', vendor_hint: 'ledgerly',
  });
  if (!opened.ok) die(`could not open a case: HTTP ${opened.status} ${JSON.stringify(opened.json).slice(0, 300)}`);
  const id = opened.json.case_id;
  const ran = await api('POST', '/v1/cases/run', { id });
  if (!ran.ok) die(`run failed: HTTP ${ran.status} ${JSON.stringify(ran.json).slice(0, 400)}`);
  const status = ran.json.result?.status;
  say(`   case ${id} ran: ${status}`);
  const view = await api('GET', `/v1/cases?id=${encodeURIComponent(id)}`);
  const list = await api('GET', '/v1/cases');
  const fp = { case_id: id, status, hash: sha(view.json), view_keys: Object.keys(view.json).sort(), cases_in_desk: Array.isArray(list.json) ? list.json.length : (list.json.cases?.length ?? null), started_at: h.started_at, recorded_at: new Date().toISOString() };
  writeFileSync(FP, JSON.stringify(fp, null, 2));
  say(`   fingerprint saved (${fp.hash.slice(0, 12)}, desk started ${fp.started_at})`);
  return fp;
}

// ---- verify ----
async function verify(label, { expectNewProcess = false } = {}) {
  if (!existsSync(FP)) die('no fingerprint. Run: node demo/persist-check.mjs record');
  const fp = JSON.parse(readFileSync(FP, 'utf8'));
  const h = await health();
  const checks = [];
  const add = (name, pass, detail) => { checks.push({ name, pass }); say(`   ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`); };
  say(`Verifying (${label})`);
  if (expectNewProcess) add('desk process really restarted', h.started_at !== fp.started_at, `${fp.started_at} -> ${h.started_at}`);
  const view = await api('GET', `/v1/cases?id=${encodeURIComponent(fp.case_id)}`);
  add('case is still there', view.ok, view.ok ? fp.case_id : `HTTP ${view.status}`);
  if (view.ok) {
    const same = sha(view.json) === fp.hash;
    add('case, events, proofs and billing are identical', same, same ? fp.hash.slice(0, 12) : `hash ${sha(view.json).slice(0, 12)} vs ${fp.hash.slice(0, 12)}`);
    if (!same) say(`        keys now: ${Object.keys(view.json).sort().join(', ')}\n        keys then: ${fp.view_keys.join(', ')}`);

  }
  const list = await api('GET', '/v1/cases');
  const n = Array.isArray(list.json) ? list.json.length : (list.json.cases?.length ?? null);
  add('no cases lost', n !== null && fp.cases_in_desk !== null && n >= fp.cases_in_desk, `${n} now, ${fp.cases_in_desk} before`);
  const failed = checks.filter((c) => !c.pass).length;
  say(failed === 0 ? `\nPASS: ${label}` : `\nFAIL: ${label} (${failed} check${failed > 1 ? 's' : ''} failed)`);
  return failed === 0;
}

async function sdk() {
  if (!bl.BL_API_KEY || !bl.BL_WORKSPACE) die('BL_API_KEY and BL_WORKSPACE are needed (demo/.env.live).');
  process.env.BL_API_KEY = bl.BL_API_KEY; process.env.BL_WORKSPACE = bl.BL_WORKSPACE;
  if (env.BL_REGION) process.env.BL_REGION = env.BL_REGION;
  try { return createRequire(join(ROOT, 'product/package.json'))('@blaxel/core'); } catch { die('Run: cd product && npm i --no-save @blaxel/core'); }
}

// ---- modes ----
const [mode = 'verify', arg] = process.argv.slice(2);
if (mode === 'record') { await record(); process.exit(0); }
if (mode === 'verify') process.exit((await verify('read back')) ? 0 : 1);

if (mode === 'restart') {
  await record();
  const { SandboxInstance } = await sdk();
  const sb = await SandboxInstance.get(deploy().sandbox || 'ahd-desk');
  say('\nRestarting the desk process inside the sandbox');
  try { await sb.process.kill('desk'); } catch { /* may already be gone */ }
  await new Promise((r) => setTimeout(r, 3000));
  await sb.process.exec({
    name: 'desk',
    command: `bash -lc 'cd /app && set -a && . ./ahd.env && set +a && exec node --experimental-strip-types product/server.ts'`,
    workingDir: '/app', waitForCompletion: false, keepAlive: true, restartOnFailure: true, maxRestarts: 20,
  });
  process.exit((await verify('after a desk restart', { expectNewProcess: true })) ? 0 : 1);
}

if (mode === 'standby') {
  await record();
  const secs = Number(arg || 90);
  say(`\nIdle for ${secs}s so Blaxel can suspend the sandbox`);
  await new Promise((r) => setTimeout(r, secs * 1000));
  process.exit((await verify(`after ${secs}s idle`)) ? 0 : 1);
}

if (mode === 'wipe') {
  await record();
  const { SandboxInstance } = await sdk();
  const name = deploy().sandbox || 'ahd-desk';
  say(`\nDeleting sandbox ${name}. The ahd-data volume is kept; the sandbox disk is gone.`);
  await SandboxInstance.delete(name);
  await new Promise((r) => setTimeout(r, 8000));
  say('Redeploying (this takes a few minutes)');
  const r = spawnSync('node', [join(ROOT, 'demo/deploy-blaxel.mjs')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) die('redeploy failed');
  process.exit((await verify('after the sandbox was deleted and redeployed', { expectNewProcess: true })) ? 0 : 1);
}
die(`unknown mode "${mode}"`);
