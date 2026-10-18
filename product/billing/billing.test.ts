// Billing tests. Handlers are called directly with a constructed Ctx and a MemoryRepository:
// no ports, no processes, no network (AGENTS.md). Do not run node on this machine — the
// orchestrator runs `node --test` serially.
//
// Coverage: golden path (billable -> exactly one meter event), idempotent replay, policy
// exemption, the x402 settle-twice path, the MPP rail, invoice numbers computed from the repo,
// cancellation inside Stripe's 24h window, and one failure path per lane.
import test from 'node:test';
import assert from 'node:assert/strict';

// Force the offline client before anything lazily constructs it (imports hoist, but
// getBillingClient() only reads env on first call).
process.env['AHD_BILLING_FAKE'] = '1';

import { HttpError, type Ctx, type Handler, type HttpResult, type Router } from '../shared/http.ts';
import type { Attempt, Failure, MeterEvent, Outcome, ToolEvent, Vendor } from '../shared/types.ts';
import { MemoryRepository } from '../store/memory.ts';
import type { Repository } from '../store/repository.ts';
import { decide } from './billable.ts';
import { cancelMeterEventForOutcome, onBillable } from './meter.ts';
import * as mpp from './mpp.ts';
import { registerRoutes } from './register.ts';
import { FakeStripeClient } from './stripe-client.ts';
import * as x402 from './x402.ts';

/** Route table bound to one repo, so handlers close over the store the test seeded. */
function routesFor(repo: Repository): Map<string, Handler> {
  const table = new Map<string, Handler>();
  const router: Router = {
    add(method, path, handler) {
      table.set(`${method} ${path}`, handler);
    },
  };
  registerRoutes(router, repo);
  return table;
}

async function hit(
  table: Map<string, Handler>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  query = '',
): Promise<HttpResult> {
  const handler = table.get(`${method} ${path}`);
  if (!handler) throw new Error(`test bug: no route registered for ${method} ${path}`);
  const url = new URL(`http://desk.test${path}${query}`);
  const ctx: Ctx = {
    method,
    path,
    query: url.searchParams,
    body: body ?? null,
    headers: {},
    requestId: 'req_test_1',
    caller: 'agent_test',
  };
  return handler(ctx);
}

async function captureError(run: () => unknown): Promise<HttpError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw new Error(`expected an HttpError, got: ${(err as Error).message}`);
  }
  throw new Error('expected the call to throw an HttpError, but it succeeded');
}

function vendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'v_ledgerly',
    name: 'Ledgerly (demo vendor)',
    repo_url: 'https://example.invalid/ledgerly',
    sandbox_name: 'ahd-ledgerly',
    risk_policy: 'auto',
    stripe_customer_id: 'cus_demo_ledgerly',
    payer_mode: 'vendor',
    report_contacts: ['ops@example.invalid'],
    ...overrides,
  };
}

function failure(id: string, overrides: Partial<Failure> = {}): Failure {
  return {
    id,
    vendor_id: 'v_ledgerly',
    agent_id: 'agent_demo',
    task: 'POST /orders returns 401 although the quickstart key is valid',
    request: { path: '/orders' },
    response: { status: 401 },
    klass: 'knowledge',
    status: 'answered',
    ack_by: '2026-10-17T10:00:00.000Z',
    resolve_by: '2026-10-17T14:00:00.000Z',
    queue_position: 1,
    created_at: '2026-10-17T09:59:00.000Z',
    ...overrides,
  };
}

function attempt(failureId: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: `att_${failureId}`,
    failure_id: failureId,
    diff: '--- a/docs/quickstart.md\n+++ b/docs/quickstart.md\n@@ -1 +1 @@\n-x-api-key\n+Authorization: Bearer',
    proof_replay: true,
    proof_vendor_tests: true,
    proof_fresh_agent: true,
    log_url: 'https://example.invalid/logs/att',
    ...overrides,
  };
}

function outcome(failureId: string, overrides: Partial<Outcome> = {}): Outcome {
  return {
    id: `out_${failureId}`,
    failure_id: failureId,
    shipped_as: 'answer',
    approved_by: null,
    agent_retry_ok: true,
    billable: true,
    payer: null,
    stripe_event_id: null,
    mpp_payment_id: null,
    x402_payment_id: null,
    ...overrides,
  };
}

