// The B2B meter lane, and the dispatcher for "this outcome just became billable".
//
// One meter event per verified fix, with the **outcome id as the identifier** so a retry can
// never bill twice (Stripe dedupes on `identifier`, and `Repository.recordMeterEvent` enforces
// the same uniqueness locally — AGENTS.md: "use it, don't re-implement").
//
// Meters use count aggregation, so `value` is 1: the price lives on the meter in Stripe, not
// in the event. A meter event can be cancelled within 24 hours, which is what
// `cancelMeterEventForOutcome` is for when a retry later turns out to have failed.
import { HttpError } from '../shared/http.ts';
import type { MeterEvent, Outcome, PayLane, Vendor } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { decide } from './billable.ts';
import { logBillingEvent } from './log.ts';
import * as mpp from './mpp.ts';
import { refreshOutcome, saveOutcome } from './outcome.ts';
import { getBillingClient, meterEventName, type StripeBillingClient } from './stripe-client.ts';
import { priceBook } from './prices.ts';
import * as x402 from './x402.ts';

const STAGE = 'billing.meter';
const LANES: PayLane[] = ['b2b_meter', 'a2a_x402', 'b2b_mpp'];

export type OnBillableResult =
  | {
      kind: 'meter_event';
      lane: 'b2b_meter';
      replayed: boolean;
      meter_event: MeterEvent;
      outcome: Outcome;
    }
  | {
      kind: 'payment_required';
      lane: 'b2b_mpp' | 'a2a_x402';
      status: 402;
      requirement: mpp.MppRequirementBody | x402.X402RequirementBody;
      outcome: Outcome;
    }
  | {
      kind: 'settled';
      lane: 'b2b_mpp' | 'a2a_x402';
      unlock: true;
      payment_id: string;
      replayed: true;
      outcome: Outcome;
    };

export function isPayLane(value: string): value is PayLane {
  return LANES.includes(value as PayLane);
}

async function assertBillable(outcome: Outcome, lane: PayLane, repo: Repository, stage: string): Promise<void> {
  const decision = await decide(outcome.failure_id, repo);
  if (!decision.billable) {
    throw new HttpError(409, 'not_billable', `refusing to bill an unverified fix: ${decision.reason}`, stage);
  }
  if (decision.lane !== lane) {
    throw new HttpError(409, 'lane_mismatch', `case "${outcome.failure_id}" bills on lane "${decision.lane}", not "${lane}"`, stage);
  }
}

/**
 * Do the money side effect for a billable outcome on the chosen lane.
 *
 * `b2b_meter` emits exactly one meter event (idempotent). The two agent-pays lanes cannot
 * move money yet — they return the 402 payment requirement, because the desk proves the fix
 * first and only serves it once a payment is verified (x402.settle / mpp.settle).
 */
