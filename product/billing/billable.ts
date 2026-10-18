// The billable decision: the one rule that decides whether AgentHelpDesk gets paid, and
// which of the two lanes pays.
//
//   billable  = repo.isBillable(failureId)            // all three proofs AND the agent's retry succeeded
//               AND not policy-exempt                 // see exemptionFor: operator-set facts, plus the
//                                                     // free-text privacy match on the vendor-pays lane only
//   lane      = vendor pays                -> 'b2b_meter'   (Stripe usage meter, count aggregation)
//               vendor chose agent-pays    -> vendor.agent_pay_rail, 'b2b_mpp' (Stripe MPP 402) by default
//               caller is a stranger agent -> 'a2a_x402'    (open x402 protocol, per call, no vendor relationship)
//
// Build plan, "Billing: Stripe meter for B2B, x402 for A2A": two lanes, one billable rule.
// Rungs 0-3 of the install ladder produce labelled suggestions only and never bill, which is
// what `suggest_only` vendors model here.
import { HttpError } from '../shared/http.ts';
import type { Attempt, BillableDecision, Failure, PayLane, Vendor } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { logBillingEvent } from './log.ts';

const STAGE = 'billing.decide';

/** Comma-separated, matched case-insensitively against the case's task text. */
const DEFAULT_EXEMPT_TERMS = [
  'privacy request',
  'data deletion',
  'delete my data',
  'right to be forgotten',
  'dsar',
  'gdpr',
  'ccpa',
  'subject access request',
];

function exemptTerms(): string[] {
  const raw = process.env['AHD_BILLING_EXEMPT_TERMS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_EXEMPT_TERMS;
  const terms = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '');
  if (terms.length === 0) {
    throw new HttpError(500, 'bad_exempt_terms', 'AHD_BILLING_EXEMPT_TERMS must list at least one term', STAGE);
  }
  return terms;
}

export interface Exemption {
  reason: string;
  detail: string;
}

/** The caller's own words, so this is a heuristic and nothing more: it reports
 * which privacy/deletion term the task text matched, or null. */
export function privacyTermHit(failure: Failure): string | null {
  const task = `${failure.task}`.toLowerCase();
  return exemptTerms().find((term) => task.includes(term)) ?? null;
}

/**
 * Policy exemptions: things the desk fixes but must never charge for.
 *
 * Only operator-controlled facts exempt on every lane. The free-text privacy match
 * is trusted solely on `b2b_meter`, where the vendor pays: on the agent-pays lanes
 * the text came from the party being charged, so honoring it would let any caller
 * zero its own bill by writing "gdpr" into a report.
 */
export function exemptionFor(failure: Failure, vendor: Vendor | null, lane: PayLane): Exemption | null {
  if (vendor?.billing_exempt === true) {
    return {
      reason: 'exempt_vendor_policy',
      detail: `vendor "${vendor.id}" is flagged billing_exempt, so its cases never meter`,
    };
  }
  if (vendor && vendor.risk_policy === 'suggest_only') {
    return {
      reason: 'exempt_suggest_only',
      detail: `vendor "${vendor.id}" is in suggest_only mode: labelled suggestions only, which never bill`,
    };
  }
  const hit = privacyTermHit(failure);
  if (hit !== null && lane === 'b2b_meter') {
    return {
      reason: 'exempt_privacy_request',
      detail: `case task matches the privacy/deletion exemption term "${hit}"; the desk does not bill rights requests`,
    };
  }
  return null;
}

/**
 * Stranger-agent test: A2A is defined by the *absence* of a vendor relationship. If there is
 * no vendor row, or the vendor has no Stripe customer to invoice, there is nobody to meter —
 * so the caller pays per call over x402.
 */
export function chooseLane(vendor: Vendor | null): PayLane {
  if (!vendor || vendor.stripe_customer_id.trim() === '') return 'a2a_x402';
  if (vendor.payer_mode === 'vendor') return 'b2b_meter';
  // The vendor picked agent-pays; `agent_pay_rail` says which rail it picked.
  return vendor.agent_pay_rail === 'x402' ? 'a2a_x402' : 'b2b_mpp';
}

function proofFailure(attempt: Attempt | null, retryOk: boolean): string {
  if (!attempt) return 'no attempt recorded';
  const missing: string[] = [];
  if (!attempt.proof_replay) missing.push('replay');
  if (!attempt.proof_vendor_tests) missing.push('vendor_tests');
  if (!attempt.proof_fresh_agent) missing.push('fresh_agent');
  if (missing.length > 0) return `proofs not passed: ${missing.join(', ')}`;
  if (!retryOk) return 'agent retry did not succeed';
  return 'unknown';
}

export async function decide(failureId: string, repo: Repository): Promise<BillableDecision> {
  const started = Date.now();
  const id = failureId.trim();
  if (id === '') {
    throw new HttpError(400, 'bad_request', 'failure_id must be a non-empty string', STAGE);
  }
  const failure = await repo.getFailure(id);
  if (!failure) {
    throw new HttpError(404, 'case_not_found', `no case "${id}"`, STAGE);
  }
  const vendor = await repo.getVendor(failure.vendor_id);
  // Lane first: whether a privacy term in the caller's own text is honored depends on
  // who is being charged.
  const lane = chooseLane(vendor);
  const privacyTerm = privacyTermHit(failure);
  const privacyTermIgnored = privacyTerm !== null && lane !== 'b2b_meter' ? privacyTerm : null;

  const exemption = exemptionFor(failure, vendor, lane);
  if (exemption) {
    // Exempt instead of a meter event: the audit trail records why nothing was charged.
    await logBillingEvent(repo, {
      ticketId: failure.id,
      stage: STAGE,
      action: 'billing.exempt',
      result: 'skipped',
      payload: {
        failure_id: failure.id,
        vendor_id: failure.vendor_id,
        reason: exemption.reason,
        detail: exemption.detail,
        lane: null,
      },
      startedAt: started,
    });
    return { billable: false, reason: `${exemption.reason}: ${exemption.detail}`, lane: null };
  }

  const billable = await repo.isBillable(failure.id);
  if (!billable) {
    const attempt = await repo.latestAttempt(failure.id);
    const outcome = await repo.getOutcome(failure.id);
    const detail = proofFailure(attempt, outcome?.agent_retry_ok ?? false);
    await logBillingEvent(repo, {
      ticketId: failure.id,
      stage: STAGE,
      action: 'billing.not_billable',
      result: 'skipped',
      payload: { failure_id: failure.id, vendor_id: failure.vendor_id, detail, lane: null },
      startedAt: started,
    });
    return { billable: false, reason: `not_billable: ${detail}`, lane: null };
  }

  const reason =
    lane === 'b2b_meter'
      ? 'billable_vendor_pays_meter: three proofs passed and the agent retry succeeded; meter the vendor'
      : lane === 'b2b_mpp'
        ? 'billable_agent_pays_mpp: vendor chose agent-pays, so the verified answer is served behind a Stripe MPP 402'
        : 'billable_a2a_x402: caller is a stranger agent with no vendor relationship, so it pays per call over x402';

  await logBillingEvent(repo, {
    ticketId: failure.id,
    stage: STAGE,
    action: 'billing.decision',
    result: 'ok',
    payload: {
      failure_id: failure.id,
      vendor_id: failure.vendor_id,
      lane,
      stripe_customer_id: vendor?.stripe_customer_id ?? null,
      payer_mode: vendor?.payer_mode ?? null,
      privacy_term_ignored: privacyTermIgnored,
    },
    startedAt: started,
  });
  return { billable: true, reason, lane };
}
