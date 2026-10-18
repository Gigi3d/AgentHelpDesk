// In-memory Repository. Used by tests and by `DESK_STORE=memory`. A Postgres
// implementation can drop in behind the same interface without touching modules.
//
// Two rules this file exists to enforce, because business logic must not:
//   - idempotency (grant keys, meter identifiers, tool-event ids) lives HERE, so a
//     retried call can never spend twice or duplicate the audit trail;
//   - rows are copied on the way in and out, so a caller holding a reference cannot
//     mutate stored state behind the store's back.
import type { ErasureResult, Repository } from './repository.ts';
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

export class MemoryRepository implements Repository {
  private vendors = new Map<string, Vendor>();
  private failures = new Map<string, Failure>();
  private attempts: Attempt[] = [];
  /** Keyed by failure_id: one case has exactly one outcome. */
  private outcomes = new Map<string, Outcome>();
  private grants: Grant[] = [];
  private grantKeys = new Map<string, Grant>();
  private meters: MeterEvent[] = [];
  private meterIds = new Map<string, MeterEvent>();
  private approvals = new Map<string, ApprovalRequest>();
  private events: ToolEvent[] = [];
  private eventIds = new Set<string>();

  async putVendor(v: Vendor): Promise<void> {
    this.vendors.set(v.id, { ...v });
  }
  async getVendor(id: string): Promise<Vendor | null> {
    return this.vendors.get(id) ?? null;
  }

  async createFailure(f: Failure): Promise<void> {
    if (this.failures.has(f.id)) throw new Error(`failure ${f.id} already exists`);
    this.failures.set(f.id, { ...f });
  }
  async getFailure(id: string): Promise<Failure | null> {
    const f = this.failures.get(id);
    return f ? { ...f } : null;
  }
  async listFailures(filter?: { status?: Failure['status']; vendor_id?: string }): Promise<Failure[]> {
    return [...this.failures.values()]
      .filter(
        (f) => (!filter?.status || f.status === filter.status) && (!filter?.vendor_id || f.vendor_id === filter.vendor_id),
      )
      .map((f) => ({ ...f }));
  }
  async setFailureStatus(id: string, status: Failure['status']): Promise<void> {
    const f = this.failures.get(id);
    if (!f) throw new Error(`failure ${id} not found`);
    f.status = status;
  }

  async createAttempt(a: Attempt): Promise<void> {
    this.attempts.push({ ...a });
  }
  async latestAttempt(failureId: string): Promise<Attempt | null> {
    const mine = this.attempts.filter((a) => a.failure_id === failureId);
    const last = mine.length ? mine[mine.length - 1] : null;
    return last ? { ...last } : null;
  }

  async createOutcome(o: Outcome): Promise<void> {
    this.outcomes.set(o.failure_id, { ...o });
  }
  async getOutcome(failureId: string): Promise<Outcome | null> {
    const o = this.outcomes.get(failureId);
    return o ? { ...o } : null;
  }
  async getOutcomeById(outcomeId: string): Promise<Outcome | null> {
    for (const o of this.outcomes.values()) {
      if (o.id === outcomeId) return { ...o };
    }
    return null;
  }
  async listOutcomes(filter?: { vendor_id?: string }): Promise<Outcome[]> {
    const all = [...this.outcomes.values()];
    if (!filter?.vendor_id) return all.map((o) => ({ ...o }));
    const vendorId = filter.vendor_id;
    return all.filter((o) => this.failures.get(o.failure_id)?.vendor_id === vendorId).map((o) => ({ ...o }));
  }
  async updateOutcome(id: string, patch: Partial<Outcome>): Promise<Outcome | null> {
    const existing = await this.getOutcomeById(id);
    if (!existing) return null;
    // The identity fields are the row's keys: a patch may not move an outcome to
    // another case or mint a second id for the same one.
    const next: Outcome = { ...existing, ...patch, id: existing.id, failure_id: existing.failure_id };
    this.outcomes.set(next.failure_id, next);
    return { ...next };
  }
  async isBillable(failureId: string): Promise<boolean> {
    const a = await this.latestAttempt(failureId);
    const o = await this.getOutcome(failureId);
    if (!a || !o) return false;
    return a.proof_replay && a.proof_vendor_tests && a.proof_fresh_agent && o.agent_retry_ok;
  }

