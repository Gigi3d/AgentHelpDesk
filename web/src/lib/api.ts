/**
 * The console's only window onto the desk API (`product/server.ts`: node:http on
 * 127.0.0.1:8787). There is no push channel, so the store polls these fetchers.
 *
 * Two rules shape this file:
 *  1. Every console field is derived from a stored row or a recorded ToolEvent.
 *     Where the backend keeps no equivalent the field stays absent or empty —
 *     a number it did not produce is never estimated here.
 *  2. The browser cannot import `product/`, so the handful of pure derivations
 *     the mapping needs (status/url/method probing, the change kind, the gate's
 *     "does a human have to see this" rule, the price key) are mirrored below and
 *     named after the module they mirror. They read only stored case data, so
 *     they cannot drift from an inbound payload.
 */
import type { FailureClass, Grant, HttpExchange, Mode, Proof, ProofStatus, Stage, Ticket, ToolEvent } from './types';

export const API_BASE = (((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8787')).replace(/\/+$/, '');

/* ---------------- desk key ---------------- */
const TOKEN_KEY = 'ahd_desk_token';
export const getToken = (): string => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
};
export const setToken = (t: string): void => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage can be blocked; the gate then asks again on every load */
  }
};

/* ---------------- backend shapes (product/shared/types.ts, product/desk/register.ts) ---------------- */

export type CaseStage =
  | 'opened'
  | 'reproducing'
  | 'fix_drafted'
  | 'proving'
  | 'awaiting_approval'
  | 'answered'
  | 'shipped'
  | 'closed'
  | 'escalated';

/** Declared as a type alias, not an interface, so it stays assignable to the
 * console's `reply?: Record<string, unknown>` (interfaces get no implicit index
 * signature). */
export type Vendor = {
  id: string;
  name: string;
  repo_url: string;
  sandbox_name: string;
  risk_policy: Mode;
  stripe_customer_id: string;
  payer_mode: 'vendor' | 'agent';
  report_contacts: string[];
  test_command?: string;
  agent_pay_rail?: 'mpp' | 'x402';
  billing_exempt?: boolean;
};

export type Failure = {
  id: string;
  vendor_id: string;
  agent_id: string;
  task: string;
  request: unknown;
  response: unknown;
  klass: FailureClass;
  status: CaseStage;
  ack_by: string;
  resolve_by: string;
  queue_position: number;
  created_at: string;
  channel_ref?: string | null;
};

export type Attempt = {
  id: string;
  failure_id: string;
  diff: string;
  proof_replay: boolean;
  proof_vendor_tests: boolean;
  proof_fresh_agent: boolean;
  log_url: string;
};

export type Outcome = {
  id: string;
  failure_id: string;
  shipped_as: 'answer' | 'pr' | 'grant' | 'regression';
  approved_by: string | null;
  agent_retry_ok: boolean;
  billable: boolean;
  payer: 'vendor' | 'agent' | null;
  stripe_event_id: string | null;
  mpp_payment_id: string | null;
  x402_payment_id: string | null;
  created_at?: string;
};

export type VendorGrant = {
  id: string;
  failure_id: string;
  verb: string;
  envelope: { verbs: string[]; cap_usd: number; per_user: number };
  idempotency_key: string;
  receipt: string;
  spent: boolean;
  created_at: string;
};

export type ApprovalRequest = {
  id: string;
  failure_id: string;
  change_summary: string;
  channel: 'text' | 'email';
  sent_at: string;
  replied_at: string | null;
  decision: 'yes' | 'no' | null;
  approver: string;
};

export type AgentReply = {
  type: string;
  title: string;
  status: number;
  retryable: boolean;
  fix_steps: string[];
  snippet: string;
  tested: { replay: boolean; vendor_tests: boolean; fresh_agent: boolean };
  regression_test_id: string;
  case_id: string;
  ack_by: string;
  resolve_by: string;
  queue_position: number;
  outcome?: unknown;
  authority?: { verbs: string[]; cap_usd: number; per_user: number };
  events: string[];
  audit_receipt: string;
};

/** The backend's ToolEvent: `t_ms` is the ABSOLUTE epoch ms the stage started,
 * `stage` is a free-form string (`billing.decide`, `proofs.replay`, `escalated`)
 * and `payload` is whatever the recording module put there. */