interface SeedItem {
  vendor?: Vendor;
  failure: Failure;
  attempt?: Attempt;
  outcome?: Outcome;
}

async function seed(repo: Repository, item: SeedItem): Promise<void> {
  if (item.vendor) await repo.putVendor(item.vendor);
  await repo.createFailure(item.failure);
  if (item.attempt) await repo.createAttempt(item.attempt);
  if (item.outcome) await repo.createOutcome(item.outcome);
}

async function events(repo: Repository, action: string): Promise<ToolEvent[]> {
  const all = await repo.toolEvents({ tool: 'billing' });
  return all.filter((e) => e.action === action);
}

// ---- golden path: billable -> exactly one meter event -------------------------------------
test('billing: a verified fix emits exactly one meter event, keyed by the outcome id', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    vendor: vendor(),
    failure: failure('f_golden'),
    attempt: attempt('f_golden'),
    outcome: outcome('f_golden'),
  });
  const table = routesFor(repo);
  const client = new FakeStripeClient();

  const stored = await repo.getOutcome('f_golden');
  assert.ok(stored, 'outcome must exist');
  const first = await onBillable(stored, 'b2b_meter', repo, client);
  assert.equal(first.kind, 'meter_event');
  if (first.kind !== 'meter_event') return;
  assert.equal(first.replayed, false);
  assert.equal(first.meter_event.identifier, 'out_f_golden', 'the identifier is the outcome id');
  assert.equal(first.meter_event.event_name, 'ahd_verified_fix');
  assert.equal(first.meter_event.value, 1, 'count aggregation: one verified fix');
  assert.equal(first.meter_event.mode, 'test');
  assert.equal(client.emitted.length, 1);

  const metered = await repo.getOutcome('f_golden');
  assert.ok(metered);
  assert.equal(metered.stripe_event_id, first.meter_event.id, 'the outcome carries the Stripe event id');
  assert.equal(metered.payer, 'vendor');
  assert.ok(await repo.meterEventByIdentifier('out_f_golden'), 'the Repository holds the receipt row');

  const created = await events(repo, 'meter_event.created');
  assert.equal(created.length, 1, 'one meter_event.created ToolEvent');
  assert.equal(created[0]?.stage, 'billing.meter');

  // The route agrees with the library call: a second POST for the same outcome is a replay.
  const viaRoute = await hit(table, 'POST', '/v1/billing/on-billable', { outcome_id: 'out_f_golden', lane: 'b2b_meter' });
  assert.equal(viaRoute.status, 200);
  const body = viaRoute.body as { replayed: boolean; meter_event: MeterEvent; stripe_event_id: string | null };
  assert.equal(body.replayed, true);
  assert.equal(body.meter_event.identifier, 'out_f_golden');
  assert.equal(body.stripe_event_id, first.meter_event.id);
  assert.equal(client.emitted.length, 1, 'the replay emitted nothing');
  assert.equal((await events(repo, 'meter_event.created')).length, 1, 'still one created event');
  assert.equal((await events(repo, 'meter_event.replayed')).length, 1, 'the replay is observable');
});

// ---- the billable rule and lane choice -----------------------------------------------------
test('billing: decide() applies the one rule and picks the lane from the vendor relationship', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    vendor: vendor({ id: 'v_vendor_pays', payer_mode: 'vendor' }),
    failure: failure('f_meter', { vendor_id: 'v_vendor_pays' }),
    attempt: attempt('f_meter'),
    outcome: outcome('f_meter'),
  });
  await seed(repo, {
    vendor: vendor({ id: 'v_agent_pays', payer_mode: 'agent' }),
    failure: failure('f_mpp', { vendor_id: 'v_agent_pays' }),
    attempt: attempt('f_mpp'),
    outcome: outcome('f_mpp'),
  });
  await seed(repo, {
    // No vendor row at all: a stranger agent, so there is nobody to invoice.
    failure: failure('f_a2a', { vendor_id: 'v_nobody' }),
    attempt: attempt('f_a2a'),
    outcome: outcome('f_a2a'),
  });
  await seed(repo, {
    vendor: vendor({ id: 'v_incomplete' }),
    failure: failure('f_incomplete', { vendor_id: 'v_incomplete' }),
    attempt: attempt('f_incomplete', { proof_fresh_agent: false }),
    outcome: outcome('f_incomplete'),
  });

  assert.deepEqual(await decide('f_meter', repo), {
    billable: true,
    reason: 'billable_vendor_pays_meter: three proofs passed and the agent retry succeeded; meter the vendor',
    lane: 'b2b_meter',
  });
  assert.equal((await decide('f_mpp', repo)).lane, 'b2b_mpp');
  assert.equal((await decide('f_a2a', repo)).lane, 'a2a_x402');

  const incomplete = await decide('f_incomplete', repo);
  assert.equal(incomplete.billable, false);
  assert.equal(incomplete.lane, null);
  assert.match(incomplete.reason, /proofs not passed: fresh_agent/);

  const missing = await captureError(() => decide('f_nope', repo));
  assert.equal(missing.status, 404);
  assert.equal(missing.code, 'case_not_found');
  assert.equal(missing.stage, 'billing.decide');
});

