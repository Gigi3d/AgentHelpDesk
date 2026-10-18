// Authority envelope: issue and look up bounded grants.
//
// Build plan, "The authority envelope": every verb carries a cap, a per-user
// limit, an idempotency key and a receipt; a replayed call must return the
// original receipt and spend nothing. The Repository enforces idempotency
// (`recordGrant` returns the stored grant for a known key) — this module never
// re-implements that rule, it only feeds it a deterministic key and reads back
// what the store decided.
//
// Envelopes are OPERATOR settings. A caller may ask for a narrower envelope; it
// can never widen one. "Review every path that reads an envelope; the only
// writer is Settings."
import type { Repository } from '../store/repository.ts';
import { HttpError } from '../shared/http.ts';
import type { Envelope, Grant } from '../shared/types.ts';
import { recordStage, shortHash } from './obs.ts';
import { envInt } from './inspect.ts';

export interface VerbPolicy {
  verb: string;
  cap_usd: number;
  per_user: number;
  /** Weekend scope: `entitlements.reissue` only; the rest are in the schema and
   * the docs, marked as coming. */
  enabled: boolean;
}

/** The verb schema. Tightest option by default; widening is a Settings change. */
export const VERB_TABLE: readonly VerbPolicy[] = [
  { verb: 'entitlements.reissue', cap_usd: 30, per_user: 1, enabled: true },
  { verb: 'verifications.appeal', cap_usd: 0, per_user: 1, enabled: false },
  { verb: 'orders.state', cap_usd: 0, per_user: 1, enabled: false },
  { verb: 'refunds.create', cap_usd: 0, per_user: 1, enabled: false },
];

export function verbPolicy(verb: string, stage = 'grants.envelope'): VerbPolicy {
  const found = VERB_TABLE.find((v) => v.verb === verb);
  if (!found) {
    throw new HttpError(400, 'unsupported_verb', `verb "${verb}" is not in the authority envelope schema`, stage);
  }
  if (!found.enabled) {
    throw new HttpError(400, 'verb_not_available', `verb "${verb}" is in the schema but not enabled yet`, stage);
  }
  return found;
}

/** The envelope for a verb, after operator overrides. Overrides may only TIGHTEN. */
export function envelopeFor(verb: string, stage = 'grants.envelope'): Envelope {
  const policy = verbPolicy(verb, stage);
  const capOverride = envInt('AHD_ENVELOPE_CAP_USD', policy.cap_usd, 0, policy.cap_usd);
  const perUserOverride = envInt('AHD_ENVELOPE_PER_USER', policy.per_user, 0, policy.per_user);
  return {
    verbs: [policy.verb],
    cap_usd: Math.min(policy.cap_usd, capOverride),
    per_user: Math.min(policy.per_user, perUserOverride),
  };
}

/** Narrow a caller-supplied envelope against policy. Returns null when nothing
 * was clamped so the audit trail only records real clamps. */
export function clampEnvelope(requested: Envelope | null | undefined, policy: Envelope): { envelope: Envelope; clamped: boolean } {
  if (!requested) return { envelope: policy, clamped: false };
  const verbs = requested.verbs.filter((v) => policy.verbs.includes(v));
  const next: Envelope = {
    verbs: verbs.length > 0 ? verbs : policy.verbs,
    cap_usd: Math.min(policy.cap_usd, Number.isFinite(requested.cap_usd) ? Math.max(0, requested.cap_usd) : policy.cap_usd),
    per_user: Math.min(policy.per_user, Number.isFinite(requested.per_user) ? Math.max(0, requested.per_user) : policy.per_user),
  };
  const clamped =
    next.cap_usd !== requested.cap_usd ||
    next.per_user !== requested.per_user ||
    next.verbs.length !== requested.verbs.length ||
    next.verbs.some((v, i) => requested.verbs[i] !== v);
  return { envelope: next, clamped };
}

