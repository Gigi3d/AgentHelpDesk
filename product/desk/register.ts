// desk/ HTTP boundary. Every inbound field is validated here; nothing below this
// file trusts a caller. Handlers are exported individually so tests can call
// them directly with a constructed Ctx (no ports, no child processes).
//
// Route note: the Router in shared/http.ts matches EXACT paths and has no path
// parameters, so `GET /v1/cases/:id` is served by `GET /v1/cases` reading
// `ctx.query.get('id')`. The same applies to the deletion route, which the plan
// writes as `DELETE /users/{id}/data`: it is registered as `DELETE
// /v1/users/data` and reads the id from the body or from `?id=`.
import type { Ctx, Handler, Router } from '../shared/http.ts';
import { badRequest, HttpError, num, ok, str } from '../shared/http.ts';
import type { Repository } from '../store/repository.ts';
import type {
  AgentReply,
  ApprovalRequest,
  Attempt,
  CaseStage,
  Failure,
  Grant,
  Outcome,
  ProblemReport,
  ToolEvent,
  Vendor,
} from '../shared/types.ts';
import { CHANNELS, intake, isTerminal } from './intake.ts';
import { runLoop } from './loop.ts';
import type { LoopDeps, LoopResult } from './loop.ts';
import { caseGrantKey, issueGrant, lookupGrant } from './grants.ts';
import { approvalIdFor, changeKindOf } from './gate.ts';
import { grantVerb, replyFromStore } from './ship.ts';
import { draftFix } from './resolve.ts';
import { recordStage, shortHash } from './obs.ts';
import { asRecord, boolOf, clip, envInt, oneOf, optOneOf, optStr, FAILURE_CLASSES } from './inspect.ts';

export const CASE_STAGES: readonly CaseStage[] = [
  'opened',
  'reproducing',
  'fix_drafted',
  'proving',
  'awaiting_approval',
  'answered',
  'shipped',
  'closed',
  'escalated',
];

const MAX_ID = 200;

/** Fire the loop without blocking the request. Anything that may exceed ~60s
 * must be background+poll: the caller gets 202 and reads GET /v1/cases?id=. */
function startBackgroundLoop(repo: Repository, caseId: string, deps: LoopDeps): void {
  void runLoop(repo, caseId, deps).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    void recordStage(repo, {
      ticketId: caseId,
      stage: 'escalated',
      tool: 'desk',
      action: 'loop.background_failed',
      result: 'error',
      payload: { error: message },
    }).catch((writeErr: unknown) => {
      // Last resort: the audit write itself failed, so say so on stderr rather
      // than swallowing it.
      process.stderr.write(
        `desk: background loop failed for ${caseId}: ${message}; audit write also failed: ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }\n`,
      );
    });
  });
}

function requireId(value: string | null, field: string, stage: string): string {
  if (value === null || value.length === 0) throw badRequest(stage, `field "${field}" must be a non-empty string`);
  if (value.length > MAX_ID) throw badRequest(stage, `field "${field}" must be at most ${MAX_ID} characters`);
  return value;
}

async function requireCase(repo: Repository, id: string, stage: string): Promise<Failure> {
  const failure = await repo.getFailure(id);
  if (!failure) throw new HttpError(404, 'case_not_found', `no case ${id}`, stage);
  return failure;
}

export interface CaseView {
  case: Failure;
  status: CaseStage;
  vendor_id: string;
  /** The vendor row behind this case. Its `risk_policy` is what decided whether a
   * green case auto-shipped or stopped at `awaiting_approval`. Null only when the
   * case names a vendor the store does not know (intake substitutes a fallback). */
  vendor: Vendor | null;
  klass: Failure['klass'];
  ack_by: string;
  resolve_by: string;
  queue_position: number;
  sla_breached: boolean;
  billable: boolean;
  attempt: Attempt | null;
  outcome: Outcome | null;
  grant: Grant | null;
  approval: ApprovalRequest | null;
  reply: AgentReply | null;
  events: ToolEvent[];
  /** The route stage that produced this view, for log/error attribution. */
  stage: string;
}

export interface DeskHandlers {
  postCase: Handler;
  getCases: Handler;
  postRun: Handler;
  postRetry: Handler;
  postHandoff: Handler;
  deleteUserData: Handler;
  postGrant: Handler;
  getGrant: Handler;
}