// ---- policy exemption ---------------------------------------------------------------------
test('billing: a privacy request is exempt — billing.exempt event, no meter event', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    vendor: vendor({ id: 'v_exempt' }),
    failure: failure('f_exempt', {
      vendor_id: 'v_exempt',
      klass: 'authority',
      task: 'DELETE /users/42/data — GDPR data deletion request from an end user',
    }),
    attempt: attempt('f_exempt'),
    outcome: outcome('f_exempt'),
  });

  const decision = await decide('f_exempt', repo);
  assert.equal(decision.billable, false);
  assert.equal(decision.lane, null);
  assert.match(decision.reason, /^exempt_privacy_request/);

  const exemptEvents = await events(repo, 'billing.exempt');
  assert.equal(exemptEvents.length, 1, 'the exemption is on the audit trail');
  assert.equal(exemptEvents[0]?.result, 'skipped');
  assert.equal(await repo.meterEventByIdentifier('out_f_exempt'), null, 'no meter event for an exempt case');
  assert.equal(await repo.isBillable('f_exempt'), true, 'the proofs passed; policy is what exempts it');

  const table = routesFor(repo);
  const refused = await captureError(() =>
    hit(table, 'POST', '/v1/billing/on-billable', { outcome_id: 'out_f_exempt', lane: 'b2b_meter' }),
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'not_billable');
  assert.equal(refused.stage, 'billing.meter.on_billable');
  assert.equal(await repo.meterEventByIdentifier('out_f_exempt'), null, 'still no meter event');
});

test('billing: a suggest_only vendor never bills (rungs 0-3 are labelled suggestions)', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    vendor: vendor({ id: 'v_suggest', risk_policy: 'suggest_only' }),
    failure: failure('f_suggest', { vendor_id: 'v_suggest' }),
    attempt: attempt('f_suggest'),
    outcome: outcome('f_suggest'),
  });
  const decision = await decide('f_suggest', repo);
  assert.equal(decision.billable, false);
  assert.match(decision.reason, /^exempt_suggest_only/);
  assert.equal((await events(repo, 'billing.exempt')).length, 1);
});