export type BackendToolEvent = {
  id: string;
  ticket_id: string;
  stage: string;
  tool: string;
  action: string;
  t_ms: number;
  d_ms: number;
  result: string;
  payload: unknown;
  at: string;
};

export type CaseView = {
  case: Failure;
  status: CaseStage;
  vendor_id: string;
  vendor: Vendor | null;
  klass: FailureClass;
  ack_by: string;
  resolve_by: string;
  queue_position: number;
  sla_breached: boolean;
  billable: boolean;
  attempt: Attempt | null;
  outcome: Outcome | null;
  grant: VendorGrant | null;
  approval: ApprovalRequest | null;
  reply: AgentReply | null;
  events: BackendToolEvent[];
  stage: string;
};

export type CaseList = { cases: Failure[]; count: number; returned: number; limit: number; open_count: number };

export type RunResult = {
  case_id: string;
  status?: CaseStage;
  run: 'inline' | 'background';
  poll?: string;
  result?: { status: CaseStage; reason: string };
  case?: Failure | null;
};

export type HandoffResult = {
  handoff_id: string;
  case_id: string;
  receipt: string;
  at: string;
  status: CaseStage;
  to?: string;
  transcript: BackendToolEvent[];
};

export type PriceKey = 'docs_error_text' | 'code_config_grant' | 'migration_pr' | 'platform_monthly';

export type PriceBook = {
  prices: Record<PriceKey, number>;
  lane_prices: { a2a_x402_usd: number; b2b_mpp_usd: number };
};

/* ---------------- transport ---------------- */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly stage: string;
  readonly requestId: string | null;
  readonly paymentRequired: string | null;
  constructor(status: number, code: string, message: string, stage: string, requestId: string | null, paymentRequired: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.stage = stage;
    this.requestId = requestId;
    this.paymentRequired = paymentRequired;
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const strOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `status` 0 means the fetch itself failed (server down, CORS, offline). */
async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(0, 'unreachable', err instanceof Error ? err.message : String(err), 'http', null, null);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const envelope = asRecord(asRecord(parsed)?.['error']);
    const needsKey = res.status === 401 && method !== 'GET';
    throw new ApiError(
      res.status,
      strOf(envelope?.['code']) ?? `http_${res.status}`,
      needsKey ? 'That action is admin only. Use Run the full demo, or unlock with the desk key at /unlock.' : strOf(envelope?.['message']) ?? (res.statusText || `HTTP ${res.status}`),
      strOf(envelope?.['stage']) ?? 'http',
      strOf(envelope?.['request_id']),
      res.headers.get('x-payment-required'),
    );
  }
  return parsed as T;
}

export const health = () => request<{ ok: boolean; request_id: string }>('GET', '/healthz');

export const listCases = (limit = 200) => request<CaseList>('GET', `/v1/cases?limit=${encodeURIComponent(String(limit))}`);

export const getCase = (id: string) => request<CaseView>('GET', `/v1/cases?id=${encodeURIComponent(id)}`);

/** Mirrors product/shared/types.ts ProblemReport, minus the fields intake derives itself. */
export type ProblemReport = {
  agent_id: string;
  task: string;
  request: unknown;
  response: unknown;
  channel: 'mcp' | 'email' | 'webhook' | 'forwarded';
  vendor_hint?: string;
  /** Intake derives the case id from this, so a repeat call replays the same case instead of
   * opening a second one. */
  idempotency_key?: string;
};

/** The 201 body from POST /v1/cases: the committed times the agent gets back right away. */
export type IntakeReceipt = {
  case_id: string;
  ack_by: string;
  resolve_by: string;
  queue_position: number;
  status: CaseStage;
  case: Failure;
};

/** Intake only — no `run_loop`. Reproducing and proving can take minutes, and an agent's first
 * call is owed the case id and the deadlines, not a blocking wait. */
export const reportProblem = (report: ProblemReport) => request<IntakeReceipt>('POST', '/v1/cases', report);

/** Background, never inline: one loop run may take minutes and a blocking fetch
 * would hang the console. The next poll reads the result from the case view. */
export const runCase = (id: string) => request<RunResult>('POST', '/v1/cases/run', { id, background: true });

