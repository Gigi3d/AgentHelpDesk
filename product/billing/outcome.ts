// Outcome lookup + persistence for the billing module.
//
// LOCAL ASSUMPTIONS, filed in product/CONTRACT_REQUESTS.md (billing-1, billing-2):
//   1. `Repository` can only fetch an outcome by *failure* id (`getOutcome(failureId)`),
//      but the billing routes are specified in terms of `outcome_id`. Until the store grows
//      `getOutcomeById`, we resolve an outcome id by scanning the vendor-independent failure
//      list (`listFailures()` with no filter) and reading each outcome. That is O(cases) and
//      capped by `AHD_BILLING_OUTCOME_SCAN_CAP` (default 2000); over the cap we fail loud
//      rather than silently guessing. Callers may pass `failure_id` to skip the scan.
//   2. `Repository` has no patch method for outcomes. `MemoryRepository.createOutcome` is an
//      upsert keyed by `failure_id` (`Map.set`), so we persist a field change by writing the
//      whole outcome back through `createOutcome`. If the Postgres store makes `createOutcome`
//      insert-only, `saveOutcome` is the single place that must change.
import { HttpError } from '../shared/http.ts';
import type { Outcome } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';

const DEFAULT_SCAN_CAP = 2000;

export interface OutcomeRef {
  outcomeId?: string;
  failureId?: string;
}

function scanCap(): number {
  const raw = process.env['AHD_BILLING_OUTCOME_SCAN_CAP'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_SCAN_CAP;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new HttpError(500, 'bad_scan_cap', `AHD_BILLING_OUTCOME_SCAN_CAP must be >= 1, got "${raw}"`, 'billing.outcome');
  }
  return value;
}

export async function resolveOutcome(repo: Repository, ref: OutcomeRef, stage: string): Promise<Outcome> {
  const outcomeId = ref.outcomeId?.trim() ?? '';
  const failureId = ref.failureId?.trim() ?? '';

  if (failureId !== '') {
    const outcome = await repo.getOutcome(failureId);
    if (!outcome) {
      throw new HttpError(404, 'outcome_not_found', `no outcome recorded for failure "${failureId}"`, stage);
    }
    if (outcomeId !== '' && outcome.id !== outcomeId) {
      throw new HttpError(409, 'outcome_mismatch', `outcome "${outcomeId}" does not belong to failure "${failureId}"`, stage);
    }
    return outcome;
  }

  if (outcomeId === '') {
    throw new HttpError(400, 'missing_outcome_ref', 'pass "outcome_id" (or "failure_id") to identify the outcome', stage);
  }

  const failures = await repo.listFailures();
  const cap = scanCap();
  if (failures.length > cap) {
    throw new HttpError(
      501,
      'outcome_lookup_unavailable',
      `${String(failures.length)} cases exceed the outcome scan cap (${String(cap)}); pass "failure_id" or add Repository.getOutcomeById`,
      stage,
    );
  }
  for (const failure of failures) {
    const outcome = await repo.getOutcome(failure.id);
    if (outcome && outcome.id === outcomeId) return outcome;
  }
  throw new HttpError(404, 'outcome_not_found', `no outcome with id "${outcomeId}"`, stage);
}

/**
 * Re-read the stored row before writing. A caller may hold a copy from earlier in the
 * request (or from a previous one); writing that copy back would silently clobber fields
 * another writer set — e.g. cancelling with a pre-meter copy would wipe `stripe_event_id`.
 */
export async function refreshOutcome(repo: Repository, outcome: Outcome): Promise<Outcome> {
  const current = await repo.getOutcome(outcome.failure_id);
  return current && current.id === outcome.id ? current : outcome;
}

/** Persist a changed outcome. See assumption 2 above. */
export async function saveOutcome(repo: Repository, outcome: Outcome): Promise<void> {
  await repo.createOutcome(outcome);
}
