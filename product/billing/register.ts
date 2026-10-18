// Billing routes. `registerRoutes(router, repo)` is this module's entry point (AGENTS.md).
//
//   POST /v1/billing/decide              {failure_id}                  -> BillableDecision
//   POST /v1/billing/on-billable         {outcome_id, lane}            -> meter event, or a 402 requirement
//   GET  /v1/billing/prices              (none)                        -> the price book, read-only
//   GET  /v1/billing/invoice-preview     ?vendor_id=                   -> line items computed from the repo
//                                                                        (not read-only: decide() appends
//                                                                        a billing.exempt row per exempt case)
//   POST /v1/billing/meter-events/cancel {outcome_id, reason}          -> cancel inside Stripe's 24h window
//   POST /v1/billing/mpp/settle          {outcome_id, proof, method}   -> B2B agent-pays (Stripe MPP) unlock
//   POST /v1/a2a/402                     {outcome_id}                  -> the x402 payment requirement
//   POST /v1/a2a/settle                  {outcome_id, proof}           -> verify, record, unlock
//
// Every inbound field is validated at the boundary; nothing here holds state.
import { badRequest, ok, str, type Ctx, type HttpResult, type Router } from '../shared/http.ts';
import type { BillableDecision } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { decide } from './billable.ts';
import { invoicePreview } from './invoice.ts';
import { cancelMeterEventForOutcome, isPayLane, onBillable } from './meter.ts';
import * as mpp from './mpp.ts';
import { resolveOutcome } from './outcome.ts';
import { PRICE_LABELS, priceBook } from './prices.ts';
import * as x402 from './x402.ts';

function envOr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function optionalStr(body: unknown, field: string, stage: string): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest(stage, `field "${field}" must be a string when present`);
  return value.trim();
}

/** `proof` may be a bare X-Payment string, or an object carrying scheme/network explicitly. */
function parseX402Proof(body: unknown, outcomeId: string, stage: string): x402.X402PaymentProof {
  const raw = (body as Record<string, unknown> | null)?.['proof'];
  const failureId = optionalStr(body, 'failure_id', stage);
  const base = failureId === '' ? { outcome_id: outcomeId } : { outcome_id: outcomeId, failure_id: failureId };
  if (typeof raw === 'string') {
    if (raw.trim() === '') throw badRequest(stage, 'field "proof" must be a non-empty string');
    return {
      ...base,
      scheme: x402.X402_SCHEME,
      // A bare proof means "I paid the requirement you just served", so it must match ours.
      network: envOr('AHD_X402_NETWORK', 'base-sepolia'),
      x_payment: raw.trim(),
    };
  }
  if (raw !== null && typeof raw === 'object') {
    const scheme = optionalStr(raw, 'scheme', stage);
    const network = optionalStr(raw, 'network', stage);
    return {
      ...base,
      scheme: scheme === '' ? x402.X402_SCHEME : scheme,
      network: network === '' ? envOr('AHD_X402_NETWORK', 'base-sepolia') : network,
      x_payment: str(raw, 'x_payment', stage),
    };
  }
  throw badRequest(stage, 'field "proof" must be an X-Payment string or an object with "x_payment"');
}