  async recordGrant(g: Grant): Promise<Grant> {
    const existing = this.grantKeys.get(g.idempotency_key);
    if (existing) return { ...existing }; // replay returns the original receipt and spends nothing
    const stored: Grant = { ...g };
    this.grants.push(stored);
    this.grantKeys.set(stored.idempotency_key, stored);
    return { ...stored };
  }
  async grantByIdempotencyKey(key: string): Promise<Grant | null> {
    const g = this.grantKeys.get(key);
    return g ? { ...g } : null;
  }
  async listGrants(filter?: { failure_id?: string; vendor_id?: string; spent?: boolean }): Promise<Grant[]> {
    return this.grants
      .filter((g) => {
        if (filter?.failure_id && g.failure_id !== filter.failure_id) return false;
        if (typeof filter?.spent === 'boolean' && g.spent !== filter.spent) return false;
        if (filter?.vendor_id && this.failures.get(g.failure_id)?.vendor_id !== filter.vendor_id) return false;
        return true;
      })
      .map((g) => ({ ...g }));
  }
  async markGrantSpent(id: string): Promise<Grant | null> {
    const g = this.grants.find((x) => x.id === id);
    if (!g) return null;
    g.spent = true;
    return { ...g };
  }

  async recordMeterEvent(m: MeterEvent): Promise<MeterEvent> {
    const existing = this.meterIds.get(m.identifier);
    if (existing) return { ...existing }; // a retry can never bill twice
    const stored: MeterEvent = { ...m };
    this.meters.push(stored);
    this.meterIds.set(stored.identifier, stored);
    return { ...stored };
  }
  async meterEventByIdentifier(identifier: string): Promise<MeterEvent | null> {
    const m = this.meterIds.get(identifier);
    return m ? { ...m } : null;
  }
  async listMeterEvents(filter?: { vendor_id?: string; outcome_id?: string; since?: string }): Promise<MeterEvent[]> {
    return this.meters
      .filter((m) => {
        if (filter?.outcome_id && m.outcome_id !== filter.outcome_id) return false;
        // ISO-8601 UTC strings sort lexicographically, so `since` is a string compare.
        if (filter?.since && m.at < filter.since) return false;
        if (filter?.vendor_id) {
          const outcome = [...this.outcomes.values()].find((o) => o.id === m.outcome_id);
          if (!outcome) return false;
          if (this.failures.get(outcome.failure_id)?.vendor_id !== filter.vendor_id) return false;
        }
        return true;
      })
      .map((m) => ({ ...m }));
  }