/** What billing/ needs when a case becomes billable. Shaped to match its
 * `POST /v1/billing/on-billable` body (`outcome_id`, `lane`, `failure_id`) so the
 * wiring is a pass-through, plus the dedupe `identifier` the Repository keys on. */
export interface BillableNotice {
  outcome_id: string;
  failure_id: string;
  lane: string;
  identifier: string;
  payer: Outcome['payer'];
}

/** What the notifier tells the desk back.
 *
 * The two agent-pays lanes do not move money on this call: they return a 402
 * payment requirement, and the tested answer must be WITHHELD until
 * `/v1/a2a/settle` or `/v1/billing/mpp/settle` reports `unlock: true`. A notifier
 * that returns nothing is treated as "charged, unlocked" (the b2b meter case). */
export interface BillableNoticeResult {
  lane: string;
  /** May the answer be served now? False when it is priced and still unpaid. */
  unlock: boolean;
  /** Did money move (or was a payment already on record)? False for an unpaid 402. */
  charged: boolean;
  /** The 402 body to hand the agent when `unlock` is false. */
  payment_required?: unknown;
}

/** Injectable billing notifier.
 *
 * desk/ never imports billing/ — same rule as the gate's `askApproval`. Pass
 * billing's real notifier here (a function that POSTs to /v1/billing/on-billable or
 * calls its handler) and desk will call it exactly once per billable outcome. When
 * it is absent, the `billing.billable` ToolEvent is the record of intent and
 * billing/ can reconcile from it. */
export type OnBillable = (notice: BillableNotice, repo: Repository) => Promise<BillableNoticeResult | void>;

export interface DeskDeps extends LoopDeps {
  onBillable?: OnBillable;
}