export const replyApproval = (id: string, decision: 'yes' | 'no', approver: string) =>
  request<{ approval: ApprovalRequest; replayed: boolean }>('POST', '/v1/approvals/reply', { id, decision, approver });

export const handoffCase = (id: string, note: string) => request<HandoffResult>('POST', '/v1/cases/handoff', { id, note });

/** What the desk counted. Both report kinds return exactly these keys. */
export type ReportNumbers = {
  cases_opened: number;
  cases_fixed: number;
  cases_escalated: number;
  awaiting_approval: number;
  agent_retries_ok: number;
  fixes_merged: number;
  regression_tests_added: number;
  grants_issued: number;
  billable_cases: number;
  expected_bill_usd: number;
  top_failures: { signature: string; count: number; example_failure_id: string }[];
  waiting_on_vendor: string[];
};

export type DeskReport = {
  kind: 'daily' | 'weekly';
  vendor_id: string;
  vendor_name: string;
  generated_at: string;
  window_start: string;
  window_end: string;
  numbers: ReportNumbers;
  /** The report's own sentences, each one a concatenation of the numbers above. */
  lines: string[];
  text: string;
  /** The definitions the desk states for its own counts. Rendering these is the point:
   * a number without its rule is just an assertion. */
  assumptions: string[];
};

/** The report the desk wrote itself. approvals/reports.ts aggregates the case store and
 * concatenates the sentences, so nothing in it was composed by a model. */
export const getReport = (kind: 'daily' | 'weekly', vendorId: string) =>
  request<{ report: DeskReport }>('GET', `/v1/reports/${kind}?vendor_id=${encodeURIComponent(vendorId)}`).then((r) => r.report);

export type SendReceipt = { message_id: string; channel: 'text' | 'email'; to: string; fake: boolean };

/** Hand the report to the desk to deliver. It masks every recipient before returning one —
 * `to` is `****1234`, never the address or number — and `fake` says whether delivery went
 * through the offline client, which is what a desk without Inkbox credentials uses. */
export const sendReportNow = (kind: 'daily' | 'weekly', vendorId: string) =>
  request<{ report: DeskReport; delivered: SendReceipt[] }>('POST', '/v1/reports/send-now', { vendor_id: vendorId, kind });

/**
 * The price book, from the read-only route that publishes it. It is configuration,
 * not per-vendor data, so one request per page load is enough — and unlike
 * invoice-preview it writes nothing to any audit trail. The failure is cached too,
 * so a desk without the route cannot make the poll loop retry it every tick.
 */
let priceBookPromise: Promise<PriceBook | null> | null = null;

export function priceBookOnce(): Promise<PriceBook | null> {
  if (!priceBookPromise) {
    priceBookPromise = request<{ prices?: Partial<Record<PriceKey, number>>; lane_prices?: Partial<PriceBook['lane_prices']> }>(
      'GET',
      '/v1/billing/prices',
    )
      .then((r) => ({
        prices: {
          docs_error_text: r.prices?.docs_error_text ?? 0,
          code_config_grant: r.prices?.code_config_grant ?? 0,
          migration_pr: r.prices?.migration_pr ?? 0,
          platform_monthly: r.prices?.platform_monthly ?? 0,
        },
        lane_prices: {
          a2a_x402_usd: r.lane_prices?.a2a_x402_usd ?? 0,
          b2b_mpp_usd: r.lane_prices?.b2b_mpp_usd ?? 0,
        },
      }))
      .catch(() => null);
  }
  return priceBookPromise;
}

/* ---------------- mirrored derivations ---------------- */

/** Mirrors product/desk/inspect.ts statusOf. */
export function statusOf(response: unknown): number | null {
  const rec = asRecord(response);
  if (!rec) return null;
  for (const key of ['status', 'status_code', 'statusCode', 'http_status', 'code']) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  }
  return null;
}

