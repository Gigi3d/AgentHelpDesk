// demo-seed.ts — boot the desk with a realistic, fully-audited demo dataset.
//
// WHY THIS EXISTS
// `server.ts` boots an empty MemoryRepository, and there is no HTTP route that
// creates a `Vendor` row. So a fresh server has no vendor: desk/intake.ts falls
// back to a synthesized row with `stripe_customer_id: ''`, and
// billing/billable.ts `chooseLane()` reads an empty customer id as "no vendor
// relationship" and puts every verified answer behind the stranger-agent lane
// `a2a_x402` — a paid 402. That is correct behaviour, but a bad first-run demo of
// the B2B meter lane, and the operator console has nothing to show. This file
// seeds the one vendor row the fallback cannot invent, then creates real cases.
//
// NOTHING HERE IS HAND-WRITTEN STATE. Every case is opened by desk/intake.ts
// `intake()` (which validates, redacts credentials, commits ack_by/resolve_by and
// writes `case.acknowledged`), run by desk/loop.ts `runLoop()` against the fake
// sandbox and the fake proof runners, approved through approvals/approvals.ts
// `applyReply()` — the same function `POST /v1/approvals/reply` calls — and
// retried through the real desk/register.ts `postRetry` handler, which is what
// fires the injected billing notifier. Every ToolEvent, proof, attempt, outcome,
// grant, approval and meter row in the demo was therefore produced by the
// production loop. This file only supplies the reports and the approver's reply.
//
// HOW ONE SEED PRODUCES BOTH A PARKED AND A SHIPPED CASE (deterministic)
// The demo vendor's `risk_policy` is `approve_first`, so desk/gate.ts holds EVERY
// proven change for a one-reply human approval — that hold is the moment the demo
// is about. The four stories differ only in what happens next:
//
//   1 quickstart-auth  nobody replies                  -> awaiting_approval, genuinely
//                                                          pending. This is the live demo
//                                                          beat: POST /v1/approvals/reply
//                                                          then POST /v1/cases/run resumes it.
//   2 booking-422      the approver replies "yes"       -> shipped, then the agent reports a
//                                                          successful retry -> closed AND
//                                                          billable -> exactly one b2b_meter
//                                                          meter event (identifier = outcome id).
//   3 entitlement-403  the approver replies "yes"       -> shipped as a bounded grant with an
//                                                          authority envelope. No retry is
//                                                          reported, so it stays NOT billable:
//                                                          the meter only counts verified fixes
//                                                          the agent actually used.
//   4 webhook-500      run with reproExpect 'nonzero'   -> escalated (not_reproduced). The
//                                                          offline fake sandbox has no vendor
//                                                          checkout, so the generated repro
//                                                          harness exits 0 while the production
//                                                          expectation demands a failure. The
//                                                          desk refuses to guess and hands it to
//                                                          a human with the evidence.
//
// The "yes" in stories 2 and 3 is recorded through the real reply path and the loop
// is then RE-RUN, which is exactly how a parked case resumes in production: the gate
// re-proves the change before it ships. Nothing is random and nothing depends on
// wall-clock time or on a network, so two boots produce the same case ids, the same
// statuses and the same audit trail.
//
// IDEMPOTENT WITHIN A PROCESS. Case ids are derived from fixed idempotency keys, so every
// boot seeds the same four ids. `MemoryRepository` is in-memory, so a restart starts empty and
// the seed simply creates them again; calling `seedDemo` twice in one process (or running it
// against a persistent store) takes the replay path instead — `intake` records
// `case.duplicate_ignored` and `runLoop` answers from the store (`already_<status>`) rather than
// re-running anything. An existing vendor row is NEVER overwritten, so an operator's edits
// survive a re-seed.
//
// WHAT IS FAKE IN DEMO MODE, AND WHAT IS NOT. The Blaxel sandbox, the proof
// runners, the Stripe client and the Inkbox approval sender are their own modules'
// offline fakes (`AHD_SANDBOX_FAKE` / `AHD_PROOFS_FAKE` / `AHD_BILLING_FAKE` /
// `AHD_APPROVALS_FAKE`, applied below only when `AHD_SEED=demo`, and only where the
// operator has not set them — no credential is ever read or invented here). The
// loop, the state machine, the gate policy matrix, the proof ordering and
// short-circuit, the one billable rule, grant idempotency, credential redaction and
// the whole audit trail are the real ones.
//
// This file is orchestrator-level (like server.ts), so it may import modules
// directly; the modules themselves still never import each other.
import { HttpError } from './shared/http.ts';
import type { Ctx } from './shared/http.ts';
import type { Repository } from './store/repository.ts';
import type {
  CaseStage,
  FailureClass,
  Mode,
  Outcome,
  PayLane,
  ProblemReport,
  Vendor,
} from './shared/types.ts';
import { intake } from './desk/intake.ts';
import { runLoop } from './desk/loop.ts';
import type { LoopDeps, LoopResult, ReproExpectation } from './desk/loop.ts';
import { makeHandlers } from './desk/register.ts';
import type { DeskDeps, DeskHandlers } from './desk/register.ts';
import { changeKindOf } from './desk/gate.ts';
import type { ApprovalAsk, ApprovalDecision, ChangeKind } from './desk/gate.ts';
import { recordStage } from './desk/obs.ts';
import { getRunner } from './sandbox/runner.ts';
import { getProofRunner } from './proofs/proofs.ts';
import { applyReply } from './approvals/approvals.ts';
import { chooseLane } from './billing/billable.ts';