export function makeHandlers(repo: Repository, deps: DeskDeps = {}): DeskHandlers {
  /** POST /v1/cases — open a case and return committed times immediately. */
  const postCase: Handler = async (ctx: Ctx) => {
    const stage = 'desk.route.post_case';
    const body = ctx.body;
    const rec = asRecord(body);
    if (!rec) throw badRequest(stage, 'body must be a JSON object');

    // `idempotency_key` is part of ProblemReport (blessed in CONTRACT_REQUESTS.md):
    // when present, intake derives a deterministic case id so a retry replays.
    const report: ProblemReport = {
      agent_id: str(body, 'agent_id', stage),
      task: str(body, 'task', stage),
      request: rec['request'] ?? null,
      response: rec['response'] ?? null,
      channel: oneOf(body, 'channel', stage, CHANNELS),
    };
    const vendorHint = optStr(body, 'vendor_hint', stage, MAX_ID);
    if (vendorHint !== null) report.vendor_hint = vendorHint;
    const klass = optOneOf(body, 'klass', stage, FAILURE_CLASSES);
    if (klass !== null) report.klass = klass;
    const idem = optStr(body, 'idempotency_key', stage, MAX_ID);
    if (idem !== null) report.idempotency_key = idem;

    const failure = await intake(report, repo);
    const base = {
      case_id: failure.id,
      ack_by: failure.ack_by,
      resolve_by: failure.resolve_by,
      queue_position: failure.queue_position,
      status: failure.status,
      case: failure,
    };

    const runNow = boolOf(body, 'run_loop', stage, false);
    if (!runNow) return ok(base, 201);

    if (boolOf(body, 'background', stage, false)) {
      startBackgroundLoop(repo, failure.id, deps);
      return ok({ ...base, run: 'background', poll: `/v1/cases?id=${encodeURIComponent(failure.id)}` }, 202);
    }
    const result: LoopResult = await runLoop(repo, failure.id, deps);
    return ok({ ...base, status: result.status, run: 'inline', result }, 201);
  };

  /** GET /v1/cases?id=… (single case) or GET /v1/cases (filtered list). */
  const getCases: Handler = async (ctx: Ctx) => {
    const stage = 'desk.route.get_cases';
    const id = ctx.query.get('id');
    if (id !== null && id.length > 0) {
      const failure = await requireCase(repo, requireId(id, 'id', stage), stage);
      return ok(await caseView(repo, failure, stage), 200);
    }
    const limitRaw = ctx.query.get('limit') ?? '50';
    const limit = num({ limit: Number.parseInt(limitRaw, 10) }, 'limit', stage);
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const statusRaw = ctx.query.get('status');
    const status =
      statusRaw === null || statusRaw.length === 0 ? null : optOneOf({ status: statusRaw }, 'status', stage, CASE_STAGES);
    const vendorId = ctx.query.get('vendor_id');
    const filter: { status?: CaseStage; vendor_id?: string } = {};
    if (status !== null) filter.status = status;
    if (vendorId !== null && vendorId.length > 0 && vendorId.length <= MAX_ID) filter.vendor_id = vendorId;
    const all = await repo.listFailures(Object.keys(filter).length > 0 ? filter : undefined);
    return ok(
      {
        cases: all.slice(0, bounded),
        count: all.length,
        returned: Math.min(all.length, bounded),
        limit: bounded,
        open_count: all.filter((f) => !isTerminal(f.status)).length,
      },
      200,
    );
  };

  /** POST /v1/cases/run — advance a case through the state machine. */
  const postRun: Handler = async (ctx: Ctx) => {
    const stage = 'desk.route.run_case';
    const body = ctx.body;
    if (!asRecord(body)) throw badRequest(stage, 'body must be a JSON object');
    const id = requireId(str(body, 'id', stage), 'id', stage);
    const failure = await requireCase(repo, id, stage);
    if (boolOf(body, 'background', stage, false)) {
      startBackgroundLoop(repo, id, deps);
      return ok({ case_id: id, status: failure.status, run: 'background', poll: `/v1/cases?id=${encodeURIComponent(id)}` }, 202);
    }
    const result = await runLoop(repo, id, deps);
    return ok({ case_id: id, run: 'inline', result, case: await repo.getFailure(id) }, 200);
  };

  /** POST /v1/cases/retry — the agent reports whether its retry succeeded. This
   * is the second half of the one billable rule. */
  const postRetry: Handler = async (ctx: Ctx) => {
    const stage = 'desk.route.retry';
    const body = ctx.body;
    const rec = asRecord(body);
    if (!rec) throw badRequest(stage, 'body must be a JSON object');
    const id = requireId(str(body, 'id', stage), 'id', stage);
    if (typeof rec['ok'] !== 'boolean') throw badRequest(stage, 'field "ok" must be a boolean');
    const retryOk = rec['ok'];

    const failure = await requireCase(repo, id, stage);
    const existing = await repo.getOutcome(id);
    if (!existing) {
      throw new HttpError(409, 'no_outcome', `case ${id} has not been answered or shipped yet`, stage);
    }

    // Two writes on purpose: the retry flag lands first, so `isBillable` — which is
    // defined against the STORED row — reads the fact it is defined against.
    const createdAt = existing.created_at ?? new Date().toISOString();
    await repo.updateOutcome(existing.id, { agent_retry_ok: retryOk, billable: false, created_at: createdAt });
    const billable = await repo.isBillable(id);
    const settled: Outcome =
      (await repo.updateOutcome(existing.id, { billable })) ?? {
        ...existing,
        agent_retry_ok: retryOk,
        billable,
        created_at: createdAt,
      };

    // The desk's own read of the lane; billing/ is the authority and the notifier
    // returns the lane it actually used, which is what the response reports.
    const lane = settled.payer === 'agent' ? 'a2a_x402' : 'b2b_meter';
    let billingNotified: boolean | null = null;
    let billingError: string | null = null;
    let billingLane: string | null = null;
    // A priced-but-unpaid answer is withheld: the agent gets the 402 requirement and
    // its case id, and the tested answer is served once a settle call unlocks it.
    let unlock = true;
    let paymentRequired: unknown = null;
    if (billable) {
      await recordStage(repo, {
        ticketId: id,
        stage: 'billing',
        tool: 'stripe',
        action: 'billing.billable',
        payload: {
          outcome_id: settled.id,
          identifier: settled.id,
          lane,
          payer: settled.payer,
          note: 'all three proofs passed and the agent retry succeeded',
        },
      });

      // The notifier is injected, never imported: desk/ does not know about
      // billing/. Its failure is recorded and surfaced, not swallowed — and it does
      // not undo the retry, because the retry outcome is the fact billing needs.
      if (deps.onBillable) {
        const notice: BillableNotice = {
          outcome_id: settled.id,
          failure_id: id,
          lane,
          identifier: settled.id,
          payer: settled.payer,
        };
        try {
          const result = await deps.onBillable(notice, repo);
          billingNotified = true;
          if (result) {
            billingLane = result.lane;
            unlock = result.unlock !== false;
            paymentRequired = result.payment_required ?? null;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          billingNotified = false;
          billingError = message;
          await recordStage(repo, {
            ticketId: id,
            stage: 'billing',
            tool: 'stripe',
            action: 'billing.notify_failed',
            result: 'error',
            payload: { outcome_id: settled.id, lane, error: message },
          });
        }
      }
      // Off by default: billing/ owns the Stripe meter. Enabling it here is safe
      // because the Repository dedupes on `identifier`, so a replay cannot bill
      // twice even if both modules emit.
      if (envInt('AHD_DESK_METER', 0, 0, 1) === 1) {
        await repo.recordMeterEvent({
          id: `met_${settled.id}`,
          outcome_id: settled.id,
          event_name: 'ahd_billable_fix',
          identifier: settled.id,
          value: 1,
          mode: process.env['AHD_STRIPE_MODE'] === 'live' ? 'live' : 'test',
          at: new Date().toISOString(),
        });
      }
    } else {
      await recordStage(repo, {
        ticketId: id,
        stage: 'billing',
        tool: 'stripe',
        action: 'billing.not_billable',
        payload: {
          outcome_id: settled.id,
          agent_retry_ok: retryOk,
          reason: retryOk ? 'one or more proofs did not pass' : 'the agent retry did not succeed',
        },
      });
    }

    let status: CaseStage = failure.status;
    if (!retryOk) {
      // A failed retry re-opens the case even if an earlier optimistic report
      // closed it: the previous status is in the event so billing/ can cancel a
      // meter event inside its 24h window.
      if (status !== 'escalated') {
        const previous = status;
        status = 'escalated';
        await repo.setFailureStatus(id, status);
        await recordStage(repo, {
          ticketId: id,
          stage: 'escalated',
          tool: 'desk',
          action: 'case.retry_failed',
          result: 'error',
          payload: { previous_status: previous, billable, note: 'the agent retried and still failed; a human owns this case now' },
        });
      }
    } else if (status === 'answered' || status === 'shipped') {
      status = 'closed';
      await repo.setFailureStatus(id, status);
      await recordStage(repo, {
        ticketId: id,
        stage: 'closed',
        tool: 'desk',
        action: 'case.closed',
        payload: { billable },
      });
    }

    const kind = changeKindOf(failure.klass, failure.response);
    if (!unlock) {
      // The fix is proven and the retry succeeded, but the answer is priced and
      // unpaid: hand back the requirement, not the answer.
      await recordStage(repo, {
        ticketId: id,
        stage: 'billing',
        tool: 'stripe',
        action: 'billing.answer_withheld',
        result: 'pending',
        payload: { outcome_id: settled.id, lane: billingLane ?? lane, settle: 'POST /v1/a2a/settle or POST /v1/billing/mpp/settle' },
      });
    }
    const headers: Record<string, string> = {};
    if (!unlock && paymentRequired !== null && typeof paymentRequired === 'object') {
      const requirement = paymentRequired as Record<string, unknown>;
      const b64 = requirement['x_payment_required_b64'] ?? requirement['payment_requirement_b64'];
      if (typeof b64 === 'string' && b64.length > 0) headers['x-payment-required'] = b64;
    }
    return {
      status: unlock ? 200 : 402,
      headers,
      body: {
        case_id: id,
        status,
        agent_retry_ok: retryOk,
        billable,
        // null = no notifier wired; false = the notifier ran and failed (see the
        // `billing.notify_failed` ToolEvent).
        billing_notified: billingNotified,
        billing_error: billingError,
        billing_lane: billingLane ?? (billable ? lane : null),
        /** False means the answer is priced and unpaid: settle, then re-POST. */
        unlock,
        payment_required: paymentRequired,
        outcome: settled,
        case: await repo.getFailure(id),
        reply: unlock ? await replyFromStore(repo, failure, kind) : null,
      },
    };
  };

  /** POST /v1/cases/handoff — bring a human into the same thread with the full
   * transcript. */
  const postHandoff: Handler = async (ctx: Ctx) => {
    const stage = 'desk.route.handoff';
    const body = ctx.body;
    if (!asRecord(body)) throw badRequest(stage, 'body must be a JSON object');
    const id = requireId(str(body, 'id', stage), 'id', stage);
    const note = optStr(body, 'note', stage, 2000) ?? '';
    const to = optStr(body, 'to', stage, MAX_ID);
    const failure = await requireCase(repo, id, stage);
    const transcript = await repo.toolEvents({ ticket_id: id });

    let status: CaseStage = failure.status;
    if (!isTerminal(status) && status !== 'escalated') {
      status = 'escalated';
      await repo.setFailureStatus(id, status);
    }
    const handoffId = `hnd_${shortHash(`handoff:${id}:${to ?? ''}:${note}`, 16)}`;
    const at = new Date().toISOString();
    await recordStage(repo, {
      ticketId: id,
      stage: status,
      tool: 'inkbox',
      action: 'case.handoff',
      payload: { handoff_id: handoffId, to, note: clip(note, 2000), transcript_events: transcript.length, status },
    });
    return ok(
      {
        handoff_id: handoffId,
        case_id: id,
        receipt: `ahd_hnd_${shortHash(`handoff-receipt:${id}:${to ?? ''}`, 20)}`,
        at,
        status,
        to,
        transcript,
      },
      200,
    );
  };

  /** DELETE /v1/users/data — real erasure with a confirmation receipt. The receipt
   * is derived from the user id, so a replay returns the same receipt. The id itself
   * is never written to the audit trail: an erasure that recorded the id it erased
   * would have to scrub its own proof that it happened. */
  const deleteUserData: Handler = async (ctx: Ctx) => {
    const stage = 'desk.route.delete_user_data';
    // The id is accepted from the body or the query, so a console call and a curl
    // one-liner both work.
    const rec = asRecord(ctx.body);
    const fromBody = rec && typeof rec['id'] === 'string' ? rec['id'] : null;
    const raw = fromBody !== null && fromBody.length > 0 ? fromBody : ctx.query.get('id');
    const userId = requireId(raw, 'id', stage);

    // Ownership has to be resolved before the erasure, which blanks `agent_id`.
    const mine = (await repo.listFailures()).filter((f) => f.agent_id === userId);
    const erasure = await repo.eraseUserData(userId);
    const receipt = `ahd_del_${shortHash(`deletion:${userId}`, 20)}`;
    const at = new Date().toISOString();

    if (!erasure.already_erased) {
      for (const c of mine) {
        await recordStage(repo, {
          ticketId: c.id,
          stage: c.status,
          tool: 'privacy',
          action: 'user.data_erased',
          payload: { receipt, fields: erasure.fields },
        });
      }
      await recordStage(repo, {
        ticketId: `user:${receipt}`,
        stage: 'closed',
        tool: 'privacy',
        action: 'user.deletion_receipt_issued',
        payload: {
          receipt,
          cases_erased: erasure.cases,
          events_redacted: erasure.events,
          fields: erasure.fields,
        },
      });
    }
    return ok(
      {
        user_id: userId,
        receipt,
        at,
        result: erasure.already_erased ? 'already_erased' : 'data_erased',
        already_erased: erasure.already_erased,
        cases_erased: erasure.cases,
        events_redacted: erasure.events,
        fields: erasure.fields,
        // What deliberately survives, so the receipt is not read as "the case is gone".
        retained:
          'the case row, its audit trail, the billing record and the fix artefacts stay as the vendor compliance record, with every field the user supplied replaced by [erased]',
      },
      200,
    );
  };

  /** POST /v1/grants — issue (or replay) a bounded verb behind the envelope. */
  const postGrant: Handler = async (ctx: Ctx) => {
    const stage = 'desk.route.post_grant';
    const body = ctx.body;
    if (!asRecord(body)) throw badRequest(stage, 'body must be a JSON object');
    const failureId = requireId(str(body, 'failure_id', stage), 'failure_id', stage);
    const verb = str(body, 'verb', stage);
    const key = str(body, 'idempotency_key', stage);
    await requireCase(repo, failureId, stage);
    const issued = await issueGrant(repo, { failure_id: failureId, verb, idempotency_key: key, stage });
    return ok(
      {
        grant: issued.grant,
        receipt: issued.grant.receipt,
        replayed: issued.replayed,
        clamped: issued.clamped,
        spent_nothing_on_replay: issued.replayed,
        case_id: failureId,
      },
      issued.replayed ? 200 : 201,
    );
  };

  /** GET /v1/grants?idempotency_key=… — look a grant up without issuing one. */
  const getGrant: Handler = async (ctx: Ctx) => {
    const stage = 'desk.route.get_grant';
    const key = ctx.query.get('idempotency_key');
    if (key === null || key.length === 0) throw badRequest(stage, 'query "idempotency_key" is required');
    if (key.length > MAX_ID) throw badRequest(stage, `query "idempotency_key" must be at most ${MAX_ID} characters`);
    const grant = await lookupGrant(repo, key);
    if (!grant) throw new HttpError(404, 'grant_not_found', `no grant for idempotency_key ${key}`, stage);
    return ok({ grant, receipt: grant.receipt, replayed: true, spent: grant.spent }, 200);
  };

  return { postCase, getCases, postRun, postRetry, postHandoff, deleteUserData, postGrant, getGrant };
}

/** The approval row for a case.
 *
 * The gate writes `case.needs_user_input` carrying the exact `approval_id` it
 * used, so the case's own audit trail is the source of truth. Recomputing the id
 * is only the fallback (used when the events are unavailable), and it matches
 * approvals/approvals.ts — `apv_` + sha256("<failureId>\n<summary>")[0:24] — so
 * a case gated here and the same change sent through the real Inkbox sender
 * collapse onto one row.
 *
 * The draft summary depends on the attempt number (a retry widens the change),
 * which is encoded in the attempt id loop.ts writes: `att_<caseId>_<n>`. */
function approvalIdForCase(events: ToolEvent[], failure: Failure, attempt: Attempt | null): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.action !== 'case.needs_user_input') continue;
    const payload = asRecord(event.payload);
    const recorded = payload === null ? null : payload['approval_id'];
    if (typeof recorded === 'string' && recorded !== '') return recorded;
  }
  const tail = attempt === null ? '' : attempt.id.slice(attempt.id.lastIndexOf('_') + 1);
  const parsed = Number.parseInt(tail, 10);
  const attemptNumber = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  return approvalIdFor(failure.id, draftFix(failure, attemptNumber).summary);
}

