// The A2A lane: x402, the open HTTP-402 protocol.
//
// Shape (x402 spec, https://docs.x402.org and https://github.com/x402-foundation/x402):
//   1. Server returns HTTP 402 with a payment requirement: network + amount + recipient,
//      plus the resource being sold. Clients read it from the `x-payment-required` header
//      (base64 JSON) and/or the JSON body.
//   2. Client pays in stablecoin and retries with an `X-Payment` header carrying the payment
//      payload.
//   3. Server verifies (in production via a facilitator) and only then serves the resource.
//
// This lane exists because the caller has no vendor relationship: a stranger agent, a support
// agent forwarding a failing call at rung 0, or a second desk buying a proven answer. No
// account, no invoice, no human in the loop — and the billable rule is identical to B2B
// (all three proofs pass AND the agent's retry succeeded), enforced by `decide()` below.
//
// `HttpResult` in shared/http.ts carries only status + body, so the base64 header value is
// returned in the body as `x_payment_required_b64` for the caller to set (CONTRACT_REQUESTS
// billing-3 asks for header support).
import { HttpError } from '../shared/http.ts';
import type { Outcome, PayLane } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { decide } from './billable.ts';
import { logBillingEvent } from './log.ts';
import { resolveOutcome, saveOutcome } from './outcome.ts';
import { priceBook } from './prices.ts';
import { getVerifier, type PaymentVerifier } from './verify.ts';

const STAGE = 'billing.x402';
export const X402_VERSION = 1;
export const X402_SCHEME = 'exact';
/** USDC has 6 decimals, so amounts travel as atomic-unit strings. */
const ASSET_DECIMALS = 6;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface X402PaymentRequirement {
  scheme: typeof X402_SCHEME;
  network: string;
  /** Atomic units of `asset` (USDC = 6 decimals), as a string per the spec. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
}

export interface X402RequirementBody {
  x402Version: typeof X402_VERSION;
  accepts: X402PaymentRequirement[];
  error: string;
  /** base64url of `accepts[0]` — the value for the `x-payment-required` response header. */
  x_payment_required_b64: string;
  price_usd: number;
  lane: PayLane;
}

export interface RequirementOptions {
  resource?: string;
  description?: string;
}

function envOr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export function atomicUnits(priceUsd: number): string {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new HttpError(500, 'bad_x402_price', `x402 price must be a positive USD number, got ${String(priceUsd)}`, STAGE);
  }
  return String(Math.round(priceUsd * 10 ** ASSET_DECIMALS));
}

/**
 * Build the 402 payment requirement body for a verified answer.
 * `payTo` defaults to the zero address on purpose: offline nothing can be paid by accident.
 * Set AHD_X402_PAY_TO (recipient) and AHD_X402_ASSET (token contract address for the chosen
 * network) before live use — the spec expects addresses, and the placeholder `USDC` symbol
 * below is only acceptable to the fake verifier.
 */
export function requirement(priceUsd: number, options?: RequirementOptions): X402RequirementBody {
  const accepts: X402PaymentRequirement = {
    scheme: X402_SCHEME,
    network: envOr('AHD_X402_NETWORK', 'base-sepolia'),
    maxAmountRequired: atomicUnits(priceUsd),
    resource: options?.resource ?? envOr('AHD_X402_RESOURCE', '/v1/a2a/answer'),
    description: options?.description ?? 'AgentHelpDesk verified fix: three proofs passed and the agent retry succeeded',
    mimeType: 'application/json',
    payTo: envOr('AHD_X402_PAY_TO', ZERO_ADDRESS),
    maxTimeoutSeconds: Number(envOr('AHD_X402_TIMEOUT_SECONDS', '60')),
    asset: envOr('AHD_X402_ASSET', 'USDC'),
  };
  if (!Number.isFinite(accepts.maxTimeoutSeconds) || accepts.maxTimeoutSeconds <= 0) {
    throw new HttpError(500, 'bad_x402_timeout', 'AHD_X402_TIMEOUT_SECONDS must be a positive integer', STAGE);
  }
  return {
    x402Version: X402_VERSION,
    accepts: [accepts],
    error: 'X-Payment header required: pay the requirement in accepts[0] and retry',
    x_payment_required_b64: Buffer.from(JSON.stringify(accepts), 'utf8').toString('base64url'),
    price_usd: priceUsd,
    lane: 'a2a_x402',
  };
}

