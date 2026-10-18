// The single persistence contract. Every module talks to the store ONLY through
// this interface, so the backing engine (in-memory now, Postgres later) can swap
// without touching business logic. This is what makes the service horizontally
// scalable: the orchestrator holds no state of its own.
import type {
  ApprovalRequest,
  Attempt,
  Failure,
  Grant,
  MeterEvent,
  Outcome,
  ToolEvent,
  Vendor,
} from '../shared/types.ts';

export interface Repository {
  // vendors
  putVendor(v: Vendor): Promise<void>;
  getVendor(id: string): Promise<Vendor | null>;

  // failures (cases)
  createFailure(f: Failure): Promise<void>;
  getFailure(id: string): Promise<Failure | null>;
  listFailures(filter?: { status?: Failure['status']; vendor_id?: string }): Promise<Failure[]>;
  setFailureStatus(id: string, status: Failure['status']): Promise<void>;

  // attempts + proofs
  createAttempt(a: Attempt): Promise<void>;
  latestAttempt(failureId: string): Promise<Attempt | null>;

  // outcomes + the one billable rule
  /** Upsert keyed by `failure_id`: one case has exactly one outcome, and
   * re-shipping or settling a case rewrites it rather than forking the truth. */
  createOutcome(o: Outcome): Promise<void>;
  getOutcome(failureId: string): Promise<Outcome | null>;
  /** Fetch by the outcome's own id — the billing routes are specified in terms of
   * `outcome_id`, and callers must not have to scan every case to resolve one. */
  getOutcomeById(outcomeId: string): Promise<Outcome | null>;
  listOutcomes(filter?: { vendor_id?: string }): Promise<Outcome[]>;
  /** Targeted write for the settlement fields (`stripe_event_id`, `payer`,
   * `mpp_payment_id`, `x402_payment_id`, `billable`). Returns null when the
   * outcome does not exist, so a caller cannot silently create a partial row. */
  updateOutcome(id: string, patch: Partial<Outcome>): Promise<Outcome | null>;
  /** The pricing model as one query: all three proofs passed AND the retry succeeded AND not exempt. */
  isBillable(failureId: string): Promise<boolean>;

  // grants (authority envelope) — idempotency is enforced here, not at callers
  recordGrant(g: Grant): Promise<Grant>;
  grantByIdempotencyKey(key: string): Promise<Grant | null>;
  listGrants(filter?: { failure_id?: string; vendor_id?: string; spent?: boolean }): Promise<Grant[]>;
  /** Record that the bounded verb was actually used. Issuing a grant spends
   * nothing; the spend is the vendor-side action. */
  markGrantSpent(id: string): Promise<Grant | null>;

  // meter events — identifier uniqueness enforced here so a retry cannot bill twice
  recordMeterEvent(m: MeterEvent): Promise<MeterEvent>;
  meterEventByIdentifier(identifier: string): Promise<MeterEvent | null>;
  /** What the weekly report's invoice preview is computed from. The Stripe meter
   * stays authoritative; this is the local record of what we emitted. */
  listMeterEvents(filter?: { vendor_id?: string; outcome_id?: string; since?: string }): Promise<MeterEvent[]>;

  // approvals
  /** Upsert by id. The id is derived from (failure_id, change_summary), so a
   * re-run of the loop must never clobber a decision a human already made. */
  createApproval(a: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  setApprovalDecision(id: string, decision: 'yes' | 'no', approver: string): Promise<void>;
  listApprovals(filter?: { failure_id?: string; decided?: boolean }): Promise<ApprovalRequest[]>;

  // observability
  /** Idempotent by event id: a writer that retries after a crash must not
   * duplicate a row in the audit trail. */
  appendToolEvent(e: ToolEvent): Promise<void>;
  toolEvents(filter?: { ticket_id?: string; tool?: string; action?: string; stage?: string }): Promise<ToolEvent[]>;

  // erasure — a data subject's right to be forgotten
  /** Redact everything that came FROM `userId` or identifies them: the task text,
   * request and response payloads, channel handle and agent id on their cases, plus
   * every tool-event payload that carries the same fields or names that user.
   *
   * Rows are redacted, not dropped, and the boundary is deliberate: the audit trail,
   * the financial record (outcomes, grants, meter events) and the engineering
   * artefacts derived from the report (the draft diff, the regression test, the PR
   * already sent to the vendor) are the vendor's own compliance record and survive.
   * The receipt says exactly what was scrubbed, so nobody has to guess.
   *
   * Idempotent: erasing twice changes nothing the second time and still returns a
   * receipt. */
  eraseUserData(userId: string): Promise<ErasureResult>;
}

/** What an erasure actually did, so the receipt is a fact and not a promise. */
export interface ErasureResult {
  /** The id the request named. Redacted everywhere else; echoed here so the caller
   * can match the receipt to the request it made. */
  user_id: string;
  /** Cases whose stored report was scrubbed. */
  cases: number;
  /** Tool-event rows whose payload was scrubbed. */
  events: number;
  /** The field names that were replaced, so the receipt is specific. */
  fields: string[];
  /** True when a second call found nothing left to scrub. */
  already_erased: boolean;
}
