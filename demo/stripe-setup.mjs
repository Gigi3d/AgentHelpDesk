#!/usr/bin/env node
// demo/stripe-setup.mjs: TEST MODE ONLY. Creates (or finds) the usage meter `ahd_verified_fix` and a test
// customer "Ledgerly Test", then writes STRIPE_TEST_CUSTOMER_ID into demo/.env.live. Safe to re-run.
//
//   demo/live.sh stripe
//
// Refuses to run unless STRIPE_SECRET_KEY starts with sk_test_ or rk_test_. Zero dependencies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(ROOT, 'demo/.env.live');
const env = { ...process.env };
if (existsSync(envFile)) for (const l of readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(l);
  if (m && m[2] && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const KEY = env.STRIPE_SECRET_KEY ?? '';
if (!/^(sk|rk)_test_/.test(KEY)) { console.error('stripe-setup: STRIPE_SECRET_KEY must be a TEST key (sk_test_... or rk_test_...). Refusing.'); process.exit(1); }
const EVENT = env.AHD_STRIPE_METER_EVENT_NAME || 'ahd_verified_fix';
const VERSION = env.AHD_STRIPE_API_VERSION || '2025-03-31.basil';

async function stripe(method, path, form) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'stripe-version': VERSION, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`stripe-setup: ${method} ${path} -> ${res.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`); process.exit(1); }
  return json;
}

// 1. Meter: find an active one with this event name, else create it.
const meters = await stripe('GET', '/v1/billing/meters?status=active&limit=100');
let meter = (meters.data ?? []).find((m) => m.event_name === EVENT);
if (meter) console.log(`meter: found ${meter.id} (${EVENT}, ${meter.default_aggregation?.formula})`);
else {
  meter = await stripe('POST', '/v1/billing/meters', {
    display_name: 'AHD verified fix',
    event_name: EVENT,
    'default_aggregation[formula]': 'count',
    'customer_mapping[event_payload_key]': 'stripe_customer_id',
    'customer_mapping[type]': 'by_id',
    'value_settings[event_payload_key]': 'value',
  });
  console.log(`meter: created ${meter.id} (${EVENT}, count)`);
}

// 2. Customer: reuse by email, else create.
const email = 'ledgerly-test@example.com';
const found = await stripe('GET', `/v1/customers?email=${encodeURIComponent(email)}&limit=1`);
let customer = found.data?.[0];
if (customer) console.log(`customer: found ${customer.id}`);
else {
  customer = await stripe('POST', '/v1/customers', { name: 'Ledgerly Test', email, 'metadata[app]': 'agenthelpdesk' });
  console.log(`customer: created ${customer.id}`);
}

// 3. Save the customer id for the desk.
let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
if (/^STRIPE_TEST_CUSTOMER_ID=.*$/m.test(text)) text = text.replace(/^STRIPE_TEST_CUSTOMER_ID=.*$/m, `STRIPE_TEST_CUSTOMER_ID=${customer.id}`);
else text += `\nSTRIPE_TEST_CUSTOMER_ID=${customer.id}\n`;
writeFileSync(envFile, text, { mode: 0o600 });
console.log(`saved STRIPE_TEST_CUSTOMER_ID=${customer.id} in demo/.env.live`);
console.log('next: demo/live.sh deploy && demo/live.sh remote');