/** Mirrors product/desk/inspect.ts urlOf, minus the credential strip (intake already redacted). */
export function urlOf(request: unknown): string | null {
  const rec = asRecord(request);
  if (!rec) return null;
  for (const key of ['url', 'uri', 'href', 'endpoint', 'path']) {
    const v = rec[key];
    if (typeof v !== 'string' || v.length === 0 || v.length > 2000) continue;
    if (/^https?:\/\//i.test(v) || v.startsWith('/')) return v;
  }
  return null;
}

/** Mirrors product/desk/inspect.ts methodOf, including its GET default. */
export function methodOf(request: unknown): string {
  const v = asRecord(request)?.['method'];
  if (typeof v === 'string') {
    const up = v.toUpperCase();
    if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(up)) return up;
  }
  return 'GET';
}

/** Mirrors product/desk/gate.ts changeKindOf. */
export function changeKindOf(klass: FailureClass, response: unknown): string {
  if (klass === 'authority') return 'grant';
  const status = statusOf(response);
  if (klass === 'code') return status === 422 || status === 400 ? 'error_text' : 'code';
  return 'docs';
}

/** Mirrors product/billing/prices.ts priceKeyForClass. */
function priceKeyForClass(klass: FailureClass): PriceKey {
  if (klass === 'code') return 'code_config_grant';
  if (klass === 'authority') return 'migration_pr';
  return 'docs_error_text';
}

/** Mirrors product/billing/billable.ts chooseLane. */
function chooseLane(vendor: Vendor | null): 'b2b_meter' | 'a2a_x402' | 'b2b_mpp' {
  if (!vendor || vendor.stripe_customer_id.trim() === '') return 'a2a_x402';
  if (vendor.payer_mode === 'vendor') return 'b2b_meter';
  return vendor.agent_pay_rail === 'x402' ? 'a2a_x402' : 'b2b_mpp';
}

/* ---------------- event mapping ---------------- */

/** A console event: the backend's row verbatim, with `t_ms` made relative and
 * `at` made epoch ms. Fixture events carry `t_ms` relative to `created_at`
 * (Home's median and the timeline read it as a duration), the backend's is the
 * absolute epoch ms the stage started. */
export type MappedEvent = ToolEvent & { at: number };

const STAGES = ['opened', 'reproducing', 'fix_drafted', 'proving', 'awaiting_approval', 'answered', 'shipped', 'closed', 'escalated'];

function eventStage(stage: string): ToolEvent['stage'] {
  // The console's own name for "the desk handed this to a human" is failed_proof,
  // and its timeline files that state under the Proving column.
  return (stage === 'escalated' ? 'failed_proof' : stage) as ToolEvent['stage'];
}

export function toEvents(view: CaseView): MappedEvent[] {
  const created = Date.parse(view.case.created_at);
  const base = Number.isFinite(created) ? created : 0;
  return [...view.events].sort((a, b) => a.t_ms - b.t_ms).map((e) => {
    const at = Date.parse(e.at);
    return {
      id: e.id,
      ticket_id: e.ticket_id,
      stage: eventStage(e.stage),
      tool: e.tool,
      action: e.action,
      t_ms: Math.max(0, e.t_ms - base),
      d_ms: Math.max(0, e.d_ms),
      result: e.result,
      payload: asRecord(e.payload) ?? {},
      at: Number.isFinite(at) ? at : Math.max(0, e.t_ms),
    };
  });
}

/* ---------------- ticket mapping ---------------- */

/** The part of a CaseView the mapping reads, so a list-only case (no view
 * fetched yet) can be mapped through the same code path. */
type CaseParts = Pick<CaseView, 'case' | 'status' | 'vendor' | 'billable' | 'attempt' | 'outcome' | 'grant' | 'approval' | 'reply' | 'events'>;

export type TicketContext = {
  /** Distinct agents that reported a failure on this same endpoint. */
  affectedAgents: number;
  /** USD, from the backend's own price book or a recorded settlement. 0 when it supplied none. */
  priceUsd: number;
};

const PROOF_ORDER = ['replay', 'vendor_tests', 'fresh_agent'] as const;
type ProofName = (typeof PROOF_ORDER)[number];
const ATTEMPT_KEY: Record<ProofName, 'proof_replay' | 'proof_vendor_tests' | 'proof_fresh_agent'> = {
  replay: 'proof_replay',
  vendor_tests: 'proof_vendor_tests',
  fresh_agent: 'proof_fresh_agent',
};

const byTime = (events: BackendToolEvent[]) => [...events].sort((a, b) => a.t_ms - b.t_ms);