export function registerRoutes(router: Router, repo: Repository): void {
  router.add('POST', '/v1/billing/decide', async (ctx: Ctx): Promise<HttpResult> => {
    const stage = 'billing.decide';
    const failureId = str(ctx.body, 'failure_id', stage);
    const decision: BillableDecision = await decide(failureId, repo);
    return ok(decision);
  });

  router.add('POST', '/v1/billing/on-billable', async (ctx: Ctx): Promise<HttpResult> => {
    const stage = 'billing.meter.on_billable';
    const outcomeId = str(ctx.body, 'outcome_id', stage);
    const lane = str(ctx.body, 'lane', stage);
    if (!isPayLane(lane)) {
      throw badRequest(stage, `lane must be one of b2b_meter, a2a_x402, b2b_mpp; got "${lane}"`);
    }
    const failureId = optionalStr(ctx.body, 'failure_id', stage);
    const outcome = await resolveOutcome(repo, { outcomeId, failureId }, stage);
    // `lane` is narrowed to PayLane by the guard above.
    const result = await onBillable(outcome, lane, repo);
    if (result.kind === 'payment_required') {
      // Money has not moved: the verified answer stays behind this 402 until a payment verifies.
      return ok({ outcome_id: result.outcome.id, ...result.requirement }, 402);
    }
    if (result.kind === 'settled') {
      return ok({
        lane: result.lane,
        unlock: result.unlock,
        payment_id: result.payment_id,
        replayed: result.replayed,
        outcome_id: result.outcome.id,
      });
    }
    return ok({
      lane: result.lane,
      replayed: result.replayed,
      meter_event: result.meter_event,
      outcome_id: result.outcome.id,
      stripe_event_id: result.outcome.stripe_event_id,
      mode: result.meter_event.mode,
    });
  });

  // Read-only price list. invoice-preview also returns these numbers, but it walks the
  // vendor's cases through decide(), which appends a `billing.exempt` audit row for every
  // exempt case — so a console that polled it just to render a price would grow the audit
  // trail on every refresh. This route touches no repository and writes nothing.
  router.add('GET', '/v1/billing/prices', async (): Promise<HttpResult> => {
    const book = priceBook();
    return ok({
      currency: book.currency,
      prices: book.prices,
      lane_prices: book.lanes,
      labels: PRICE_LABELS,
    });
  });

  router.add('GET', '/v1/billing/invoice-preview', async (ctx: Ctx): Promise<HttpResult> => {
    const stage = 'billing.invoice';
    const vendorId = ctx.query.get('vendor_id') ?? '';
    if (vendorId.trim() === '') throw badRequest(stage, 'query parameter "vendor_id" is required');
    const preview = await invoicePreview(vendorId, repo);
    const book = priceBook();
    return ok({ ...preview, prices: book.prices, lane_prices: book.lanes });
  });

  router.add('POST', '/v1/billing/meter-events/cancel', async (ctx: Ctx): Promise<HttpResult> => {
    const stage = 'billing.meter.cancel';
    const outcomeId = str(ctx.body, 'outcome_id', stage);
    const reason = str(ctx.body, 'reason', stage);
    const failureId = optionalStr(ctx.body, 'failure_id', stage);
    const outcome = await resolveOutcome(repo, { outcomeId, failureId }, stage);
    const result = await cancelMeterEventForOutcome(outcome, repo, reason);
    return ok({
      cancelled: result.cancelled,
      identifier: result.identifier,
      stripe_event_id: result.stripe_event_id,
      outcome_id: result.outcome.id,
      billable: result.outcome.billable,
      reason,
    });
  });

  router.add('POST', '/v1/billing/mpp/settle', async (ctx: Ctx): Promise<HttpResult> => {
    const stage = 'billing.mpp.settle';
    const outcomeId = str(ctx.body, 'outcome_id', stage);
    const failureId = optionalStr(ctx.body, 'failure_id', stage);
    const rawMethod = optionalStr(ctx.body, 'method', stage);
    if (rawMethod !== '' && rawMethod !== 'card' && rawMethod !== 'usdc') {
      throw badRequest(stage, `method must be "card" or "usdc"; got "${rawMethod}"`);
    }
    const method: mpp.MppMethod = rawMethod === 'usdc' ? 'usdc' : 'card';
    const rawProof = (ctx.body as Record<string, unknown> | null)?.['proof'];
    const payment = typeof rawProof === 'string' ? rawProof.trim() : optionalStr(rawProof, 'payment', stage);
    const proof: mpp.MppPaymentProof =
      failureId === ''
        ? { outcome_id: outcomeId, method, payment }
        : { outcome_id: outcomeId, failure_id: failureId, method, payment };
    const result = await mpp.settle(proof, repo);
    return ok({
      lane: result.lane,
      unlock: result.unlock,
      payment_id: result.payment_id,
      payer: result.payer,
      method: result.method,
      amount_usd: result.amount_usd,
      replayed: result.replayed,
      mode: result.mode,
      detail: result.detail,
      outcome_id: result.outcome.id,
      unlocked_for: ctx.caller,
    });
  });

  router.add('POST', '/v1/a2a/402', async (ctx: Ctx): Promise<HttpResult> => {
    const stage = 'billing.x402.requirement';
    const outcomeId = str(ctx.body, 'outcome_id', stage);
    const failureId = optionalStr(ctx.body, 'failure_id', stage);
    const outcome = await resolveOutcome(repo, { outcomeId, failureId }, stage);
    const body = x402.requirement(priceBook().lanes.a2a_x402_usd, {
      resource: `/v1/a2a/outcomes/${outcome.id}`,
      description: `AgentHelpDesk verified fix for case ${outcome.failure_id} (outcome ${outcome.id})`,
    });
    // 402 is the protocol's signal, not an error: the answer is ready and priced.
    return ok({ outcome_id: outcome.id, ...body }, 402);
  });

  router.add('POST', '/v1/a2a/settle', async (ctx: Ctx): Promise<HttpResult> => {
    const stage = 'billing.x402.settle';
    const outcomeId = str(ctx.body, 'outcome_id', stage);
    const proof = parseX402Proof(ctx.body, outcomeId, stage);
    const result = await x402.settle(proof, repo);
    return ok({
      lane: result.lane,
      unlock: result.unlock,
      payment_id: result.payment_id,
      payer: result.payer,
      amount_usd: result.amount_usd,
      replayed: result.replayed,
      mode: result.mode,
      detail: result.detail,
      outcome_id: result.outcome.id,
      unlocked_for: ctx.caller,
    });
  });
}