const STAGE_SEED = 'demo.seed';
const STAGE_VENDOR = 'demo.seed.vendor';

/** ToolEvent `stage` for seed-level rows. Case-level rows use the case's own status,
 * matching the convention every other desk/ writer uses. */
const STAGE_DEMO = 'demo';

/** RFC 6761 reserved documentation domains. The demo repo url must stay on one of
 * them so a seeded PR descriptor can never name a real repository. */
const RESERVED_HOSTS: readonly string[] = ['example', 'invalid', 'test', 'localhost'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s().-]{6,24}$/;

// ---------------------------------------------------------------------------
// Environment: the demo flag, and the offline fakes it implies
// ---------------------------------------------------------------------------

export const DEMO_SEED_ENV = 'AHD_SEED';

/** The one env var that turns the demo seed on. `AHD_SEED=demo`. */
export function demoSeedRequested(env: Record<string, string | undefined> = process.env): boolean {
  return (env[DEMO_SEED_ENV] ?? '').trim().toLowerCase() === 'demo';
}

/** Offline selectors for the four modules the demo touches. Every one of them also
 * falls back to its fake when the matching credential is absent, so this is
 * belt-and-braces: it guarantees a demo boot cannot emit a real Stripe meter event
 * or a real Inkbox text just because a credential happens to be in the environment.
 * An operator's explicit value always wins — this never overwrites a set variable. */
const DEMO_FAKE_ENV: readonly (readonly [string, string])[] = [
  ['AHD_SANDBOX_FAKE', '1'],
  ['AHD_PROOFS_FAKE', '1'],
  ['AHD_BILLING_FAKE', '1'],
  ['AHD_APPROVALS_FAKE', '1'],
];

export function applyDemoEnv(): void {
  for (const entry of DEMO_FAKE_ENV) {
    const current = process.env[entry[0]];
    if (current === undefined || current.trim() === '') process.env[entry[0]] = entry[1];
  }
}

/** Which offline fakes are actually active, for the audit trail. */
function activeFakes(): string[] {
  return DEMO_FAKE_ENV.filter((entry) => process.env[entry[0]] === '1').map((entry) => entry[0]);
}

// Applied at import time, guarded by the flag, and BEFORE server.ts builds its
// DeskDeps: `getRunner()` / `getProofRunner()` / `getBillingClient()` read the
// environment when they are called, so setting it here makes the seed and the live
// routes agree on the same offline fakes. A normal boot never touches the
// environment. (Same ordering rationale as desk/testenv.ts.)
if (demoSeedRequested()) applyDemoEnv();

// ---------------------------------------------------------------------------
// Operator configuration. No secrets: these are identities and behaviour switches,
// and every one of them defaults to something obviously fake.
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function badConfig(message: string, stage: string): HttpError {
  return new HttpError(500, 'bad_demo_config', message, stage);
}

function envText(name: string, fallback: string, max: number, stage: string): string {
  const raw = process.env[name];
  const value = raw === undefined ? '' : raw.trim();
  if (value === '') return fallback;
  if (value.length > max) throw badConfig(`${name} must be at most ${max} characters`, stage);
  return value;
}