// ---- A2A: x402 ---------------------------------------------------------------------------
test('a2a: the 402 requirement is priced in atomic USDC and settles once, idempotently', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    failure: failure('f_stranger', { vendor_id: 'v_nobody', agent_id: 'agent_stranger' }),
    attempt: attempt('f_stranger'),
    outcome: outcome('f_stranger'),
  });
  const table = routesFor(repo);

  const required = await hit(table, 'POST', '/v1/a2a/402', { outcome_id: 'out_f_stranger' });
  assert.equal(required.status, 402, 'the answer sits behind a 402');
  const requirementBody = required.body as x402.X402RequirementBody;
  assert.equal(requirementBody.x402Version, 1);
  assert.equal(requirementBody.lane, 'a2a_x402');
  assert.equal(requirementBody.price_usd, 0.5);
  const accepts = requirementBody.accepts[0];
  assert.ok(accepts, 'a payment requirement must be offered');
  assert.equal(accepts.scheme, 'exact');
  assert.equal(accepts.network, 'base-sepolia');
  assert.equal(accepts.maxAmountRequired, '500000', '$0.50 in USDC atomic units (6 decimals)');
  assert.equal(accepts.resource, '/v1/a2a/outcomes/out_f_stranger');
  assert.ok(requirementBody.x_payment_required_b64.length > 0, 'header value for the caller to set');

  const first = await hit(table, 'POST', '/v1/a2a/settle', { outcome_id: 'out_f_stranger', proof: 'xpay_demo_blob_1' });
  assert.equal(first.status, 200);
  const firstBody = first.body as { unlock: boolean; payment_id: string; payer: string; replayed: boolean };
  assert.equal(firstBody.unlock, true);
  assert.equal(firstBody.payer, 'agent');
  assert.equal(firstBody.replayed, false);
  assert.match(firstBody.payment_id, /^x402_fake_[0-9a-f]{24}$/);

  const second = await hit(table, 'POST', '/v1/a2a/settle', { outcome_id: 'out_f_stranger', proof: 'xpay_demo_blob_1' });
  const secondBody = second.body as { unlock: boolean; payment_id: string; replayed: boolean };
  assert.equal(secondBody.payment_id, firstBody.payment_id, 'the same payment id comes back');
  assert.equal(secondBody.replayed, true);
  assert.equal((await events(repo, 'x402.settled')).length, 1, 'settled once, not twice');

  // A different proof cannot buy the same answer again: the first receipt wins.
  const third = await hit(table, 'POST', '/v1/a2a/settle', { outcome_id: 'out_f_stranger', proof: 'xpay_demo_blob_2' });
  const thirdBody = third.body as { payment_id: string; replayed: boolean };
  assert.equal(thirdBody.payment_id, firstBody.payment_id);
  assert.equal(thirdBody.replayed, true);

  const stored = await repo.getOutcome('f_stranger');
  assert.ok(stored);
  assert.equal(stored.payer, 'agent');
  assert.equal(stored.x402_payment_id, firstBody.payment_id);
  assert.equal(await repo.meterEventByIdentifier('out_f_stranger'), null, 'A2A never touches the vendor meter');
});

test('a2a: a rejected payment fails loud at 402 and unlocks nothing', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    failure: failure('f_bad_pay', { vendor_id: 'v_nobody' }),
    attempt: attempt('f_bad_pay'),
    outcome: outcome('f_bad_pay'),
  });
  const table = routesFor(repo);
  const err = await captureError(() =>
    hit(table, 'POST', '/v1/a2a/settle', { outcome_id: 'out_f_bad_pay', proof: 'xpay_invalid_signature' }),
  );
  assert.equal(err.status, 402);
  assert.equal(err.code, 'payment_rejected');
  assert.equal(err.stage, 'billing.x402.verify');
  const stored = await repo.getOutcome('f_bad_pay');
  assert.ok(stored);
  assert.equal(stored.x402_payment_id, null, 'nothing is recorded for a payment that did not verify');
  assert.equal((await events(repo, 'x402.rejected')).length, 1);
});

test('a2a: settling a case that is not billable is refused', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    failure: failure('f_unproven', { vendor_id: 'v_nobody' }),
    attempt: attempt('f_unproven', { proof_replay: false }),
    outcome: outcome('f_unproven', { agent_retry_ok: false }),
  });
  const err = await captureError(() =>
    x402.settle({ outcome_id: 'out_f_unproven', scheme: 'exact', network: 'base-sepolia', x_payment: 'xpay_demo_blob' }, repo),
  );
  assert.equal(err.status, 409);
  assert.equal(err.code, 'not_billable');
  assert.equal(err.stage, 'billing.x402.settle');
});

