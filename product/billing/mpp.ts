// The B2B agent-pays rail: Stripe MPP (Machine Payments Protocol).
//
// Where x402 is the open protocol for a caller with no vendor relationship, MPP is the
// Stripe-native rail *inside* B2B: the vendor has a Stripe relationship but chooses
// `payer_mode: 'agent'`, so the agent that benefits from the verified fix pays for it itself.
// Build plan, "Billing: Stripe meter for B2B, x402 for A2A" — "Why both: the meter is the
// revenue model, and MPP is the moment an agent pays by itself. The vendor chooses who pays."
//
// Stripe facts cited (do not invent APIs):
//   * MPP is an HTTP 402 carrying a payment requirement; the server handler is a short
//     `mppx` + `stripe` program and is tested end to end with `npx mppx@latest validate`.
//     We do NOT run that command (AGENTS.md forbids node/npm/npx on this machine).
//   * Cards pay through Shared Payment Tokens with a **$0.50 minimum**; USDC has a
//     **$0.01 minimum**. Our $0.50 answer price therefore fits both rails exactly.
//   * The MPP setup uses the `2026-07-29.preview` API version for the business profile and
//     the Tempo deposit address, so account access must be confirmed before relying on it
//     (build plan, "Check first").
//   * Cut order: **drop the MPP lane before the meter** — the meter is the revenue model.
//
// Verification cannot reach Stripe from this repo, so it goes through `PaymentVerifier`
// (FakePaymentVerifier offline, tagged mode:'test'). See verify.ts.
import { HttpError } from '../shared/http.ts';
import type { Outcome, PayLane } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { decide } from './billable.ts';
import { logBillingEvent } from './log.ts';
import { resolveOutcome, saveOutcome } from './outcome.ts';
import { priceBook } from './prices.ts';
import { getVerifier, MPP_CARD_MIN_USD, MPP_USDC_MIN_USD, type PaymentVerifier } from './verify.ts';

const STAGE = 'billing.mpp';
export const MPP_VERSION = 1;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type MppMethod = 'card' | 'usdc';

export interface MppMethodRequirement {
  method: MppMethod;
  /** What we charge, in USD. */
  amount: number;
  /** The protocol minimum for this method, so the console can show why a price is legal. */
  minimum: number;
  currency: string;
  /** Cards ride Shared Payment Tokens; no Stripe account needed on the agent side. */
  shared_payment_token?: boolean;
  network?: string;
  asset?: string;
  deposit_address?: string;
}

export interface MppRequirementBody {
  mpp_version: typeof MPP_VERSION;
  stripe_api_version: string;
  resource: string;
  description: string;
  error: string;
  accepts: MppMethodRequirement[];
  price_usd: number;
  lane: PayLane;
  /** base64 of `accepts`, for the caller to put on the 402 (HttpResult cannot set headers). */
  payment_requirement_b64: string;
}

function envOr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export function mppPriceUsd(): number {
  return priceBook().lanes.b2b_mpp_usd;
}

/**
 * Build the 402 body. If the configured price is under the $0.50 card minimum the card
 * method is dropped rather than advertised illegally; under the $0.01 USDC minimum there is
 * no legal MPP price at all and we fail loud.
 */
export function requirement(outcome: Outcome, priceUsd: number = mppPriceUsd()): MppRequirementBody {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new HttpError(500, 'bad_mpp_price', `MPP price must be a positive USD number, got ${String(priceUsd)}`, STAGE);
  }
  if (priceUsd < MPP_USDC_MIN_USD) {
    throw new HttpError(
      500,
      'mpp_below_usdc_minimum',
      `MPP price $${String(priceUsd)} is below the USDC minimum of $${String(MPP_USDC_MIN_USD)}`,
      STAGE,
    );
  }
  const accepts: MppMethodRequirement[] = [];
  if (priceUsd >= MPP_CARD_MIN_USD) {
    accepts.push({
      method: 'card',
      amount: priceUsd,
      minimum: MPP_CARD_MIN_USD,
      currency: 'usd',
      shared_payment_token: true,
    });
  }
  accepts.push({
    method: 'usdc',
    amount: priceUsd,
    minimum: MPP_USDC_MIN_USD,
    currency: 'usdc',
    network: envOr('AHD_MPP_NETWORK', 'tempo'),
    asset: envOr('AHD_MPP_ASSET', 'USDC'),
    // Tempo deposit address; the zero placeholder means nothing can be paid by accident offline.
    deposit_address: envOr('AHD_MPP_DEPOSIT_ADDRESS', ZERO_ADDRESS),
  });

  const body: MppRequirementBody = {
    mpp_version: MPP_VERSION,
    stripe_api_version: envOr('AHD_MPP_API_VERSION', '2026-07-29.preview'),
    resource: envOr('AHD_MPP_RESOURCE', '/v1/billing/verified-answer'),
    description: `AgentHelpDesk verified fix for case ${outcome.failure_id} (outcome ${outcome.id})`,
    error: 'payment required: send an MPP payment for one of the methods in accepts[] and retry',
    accepts,
    price_usd: priceUsd,
    lane: 'b2b_mpp',
    payment_requirement_b64: Buffer.from(JSON.stringify(accepts), 'utf8').toString('base64url'),
  };
  return body;
}

