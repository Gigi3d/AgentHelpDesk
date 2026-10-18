// Payment verification for the two agent-pays rails (x402 and Stripe MPP).
//
// What is real and what is faked, stated plainly:
//   * x402 (open HTTP-402 protocol): the server returns 402 with a payment requirement
//     (network + amount + recipient); the client pays in stablecoin and sends the payment
//     back; the server verifies it — in production by asking a facilitator — and only then
//     serves the resource. The facilitator call is a JSON-RPC POST (`method: "verify"` with
//     the payment payload and the payment requirements). Doc: https://docs.x402.org
//     (scheme "exact"), spec: https://github.com/x402-foundation/x402
//   * Stripe MPP: HTTP 402 with a payment requirement; cards pay through Shared Payment
//     Tokens with a $0.50 minimum and USDC has a $0.01 minimum; the server handler is built
//     with `mppx` + `stripe` and is tested end to end with `npx mppx@latest validate`
//     (we do NOT run that here — AGENTS.md forbids node/npm/npx on this machine).
//     Doc: Stripe MPP quickstart (docs.stripe.com) and Stripe's hackathon primer.
//
// Neither verifier can reach its network from this repo (zero runtime dependencies, offline
// box), so both sit behind `PaymentVerifier` with a `FakePaymentVerifier` that is
// deterministic, offline and clearly tagged `mode: 'test'`. It never claims a payment is
// settled in live mode: swapping in a real facilitator/MPP client means implementing this
// one interface, and nothing else in the module changes.
import { createHash } from 'node:crypto';
import { HttpError } from '../shared/http.ts';

export type PayRail = 'a2a_x402' | 'b2b_mpp';

/** Protocol minimums we must respect when building a 402 (see header comment). */
export const MPP_CARD_MIN_USD = 0.5;
export const MPP_USDC_MIN_USD = 0.01;

export interface VerificationRequest {
  rail: PayRail;
  /** The client's payment blob: x402 `X-Payment` header value, or MPP payment token. */
  proof: string;
  /** What we asked for. The verifier must not accept less. */
  amountUsd: number;
}

export interface Verification {
  ok: boolean;
  rail: PayRail;
  paymentId: string;
  amountUsd: number;
  detail: string;
  mode: 'test';
  verifiedAt: string;
}

export interface PaymentVerifier {
  readonly mode: 'test';
  verify(req: VerificationRequest): Promise<Verification>;
}

/** Proofs containing any of these are rejected, so tests can drive the failure path deterministically. */
const POISON_TOKENS = ['invalid', 'reject', 'insufficient', 'bad_signature'];

function paymentIdFor(rail: PayRail, proof: string): string {
  const digest = createHash('sha256').update(`${rail}:${proof}`).digest('hex');
  return `${rail === 'a2a_x402' ? 'x402' : 'mpp'}_fake_${digest.slice(0, 24)}`;
}

export class FakePaymentVerifier implements PaymentVerifier {
  readonly mode = 'test' as const;
  /** Every verification this fake performed, in order. Test-visible on purpose. */
  readonly calls: VerificationRequest[] = [];

  async verify(req: VerificationRequest): Promise<Verification> {
    if (req.proof.trim() === '') {
      throw new HttpError(400, 'missing_payment_proof', 'payment proof must be a non-empty string', `billing.${req.rail}.verify`);
    }
    if (!Number.isFinite(req.amountUsd) || req.amountUsd <= 0) {
      throw new HttpError(400, 'bad_amount', `amount must be a positive USD number, got ${String(req.amountUsd)}`, `billing.${req.rail}.verify`);
    }
    this.calls.push({ rail: req.rail, proof: req.proof, amountUsd: req.amountUsd });

    const lowered = req.proof.toLowerCase();
    const poison = POISON_TOKENS.find((token) => lowered.includes(token));
    const verifiedAt = new Date().toISOString();
    if (poison !== undefined) {
      return {
        ok: false,
        rail: req.rail,
        paymentId: '',
        amountUsd: req.amountUsd,
        detail: `fake verifier rejected proof: contains "${poison}"`,
        mode: 'test',
        verifiedAt,
      };
    }
    return {
      ok: true,
      rail: req.rail,
      // Deterministic in the proof, so a replayed proof yields the same payment id.
      paymentId: paymentIdFor(req.rail, req.proof),
      amountUsd: req.amountUsd,
      detail: 'fake offline verifier accepted the payment (no network was contacted)',
      mode: 'test',
      verifiedAt,
    };
  }
}

let cachedVerifier: PaymentVerifier | null = null;

/** Configuration-derived adapter; holds no case state. */
export function getVerifier(): PaymentVerifier {
  if (cachedVerifier) return cachedVerifier;
  cachedVerifier = new FakePaymentVerifier();
  return cachedVerifier;
}