/** Inbound proof from a paying agent. Every field is validated at the boundary. */
export interface X402PaymentProof {
  outcome_id: string;
  /** Optional shortcut that skips the outcome-id scan (see outcome.ts assumption 1). */
  failure_id?: string;
  scheme: string;
  network: string;
  /** The `X-Payment` header value the client paid with. */
  x_payment: string;
}

export interface X402Settlement {
  unlock: boolean;
  lane: PayLane;
  payment_id: string;
  payer: 'agent';
  amount_usd: number;
  replayed: boolean;
  detail: string;
  mode: 'test';
  outcome: Outcome;
}

/**
 * Verify a payment and unlock the verified answer. Idempotent: once the outcome carries an
 * `x402_payment_id`, a replay returns that same id and unlocks without re-verifying, so one
 * payment can never be spent twice against the desk.
 */
export async function settle(
  proof: X402PaymentProof,
  repo: Repository,
  verifier: PaymentVerifier = getVerifier(),
): Promise<X402Settlement> {
  const started = Date.now();
  if (proof.x_payment.trim() === '') {
    throw new HttpError(400, 'missing_payment_proof', 'x_payment must be a non-empty string', `${STAGE}.settle`);
  }
  const outcome = await resolveOutcome(repo, { outcomeId: proof.outcome_id, failureId: proof.failure_id }, `${STAGE}.settle`);

  const existingPaymentId = outcome.x402_payment_id;
  if (existingPaymentId) {
    await logBillingEvent(repo, {
      ticketId: outcome.failure_id,
      stage: STAGE,
      action: 'x402.replayed',
      result: 'replayed',
      payload: { outcome_id: outcome.id, payment_id: existingPaymentId },
      startedAt: started,
    });
    return {
      unlock: true,
      lane: 'a2a_x402',
      payment_id: existingPaymentId,
      payer: 'agent',
      amount_usd: priceBook().lanes.a2a_x402_usd,
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
  if (decision.lane !== 'a2a_x402') {
    throw new HttpError(
      409,
      'lane_mismatch',
      `case "${outcome.failure_id}" bills on lane "${decision.lane}", not a2a_x402`,
      `${STAGE}.settle`,
    );
  }
  if (proof.scheme !== X402_SCHEME) {
    throw new HttpError(400, 'unsupported_scheme', `only the "${X402_SCHEME}" x402 scheme is accepted, got "${proof.scheme}"`, `${STAGE}.settle`);
  }
  const network = envOr('AHD_X402_NETWORK', 'base-sepolia');
  if (proof.network !== network) {
    throw new HttpError(400, 'network_mismatch', `payment must be on "${network}", got "${proof.network}"`, `${STAGE}.settle`);
  }

  const priceUsd = priceBook().lanes.a2a_x402_usd;
  const verification = await verifier.verify({ rail: 'a2a_x402', proof: proof.x_payment, amountUsd: priceUsd });
  if (!verification.ok) {
    await logBillingEvent(repo, {
      ticketId: outcome.failure_id,
      stage: STAGE,
      action: 'x402.rejected',
      result: 'error',
      payload: { outcome_id: outcome.id, detail: verification.detail, amount_usd: priceUsd },
      startedAt: started,
    });
    // 402 (not 400) so the paying agent knows it may retry with a valid payment.
    throw new HttpError(402, 'payment_rejected', verification.detail, `${STAGE}.verify`);
  }

  const settled: Outcome = { ...outcome, payer: 'agent', x402_payment_id: verification.paymentId };
  await saveOutcome(repo, settled);
  await logBillingEvent(repo, {
    ticketId: outcome.failure_id,
    stage: STAGE,
    action: 'x402.settled',
    result: 'ok',
    payload: {
      outcome_id: outcome.id,
      payment_id: verification.paymentId,
      amount_usd: priceUsd,
      network: proof.network,
      mode: verification.mode,
    },
    startedAt: started,
  });
  return {
    unlock: true,
    lane: 'a2a_x402',
    payment_id: verification.paymentId,
    payer: 'agent',
    amount_usd: priceUsd,
    replayed: false,
    detail: verification.detail,
    mode: verification.mode,
    outcome: settled,
  };
}