function lastAction(events: BackendToolEvent[], action: string, tool?: string): BackendToolEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e && e.action === action && (tool === undefined || e.tool === tool)) return e;
  }
  return null;
}

function toStage(status: CaseStage): Stage {
  switch (status) {
    case 'opened':
    case 'reproducing':
    case 'fix_drafted':
    case 'proving':
    case 'awaiting_approval':
    case 'answered':
    case 'shipped':
    case 'closed':
      return status;
    case 'escalated':
      // Kept as its own stage rather than folded into failed_proof: the desk escalates for
      // reasons that are not a failed proof (the seeded webhook case escalated on
      // `not_reproduced`, with no proof ever attempted), and "Proof failed" would state a
      // reason the desk never gave. Both mean "nothing shipped, nothing billed, a human owns
      // it", so every predicate that reads one reads the other.
      return 'escalated';
    default:
      return 'escalated';
  }
}

/** Absolute URL -> pathname, mirroring approvals/reports.ts normalizePath, so the console
 * groups an endpoint the way the desk's own report does and the label matches the route
 * table read from the OpenAPI spec instead of carrying a host and a query string. */
function normalizePath(raw: string): string {
  if (!/^https?:\/\//i.test(raw)) return raw.split('?')[0];
  try {
    return new URL(raw).pathname;
  } catch {
    // A stored request may hold a malformed URL. Dropping the query is still better than
    // failing the whole case view over one bad string.
    return raw.split('?')[0];
  }
}

export function endpointOf(request: unknown): string {
  const url = urlOf(request);
  return url === null ? '' : `${methodOf(request)} ${normalizePath(url)}`;
}

function exchange(payload: unknown, kind: 'req' | 'res'): HttpExchange {
  const rec = asRecord(payload);
  const headers: Record<string, string> = {};
  const raw = rec ? asRecord(rec['headers']) : null;
  if (raw) {
    for (const key of Object.keys(raw)) {
      const value = raw[key];
      headers[key] = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
    }
  }
  const x: HttpExchange = { headers, body: rec && 'body' in rec ? rec['body'] : payload };
  if (kind === 'req') {
    x.method = methodOf(payload);
    const url = urlOf(payload);
    if (url !== null) x.url = url;
  } else {
    const status = statusOf(payload);
    if (status !== null) x.status = status;
  }
  return x;
}

function changeTypeOf(v: CaseParts): Ticket['change_type'] {
  const recorded = strOf(asRecord(lastAction(v.events, 'case.fix_drafted')?.payload)?.['kind']);
  const kind = recorded ?? changeKindOf(v.case.klass, v.case.response);
  switch (kind) {
    case 'docs':
    case 'error_text':
    case 'code':
    case 'config':
    case 'grant':
      return kind;
    case 'schema':
      return 'code';
    default:
      return 'docs';
  }
}

function modeOf(v: CaseParts): Mode {
  if (v.vendor) return v.vendor.risk_policy;
  for (const e of v.events) {
    const raw = asRecord(e.payload)?.['risk_policy'];
    if (raw === 'auto' || raw === 'approve_first' || raw === 'suggest_only' || raw === 'autonomous') return raw;
  }
  // intake's fallback vendor runs on AHD_DEFAULT_RISK_POLICY, which defaults to auto.
  return 'auto';
}

/** Mirrors gate.gateWouldNeedApproval: low risk is exactly what the desk would
 * ship without a human, so the console's bulk-approve gate matches the backend's. */
function riskOf(mode: Mode, kind: Ticket['change_type']): Ticket['risk'] {
  const needsHuman = mode === 'approve_first' ? true : mode === 'suggest_only' || mode === 'autonomous' ? false : !(kind === 'docs' || kind === 'error_text');
  if (!needsHuman) return 'low';
  return kind === 'grant' ? 'high' : 'medium';
}

function proofStatusOf(result: string): ProofStatus {
  switch (result) {
    case 'ok':
    case 'pass':
    case 'replayed':
      return 'passed';
    case 'error':
    case 'fail':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'pending':
      return 'running';
    default:
      return 'pending';
  }
}

/** The loop records `proof.<name>` (and `skipped` when an earlier proof failed);
 * proofs/ records its own `<name>` row with the real duration. The loop's row is
 * the verdict, the attempt row is the fallback, and `running` is inferred only
 * while the case is in `proving` and every earlier proof already passed. */
function proofsOf(v: CaseParts, events: BackendToolEvent[]): Ticket['proofs'] {
  const out = {} as Ticket['proofs'];
  let earlierPassed = true;
  for (const name of PROOF_ORDER) {
    const event = lastAction(events, `proof.${name}`) ?? lastAction(events, name, 'proofs');
    let proof: Proof;
    if (event) {
      const payload = asRecord(event.payload);
      proof = {
        status: proofStatusOf(event.result),
        duration_ms: Math.max(0, event.d_ms),
        detail: strOf(payload?.['detail']) ?? strOf(payload?.['error']) ?? '',
      };
    } else if (v.attempt) {
      proof = { status: v.attempt[ATTEMPT_KEY[name]] ? 'passed' : 'failed', duration_ms: 0, detail: '' };
    } else if (v.reply) {
      proof = { status: v.reply.tested[name] ? 'passed' : 'failed', duration_ms: 0, detail: '' };
    } else if (v.status === 'proving' && earlierPassed) {
      proof = { status: 'running', duration_ms: 0, detail: '' };
    } else {
      proof = { status: 'pending', duration_ms: 0, detail: '' };
    }
    out[name] = proof;
    if (proof.status !== 'passed') earlierPassed = false;
  }
  return out;
}

function grantsOf(grant: VendorGrant | null): Grant[] {
  if (!grant) return [];
  return [
    {
      id: grant.id,
      verb: grant.verb,
      status: 'issued',
      cap_usd: numOf(grant.envelope?.cap_usd) ?? 0,
      per_user: numOf(grant.envelope?.per_user) ?? 0,
      // The store keeps `spent: boolean` with no amount, so there is no spent
      // figure to show and nothing in the desk flow has spent anything.
      spent_usd: 0,
      idempotency_key: grant.idempotency_key,
      receipt: grant.receipt,
    },
  ];
}

type Billing = { billed: boolean; amount: number | null; reason?: string };

/** Money, read only from what billing/ recorded. `billing.decision` means the
 * latest decision was "billable", so it clears an older exemption. */
function billingOf(events: BackendToolEvent[]): Billing {
  const out: Billing = { billed: false, amount: null };
  for (const e of events) {
    const p = asRecord(e.payload);
    switch (e.action) {
      case 'meter_event.created':
      case 'meter_event.replayed':
        out.billed = true;
        break;
      case 'meter_event.cancelled':
        out.billed = false;
        break;
      case 'x402.settled':
      case 'mpp.settled':
        out.billed = true;
        out.amount = numOf(p?.['amount_usd']) ?? out.amount;
        break;
      case 'x402.requirement_issued':
      case 'mpp.requirement_issued':
        out.amount = numOf(p?.['price_usd']) ?? out.amount;
        break;
      case 'billing.exempt': {
        const reason = strOf(p?.['reason']) ?? 'exempt';
        const detail = strOf(p?.['detail']);
        out.reason = detail === null ? reason : `${reason}: ${detail}`;
        break;
      }
      case 'billing.not_billable':
        out.reason = `not_billable: ${strOf(p?.['detail']) ?? strOf(p?.['reason']) ?? 'the billable rule was not met'}`;
        break;
      case 'billing.answer_withheld':
        out.reason = `Priced and unpaid: the answer is withheld until ${strOf(p?.['settle']) ?? 'the payment settles'}.`;
        break;
      case 'billing.decision':
        out.reason = undefined;
        break;
      default:
        break;
    }
  }
  return out;
}

/** The price the backend itself stated: a settled amount, then an issued 402
 * requirement, then the price book for the lane this case bills on. */
export function priceUsdFor(view: CaseView, book: PriceBook | null): number {
  const billing = billingOf(byTime(view.events));
  if (billing.amount !== null) return billing.amount;
  if (!view.billable || !book) return 0;
  const lane = chooseLane(view.vendor);
  if (lane === 'b2b_meter') return book.prices[priceKeyForClass(view.case.klass)] ?? 0;
  return lane === 'a2a_x402' ? book.lane_prices.a2a_x402_usd : book.lane_prices.b2b_mpp_usd;
}

/** Distinct agents that reported a failure on this same endpoint, counted from
 * the case list. The reporting agent is always in the set, so the floor is 1. */
export function affectedAgents(list: Failure[], endpoint: string, agentId: string): number {
  if (endpoint === '') return 1;
  const seen = new Set<string>([agentId]);
  for (const f of list) if (endpointOf(f.request) === endpoint) seen.add(f.agent_id);
  return seen.size;
}

function outcomeActionOf(v: CaseParts): string | null {
  const recorded = asRecord(v.reply?.outcome);
  return strOf(recorded?.['action']) ?? (v.outcome ? v.outcome.shipped_as : null);
}

function buildTicket(v: CaseParts, ctx: TicketContext): Ticket {
  const f = v.case;
  const events = byTime(v.events);
  const status = v.status ?? f.status;
  const kind = changeTypeOf(v);
  const mode = modeOf(v);
  const drafted = asRecord(lastAction(events, 'case.fix_drafted')?.payload);
  const changed = drafted?.['changed'];
  const acked = lastAction(events, 'case.acknowledged');
  const resolved = lastAction(events, 'case.resolved') ?? lastAction(events, 'case.closed');
  const regression = asRecord(lastAction(events, 'regression.created')?.payload);
  const billing = billingOf(events);
  // A denied gate finishes as `answered` with reason `approval_denied`: nothing
  // shipped and nothing is billed, so the console's own `rejected` describes what
  // happened instead of showing a green "the agent got a verified answer" card.
  const denied = v.approval !== null && v.approval.decision === 'no';

  const t: Ticket = {
    id: f.id,
    title: strOf(v.reply?.title) ?? f.task,
    stage: denied ? 'rejected' : toStage(status),
    failure_class: f.klass,
    endpoint: endpointOf(f.request),
    agent_id: f.agent_id,
    created_at: f.created_at,
    ack_by: f.ack_by,
    resolve_by: f.resolve_by,
    queue_position: f.queue_position,
    mode,
    risk: riskOf(mode, kind),
    change_type: kind,
    affected_agents: ctx.affectedAgents,
    goal: f.task,
    // The report carries no "already tried" and no cause statement; the desk's own
    // diagnosis is the reply title, which the fix card shows.
    tried: '',
    request: exchange(f.request, 'req'),
    response: exchange(f.response, 'res'),
    cause: '',
    fix: {
      kind,
      summary: strOf(v.approval?.change_summary) ?? strOf(drafted?.['summary']) ?? strOf(v.reply?.title) ?? '',
      file: Array.isArray(changed) ? (strOf(changed[0]) ?? '') : '',
      diff: v.attempt && v.attempt.diff.length > 0 ? v.attempt.diff.split('\n') : [],
      reply_text: v.reply ? v.reply.fix_steps.join(' ') : '',
    },
    proofs: proofsOf(v, events),
    grants: grantsOf(v.grant),
    price_usd: ctx.priceUsd,
  };

  if (acked) t.acked_at = acked.at;
  if (resolved) t.resolved_at = resolved.at;
  else if (v.outcome?.created_at) t.resolved_at = v.outcome.created_at;
  if (v.reply) t.reply = v.reply;
  if (v.outcome) {
    t.outcome = {
      action: outcomeActionOf(v) ?? v.outcome.shipped_as,
      agent_retry_ok: v.outcome.agent_retry_ok,
    };
  }
  const regressionId = strOf(v.reply?.regression_test_id) ?? strOf(regression?.['id']);
  if (regressionId !== null) t.regression_test_id = regressionId;
  t.billed = billing.billed;
  if (!billing.billed && billing.reason !== undefined) t.not_billable_reason = billing.reason;
  if (denied) {
    const repliedAt = v.approval?.replied_at;
    const what = strOf(v.approval?.change_summary);
    t.rejected_reason = `Rejected at the gate${repliedAt ? ` at ${repliedAt}` : ''}${what ? `: ${what}` : ''}. The API stores the decision only, not a reason. Nothing shipped and nothing is billed.`;
  } else if (!STAGES.includes(status)) {
    t.rejected_reason = `The desk reported status "${String(status)}", which this console does not recognise.`;
  }
  return t;
}

export function caseViewToTicket(view: CaseView, ctx: TicketContext): Ticket {
  return buildTicket(view, ctx);
}

/** A case the console has listed but not fetched a view for yet: the Failure row
 * only, so every field it cannot support stays empty rather than guessed. */
export function failureToTicket(f: Failure, ctx: TicketContext): Ticket {
  return buildTicket(
    {
      case: f,
      status: f.status,
      vendor: null,
      billable: false,
      attempt: null,
      outcome: null,
      grant: null,
      approval: null,
      reply: null,
      events: [],
    },
    ctx,
  );
}

// ---- fix memory ----
export interface MemoryEntry {
  signature: { key: string; vendor: string; method: string; path: string; status: number | null; error: string };
  source_case: string;
  sandbox: string;
  path: string;
  model: string;
  remembered_at: string;
  reuse_count: number;
  reused_by: string[];
  proofs: { replay: boolean; vendor_tests: boolean; fresh_agent: boolean };
  fix_steps: string[];
  content_sha256: string;
}
export interface MemoryList { sandboxes: 'blaxel' | 'simulated'; total_reuses: number; entries: MemoryEntry[] }
export interface MemoryResume {
  case_id: string; sandbox: string; real: boolean; found: boolean; resumed_ms: number;
  state_preserved: boolean; path: string; expected_sha256: string; actual_sha256: string | null; note: string;
}
export const getMemory = () => request<MemoryList>('GET', '/v1/memory');
export const resumeMemory = (caseId: string) => request<MemoryResume>('POST', '/v1/memory/resume', { case_id: caseId });

// ---- Blaxel view ----
export interface BlaxelSandbox { name: string; role: 'desk' | 'case' | 'fresh' | 'other'; case_id: string | null; status: string; created_at: string | null; memory_mb: number | null; region: string | null }
export interface BlaxelSandboxes { real: boolean; limit: number; used: number; sandboxes: BlaxelSandbox[]; note?: string }
export interface BlaxelActivity { real: boolean; activity: Array<{ at: string; action: string; sandbox: string; case_id: string; ms: number; ok: boolean; error: string | null }> }
export const getBlaxelSandboxes = () => request<BlaxelSandboxes>('GET', '/v1/blaxel/sandboxes');
export const deleteBlaxelSandbox = (name: string) => request<{ deleted: string }>('POST', '/v1/blaxel/delete', { name });
export const getBlaxelActivity = () => request<BlaxelActivity>('GET', '/v1/blaxel/activity');

export type ArmatureStatus = { simulated: boolean; note: string };
export type ArmaturePull = { simulated: boolean; count: number; cases: { issue: string; case_id: string }[] };
export const getArmature = () => request<ArmatureStatus>('GET', '/v1/feeds/armature');
export const pullArmature = (limit = 3) => request<ArmaturePull>('POST', '/v1/feeds/armature/pull', { limit, run: true });

export type ScenarioRun = {
  case_id: string;
  scenario: string | null;
  agent: string;
  status: CaseStage;
  created_at: string;
  ms: number | null;
  memory_hit: boolean;
  sandbox: string;
  proofs: { replay: boolean; vendor_tests: boolean; fresh_agent: boolean } | null;
  billable: boolean;
};
export type Scenario = { featured?: boolean; id: string; title: string; defect: string; sent: string; message: string; runs: ScenarioRun[] };
export const getScenarios = () => request<{ scenarios: Scenario[] }>('GET', '/v1/scenarios');
export const runScenarios = (agent: string, ids?: string[]) => request<{ started: { scenario: string; case_id: string }[] }>('POST', '/v1/scenarios/run', { agent, ids });

export type PublicDemo = {
  run: { id: string; phase: 'idle' | 'alpha' | 'beta' | 'done' | 'failed'; started_at: string; finished_at: string | null; cases: string[]; note: string } | null;
  rows: ScenarioRun[];
  can_run: boolean;
  why: string | null;
  runs_left: number;
  wait_s: number;
};
export const getPublicDemo = () => request<PublicDemo>('GET', '/v1/public/demo');
export const runPublicDemo = () => request<{ run: PublicDemo['run'] }>('POST', '/v1/public/demo/run', {});
