#!/usr/bin/env node
// demo/stripe-seed.mjs: TEST MODE ONLY. Fills your Stripe TEST dashboard with demo billing so the Billing page and
// the Stripe dashboard show realistic usage: a metered price ($4 per verified fix), three demo vendors with test
// subscriptions, and meter events spread over the last week. Everything is labelled demo and uses Stripe's test card.
//
//   demo/live.sh stripe-seed [--events 60]
//
// Refuses to run unless STRIPE_SECRET_KEY starts with sk_test_ or rk_test_. It cannot create live-mode charges,
// and demo data is never presented as revenue. Needs `demo/live.sh stripe` to have created the meter first. Safe to re-run.
import { readFileSync, existsSync } from 'node:fs';
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
if (!/^(sk|rk)_test_/.test(KEY)) { console.error('stripe-seed: STRIPE_SECRET_KEY must be a TEST key (sk_test_... or rk_test_...). Refusing: demo data never goes to live mode.'); process.exit(1); }
const EVENT = env.AHD_STRIPE_METER_EVENT_NAME || 'ahd_verified_fix';
const VERSION = env.AHD_STRIPE_API_VERSION || '2025-03-31.basil';
const i = process.argv.indexOf('--events');
const EVENTS = Math.min(Math.max(Number(i > 0 ? process.argv[i + 1] : 60) || 60, 1), 300);

async function stripe(method, path, form) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'stripe-version': VERSION, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`stripe-seed: ${method} ${path} -> ${res.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`); process.exit(1); }
  return json;
}

const meters = await stripe('GET', '/v1/billing/meters?status=active&limit=100');
const meter = (meters.data ?? []).find((m) => m.event_name === EVENT);
if (!meter) { console.error(`stripe-seed: no active meter named ${EVENT}. Run demo/live.sh stripe first.`); process.exit(1); }

// Product and metered price: $4.00 per verified fix.
const products = await stripe('GET', '/v1/products?active=true&limit=100');
let product = (products.data ?? []).find((p) => p.metadata?.app === 'agenthelpdesk-demo');
if (!product) product = await stripe('POST', '/v1/products', { name: 'AgentHelpDesk verified fix (demo)', 'metadata[app]': 'agenthelpdesk-demo' });
const prices = await stripe('GET', `/v1/prices?product=${product.id}&active=true&limit=10`);
let price = (prices.data ?? []).find((p) => p.recurring?.meter === meter.id);
if (!price) price = await stripe('POST', '/v1/prices', {
  product: product.id, currency: 'usd', unit_amount: '400',
  'recurring[interval]': 'month', 'recurring[usage_type]': 'metered', 'recurring[meter]': meter.id,
  nickname: 'Per verified fix (demo)',
});
console.log(`price: ${price.id} ($4.00 per verified fix, test mode)`);

// Three demo vendors, each with Stripe's test card and a subscription to the metered price.
const VENDORS = [['Ledgerly (demo)', 'ledgerly-demo@example.com', 0.5], ['Hark (demo)', 'hark-demo@example.com', 0.3], ['Northwind Pay (demo)', 'northwind-demo@example.com', 0.2]];
const customers = [];
for (const [name, email, share] of VENDORS) {
  const found = await stripe('GET', `/v1/customers?email=${encodeURIComponent(email)}&limit=1`);
  let c = found.data?.[0];
  if (!c) {
    c = await stripe('POST', '/v1/customers', { name, email, 'metadata[app]': 'agenthelpdesk-demo' });
    const pm = await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer: c.id });
    await stripe('POST', `/v1/customers/${c.id}`, { 'invoice_settings[default_payment_method]': pm.id });
  }
  const subs = await stripe('GET', `/v1/subscriptions?customer=${c.id}&status=active&limit=1`);
  if (!subs.data?.[0]) await stripe('POST', '/v1/subscriptions', { customer: c.id, 'items[0][price]': price.id });
  customers.push({ id: c.id, name, share });
  console.log(`vendor: ${name} ${c.id}`);
}

// Meter events over the last 7 days, one per verified fix. Identifiers are unique per run.
const run = Date.now().toString(36);
let sent = 0;
for (let n = 0; n < EVENTS; n += 1) {
  const r = Math.random();
  let acc = 0;
  const c = customers.find((x) => (acc += x.share) >= r) ?? customers[0];
  const ts = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 7 * 86400);
  await stripe('POST', '/v1/billing/meter_events', {
    event_name: EVENT, identifier: `demo-${run}-${n}`, timestamp: String(ts),
    'payload[stripe_customer_id]': c.id, 'payload[value]': '1',
  });
  sent += 1;
}
console.log(`\nsent ${sent} test meter events (about $${(sent * 4).toFixed(0)} of test-mode usage). Open dashboard.stripe.com/test/billing/meters to see them.`);
console.log('Test mode only: this is demo data, not revenue.');