export async function onBillable(
  outcomeRef: Outcome,
  lane: PayLane,
  repo: Repository,
  client: StripeBillingClient = getBillingClient(),
): Promise<OnBillableResult> {
  const started = Date.now();
  if (!isPayLane(lane)) {
    throw new HttpError(400, 'unknown_lane', `lane must be one of ${LANES.join(', ')}, got "${String(lane)}"`, `${STAGE}.on_billable`);
  }
  await assertBillable(outcomeRef, lane, repo, `${STAGE}.on_billable`);
  // Always act on the stored row: a caller may be holding a copy from before another worker
  // recorded a payment id or a Stripe event id on it.
  const outcome = await refreshOutcome(repo, outcomeRef);

  if (lane === 'a2a_x402') {
    if (outcome.x402_payment_id) {
      return { kind: 'settled', lane, unlock: true, payment_id: outcome.x402_payment_id, replayed: true, outcome };
    }
    const body = x402.requirement(priceBook().lanes.a2a_x402_usd, {
      resource: `/v1/a2a/outcomes/${outcome.id}`,
      description: `AgentHelpDesk verified fix for case ${outcome.failure_id} (outcome ${outcome.id})`,
    });
    await logBillingEvent(repo, {
      ticketId: outcome.failure_id,
      stage: 'billing.x402',
      action: 'x402.requirement_issued',
      result: 'ok',
      payload: { outcome_id: outcome.id, price_usd: body.price_usd, network: body.accepts[0]?.network ?? null },
      startedAt: started,
    });
    return { kind: 'payment_required', lane, status: 402, requirement: body, outcome };
  }

  if (lane === 'b2b_mpp') {
    if (outcome.mpp_payment_id) {
      return { kind: 'settled', lane, unlock: true, payment_id: outcome.mpp_payment_id, replayed: true, outcome };
    }
    const body = mpp.requirement(outcome);
    await logBillingEvent(repo, {
      ticketId: outcome.failure_id,
      stage: 'billing.mpp',
      action: 'mpp.requirement_issued',
      result: 'ok',
      payload: { outcome_id: outcome.id, price_usd: body.price_usd, methods: body.accepts.map((a) => a.method) },
      startedAt: started,
    });
    return { kind: 'payment_required', lane, status: 402, requirement: body, outcome };
  }

  // ---- b2b_meter ----
  const existing = await repo.meterEventByIdentifier(outcome.id);
  if (existing) {
    // Replay: return the original receipt and emit nothing. This is the whole point of the
    // identifier — the desk may call this again after a restart and must not bill twice.
    await logBillingEvent(repo, {
      ticketId: outcome.failure_id,
      stage: STAGE,
      action: 'meter_event.replayed',
      result: 'replayed',
      payload: { outcome_id: outcome.id, identifier: existing.identifier, stripe_event_id: existing.id },
      startedAt: started,
    });
    return { kind: 'meter_event', lane: 'b2b_meter', replayed: true, meter_event: existing, outcome };
  }

  const failure = await repo.getFailure(outcome.failure_id);
  if (!failure) {
    throw new HttpError(404, 'case_not_found', `outcome "${outcome.id}" points at missing case "${outcome.failure_id}"`, `${STAGE}.emit`);
  }
  const vendor: Vendor | null = await repo.getVendor(failure.vendor_id);
  if (!vendor || vendor.stripe_customer_id.trim() === '') {
    throw new HttpError(
      409,
      'no_stripe_customer',
      `vendor "${failure.vendor_id}" has no stripe_customer_id, so the meter lane cannot bill it (use a2a_x402)`,
      `${STAGE}.emit`,
    );
  }

  const eventName = meterEventName();
  const emitted = await client.emitMeterEvent({
    eventName,
    customerId: vendor.stripe_customer_id,
    value: 1, // count aggregation: one verified fix
    identifier: outcome.id,
  });

  const recorded = await repo.recordMeterEvent({
    id: emitted.id,
    outcome_id: outcome.id,
    event_name: eventName,
    identifier: outcome.id,
    value: emitted.value,
    mode: emitted.mode,
    at: emitted.created_at,
  });

  if (recorded.id !== emitted.id) {
    // Two workers raced on the same outcome. We do NOT auto-cancel: Stripe cancels by
    // identifier, which is shared with the winning event, so cancelling here could cancel the
    // receipt we keep. Surface it loudly and let an operator use the 24h cancel window.
    await logBillingEvent(repo, {
      ticketId: outcome.failure_id,
      stage: STAGE,
      action: 'meter_event.race_lost',
      result: 'error',
      payload: { outcome_id: outcome.id, kept: recorded.id, emitted: emitted.id, window: 'cancellable within 24h' },
      startedAt: started,
    });
    return { kind: 'meter_event', lane: 'b2b_meter', replayed: true, meter_event: recorded, outcome };
  }

  const updated: Outcome = {
    ...outcome,
    billable: true,
    payer: outcome.payer ?? 'vendor',
    stripe_event_id: emitted.id,
  };
  await saveOutcome(repo, updated);
  await logBillingEvent(repo, {
    ticketId: outcome.failure_id,
    stage: STAGE,
    action: 'meter_event.created',
    result: 'ok',
    payload: {
      outcome_id: outcome.id,
      identifier: outcome.id,
      stripe_event_id: emitted.id,
      event_name: eventName,
      value: emitted.value,
      mode: emitted.mode,
      stripe_customer_id: vendor.stripe_customer_id,
    },
    startedAt: started,
  });
  return { kind: 'meter_event', lane: 'b2b_meter', replayed: false, meter_event: recorded, outcome: updated };
}

/**
 * Cancel the meter event for an outcome — legal within 24 hours of creation, and the right
 * move when a retry later turns out to have failed. The local receipt row is kept (so the
 * outcome can never be re-metered) and the outcome is marked not billable again.
 */
export async function cancelMeterEventForOutcome(
  outcome: Outcome,
  repo: Repository,
  reason: string,
  client: StripeBillingClient = getBillingClient(),
): Promise<{ cancelled: boolean; identifier: string; stripe_event_id: string | null; outcome: Outcome }> {
  const started = Date.now();
  if (reason.trim() === '') {
    throw new HttpError(400, 'missing_reason', 'a cancellation reason is required for the audit trail', `${STAGE}.cancel`);
  }
  const recorded = await repo.meterEventByIdentifier(outcome.id);
  if (!recorded) {
    throw new HttpError(404, 'meter_event_not_found', `no meter event for outcome "${outcome.id}"`, `${STAGE}.cancel`);
  }
  const result = await client.cancelMeterEvent(recorded.identifier);
  const current = await refreshOutcome(repo, outcome);
  const updated: Outcome = { ...current, billable: false };
  await saveOutcome(repo, updated);
  await logBillingEvent(repo, {
    ticketId: outcome.failure_id,
    stage: STAGE,
    action: 'meter_event.cancelled',
    result: 'ok',
    payload: { outcome_id: outcome.id, identifier: recorded.identifier, reason, mode: result.mode },
    startedAt: started,
  });
  return { cancelled: result.cancelled, identifier: recorded.identifier, stripe_event_id: updated.stripe_event_id, outcome: updated };
}
