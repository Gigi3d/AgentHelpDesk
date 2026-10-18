#!/usr/bin/env node
// demo/check-keys.mjs: find the keys, say which tools will be REAL, and probe each one that has a
// safe read-only check. Never prints a key (only its kind and last 4 characters).
//
//   node demo/check-keys.mjs            # reads demo/.env.live, then the environment
//   node demo/check-keys.mjs --offline  # skip network probes
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const offline = process.argv.includes('--offline');
const envFile = join(here, '.env.live');

// Load demo/.env.live without overriding variables already exported in the shell.
const fromFile = {};
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (v !== '') fromFile[k] = v;
  }
}
const env = { ...fromFile, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
const get = (k) => (env[k] ?? '').trim();
const mask = (v) => (v.length > 8 ? `...${v.slice(-4)}` : '(short)');

const rows = [];
const add = (tool, status, detail) => rows.push({ tool, status, detail });

async function probe(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  return { status: res.status, text };
}

// ---- Anthropic ----
{
  const k = get('ANTHROPIC_API_KEY');
  if (!k) add('Anthropic', 'missing', 'resolver and fresh agent cannot run for real');
  else if (offline) add('Anthropic', 'present', `key ${mask(k)} (not probed)`);
  else {
    try {
      const r = await probe('https://api.anthropic.com/v1/models', { 'x-api-key': k, 'anthropic-version': '2023-06-01' });
      add('Anthropic', r.status === 200 ? 'ok' : 'FAIL', r.status === 200 ? `key ${mask(k)} accepted` : `HTTP ${r.status}: ${r.text.slice(0, 120)}`);
    } catch (e) {
      add('Anthropic', 'unreachable', e.message);
    }
  }
}

// ---- Blaxel ----
{
  const k = get('BL_API_KEY') || get('BLAXEL_API_KEY');
  const ws = get('BL_WORKSPACE') || get('BLAXEL_WORKSPACE');
  if (!k) add('Blaxel', 'missing', 'no sandbox: reproduction and every proof stay stand-ins');
  else if (!ws) add('Blaxel', 'FAIL', 'BL_API_KEY is set but BL_WORKSPACE is not');
  else if (!get('AHD_SANDBOX_IMAGE')) add('Blaxel', 'FAIL', 'AHD_SANDBOX_IMAGE is not set');
  else if (offline) add('Blaxel', 'present', `key ${mask(k)}, workspace ${ws} (not probed)`);
  else {
    try {
      const req = createRequire(join(resolve(here, '..'), 'product', 'package.json'));
      const mod = await import(pathToFileURL(req.resolve('@blaxel/core')).href);
      process.env.BL_API_KEY = k;
      process.env.BL_WORKSPACE = ws;
      const SI = mod.SandboxInstance;
      if (SI && typeof SI.list === 'function') {
        const list = await SI.list();
        add('Blaxel', 'ok', `key ${mask(k)} accepted, ${Array.isArray(list) ? list.length : '?'} sandbox(es) in ${ws}`);
      } else {
        add('Blaxel', 'present', 'SDK loaded but has no list(); first real run is the test');
      }
    } catch (e) {
      add('Blaxel', 'FAIL', `${e.message.slice(0, 160)} (run: cd product && npm i --no-save @blaxel/core)`);
    }
  }
}

// ---- Stripe ----
{
  const k = get('STRIPE_SECRET_KEY');
  if (!k) add('Stripe', 'missing', 'billing stays a stand-in: no meter event leaves this machine');
  else if (k.startsWith('sk_live_') || k.startsWith('rk_live_')) add('Stripe', 'FAIL', 'this is a LIVE-mode key. Use sk_test_ only. Refusing.');
  else if (!get('STRIPE_TEST_CUSTOMER_ID')) add('Stripe', 'FAIL', 'STRIPE_TEST_CUSTOMER_ID is not set (the vendor row needs it for the meter lane)');
  else if (offline) add('Stripe', 'present', `test key ${mask(k)} (not probed)`);
  else {
    try {
      const r = await probe('https://api.stripe.com/v1/billing/meters?limit=20', { authorization: `Bearer ${k}` });
      if (r.status !== 200) add('Stripe', 'FAIL', `HTTP ${r.status}: ${r.text.slice(0, 120)}`);
      else {
        const want = get('AHD_STRIPE_METER_EVENT_NAME') || 'ahd_verified_fix';
        const meters = JSON.parse(r.text).data ?? [];
        const m = meters.find((x) => x.event_name === want);
        add('Stripe', m ? 'ok' : 'FAIL', m ? `test key ${mask(k)}, meter '${want}' found (${m.default_aggregation?.formula ?? '?'} aggregation)` : `key works but no meter with event_name '${want}'. Create one (count aggregation) in the Stripe test dashboard.`);
      }
    } catch (e) {
      add('Stripe', 'unreachable', e.message);
    }
  }
}

// ---- Tools with no documented read-only probe: presence only ----
for (const [tool, key, extra] of [
  ['Inkbox', 'INKBOX_API_KEY', 'also set AHD_APPROVALS_FALLBACK_EMAIL or a vendor contact'],
  ['Primitive', 'PRIMITIVE_KEY', ''],
  ['Armature', 'ARMATURE_KEY', ''],
]) {
  const k = get(key);
  add(tool, k ? 'present' : 'missing', k ? `key ${mask(k)}; first real call is the test${extra ? `; ${extra}` : ''}` : 'stays a stand-in');
}

const w = Math.max(...rows.map((r) => r.tool.length));
process.stdout.write(`keys from ${existsSync(envFile) ? 'demo/.env.live + environment' : 'environment only (no demo/.env.live yet)'}\n\n`);
for (const r of rows) process.stdout.write(`  ${r.tool.padEnd(w)}  ${r.status.padEnd(11)} ${r.detail}\n`);
const core = ['Anthropic', 'Blaxel'].map((t) => rows.find((r) => r.tool === t));
const coreOk = core.every((r) => r.status === 'ok' || r.status === 'present');
const bad = rows.some((r) => r.status === 'FAIL' || r.status === 'unreachable');
process.stdout.write(`\n${coreOk && !bad ? 'Core keys ready: the live run can start.' : 'Not ready: fix the FAIL/missing lines above.'}\n`);
process.exit(coreOk && !bad ? 0 : 1);