  async createApproval(a: ApprovalRequest): Promise<void> {
    // Idempotent by id, and an existing row is never overwritten: the id is derived
    // from (failure_id, change_summary), so a loop re-run would otherwise wipe the
    // decision a human already made.
    if (this.approvals.has(a.id)) return;
    this.approvals.set(a.id, { ...a });
  }
  async getApproval(id: string): Promise<ApprovalRequest | null> {
    const a = this.approvals.get(id);
    return a ? { ...a } : null;
  }
  async setApprovalDecision(id: string, decision: 'yes' | 'no', approver: string): Promise<void> {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`approval ${id} not found`);
    a.decision = decision;
    a.approver = approver;
    a.replied_at = new Date().toISOString();
  }
  async listApprovals(filter?: { failure_id?: string; decided?: boolean }): Promise<ApprovalRequest[]> {
    return [...this.approvals.values()]
      .filter((a) => {
        if (filter?.failure_id && a.failure_id !== filter.failure_id) return false;
        if (typeof filter?.decided === 'boolean' && (a.decision !== null) !== filter.decided) return false;
        return true;
      })
      .map((a) => ({ ...a }));
  }

  async appendToolEvent(e: ToolEvent): Promise<void> {
    if (this.eventIds.has(e.id)) return; // a retried writer must not duplicate the audit trail
    this.eventIds.add(e.id);
    this.events.push({ ...e });
  }
  async toolEvents(filter?: { ticket_id?: string; tool?: string; action?: string; stage?: string }): Promise<ToolEvent[]> {
    return this.events
      .filter(
        (e) =>
          (!filter?.ticket_id || e.ticket_id === filter.ticket_id) &&
          (!filter?.tool || e.tool === filter.tool) &&
          (!filter?.action || e.action === filter.action) &&
          (!filter?.stage || e.stage === filter.stage),
      )
      .map((e) => ({ ...e }));
  }

  async eraseUserData(userId: string): Promise<ErasureResult> {
    const id = userId.trim();
    const fields = new Set<string>();
    const caseIds = new Set<string>();
    let cases = 0;

    for (const f of this.failures.values()) {
      if (f.agent_id !== id) continue;
      caseIds.add(f.id);
      cases += 1;
      // The case row survives (the vendor's engineering record) minus everything the
      // user supplied. `agent_id` goes too, which is what makes a second call a no-op.
      this.failures.set(f.id, scrub(f, fields, id) as Failure);
    }

    let events = 0;
    for (let i = 0; i < this.events.length; i += 1) {
      const e = this.events[i];
      if (!e) continue;
      // Ownership is either the case or the id turning up anywhere in the payload,
      // which catches keys the field list does not know about.
      const mine = caseIds.has(e.ticket_id) || mentions(e.payload, id);
      if (!mine) continue;
      const scrubbed = scrubRows(e.payload, fields, id, '');
      if (!scrubbed.changed) continue; // nothing user-supplied in this row, so leave it exactly as it was
      this.events[i] = { ...e, payload: scrubbed.value };
      events += 1;
    }

    return {
      user_id: id,
      cases,
      events,
      fields: [...fields].sort(),
      already_erased: cases === 0 && events === 0,
    };
  }
}

const ERASED = '[erased]';

/** Keys whose values came from the reporting user, so an erasure replaces them
 * wherever they turn up — on the case row and at any depth inside an event payload. */
const USER_FIELDS = [
  'agent_id',
  'user_id',
  'task',
  'goal',
  'tried',
  'contact',
  'channel_ref',
  'request',
  'response',
  'body',
  'headers',
  'command',
  'stdout',
  'stderr',
];

/** The erasure walk. Two rules: everything under a user-supplied key goes, whatever
 * its type, and so does any string that IS the user id — which catches the keys the
 * list above cannot know about (an email row's `from`, a webhook's `sender`). */
function scrubRows(
  value: unknown,
  fields: Set<string>,
  userId: string,
  key: string,
): { value: unknown; changed: boolean } {
  if (USER_FIELDS.includes(key)) {
    fields.add(key);
    return { value: ERASED, changed: value !== ERASED };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = scrubRows(v, fields, userId, key);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: out, changed };
  }
  if (typeof value === 'string') {
    if (value !== userId) return { value, changed: false };
    fields.add(key === '' ? 'value' : key);
    return { value: ERASED, changed: true };
  }
  if (value === null || typeof value !== 'object') return { value, changed: false };
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const r = scrubRows(v, fields, userId, k);
    if (r.changed) changed = true;
    out[k] = r.value;
  }
  return { value: out, changed };
}

function scrub<T>(row: T, fields: Set<string>, userId: string): T {
  return scrubRows({ ...(row as object) }, fields, userId, '').value as T;
}

/** Does anything at any depth name this user? Decides which event rows are theirs. */
function mentions(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value === needle;
  if (Array.isArray(value)) return value.some((v) => mentions(v, needle));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => mentions(v, needle));
  }
  return false;
}