export function demoVendorId(): string {
  return envText('AHD_DEMO_VENDOR_ID', 'ledgerly', 100, STAGE_VENDOR);
}

export function demoVendorName(): string {
  const id = demoVendorId();
  return envText('AHD_DEMO_VENDOR_NAME', id.charAt(0).toUpperCase() + id.slice(1), 120, STAGE_VENDOR);
}

export function demoRiskPolicy(): Mode {
  const raw = envText('AHD_DEMO_RISK_POLICY', 'approve_first', 20, STAGE_VENDOR).toLowerCase();
  if (raw === 'auto' || raw === 'approve_first' || raw === 'suggest_only' || raw === 'autonomous') return raw;
  throw badConfig(`AHD_DEMO_RISK_POLICY must be auto, approve_first, suggest_only or autonomous, got "${raw}"`, STAGE_VENDOR);
}

/** A clearly-fake Stripe customer id, so `chooseLane()` picks the B2B meter lane.
 * Set it to `none` to seed the stranger-agent story instead: an empty customer id
 * sends every billable answer to `a2a_x402` behind a 402. */
export function demoStripeCustomer(): string {
  const value = envText('AHD_DEMO_STRIPE_CUSTOMER', 'cus_demo_ledgerly', 100, STAGE_VENDOR);
  return value.toLowerCase() === 'none' ? '' : value;
}

/** The vendor's approver of record. Reserved documentation domain by default, so no
 * real person's address is ever written into a row, an audit event or a log line. */
export function demoApprover(): string {
  const value = envText('AHD_DEMO_APPROVER', 'approver@ledgerly.example', 200, STAGE_VENDOR);
  if (!EMAIL_RE.test(value) && !PHONE_RE.test(value)) {
    throw badConfig(`AHD_DEMO_APPROVER must be an email address or a phone number, got "${value}"`, STAGE_VENDOR);
  }
  return value;
}