/** Inbound MPP payment from an agent. Validated at the boundary in register.ts and here. */
export interface MppPaymentProof {
  outcome_id: string;
  failure_id?: string;
  method: MppMethod;
  /** Shared Payment Token (card) or the USDC payment reference. */
  payment: string;
}

export interface MppSettlement {
  unlock: boolean;
  lane: PayLane;
  payment_id: string;
  payer: 'agent';
  method: MppMethod;
  amount_usd: number;
  replayed: boolean;
  detail: string;
  mode: 'test';
  outcome: Outcome;
}

/** Verify an MPP payment and record `mpp_payment_id` + `payer: 'agent'` on the outcome. Idempotent. */
export async function settle(
  proof: MppPaymentProof,
  repo: Repository,
  verifier: PaymentVerifier = getVerifier(),
): Promise<MppSettlement> {
  const started = Date.now();
  if (proof.payment.trim() === '') {
    throw new HttpError(400, 'missing_payment_proof', 'payment must be a non-empty string', `${STAGE}.settle`);
  }
  if (proof.method !== 'card' && proof.method !== 'usdc') {
    throw new HttpError(400, 'unsupported_method', `method must be "card" or "usdc", got "${String(proof.method)}"`, `${STAGE}.settle`);
  }
  const outcome = await resolveOutcome(repo, { outcomeId: proof.outcome_id, failureId: proof.failure_id }, `${STAGE}.settle`);
  const priceUsd = mppPriceUsd();
  const minimum = proof.method === 'card' ? MPP_CARD_MIN_USD : MPP_USDC_MIN_USD;
  if (priceUsd < minimum) {
    throw new HttpError(
      409,
      'mpp_below_minimum',
      `configured MPP price $${String(priceUsd)} is below the ${proof.method} minimum of $${String(minimum)}`,
      `${STAGE}.settle`,
    );
  }

  // Hoisted so narrowing survives the awaited log call (Outcome fields are optional strings).
  const existingPaymentId = outcome.mpp_payment_id;
  if (existingPaymentId) {
    await logBillingEvent(repo, {
      ticketId: outcome.failure_id,
      stage: STAGE,
      action: 'mpp.replayed',
      result: 'replayed',
      payload: { outcome_id: outcome.id, payment_id: existingPaymentId },
      startedAt: started,
    });
    return {
      unlock: true,
      lane: 'b2b_mpp',
      payment_id: existingPaymentId,
      payer: 'agent',
      method: proof.method,
      amount_usd: priceUsd,
      replayed: true,
      detail: 'payment already settled for this outcome; original receipt returned',
      mode: 'test',
      outcome,
    };
  }

  const decision = await decide(outcome.failure_id, repo);
  if (!decision.billable) {
    throw new HttpError(409, 'not_billable', `refusing to sell an unverified fix: ${decision.reason}`, `${STAGE}.settle`);
  }
  if (decision.lane !== 'b2b_mpp') {
    throw new HttpError(
      409,
      'lane_mismatch',
      `case "${outcome.failure_id}" bills on lane "${decision.lane}", not b2b_mpp`,
      `${STAGE}.settle`,
    );
  }

  const verification = await verifier.verify({ rail: 'b2b_mpp', proof: proof.payment, amountUsd: priceUsd });
  if (!verification.ok) {
    await logBillingEvent(repo, {
      ticketId: outcome.failure_id,
      stage: STAGE,
      action: 'mpp.rejected',
      result: 'error',
      payload: { outcome_id: outcome.id, detail: verification.detail, amount_usd: priceUsd },
      startedAt: started,
    });
    throw new HttpError(402, 'payment_rejected', verification.detail, `${STAGE}.verify`);
  }

  const settled: Outcome = { ...outcome, payer: 'agent', mpp_payment_id: verification.paymentId };
  await saveOutcome(repo, settled);
  await logBillingEvent(repo, {
    ticketId: outcome.failure_id,
    stage: STAGE,
    action: 'mpp.settled',
    result: 'ok',
    payload: {
      outcome_id: outcome.id,
      payment_id: verification.paymentId,
      method: proof.method,
      amount_usd: priceUsd,
      mode: verification.mode,
    },
    startedAt: started,
  });
  return {
    unlock: true,
    lane: 'b2b_mpp',
    payment_id: verification.paymentId,
    payer: 'agent',
    method: proof.method,
    amount_usd: priceUsd,
    replayed: false,
    detail: verification.detail,
    mode: verification.mode,
    outcome: settled,
  };
}