// ---- B2B agent-pays: Stripe MPP ----------------------------------------------------------
test('mpp: a vendor that chose agent-pays gets a 402 at the $0.50 card / $0.01 USDC minimums', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    vendor: vendor({ id: 'v_agent_pays', payer_mode: 'agent' }),
    failure: failure('f_mpp', { vendor_id: 'v_agent_pays' }),
    attempt: attempt('f_mpp'),
    outcome: outcome('f_mpp'),
  });
  const table = routesFor(repo);

  const required = await hit(table, 'POST', '/v1/billing/on-billable', { outcome_id: 'out_f_mpp', lane: 'b2b_mpp' });
  assert.equal(required.status, 402);
  const body = required.body as mpp.MppRequirementBody;
  assert.equal(body.lane, 'b2b_mpp');
  assert.equal(body.price_usd, 0.5);
  assert.equal(body.stripe_api_version, '2026-07-29.preview');
  const card = body.accepts.find((a) => a.method === 'card');
  const usdc = body.accepts.find((a) => a.method === 'usdc');
  assert.ok(card, 'card is offered at the $0.50 Shared Payment Token minimum');
  assert.equal(card.minimum, 0.5);
  assert.equal(card.shared_payment_token, true);
  assert.ok(usdc, 'USDC is offered down to $0.01');
  assert.equal(usdc.minimum, 0.01);
  assert.equal((await events(repo, 'mpp.requirement_issued')).length, 1);

  const settled = await hit(table, 'POST', '/v1/billing/mpp/settle', {
    outcome_id: 'out_f_mpp',
    method: 'card',
    proof: 'spt_demo_token_1',
  });
  const settledBody = settled.body as { unlock: boolean; payment_id: string; payer: string };
  assert.equal(settledBody.unlock, true);
  assert.equal(settledBody.payer, 'agent');
  assert.match(settledBody.payment_id, /^mpp_fake_[0-9a-f]{24}$/);

  const replay = await hit(table, 'POST', '/v1/billing/mpp/settle', {
    outcome_id: 'out_f_mpp',
    method: 'card',
    proof: 'spt_demo_token_1',
  });
  const replayBody = replay.body as { payment_id: string; replayed: boolean };
  assert.equal(replayBody.payment_id, settledBody.payment_id);
  assert.equal(replayBody.replayed, true);
  assert.equal((await events(repo, 'mpp.settled')).length, 1);

  const stored = await repo.getOutcome('f_mpp');
  assert.ok(stored);
  assert.equal(stored.mpp_payment_id, settledBody.payment_id);
  assert.equal(await repo.meterEventByIdentifier('out_f_mpp'), null, 'the agent paid, so the vendor is not metered');

  // After settlement, on-billable reports the receipt instead of issuing a new 402.
  const after = await hit(table, 'POST', '/v1/billing/on-billable', { outcome_id: 'out_f_mpp', lane: 'b2b_mpp' });
  assert.equal(after.status, 200);
  const afterBody = after.body as { unlock: boolean; payment_id: string };
  assert.equal(afterBody.unlock, true);
  assert.equal(afterBody.payment_id, settledBody.payment_id);
});

test('mpp: a price under the card minimum drops the card method; under the USDC minimum fails loud', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    vendor: vendor({ id: 'v_agent_pays', payer_mode: 'agent' }),
    failure: failure('f_mpp_cheap', { vendor_id: 'v_agent_pays' }),
    attempt: attempt('f_mpp_cheap'),
    outcome: outcome('f_mpp_cheap'),
  });
  const stored = await repo.getOutcome('f_mpp_cheap');
  assert.ok(stored);

  process.env['AHD_MPP_PRICE_USD'] = '0.25';
  try {
    const cheap = mpp.requirement(stored);
    assert.equal(cheap.accepts.some((a) => a.method === 'card'), false, 'no illegal card offer below $0.50');
    assert.equal(cheap.accepts.length, 1);
    assert.equal(cheap.accepts[0]?.method, 'usdc');
  } finally {
    delete process.env['AHD_MPP_PRICE_USD'];
  }

  process.env['AHD_MPP_PRICE_USD'] = '0.001';
  try {
    const err = await captureError(() => mpp.requirement(stored));
    assert.equal(err.status, 500);
    assert.equal(err.code, 'mpp_below_usdc_minimum');
    assert.equal(err.stage, 'billing.mpp');
  } finally {
    delete process.env['AHD_MPP_PRICE_USD'];
  }
});