export function demoRepoUrl(): string {
  const value = envText(
    'AHD_DEMO_REPO_URL',
    'https://git.ledgerly.example/ledgerly/ledgerly-api',
    500,
    STAGE_VENDOR,
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badConfig(`AHD_DEMO_REPO_URL is not a valid URL: "${value.slice(0, 120)}"`, STAGE_VENDOR);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badConfig(`AHD_DEMO_REPO_URL must be http(s), got "${url.protocol}"`, STAGE_VENDOR);
  }
  const host = url.hostname.toLowerCase();
  const reserved = RESERVED_HOSTS.some((tld) => host === tld || host.endsWith(`.${tld}`));
  if (!reserved) {
    throw badConfig(
      `AHD_DEMO_REPO_URL must stay on a reserved documentation domain (${RESERVED_HOSTS.join(', ')}) so the demo can never name a real repository, got "${host}"`,
      STAGE_VENDOR,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// The demo vendor row
// ---------------------------------------------------------------------------

/** Upsert that never clobbers: an existing row is an operator's (or a previous
 * seed's) and is returned untouched. Only a missing row is written. */
async function seedVendor(repo: Repository, id: string): Promise<{ vendor: Vendor; created: boolean }> {
  const existing = await repo.getVendor(id);
  if (existing) {
    await recordStage(repo, {
      ticketId: `demo:${id}`,
      stage: STAGE_DEMO,
      tool: 'desk',
      action: 'demo.vendor_reused',
      payload: {
        vendor_id: existing.id,
        risk_policy: existing.risk_policy,
        payer_mode: existing.payer_mode,
        stripe_customer_id: existing.stripe_customer_id,
        lane: chooseLane(existing),
        report_contacts: existing.report_contacts.length,
        note: 'a vendor row already existed; the seed never overwrites an operator edit',
      },
    });
    return { vendor: existing, created: false };
  }

  const vendor: Vendor = {
    id,
    name: demoVendorName(),
    repo_url: demoRepoUrl(),
    sandbox_name: `ahd-vendor-${id}`,
    // approve_first is the whole point of the demo: it is what makes the gate hold a
    // proven change for a human, which is the beat the console exists to show.
    risk_policy: demoRiskPolicy(),
    stripe_customer_id: demoStripeCustomer(),
    payer_mode: 'vendor',
    report_contacts: [demoApprover()],
  };
  await repo.putVendor(vendor);
  await recordStage(repo, {
    ticketId: `demo:${id}`,
    stage: STAGE_DEMO,
    tool: 'desk',
    action: 'demo.vendor_seeded',
    payload: {
      vendor_id: vendor.id,
      name: vendor.name,
      repo_url: vendor.repo_url,
      sandbox_name: vendor.sandbox_name,
      risk_policy: vendor.risk_policy,
      payer_mode: vendor.payer_mode,
      stripe_customer_id: vendor.stripe_customer_id,
      lane: chooseLane(vendor),
      report_contacts: vendor.report_contacts,
      note: 'demo data: reserved domain, fake Stripe customer id, no credentials',
    },
  });
  return { vendor, created: true };
}

// ---------------------------------------------------------------------------
// The four stories. Report text is original, modelled on the demo story in
// sandbox/README.md (a quickstart that shows the wrong auth header) and on the
// fixture variety in web/src/data/tickets.json. No real person's address and no
// credential: every key value is a `$PLACEHOLDER`, and desk/intake.ts redacts
// credential-shaped header values before they are stored anyway.
// ---------------------------------------------------------------------------

interface DemoStory {
  /** Stable idempotency key. desk/intake.ts derives the case id from it, so a
   * re-seed replays the same case instead of opening a second one. */
  key: string;
  /** One-line label for the log, the ToolEvent and the summary. */
  label: string;
  report: ProblemReport;
  /** What the demo's approver does when the gate holds the change. */
  approval: 'hold' | 'approve';
  /** Reproduction rule for this case. `any` is the offline default; `nonzero` is
   * the production rule (the repro test must FAIL because the failure is real). */
  reproExpect: ReproExpectation;
  /** Whether the agent reports a successful retry once the case has shipped. This
   * is the second half of the one billable rule. */
  reportRetry: boolean;
}

function demoStories(vendorId: string): DemoStory[] {
  const api = 'https://api.ledgerly.example';
  // Credential-shaped header values are placeholders; intake redacts them to
  // '[REDACTED]' on the way in, which is itself worth showing on the console.
  const auth = { authorization: 'Bearer $LEDGERLY_API_KEY' };

  return [
    {
      key: `demo-${vendorId}-quickstart-auth`,
      label: 'the quickstart shows x-api-key, the API wants Authorization: Bearer',
      // Nobody replies. With risk_policy approve_first this parks at
      // awaiting_approval and stays there: a genuinely pending human decision.
      approval: 'hold',
      reproExpect: 'any',
      reportRetry: false,
      report: {
        vendor_hint: vendorId,
        agent_id: 'agt_codex_onboarding',
        task: `Check that the ${demoVendorName()} API key works: list the last 10 journal entries exactly as the quickstart shows.`,
        request: {
          method: 'GET',
          url: `${api}/v1/entries?limit=10`,
          headers: { 'x-api-key': '$LEDGERLY_API_KEY', accept: 'application/json' },
        },
        response: {
          status: 401,
          error: 'unauthorized',
          detail: 'x-api-key is not a supported authentication scheme on this endpoint',
          request_id: 'req_demo_401_quickstart',
        },
        channel: 'mcp',
        idempotency_key: `demo-${vendorId}-quickstart-auth`,
      },
    },
    {
      key: `demo-${vendorId}-entry-422`,
      label: 'a 422 that never names the field it rejected',
      // The approver replies yes, the loop re-runs and ships the error-text change,
      // then the agent reports a successful retry: three proofs AND the retry, so
      // this is the case that puts a row on the B2B meter lane.
      approval: 'approve',
      reproExpect: 'any',
      reportRetry: true,
      report: {
        vendor_hint: vendorId,
        agent_id: 'agt_claude_code_bookkeeper',
        task: 'Post a journal entry for an imported bank transaction and confirm it landed in the ledger.',
        request: {
          method: 'POST',
          url: `${api}/v1/entries`,
          headers: { ...auth, 'content-type': 'application/json' },
          body: { account_id: 'acct_demo_01', posted_on: '17/10/2026', amount_minor: 4200, currency: 'usd' },
        },
        response: {
          status: 422,
          error: 'invalid request',
          field: 'posted_on',
          request_id: 'req_demo_422_entry',
        },
        channel: 'webhook',
        channel_ref: 'dlv_demo_422_entry',
        idempotency_key: `demo-${vendorId}-entry-422`,
      },
    },
    {
      key: `demo-${vendorId}-entitlement-403`,
      label: 'a valid one-per-person credit only the vendor can reissue',
      // Approved, and the fix is an authority failure's fix: a bounded verb behind
      // an envelope rather than a diff. No retry is reported, so it ships but does
      // not bill — the meter counts verified fixes the agent actually used.
      approval: 'approve',
      reproExpect: 'any',
      reportRetry: false,
      report: {
        vendor_hint: vendorId,
        agent_id: 'agt_concierge_checkout',
        task: "Apply the customer's one-per-person launch credit so the checkout that is blocked on it can finish.",
        request: {
          method: 'POST',
          url: `${api}/v1/entitlements/ent_demo_01/reissue`,
          headers: { ...auth, 'idempotency-key': 'chk_demo_17' },
          body: { order_id: 'ord_demo_17', amount_minor: 3000, currency: 'usd' },
        },
        response: {
          status: 403,
          error: 'forbidden',
          detail: 'missing scope entitlements.reissue; one reissue per person',
          request_id: 'req_demo_403_entitlement',
        },
        channel: 'email',
        channel_ref: 'thread_demo_403_entitlement',
        idempotency_key: `demo-${vendorId}-entitlement-403`,
      },
    },
    {
      key: `demo-${vendorId}-webhook-500`,
      label: 'an intermittent 500 the desk could not confirm',
      // Run under the PRODUCTION reproduction rule: the generated repro test must
      // fail, because the failure has to be real. The offline fake sandbox has no
      // vendor checkout, so the harness exits 0 and the desk honestly reports that
      // it could not reproduce the problem — it escalates instead of guessing.
      approval: 'hold',
      reproExpect: 'nonzero',
      reportRetry: false,
      report: {
        vendor_hint: vendorId,
        agent_id: 'agt_cursor_webhooks',
        task: 'Replay the webhook delivery that failed signature verification and confirm the handler accepts it.',
        request: {
          method: 'POST',
          url: `${api}/v1/webhooks/deliveries/dlv_demo_09/replay`,
          headers: { ...auth },
        },
        response: {
          status: 500,
          error: 'internal error',
          detail: 'the signature check timed out against the delivery store',
          request_id: 'req_demo_500_webhook',
        },
        channel: 'forwarded',
        channel_ref: 'thread_demo_500_webhook',
        idempotency_key: `demo-${vendorId}-webhook-500`,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Summary shapes
// ---------------------------------------------------------------------------

export interface SeededCase {
  case_id: string;
  status: CaseStage;
  klass: FailureClass;
  /** The kind of change desk/gate.ts derived, which is what the policy judges. */
  kind: ChangeKind;
  label: string;
  /** The loop's own reason string (`awaiting_human_reply`, `approved`,
   * `not_reproduced`, `already_shipped` on a re-seed, ...). */
  reason: string;
  billable: boolean;
  approval_id: string | null;
  approval_decision: 'yes' | 'no' | null;
  outcome_id: string | null;
  shipped_as: Outcome['shipped_as'] | null;
  meter_event_id: string | null;
  grant_receipt: string | null;
  /** HTTP status the retry report returned (200 unlocked, 402 priced-and-unpaid).
   * Null when the story never reached a retry. */
  retry_status: number | null;
  events: number;
  /** True when the case already existed: intake replayed instead of opening one. */
  replayed: boolean;
}

export interface SeedSummary {
  vendor_id: string;
  /** False when a vendor row already existed and was left untouched. */
  vendor_created: boolean;
  risk_policy: Mode;
  /** The lane billing/billable.ts will pick for this vendor. `b2b_meter` when the
   * demo Stripe customer id is present; `a2a_x402` when it is empty. */
  lane: PayLane;
  /** False when the orchestrator injected no `onBillable`: the desk still records
   * `billing.billable`, but no meter event is emitted. */
  billing_wired: boolean;
  cases: SeededCase[];
  meter_events: number;
  approvals_pending: number;
  /** Which offline fakes were active while the seed ran. */
  fakes: string[];
  started_at: string;
  finished_at: string;
}

export interface SeedDemoOptions {
  /** Vendor id to seed. Defaults to `AHD_DEMO_VENDOR_ID` (`ledgerly`). */
  vendorId?: string;
  /** The orchestrator's own desk deps. The seed reuses `askApproval` (so the ask
   * goes out on the real approvals/Inkbox channel) and `onBillable` (so the meter
   * event comes from the real billing module). It builds its OWN sandbox and proof
   * runners after `applyDemoEnv()`, because those two are selected from the
   * environment at call time. */
  deps?: DeskDeps;
  /** One call per seeded case. Defaults to stdout, in the startup line's style. */
  log?: (line: string) => void;
}

function stdoutLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Approval channel used only when the orchestrator injects none. `pending` is the
 * single honest answer with no channel wired: the gate holds the change and the
 * case parks, which is what the gate exists to do. */
async function holdForHuman(ask: ApprovalAsk): Promise<ApprovalDecision> {
  return {
    decision: 'pending',
    approver: ask.approvers.find((a) => a.trim().length > 0)?.trim() ?? '',
    detail: 'demo seed: no approval channel was injected, so the change is held for a human',
  };
}

/** A Ctx for the real desk handlers. The seed drives the same functions the HTTP
 * routes drive, so nothing about the demo bypasses boundary validation. */
function demoCtx(path: string, body: unknown, requestId: string): Ctx {
  return {
    method: 'POST',
    path,
    query: new URLSearchParams(),
    body,
    headers: {},
    requestId,
    caller: null,
  };
}

async function seedCase(
  repo: Repository,
  story: DemoStory,
  vendor: Vendor,
  approver: string,
  loopDeps: LoopDeps,
  handlers: DeskHandlers,
): Promise<SeededCase> {
  // ---- 1. open the case through the real intake (validate, redact, commit times)
  const failure = await intake(story.report, repo);

  // ---- 2. run the real loop: reproduce, draft, prove three ways, gate
  let result: LoopResult = await runLoop(repo, failure.id, loopDeps);

  // ---- 3. the human beat. A held change resumes exactly as it does in production:
  // the decision lands on the approval row, then the loop RE-RUNS and re-proves
  // before anything ships. `applyReply` is what POST /v1/approvals/reply calls.
  const heldApprovalId = result.gate ? result.gate.approval_id : null;
  if (story.approval === 'approve' && result.status === 'awaiting_approval' && heldApprovalId) {
    await applyReply(heldApprovalId, 'yes', approver, repo);
    result = await runLoop(repo, failure.id, loopDeps);
  }

  // ---- 4. the agent's retry report, through the real route handler. This is the
  // second half of the billable rule and the only thing that fires the billing
  // notifier, so the meter row is billing/'s, not ours.
  let retryStatus: number | null = null;
  if (story.reportRetry && (result.status === 'shipped' || result.status === 'answered')) {
    const res = await handlers.postRetry(demoCtx('/v1/cases/retry', { id: failure.id, ok: true }, `demo-${failure.id}`));
    retryStatus = res.status;
  }

  // ---- 5. read back what the store actually holds, and record that we seeded it
  const stored = await repo.getFailure(failure.id);
  const outcome = await repo.getOutcome(failure.id);
  const meter = outcome ? await repo.meterEventByIdentifier(outcome.id) : null;
  const events = await repo.toolEvents({ ticket_id: failure.id });
  const approvalId = result.gate ? result.gate.approval_id : heldApprovalId;
  const approval = approvalId ? await repo.getApproval(approvalId) : null;
  const status: CaseStage = stored ? stored.status : result.status;

  const row: SeededCase = {
    case_id: failure.id,
    status,
    klass: failure.klass,
    kind: changeKindOf(failure.klass, failure.response),
    label: story.label,
    reason: result.reason,
    billable: outcome ? outcome.billable : false,
    approval_id: approvalId,
    approval_decision: approval ? approval.decision : null,
    outcome_id: outcome ? outcome.id : null,
    shipped_as: outcome ? outcome.shipped_as : null,
    meter_event_id: meter ? meter.id : null,
    grant_receipt: result.grant ? result.grant.receipt : null,
    retry_status: retryStatus,
    events: events.length,
    replayed: events.some((e) => e.action === 'case.duplicate_ignored'),
  };

  await recordStage(repo, {
    ticketId: row.case_id,
    stage: row.status,
    tool: 'desk',
    action: 'demo.case_seeded',
    payload: {
      vendor_id: vendor.id,
      label: row.label,
      klass: row.klass,
      change_kind: row.kind,
      status: row.status,
      reason: row.reason,
      approval: story.approval,
      approval_id: row.approval_id,
      approval_decision: row.approval_decision,
      billable: row.billable,
      shipped_as: row.shipped_as,
      meter_event_id: row.meter_event_id,
      grant_receipt: row.grant_receipt,
      retry_status: row.retry_status,
      replayed: row.replayed,
      repro_expect: story.reproExpect,
      fakes: activeFakes(),
      note: 'demo data: every row above was produced by the real intake/loop/gate/billing code',
    },
  });

  return row;
}

/** One line per case, in the startup line's style. */
function caseLine(row: SeededCase, vendorId: string, lane: PayLane): string {
  const note = row.billable
    ? `billable on ${lane}${row.meter_event_id ? `, meter ${row.meter_event_id}` : ''}`
    : row.status === 'awaiting_approval'
      ? 'held for a human reply'
      : row.status === 'escalated'
        ? `escalated: ${row.reason}`
        : 'not billable yet (the agent has not reported a successful retry)';
  const replayed = row.replayed ? ' [replayed]' : '';
  return `agenthelpdesk demo seed: case ${row.case_id} ${row.status} (${vendorId}, ${row.kind})${replayed} - ${row.label}; ${note}`;
}

/** Seed the demo vendor and the demo cases. Idempotent: a second call replays.
 * Fails loud with an `HttpError` naming its stage — a half-seeded demo is worse
 * than no demo, so this is allowed to stop the boot. */
export async function seedDemo(repo: Repository, opts: SeedDemoOptions = {}): Promise<SeedSummary> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  // Must run before getRunner()/getProofRunner() are called below.
  applyDemoEnv();
  const log = opts.log ?? stdoutLine;

  try {
    const vendorId = opts.vendorId ?? demoVendorId();
    if (vendorId === '') throw badConfig('the demo vendor id must not be empty', STAGE_VENDOR);
    const seededVendor = await seedVendor(repo, vendorId);
    const vendor = seededVendor.vendor;
    const lane = chooseLane(vendor);
    const approver = vendor.report_contacts.find((c) => c.trim().length > 0)?.trim() ?? demoApprover();

    // The seed's own runners, selected AFTER the demo fakes are applied, and
    // observed (both take the repo) so the sandbox and proof ToolEvents are real.
    const deps: DeskDeps = {
      runner: getRunner(repo),
      proofs: getProofRunner(repo),
      askApproval: opts.deps?.askApproval ?? holdForHuman,
      onBillable: opts.deps?.onBillable,
    };
    const handlers = makeHandlers(repo, deps);
    const loopDeps: LoopDeps = {
      runner: deps.runner,
      proofs: deps.proofs,
      askApproval: deps.askApproval,
    };

    const cases: SeededCase[] = [];
    for (const story of demoStories(vendor.id)) {
      const row = await seedCase(repo, story, vendor, approver, { ...loopDeps, reproExpect: story.reproExpect }, handlers);
      cases.push(row);
      log(caseLine(row, vendor.id, lane));
    }

    const meterEvents = await repo.listMeterEvents({ vendor_id: vendor.id });
    const pending = await repo.listApprovals({ decided: false });
    const summary: SeedSummary = {
      vendor_id: vendor.id,
      vendor_created: seededVendor.created,
      risk_policy: vendor.risk_policy,
      lane,
      billing_wired: opts.deps?.onBillable !== undefined,
      cases,
      meter_events: meterEvents.length,
      approvals_pending: pending.length,
      fakes: activeFakes(),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };

    await recordStage(repo, {
      ticketId: `demo:${vendor.id}`,
      stage: STAGE_DEMO,
      tool: 'desk',
      action: 'demo.seed_completed',
      startedAtMs,
      payload: {
        vendor_id: summary.vendor_id,
        vendor_created: summary.vendor_created,
        risk_policy: summary.risk_policy,
        lane: summary.lane,
        billing_wired: summary.billing_wired,
        cases: summary.cases.map((c) => ({ case_id: c.case_id, status: c.status, billable: c.billable })),
        meter_events: summary.meter_events,
        approvals_pending: summary.approvals_pending,
        fakes: summary.fakes,
      },
    });

    return summary;
  } catch (err) {
    // Fail loud and name the stage. HttpError from a module below passes through
    // untouched so the original stage survives.
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, 'demo_seed_failed', `demo seed failed: ${errMessage(err)}`, STAGE_SEED);
  }
}