/** The full stored picture of one case: what the console and the agent poll. */
export async function caseView(repo: Repository, failure: Failure, stage: string): Promise<CaseView> {
  const attempt = await repo.latestAttempt(failure.id);
  const outcome = await repo.getOutcome(failure.id);
  const billable = await repo.isBillable(failure.id);
  const events = await repo.toolEvents({ ticket_id: failure.id });
  const vendor = await repo.getVendor(failure.vendor_id);
  const grant = await repo.grantByIdempotencyKey(caseGrantKey(failure.id, grantVerb()));
  const approval = await repo.getApproval(approvalIdForCase(events, failure, attempt));
  const reply = await replyFromStore(repo, failure, changeKindOf(failure.klass, failure.response));
  return {
    case: failure,
    status: failure.status,
    vendor_id: failure.vendor_id,
    vendor,
    klass: failure.klass,
    ack_by: failure.ack_by,
    resolve_by: failure.resolve_by,
    queue_position: failure.queue_position,
    sla_breached: new Date().toISOString() > failure.resolve_by,
    billable,
    attempt,
    outcome,
    grant,
    approval,
    reply,
    events,
    stage,
  };
}

export function registerRoutes(router: Router, repo: Repository, deps: DeskDeps = {}): void {
  const h = makeHandlers(repo, deps);
  router.add('POST', '/v1/cases', h.postCase);
  // Exact-path router: one case is GET /v1/cases?id=…, the list is GET /v1/cases.
  router.add('GET', '/v1/cases', h.getCases);
  router.add('POST', '/v1/cases/run', h.postRun);
  router.add('POST', '/v1/cases/retry', h.postRetry);
  router.add('POST', '/v1/cases/handoff', h.postHandoff);
  router.add('DELETE', '/v1/users/data', h.deleteUserData);
  router.add('POST', '/v1/grants', h.postGrant);
  router.add('GET', '/v1/grants', h.getGrant);
}