// ---- invoice preview ---------------------------------------------------------------------
test('invoice-preview: every number is counted from the repository', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    vendor: vendor({ id: 'v_bill' }),
    failure: failure('f_docs', { vendor_id: 'v_bill', klass: 'knowledge' }),
    attempt: attempt('f_docs'),
    outcome: outcome('f_docs'),
  });
  await seed(repo, {
    failure: failure('f_code', { vendor_id: 'v_bill', klass: 'code' }),
    attempt: attempt('f_code'),
    outcome: outcome('f_code', { shipped_as: 'pr' }),
  });
  await seed(repo, {
    failure: failure('f_mig', { vendor_id: 'v_bill', klass: 'authority' }),
    attempt: attempt('f_mig'),
    outcome: outcome('f_mig', { shipped_as: 'grant', approved_by: '+15550000000' }),
  });
  await seed(repo, {
    failure: failure('f_broken', { vendor_id: 'v_bill', klass: 'knowledge' }),
    attempt: attempt('f_broken', { proof_vendor_tests: false }),
    outcome: outcome('f_broken', { agent_retry_ok: false }),
  });
  await seed(repo, {
    failure: failure('f_privacy', { vendor_id: 'v_bill', klass: 'knowledge', task: 'CCPA right to be forgotten' }),
    attempt: attempt('f_privacy'),
    outcome: outcome('f_privacy'),
  });
  const table = routesFor(repo);

  const res = await hit(table, 'GET', '/v1/billing/invoice-preview', undefined, '?vendor_id=v_bill');
  assert.equal(res.status, 200);
  const preview = res.body as {
    mode: string;
    counts: {
      cases: number;
      billable: number;
      exempt: number;
      not_billable: number;
      metered: number;
      pending: number;
      by_class: { docs: number; code: number; migration: number };
      by_lane: Record<string, number>;
    };
    line_items: { key: string; count: number; unit_price_usd: number; amount_usd: number }[];
    total_usd: number;
  };

  assert.equal(preview.counts.cases, 5, 'all five cases for this vendor were read');
  assert.equal(preview.counts.billable, 3, 'three passed the one rule');
  assert.equal(preview.counts.exempt, 1, 'the privacy case is exempt, not billable');
  assert.equal(preview.counts.not_billable, 1, 'the unproven case is not billable');
  assert.equal(preview.counts.metered, 0);
  assert.equal(preview.counts.pending, 3);
  assert.deepEqual(preview.counts.by_class, { docs: 1, code: 1, migration: 1 });
  assert.equal(preview.counts.by_lane['b2b_meter'], 3);

  const amountFor = (key: string): number | undefined =>
    preview.line_items.find((line) => line.key === key)?.amount_usd;
  assert.equal(amountFor('docs_error_text'), 0.5);
  assert.equal(amountFor('code_config_grant'), 1);
  assert.equal(amountFor('migration_pr'), 25);
  assert.equal(amountFor('platform_monthly'), 0, 'the platform line is $0 in test mode');
  assert.equal(preview.line_items.length, 4, 'three usage lines plus the platform line');
  assert.equal(preview.total_usd, 26.5);
  assert.equal(preview.mode, 'test');

  // Meter one case: the preview must move with the repository, not with a hardcoded number.
  const docsOutcome = await repo.getOutcome('f_docs');
  assert.ok(docsOutcome);
  await onBillable(docsOutcome, 'b2b_meter', repo, new FakeStripeClient());
  const after = await hit(table, 'GET', '/v1/billing/invoice-preview', undefined, '?vendor_id=v_bill');
  const afterPreview = after.body as { counts: { metered: number; pending: number }; total_usd: number };
  assert.equal(afterPreview.counts.metered, 1);
  assert.equal(afterPreview.counts.pending, 2);
  assert.equal(afterPreview.total_usd, 26.5, 'metering does not change what is owed');

  // Prices are env-configurable, so the preview is a function of configuration + rows.
  process.env['AHD_PRICE_DOCS_USD'] = '2';
  try {
    const overridden = await hit(table, 'GET', '/v1/billing/invoice-preview', undefined, '?vendor_id=v_bill');
    const overriddenPreview = overridden.body as {
      prices: Record<string, number>;
      line_items: { key: string; amount_usd: number }[];
      total_usd: number;
    };
    assert.equal(overriddenPreview.prices['docs_error_text'], 2);
    assert.equal(overriddenPreview.line_items.find((l) => l.key === 'docs_error_text')?.amount_usd, 2);
    assert.equal(overriddenPreview.total_usd, 28);
  } finally {
    delete process.env['AHD_PRICE_DOCS_USD'];
  }

  const missingVendor = await captureError(() => hit(table, 'GET', '/v1/billing/invoice-preview', undefined, '?vendor_id=v_nope'));
  assert.equal(missingVendor.status, 404);
  assert.equal(missingVendor.code, 'vendor_not_found');
  assert.equal(missingVendor.stage, 'billing.invoice');

  const noParam = await captureError(() => hit(table, 'GET', '/v1/billing/invoice-preview'));
  assert.equal(noParam.status, 400);
  assert.equal(noParam.stage, 'billing.invoice');
});