export interface IssueGrantInput {
  failure_id: string;
  verb: string;
  idempotency_key: string;
  /** Optional narrowing request. Ignored when it would widen the envelope. */
  requested_envelope?: Envelope | null;
  /** Require the case to be an authority failure. On by default: a grant is the
   * third failure class's fix, not a general-purpose escape hatch. */
  require_authority_case?: boolean;
  stage?: string;
}

export interface IssueGrantResult {
  grant: Grant;
  /** True when the key had already been used: the original receipt is returned
   * and nothing was spent. */
  replayed: boolean;
  clamped: boolean;
}

/** Deterministic ids derived from the idempotency key, so two concurrent issuers
 * of the same key converge on the same grant row and the store can dedupe. */
export function grantIdFor(idempotencyKey: string): string {
  return `grt_${shortHash(`grant-id:${idempotencyKey}`, 16)}`;
}

export function receiptFor(idempotencyKey: string): string {
  return `ahd_rcpt_${shortHash(`grant-receipt:${idempotencyKey}`, 20)}`;
}

/** The key ship.ts uses for the grant that belongs to a case, so re-shipping a
 * case can never mint a second grant. */
export function caseGrantKey(failureId: string, verb: string): string {
  return `ahd-grant-${failureId}-${verb}`;
}

export async function lookupGrant(repo: Repository, idempotencyKey: string): Promise<Grant | null> {
  return repo.grantByIdempotencyKey(idempotencyKey);
}

export async function issueGrant(repo: Repository, input: IssueGrantInput): Promise<IssueGrantResult> {
  const stage = input.stage ?? 'grants.issue';
  const key = input.idempotency_key;
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw new HttpError(400, 'bad_idempotency_key', 'idempotency_key must be a non-empty string of at most 200 chars', stage);
  }
  if (typeof input.failure_id !== 'string' || input.failure_id.length === 0) {
    throw new HttpError(400, 'bad_failure_id', 'failure_id must be a non-empty string', stage);
  }

  // Fast replay path: the store already knows this key, so return the ORIGINAL
  // receipt and spend nothing.
  const existing = await repo.grantByIdempotencyKey(key);
  if (existing) {
    await recordStage(repo, {
      ticketId: input.failure_id,
      stage: 'shipped',
      tool: 'desk',
      action: 'grant.replayed',
      payload: { idempotency_key: key, grant_id: existing.id, receipt: existing.receipt, spent: existing.spent },
    });
    return { grant: existing, replayed: true, clamped: false };
  }

  const failure = await repo.getFailure(input.failure_id);
  if (!failure) {
    throw new HttpError(404, 'case_not_found', `no case ${input.failure_id}`, stage);
  }
  if (input.require_authority_case !== false && failure.klass !== 'authority') {
    throw new HttpError(
      409,
      'not_authority_case',
      `case ${failure.id} is classified "${failure.klass}"; grants are only issued for authority failures`,
      stage,
    );
  }

  const policy = envelopeFor(input.verb, stage);
  const { envelope, clamped } = clampEnvelope(input.requested_envelope ?? null, policy);
  const now = new Date().toISOString();
  const candidate: Grant = {
    id: grantIdFor(key),
    failure_id: failure.id,
    verb: input.verb,
    envelope,
    idempotency_key: key,
    receipt: receiptFor(key),
    // Issuing a grant does not spend it; the spend is the vendor-side action and
    // is recorded by whoever executes the verb (see CONTRACT_REQUESTS.md:
    // Repository needs `markGrantSpent`).
    spent: false,
    created_at: now,
  };

  let stored: Grant;
  try {
    stored = await repo.recordGrant(candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(500, 'grant_record_failed', `could not record grant: ${message}`, stage);
  }
  const replayed = stored.id !== candidate.id || stored.created_at !== candidate.created_at;

  await recordStage(repo, {
    ticketId: failure.id,
    stage: 'shipped',
    tool: 'desk',
    action: replayed ? 'grant.replayed' : 'grant.issued',
    payload: {
      grant_id: stored.id,
      verb: stored.verb,
      envelope: stored.envelope,
      idempotency_key: key,
      receipt: stored.receipt,
      clamped,
      replayed,
    },
  });

  return { grant: stored, replayed, clamped };
}