test('prices: a negative price in the environment fails loud instead of billing nonsense', async () => {
  const repo = new MemoryRepository();
  await seed(repo, { vendor: vendor({ id: 'v_prices' }), failure: failure('f_prices', { vendor_id: 'v_prices' }) });
  const table = routesFor(repo);
  process.env['AHD_PRICE_CODE_USD'] = '-5';
  try {
    const err = await captureError(() => hit(table, 'GET', '/v1/billing/invoice-preview', undefined, '?vendor_id=v_prices'));
    assert.equal(err.status, 500);
    assert.equal(err.code, 'bad_price_config');
    assert.equal(err.stage, 'billing.prices');
  } finally {
    delete process.env['AHD_PRICE_CODE_USD'];
  }
});

test('prices: the price book is published read-only, with no audit trail behind it', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    vendor: vendor({ id: 'v_price_route' }),
    // An exempt case, so invoice-preview has something to write an audit row about.
    failure: failure('f_priv', { vendor_id: 'v_price_route', klass: 'knowledge', task: 'CCPA right to be forgotten' }),
    attempt: attempt('f_priv'),
    outcome: outcome('f_priv'),
  });
  const table = routesFor(repo);

  const res = await hit(table, 'GET', '/v1/billing/prices');
  assert.equal(res.status, 200);
  const book = res.body as {
    currency: string;
    prices: Record<string, number>;
    lane_prices: Record<string, number>;
    labels: Record<string, string>;
  };
  assert.equal(book.currency, 'usd');
  assert.deepEqual(book.prices, {
    docs_error_text: 0.5,
    code_config_grant: 1,
    migration_pr: 25,
    platform_monthly: 0,
  });
  assert.deepEqual(book.lane_prices, { a2a_x402_usd: 0.5, b2b_mpp_usd: 0.5 });
  assert.equal(book.labels['docs_error_text'], 'Docs / error-text fixes (auto-merge on green)');

  // The reason this route exists: reading a price must not grow the audit trail, while
  // invoice-preview does, because it walks every case through decide().
  const before = (await repo.toolEvents()).length;
  await hit(table, 'GET', '/v1/billing/prices');
  await hit(table, 'GET', '/v1/billing/prices');
  assert.equal((await repo.toolEvents()).length, before, 'a price read writes nothing');

  await hit(table, 'GET', '/v1/billing/invoice-preview', undefined, '?vendor_id=v_price_route');
  const afterPreview = (await repo.toolEvents()).length;
  assert.ok(afterPreview > before, 'invoice-preview writes, so a polling console must not read prices from it');
  const exempt = (await repo.toolEvents({ action: 'billing.exempt' })).length;
  assert.ok(exempt >= 1, 'the exempt case is what invoice-preview wrote about');

  process.env['AHD_PRICE_MIGRATION_USD'] = '30';
  try {
    const overridden = await hit(table, 'GET', '/v1/billing/prices');
    assert.equal((overridden.body as { prices: Record<string, number> }).prices['migration_pr'], 30);
    assert.equal((await repo.toolEvents()).length, afterPreview, 'an override changes the price, not the trail');
  } finally {
    delete process.env['AHD_PRICE_MIGRATION_USD'];
  }
});

// ---- validation + cancellation -----------------------------------------------------------
test('billing: inbound validation fails loud at the boundary', async () => {
  const repo = new MemoryRepository();
  const table = routesFor(repo);

  const noBody = await captureError(() => hit(table, 'POST', '/v1/billing/decide', {}));
  assert.equal(noBody.status, 400);
  assert.equal(noBody.stage, 'billing.decide');

  const badLane = await captureError(() => hit(table, 'POST', '/v1/billing/on-billable', { outcome_id: 'out_x', lane: 'cash' }));
  assert.equal(badLane.status, 400);
  assert.equal(badLane.stage, 'billing.meter.on_billable');

  const unknownOutcome = await captureError(() =>
    hit(table, 'POST', '/v1/billing/on-billable', { outcome_id: 'out_ghost', lane: 'b2b_meter' }),
  );
  assert.equal(unknownOutcome.status, 404);
  assert.equal(unknownOutcome.code, 'outcome_not_found');
  assert.equal(unknownOutcome.stage, 'billing.meter.on_billable');

  const noProof = await captureError(() => hit(table, 'POST', '/v1/a2a/settle', { outcome_id: 'out_ghost' }));
  assert.equal(noProof.status, 400);
  assert.equal(noProof.code, 'bad_request');

  const ghostSettle = await captureError(() =>
    x402.settle({ outcome_id: 'out_ghost', scheme: 'nope', network: 'base-sepolia', x_payment: 'x' }, repo),
  );
  assert.equal(ghostSettle.status, 404, 'the outcome is resolved before the scheme is checked');
});

test('billing: the meter lane needs a Stripe customer, and a meter event can be cancelled within 24h', async () => {
  const repo = new MemoryRepository();
  await seed(repo, {
    vendor: vendor({ id: 'v_no_customer', stripe_customer_id: '' }),
    failure: failure('f_no_customer', { vendor_id: 'v_no_customer' }),
    attempt: attempt('f_no_customer'),
    outcome: outcome('f_no_customer'),
  });
  const noCustomer = await repo.getOutcome('f_no_customer');
  assert.ok(noCustomer);
  // A vendor with no Stripe customer is routed to A2A, so forcing the meter lane is refused.
  const laneErr = await captureError(() => onBillable(noCustomer, 'b2b_meter', repo, new FakeStripeClient()));
  assert.equal(laneErr.status, 409);
  assert.equal(laneErr.code, 'lane_mismatch');
  assert.equal(laneErr.stage, 'billing.meter.on_billable');

  await seed(repo, {
    vendor: vendor({ id: 'v_cancel' }),
    failure: failure('f_cancel', { vendor_id: 'v_cancel' }),
    attempt: attempt('f_cancel'),
    outcome: outcome('f_cancel'),
  });
  const table = routesFor(repo);
  const client = new FakeStripeClient();
  const cancelOutcome = await repo.getOutcome('f_cancel');
  assert.ok(cancelOutcome);
  const emitted = await onBillable(cancelOutcome, 'b2b_meter', repo, client);
  assert.equal(emitted.kind, 'meter_event');
  assert.equal(client.emitted.length, 1);

  const cancelled = await cancelMeterEventForOutcome(cancelOutcome, repo, 'the agent retry later failed', client);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.identifier, 'out_f_cancel');
  assert.equal(cancelled.outcome.billable, false, 'the outcome is no longer presented as billable');
  assert.deepEqual(client.cancelled, ['out_f_cancel']);
  assert.equal((await events(repo, 'meter_event.cancelled')).length, 1);

  // The receipt row stays, so a cancelled outcome can never be metered a second time.
  assert.ok(await repo.meterEventByIdentifier('out_f_cancel'), 'the audit row survives cancellation');
  const afterCancel = await onBillable(cancelOutcome, 'b2b_meter', repo, client);
  assert.equal(afterCancel.kind, 'meter_event');
  if (afterCancel.kind === 'meter_event') assert.equal(afterCancel.replayed, true);
  assert.equal(client.emitted.length, 1, 'nothing new was emitted');

  // The same cancel over HTTP, on its own case, using the process-wide fake client.
  await seed(repo, {
    vendor: vendor({ id: 'v_route' }),
    failure: failure('f_route', { vendor_id: 'v_route' }),
    attempt: attempt('f_route'),
    outcome: outcome('f_route'),
  });
  const meteredViaRoute = await hit(table, 'POST', '/v1/billing/on-billable', { outcome_id: 'out_f_route', lane: 'b2b_meter' });
  assert.equal(meteredViaRoute.status, 200);
  const cancelledViaRoute = await hit(table, 'POST', '/v1/billing/meter-events/cancel', {
    outcome_id: 'out_f_route',
    reason: 'operator cancelled inside the 24h window',
  });
  assert.equal(cancelledViaRoute.status, 200);
  const routeBody = cancelledViaRoute.body as { cancelled: boolean; identifier: string; billable: boolean };
  assert.equal(routeBody.cancelled, true);
  assert.equal(routeBody.identifier, 'out_f_route');
  assert.equal(routeBody.billable, false);

  const missingReason = await captureError(() => cancelMeterEventForOutcome(cancelOutcome, repo, '   ', client));
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.code, 'missing_reason');
  assert.equal(missingReason.stage, 'billing.meter.cancel');
});
