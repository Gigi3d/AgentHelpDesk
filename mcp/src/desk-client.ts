// The MCP edge's only road to case state.
//
// report_problem and the case routes used to run an in-process loop over a local
// store (src/desk.ts). Case state now belongs to the AgentHelpDesk backend service in
// product/ — a dependency-free node:http API on 127.0.0.1:8787 — and this module is
// the thin HTTP client that forwards to it. The edge keeps no case state of its own,
// so N copies of it can sit behind a load balancer.
//
// Two modes, chosen by resolveConfig():
//
//   live (default)  Every call goes to AHD_DESK_URL. If the backend is down or slow
//                   the call fails LOUD with the machine-readable envelope from
//                   product/shared/http.ts, stage 'mcp.upstream'. We never invent a
//                   case: an agent that trusts a fabricated ack_by is worse off than
//                   an agent holding an error it can act on.
//   fake            AHD_DESK_FAKE=1 serves the deterministic fixtures in
//                   src/fixtures/, seeded into a local DeskStore so the console
//                   routes (/cases, /cases/:id/events, /stream) still work offline.
//
// Routes called, read off product/desk/register.ts (exact-path router):
//
//   POST /v1/cases          ProblemReport + idempotency_key -> committed times at once
//   GET  /v1/cases?id=      one CaseView { case, status, attempt, outcome, grant, reply, events }
//   GET  /v1/cases          { cases: Failure[], count, returned, limit, open_count }
//   POST /v1/cases/retry    { id, ok } -> { case_id, status, agent_retry_ok, billable, outcome, reply }
//
// The backend answers a case read with a CaseView, not with the console's flat ticket,
// and its ToolEvent.t_ms is an epoch, not "ms since the case opened", so both are
// reshaped here. What the backend does not carry yet (a console title/endpoint/SLA
// class, a dedicated events route, stage/wait/docs_url on AgentReply) is filed in
// product/CONTRACT_REQUESTS.md; until it lands the edge derives those fields from the
// report it sent and says so in a comment at each derivation.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EVENT_TOPICS, toAgentReply, type ReportInput } from './desk.js';
import { createStore, type Case, type DeskStore, type Proof, type ProofStatus, type Stage, type StoreChange, type ToolEvent } from './store/index.js';
import { reportOutputSchema, type AgentStatus, type EventTopic, type RetryReceipt, type ToolReply } from './schemas.js';
import {
  DOCS_URL,
  FAKE_CASE,
  FAKE_EVENTS,
  FAKE_TOOL_REPLY,
  fakeRetryEvent,
  fakeRetryReceipt,
  fakeUnknownCase,
} from './fixtures/index.js';

export const UPSTREAM_STAGE = 'mcp.upstream';
const FAKE_STAGE = 'mcp.fake';
const CONFIG_STAGE = 'mcp.config';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 2_000;
/** Seconds an agent should wait before polling again, as in the previous release. */
const DEFAULT_WAIT_S = 30;
/** Same cap the backend enforces on inbound bodies (product/server.ts). */
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_VENDOR_HINT = 'ledgerly';

/**
 * What the edge asks the backend to do after intake. product/desk/register.ts only runs
 * the resolver loop when POST /v1/cases is told to, so 'off' would leave every case
 * sitting at 'opened': the default asks for the loop in the background, which keeps the
 * agent's reply immediate (committed times, 202) while the desk works the case.
 */
export type DeskRun = 'off' | 'background' | 'inline';
const RUN_MODES: readonly DeskRun[] = ['off', 'background', 'inline'];

export type DeskMode = 'live' | 'fake';

/** Statuses this edge can put in an envelope. All are valid Hono StatusCodes. */
export type ErrorStatus = 400 | 404 | 408 | 409 | 413 | 422 | 500 | 502 | 504;

/** The error envelope of product/shared/http.ts, mirrored so we can pass it through verbatim. */
export interface ErrorEnvelope {
  error: { code: string; message: string; stage: string; request_id: string };
}

const newRequestId = (): string => randomUUID();

/**
 * Every failure this edge can produce. `stage` says whose fault it is: 'mcp.upstream'
 * for a backend we could not use, the backend's own stage when it answered with an
 * envelope, 'mcp.fake' offline, 'mcp.config' for a bad env.
 */
export class DeskClientError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly status: ErrorStatus;
  readonly requestId: string;

  constructor(parts: { status: ErrorStatus; code: string; message: string; stage: string; requestId: string }) {
    super(parts.message);
    this.name = 'DeskClientError';
    this.code = parts.code;
    this.stage = parts.stage;
    this.status = parts.status;
    this.requestId = parts.requestId;
  }

  toEnvelope(): ErrorEnvelope {
    return { error: { code: this.code, message: this.message, stage: this.stage, request_id: this.requestId } };
  }
}

/** Coerce anything thrown anywhere in the edge into the one error shape callers render. */
export function asDeskClientError(err: unknown): DeskClientError {
  if (err instanceof DeskClientError) return err;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new DeskClientError({
    status: 500,
    code: 'edge_internal',
    message: `The MCP edge failed while handling this call: ${detail}`,
    stage: 'mcp.edge',
    requestId: newRequestId(),
  });
}

/** Inbound arguments are untrusted: a failed Zod parse is a 400 in the same envelope. */
export function validationError(detail: string): DeskClientError {
  return new DeskClientError({
    status: 400,
    code: 'invalid_input',
    message: `Invalid arguments: ${detail}`,
    stage: 'mcp.edge',
    requestId: newRequestId(),
  });
}

export interface DeskClientConfig {
  mode: DeskMode;
  /** Backend origin, no trailing slash. */
  baseUrl: string;
  timeoutMs: number;
  /** How often live mode polls the backend for /stream changes. */
  pollMs: number;
  /** Whether intake asks the backend to run the resolver loop, and how. Live mode only. */
  run: DeskRun;
  /** ProblemReport.vendor_hint: which vendor's desk this edge reports to. Live mode only. */
  vendorHint: string;
  /** Injected in tests; fake mode only. */
  store?: DeskStore;
}

export type DeskClientOverrides = Partial<DeskClientConfig> & { env?: Record<string, string | undefined> };

function badConfig(message: string): DeskClientError {
  return new DeskClientError({ status: 500, code: 'bad_config', message, stage: CONFIG_STAGE, requestId: newRequestId() });
}

function intFromEnv(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw badConfig(`${name} must be an integer between ${min} and ${max} ms, got "${raw}".`);
  }
  return n;
}

function enumFromEnv<T extends string>(raw: string | undefined, name: string, allowed: readonly T[], fallback: T): T {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  const found = allowed.find((a) => a === value);
  if (!found) throw badConfig(`${name} must be one of ${allowed.join(', ')}; got "${raw}".`);
  return found;
}

/** product/desk/intake.ts caps vendor_hint at 200 characters; so does the edge. */
function vendorFromEnv(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim();
  if (value.length > 200) throw badConfig(`AHD_DESK_VENDOR must be at most 200 characters, got ${value.length}.`);
  return value;
}

/**
 * Env wins nothing over an explicit override; both beat the defaults.
 * AHD_DESK_FAKE=1 is the only switch that changes the mode.
 */
export function resolveConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<DeskClientConfig> = {}): DeskClientConfig {
  const mode: DeskMode = overrides.mode ?? (env.AHD_DESK_FAKE === '1' ? 'fake' : 'live');
  const baseUrl = (overrides.baseUrl ?? env.AHD_DESK_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badConfig(`AHD_DESK_URL must be http(s), got "${baseUrl}".`);
  } catch (err) {
    if (err instanceof DeskClientError) throw err;
    throw badConfig(`AHD_DESK_URL is not a usable URL: "${baseUrl}".`);
  }
  return {
    mode,
    baseUrl,
    timeoutMs: overrides.timeoutMs ?? intFromEnv(env.AHD_DESK_TIMEOUT_MS, 'AHD_DESK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 250, 60_000),
    pollMs: overrides.pollMs ?? intFromEnv(env.AHD_DESK_POLL_MS, 'AHD_DESK_POLL_MS', DEFAULT_POLL_MS, 250, 60_000),
    run: overrides.run ?? enumFromEnv(env.AHD_DESK_RUN, 'AHD_DESK_RUN', RUN_MODES, 'background'),
    vendorHint: overrides.vendorHint ?? vendorFromEnv(env.AHD_DESK_VENDOR, DEFAULT_VENDOR_HINT),
    store: overrides.store,
  };
}

// ---- error mapping (pure; unit-tested without any network) ----

export interface UpstreamResponse {
  status: number;
  body: unknown;
  /** From the backend's x-request-id header, or minted here when it sent none. */
  requestId: string;
}

/** Structural view of a Zod failure, so this helper does not depend on Zod's error types. */
export interface IssueList {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}

export function issueText(error: IssueList): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') || 'no detail';
}

export function contractError(
  op: string,
  requestId: string,
  detail: string,
  opts: { status?: ErrorStatus; stage?: string } = {},
): DeskClientError {
  return new DeskClientError({
    status: opts.status ?? 502,
    code: 'upstream_contract',
    message: `${op} returned a payload this edge could not validate: ${detail}`,
    stage: opts.stage ?? UPSTREAM_STAGE,
    requestId,
  });
}

const KNOWN_STATUSES: readonly ErrorStatus[] = [400, 404, 408, 409, 413, 422, 500, 502, 504];

function normalizeStatus(status: number): ErrorStatus {
  if ((KNOWN_STATUSES as readonly number[]).includes(status)) return status as ErrorStatus;
  if (status >= 400 && status < 500) return 400;
  return 502;
}

function preview(body: unknown): string {
  let text: string;
  try {
    text = typeof body === 'string' ? body : String(JSON.stringify(body));
  } catch {
    text = String(body);
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    stage: z.string(),
    request_id: z.string().optional(),
  }),
});

/**
 * Turn a non-2xx answer into a DeskClientError. When the backend sent its own
 * envelope we keep its code, message, stage and request_id and only add the call
 * that failed; when it sent something else we say so loudly instead of guessing.
 */
export function errorFromResponse(op: string, res: UpstreamResponse): DeskClientError {
  const parsed = errorEnvelopeSchema.safeParse(res.body);
  if (parsed.success) {
    const e = parsed.data.error;
    return new DeskClientError({
      status: normalizeStatus(res.status),
      code: e.code,
      message: `${op}: ${e.message}`,
      stage: e.stage.length > 0 ? e.stage : UPSTREAM_STAGE,
      requestId: e.request_id && e.request_id.length > 0 ? e.request_id : res.requestId,
    });
  }
  return new DeskClientError({
    status: normalizeStatus(res.status),
    code: res.status === 404 ? 'case_not_found' : 'upstream_error',
    message: `${op} failed with HTTP ${res.status} and no error envelope. Body: ${preview(res.body)}`,
    stage: UPSTREAM_STAGE,
    requestId: res.requestId,
  });
}

/** Transport-level failure: nothing answered, or the answer did not arrive in time. */
export function errorFromTransport(op: string, err: unknown, cfg: Pick<DeskClientConfig, 'baseUrl' | 'timeoutMs'>): DeskClientError {
  const name = err instanceof Error ? err.name : '';
  const detail = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new DeskClientError({
      status: 504,
      code: 'upstream_timeout',
      message: `${op} timed out after ${cfg.timeoutMs}ms waiting for the AgentHelpDesk backend at ${cfg.baseUrl}.`,
      stage: UPSTREAM_STAGE,
      requestId: newRequestId(),
    });
  }
  return new DeskClientError({
    status: 502,
    code: 'upstream_unreachable',
    message:
      `${op} could not reach the AgentHelpDesk backend at ${cfg.baseUrl}: ${detail}. ` +
      'Start the desk service (product/: node --experimental-strip-types server.ts) or set AHD_DESK_FAKE=1 to serve the offline demo fixtures. ' +
      'This edge does not invent cases.',
    stage: UPSTREAM_STAGE,
    requestId: newRequestId(),
  });
}

// ---- transport ----

const opOf = (method: string, path: string): string => `${method} ${path.split('?')[0]}`;

async function httpRequest(
  cfg: DeskClientConfig,
  method: 'GET' | 'POST',
  path: string,
  init?: { body?: unknown; headers?: Record<string, string> },
): Promise<UpstreamResponse> {
  const op = opOf(method, path);
  const hasBody = init?.body !== undefined;
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    ...(hasBody ? { body: JSON.stringify(init?.body) } : {}),
    // Hard timeout on every upstream call: a hung backend must not hang an agent.
    signal: AbortSignal.timeout(cfg.timeoutMs),
  }).catch((err: unknown): never => {
    throw errorFromTransport(op, err, cfg);
  });

  const requestId = res.headers.get('x-request-id') ?? newRequestId();
  const text = await res.text().catch((err: unknown): never => {
    throw errorFromTransport(`${op} (reading the body)`, err, cfg);
  });
  if (text.length > MAX_BODY_BYTES) {
    throw new DeskClientError({
      status: 413,
      code: 'upstream_payload_too_large',
      message: `${op} returned ${text.length} bytes; this edge refuses bodies over ${MAX_BODY_BYTES}.`,
      stage: UPSTREAM_STAGE,
      requestId,
    });
  }
  if (text.trim() === '') return { status: res.status, body: null, requestId };
  try {
    return { status: res.status, body: JSON.parse(text) as unknown, requestId };
  } catch {
    throw new DeskClientError({
      status: 502,
      code: 'upstream_invalid_json',
      message: `${op} returned a body that is not JSON: ${preview(text)}`,
      stage: UPSTREAM_STAGE,
      requestId,
    });
  }
}

async function requestOk(cfg: DeskClientConfig, method: 'GET' | 'POST', path: string, init?: { body?: unknown; headers?: Record<string, string> }): Promise<UpstreamResponse> {
  const res = await httpRequest(cfg, method, path, init);
  if (res.status < 200 || res.status >= 300) throw errorFromResponse(opOf(method, path), res);
  return res;
}

// ---- backend payloads (mirrors of product/shared/types.ts and product/desk/register.ts;
// ---- the edge cannot import across module directories, so the shapes are restated here) ----

/** Mirror of ProblemReport in product/shared/types.ts. */
export interface ProblemReport {
  vendor_hint?: string;
  agent_id: string;
  task: string;
  request: unknown;
  response: unknown;
  klass?: 'knowledge' | 'code' | 'authority';
  channel: 'mcp' | 'email' | 'webhook' | 'forwarded';
}

/**
 * POST /v1/cases also reads these three, which are not part of ProblemReport yet
 * (product/CONTRACT_REQUESTS.md). `idempotency_key` is what makes a repeated report a
 * replay instead of a second case; the backend hashes it into the case id.
 */
export interface CasePost extends ProblemReport {
  idempotency_key?: string;
  run_loop?: boolean;
  background?: boolean;
}

/**
 * Mirror of AgentReply in product/shared/types.ts, loosened: only the fields this edge
 * maps are required, everything else is optional so a backend that is still filling in
 * the contract does not break installed agents. `status` is a number on a stored
 * AgentReply but a CaseStage string on the intake answer, so both are accepted.
 * `stage`, `wait` and `docs_url` are the three additions requested in
 * product/CONTRACT_REQUESTS.md and are used when present.
 */
const backendReplySchema = z.object({
  case_id: z.string(),
  ack_by: z.string(),
  resolve_by: z.string(),
  queue_position: z.number(),
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.union([z.number(), z.string()]).optional(),
  retryable: z.boolean().optional(),
  fix_steps: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  tested: z.object({ replay: z.boolean(), vendor_tests: z.boolean(), fresh_agent: z.boolean() }).optional(),
  regression_test_id: z.string().optional(),
  audit_receipt: z.string().optional(),
  outcome: z.unknown().optional(),
  authority: z.record(z.string(), z.unknown()).optional(),
  events: z.array(z.string()).optional(),
  stage: z.string().optional(),
  wait: z.number().int().optional(),
  docs_url: z.string().optional(),
});

export type BackendAgentReply = z.infer<typeof backendReplySchema>;

/** product/shared/types.ts Attempt: the resolver's diff and the three proof booleans. */
const attemptSchema = z.looseObject({
  id: z.string().optional(),
  diff: z.string().optional(),
  proof_replay: z.boolean().optional(),
  proof_vendor_tests: z.boolean().optional(),
  proof_fresh_agent: z.boolean().optional(),
  log_url: z.string().optional(),
});

/** product/shared/types.ts Outcome. `shipped_as` is the closest thing to a console action. */
const outcomeSchema = z.looseObject({
  id: z.string().optional(),
  shipped_as: z.string().optional(),
  agent_retry_ok: z.boolean().optional(),
  billable: z.boolean().optional(),
  payer: z.string().nullable().optional(),
});

/** product/shared/types.ts Grant: the bounded authority the agent may call itself. */
const grantSchema = z.looseObject({
  id: z.string().optional(),
  failure_id: z.string().optional(),
  verb: z.string().optional(),
  idempotency_key: z.string().optional(),
  receipt: z.string().optional(),
  spent: z.boolean().optional(),
  envelope: z.record(z.string(), z.unknown()).optional(),
});

/**
 * product/shared/types.ts ToolEvent. Note `t_ms` is the epoch ms the stage started at
 * (product/desk/obs.ts), not the console's "ms since the case opened": toConsoleEvent
 * rebases it against created_at.
 */
const backendEventSchema = z.looseObject({
  id: z.string(),
  ticket_id: z.string().optional(),
  stage: z.unknown().optional(),
  tool: z.unknown().optional(),
  action: z.unknown().optional(),
  t_ms: z.unknown().optional(),
  d_ms: z.unknown().optional(),
  result: z.unknown().optional(),
  at: z.string().optional(),
  cost_usd: z.unknown().optional(),
  payload: z.unknown().optional(),
  gate: z.unknown().optional(),
  after_gate: z.unknown().optional(),
});

export type BackendEventRow = z.infer<typeof backendEventSchema>;

/** shared/types.ts Failure, the row inside GET /v1/cases' {cases: [...]}. */
const failureFields = {
  id: z.string().optional(),
  created_at: z.string().optional(),
  vendor_id: z.string().optional(),
  agent_id: z.string().optional(),
  task: z.string().optional(),
  request: z.unknown().optional(),
  response: z.unknown().optional(),
  klass: z.string().optional(),
  status: z.string().optional(),
  ack_by: z.string().optional(),
  resolve_by: z.string().optional(),
  queue_position: z.number().optional(),
};

/**
 * One case, in any of the three shapes the backend sends:
 *   GET /v1/cases?id=  a CaseView  { case: Failure, status, attempt, outcome, grant, approval, reply, events }
 *   GET /v1/cases      a bare Failure inside { cases: [...] }
 *   POST /v1/cases     the intake answer { case_id, ack_by, resolve_by, queue_position, status, case }
 * Every field is optional because the three overlap only partly; parseCase() is what
 * insists on an id and a created_at, and it fails loud when neither shape has one.
 * Console-shaped fields (title, endpoint, goal, sla, fix, ...) are not listed: they are
 * carried through untouched so a backend that starts sending them needs no edge change.
 */
const backendCaseSchema = z.looseObject({
  ...failureFields,
  case_id: z.string().optional(),
  case: z.looseObject(failureFields).nullable().optional(),
  stage: z.string().optional(),
  sla: z.string().optional(),
  sla_breached: z.boolean().optional(),
  billable: z.boolean().optional(),
  attempt: attemptSchema.nullable().optional(),
  outcome: outcomeSchema.nullable().optional(),
  grant: grantSchema.nullable().optional(),
  approval: z.record(z.string(), z.unknown()).nullable().optional(),
  reply: backendReplySchema.nullable().optional(),
  events: z.array(backendEventSchema).optional(),
  run: z.string().optional(),
  poll: z.string().optional(),
  result: z.looseObject({ status: z.string().optional(), reply: backendReplySchema.nullable().optional() }).nullable().optional(),
});

type BackendCase = z.infer<typeof backendCaseSchema>;

/** POST /v1/cases/retry answers with the settled outcome and the rebuilt reply. */
const retryReceiptSchema = z.looseObject({
  case_id: z.string().optional(),
  ok: z.boolean().optional(),
  agent_retry_ok: z.boolean().optional(),
  billable: z.boolean().optional(),
  status: z.string().optional(),
  outcome_id: z.string().optional(),
  receipt: z.string().optional(),
  outcome: outcomeSchema.nullable().optional(),
  reply: backendReplySchema.nullable().optional(),
});

export type RetryRow = z.infer<typeof retryReceiptSchema>;

// ---- small normalisers: the backend owns the truth, the console owns the shape ----

function strOr(fallback: string, ...candidates: unknown[]): string {
  for (const c of candidates) if (typeof c === 'string' && c.length > 0) return c;
  return fallback;
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function recordOr(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { value: value ?? null };
}

const PROOF_STATUSES: readonly ProofStatus[] = ['pending', 'running', 'passed', 'failed', 'skipped'];

/** Proofs arrive from the backend as booleans (shared/types.ts Proofs) and render as objects. */
function proofOf(raw: unknown): Proof {
  if (typeof raw === 'boolean') return { status: raw ? 'passed' : 'pending', duration_ms: 0, detail: raw ? 'passed' : 'not run yet' };
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const status = typeof o.status === 'string' && (PROOF_STATUSES as readonly string[]).includes(o.status) ? (o.status as ProofStatus) : 'pending';
    return { status, duration_ms: numOr(o.duration_ms, 0), detail: strOr('', o.detail) };
  }
  return { status: 'pending', duration_ms: 0, detail: '' };
}

function proofsOf(raw: unknown): Case['proofs'] {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { replay: proofOf(o.replay), vendor_tests: proofOf(o.vendor_tests), fresh_agent: proofOf(o.fresh_agent) };
}

function responseOf(raw: unknown): Case['response'] {
  if (raw === null || typeof raw !== 'object') return { headers: {}, body: raw ?? null };
  const o = raw as Record<string, unknown>;
  const headers: Record<string, string> = {};
  if (o.headers !== null && typeof o.headers === 'object') {
    for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) headers[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  const base: Case['response'] = { headers, body: o.body ?? null };
  if (typeof o.status === 'number') base.status = o.status;
  return base;
}

/** product/'s CaseStage has 'escalated' where the console has 'failed_proof'/'rejected'. */
const CONSOLE_STAGE: Record<string, Stage> = {
  opened: 'opened',
  reproducing: 'reproducing',
  fix_drafted: 'fix_drafted',
  proving: 'proving',
  awaiting_approval: 'awaiting_approval',
  answered: 'answered',
  shipped: 'shipped',
  closed: 'closed',
  escalated: 'failed_proof',
  failed_proof: 'failed_proof',
  rejected: 'rejected',
};

function toConsoleStage(raw: unknown, fallback: Stage = 'opened'): Stage {
  return typeof raw === 'string' ? (CONSOLE_STAGE[raw] ?? fallback) : fallback;
}

function failureClassOf(raw: unknown): Case['failure_class'] {
  return raw === 'code' || raw === 'authority' ? raw : 'knowledge';
}

/**
 * Validate any of the three case payloads and fail loud when none of them carries an id
 * and a created_at. The edge never invents those two: the console sorts and times
 * everything by them, so a case without them is a backend contract bug to surface.
 */
function parseCase(body: unknown, op: string, requestId: string): BackendCase {
  const parsed = backendCaseSchema.safeParse(body);
  if (!parsed.success) throw contractError(op, requestId, `expected a case object; ${issueText(parsed.error)}`);
  const row = parsed.data;
  const id = row.case?.id ?? row.id ?? row.case_id;
  const createdAt = row.case?.created_at ?? row.created_at;
  if (typeof id !== 'string' || id.length === 0 || typeof createdAt !== 'string' || createdAt.length === 0) {
    throw contractError(op, requestId, `expected a case with an id and a created_at; got ${preview(body)}`);
  }
  return row;
}

function fieldOf(raw: unknown, key: string): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

/**
 * The console shows the failing call as "METHOD /path". Failure has no endpoint field
 * (product/CONTRACT_REQUESTS.md), so it is read off the request the agent reported.
 */
function endpointOf(request: unknown): string {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return '';
  const o = request as Record<string, unknown>;
  const method = typeof o.method === 'string' ? o.method.toUpperCase() : '';
  const path = strOr('', o.path, o.endpoint, o.url);
  return path.length > 0 ? (method.length > 0 ? `${method} ${path}` : path) : '';
}

/**
 * Failure carries no SLA class either. Derive it from the window the desk itself
 * committed to: 5m/1h is the console's blocked_order class, anything wider is 'default'.
 */
function slaOf(row: BackendCase): Case['sla'] {
  if (row.sla === 'blocked_order' || row.sla === 'default') return row.sla;
  const created = Date.parse(strOr('', row.created_at));
  const ack = Date.parse(strOr('', row.ack_by));
  const resolve = Date.parse(strOr('', row.resolve_by));
  if (!Number.isFinite(created) || !Number.isFinite(ack) || !Number.isFinite(resolve)) return 'default';
  return ack - created <= 5 * 60_000 && resolve - created <= 60 * 60_000 ? 'blocked_order' : 'default';
}

/**
 * Attempt's three proof booleans -> the console's Proof objects. A console-shaped
 * `proofs` block on the payload wins, so a backend that starts sending one is used
 * verbatim. Nothing is claimed that did not run: an absent boolean stays 'pending'.
 */
function proofsFrom(row: BackendCase): Case['proofs'] {
  const raw = (row as Record<string, unknown>).proofs;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return proofsOf(raw);
  const a = row.attempt;
  const one = (passed: boolean | undefined, name: string): Proof => ({
    status: passed === true ? 'passed' : passed === false ? 'failed' : 'pending',
    duration_ms: 0,
    detail: passed === true ? `${name} passed` : passed === false ? `${name} failed` : `${name} has not run yet`,
  });
  return {
    replay: one(a?.proof_replay, 'replay'),
    vendor_tests: one(a?.proof_vendor_tests, 'vendor_tests'),
    fresh_agent: one(a?.proof_fresh_agent, 'fresh_agent'),
  };
}

/** The console's fix block, from the resolver's diff and the reply the desk wrote. */
function fixFrom(row: BackendCase): Record<string, unknown> | undefined {
  const diff = typeof row.attempt?.diff === 'string' ? row.attempt.diff : '';
  const reply = row.reply;
  const summary = strOr('', reply?.title, reply?.snippet);
  if (diff.length === 0 && summary.length === 0) return undefined;
  return {
    kind: strOr('docs', row.outcome?.shipped_as),
    summary,
    file: '',
    diff: diff.length > 0 ? diff.split('\n') : [],
    reply_text: strOr('', reply?.snippet),
    fix_steps: reply?.fix_steps ?? [],
  };
}

/** A backend Grant -> the console's grant row (web/src/data/tickets.json shape). */
function grantsFrom(row: BackendCase): Record<string, unknown>[] {
  const raw = (row as Record<string, unknown>).grants;
  if (Array.isArray(raw)) return raw.map((g) => recordOr(g));
  const g = row.grant;
  if (!g) return [];
  return [
    {
      id: strOr('', g.id),
      verb: strOr('', g.verb),
      status: g.spent === true ? 'spent' : 'issued',
      cap_usd: numOr(g.envelope?.cap_usd, 0),
      per_user: numOr(g.envelope?.per_user, 0),
      spent_usd: 0,
      idempotency_key: strOr('', g.idempotency_key),
      receipt: g.receipt ?? null,
    },
  ];
}

/**
 * Backend case payload -> the ticket shape the console and src/desk.ts already speak.
 * Accepts a CaseView (GET /v1/cases?id=), a bare Failure (GET /v1/cases) or the intake
 * answer (POST /v1/cases). A CaseView's nested Failure is merged under the view, so the
 * view's committed times and the Failure's report both land on the ticket.
 */
export function toConsoleCase(body: unknown, op: string, requestId: string): Case {
  const row = parseCase(body, op, requestId);
  const src: BackendCase = row.case ? { ...row, ...row.case } : row;
  const id = strOr('', src.id, src.case_id);
  const createdAt = strOr('', src.created_at);
  const wide = src as Record<string, unknown>;
  const c: Case = {
    id,
    title: strOr(`Case ${id}`, wide.title, src.task),
    stage: toConsoleStage(src.stage ?? src.status),
    failure_class: failureClassOf(wide.failure_class ?? src.klass),
    endpoint: strOr('Unknown endpoint', wide.endpoint, endpointOf(src.request)),
    agent_id: strOr('agt_unknown', src.agent_id),
    created_at: createdAt,
    ack_by: strOr(createdAt, src.ack_by),
    resolve_by: strOr(createdAt, src.resolve_by),
    queue_position: numOr(src.queue_position, 1),
    sla: slaOf(src),
    goal: strOr('', wide.goal, src.task),
    tried: strOr('', wide.tried, fieldOf(src.request, 'tried')),
    request_id: strOr('', wide.request_id, fieldOf(src.request, 'request_id')),
    response: responseOf(src.response),
    proofs: proofsFrom(src),
  };
  const contact = strOr('', wide.contact, fieldOf(src.request, 'contact'));
  if (contact.length > 0) c.contact = contact;
  if (typeof src.vendor_id === 'string') c.vendor_id = src.vendor_id;
  const fix = fixFrom(src);
  if (fix) c.fix = fix;
  if (src.reply) c.reply = recordOr(src.reply);
  if (src.outcome) {
    c.outcome = {
      action: strOr(src.outcome.shipped_as ?? 'answer', src.grant?.verb),
      agent_retry_ok: src.outcome.agent_retry_ok === true,
    };
  }
  const grants = grantsFrom(src);
  if (grants.length > 0) c.grants = grants;
  if (src.approval) c.approval = src.approval;
  if (typeof src.attempt?.log_url === 'string' && src.attempt.log_url.length > 0) c.proof_log_url = src.attempt.log_url;
  c.billed = src.outcome?.billable === true || src.billable === true;
  // Carry the rest of the ticket through untouched (cause, mode, risk, change_type,
  // affected_agents, price_usd, pr, ...): the console renders fields this edge does not
  // model, and a backend that starts sending them needs no change here. Nested backend
  // objects are skipped because they were just mapped into their console equivalents.
  const skip: readonly string[] = ['case', 'case_id', 'attempt', 'outcome', 'grant', 'approval', 'reply', 'events', 'result', 'run', 'poll', 'status', 'klass', 'sla_breached', 'billable', 'vendor'];
  const target = c as Record<string, unknown>;
  for (const key of Object.keys(wide)) if (!(key in target) && !skip.includes(key)) target[key] = wide[key];
  return c;
}

/** Above this, a t_ms is an epoch (product/desk/obs.ts); below it, already relative. */
const RELATIVE_MS_CEILING = 1e11;

/**
 * Backend ToolEvent -> the console's row. Two reshapes: `t_ms` is rebased from an epoch
 * to "ms since the case opened" (web/src/lib/store.tsx adds it to created_at), and a
 * stage the console has no name for ('billing', 'privacy', ...) falls back to the case's
 * own stage instead of resetting the ticket to 'opened'.
 */
export function toConsoleEvent(row: BackendEventRow, caseId: string, fallback: Stage, createdMs: number): ToolEvent {
  const started = numOr(row.t_ms, Number.NaN);
  const at = typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN;
  const absolute = Number.isFinite(started) ? started : at;
  const base = Number.isFinite(createdMs) ? createdMs : 0;
  const e: ToolEvent = {
    id: row.id,
    ticket_id: strOr(caseId, row.ticket_id),
    stage: toConsoleStage(row.stage, fallback),
    tool: strOr('AgentHelpDesk', row.tool),
    action: strOr('unknown', row.action),
    t_ms: Number.isFinite(absolute) ? Math.max(0, absolute > RELATIVE_MS_CEILING ? absolute - base : absolute) : 0,
    d_ms: numOr(row.d_ms, 0),
    result: strOr('unknown', row.result),
    payload: recordOr(row.payload),
  };
  if (typeof row.cost_usd === 'number') e.cost_usd = row.cost_usd;
  if (row.gate === true) e.gate = true;
  if (row.after_gate === true) e.after_gate = true;
  return e;
}

const AGENT_STATUS: Record<string, AgentStatus> = {
  opened: 'opened',
  reproducing: 'working',
  fix_drafted: 'working',
  proving: 'working',
  awaiting_approval: 'working',
  answered: 'answered',
  shipped: 'answered',
  closed: 'answered',
  escalated: 'handed_off',
  failed_proof: 'handed_off',
  rejected: 'handed_off',
};

/** CaseStages after which a case stops moving (product/desk/intake.ts TERMINAL_STAGES). */
const TERMINAL_STAGES: readonly string[] = ['answered', 'shipped', 'closed'];

/**
 * Keep only the topics this server advertises: outputSchema is an enum, so an
 * unknown backend topic must be dropped rather than fail the agent's call. With
 * nothing recognised we advertise all of them, which is what the tool always did.
 */
function eventTopicsOf(raw: string[] | undefined): EventTopic[] {
  const known = (raw ?? []).filter((e): e is EventTopic => (EVENT_TOPICS as readonly string[]).includes(e));
  return known.length > 0 ? known : [...EVENT_TOPICS];
}

/**
 * The backend's AgentReply -> the report_problem outputSchema an installed agent
 * already parses. Proof booleans become answer.tested, and status comes from the
 * case stage when the backend sends one, otherwise from the proofs themselves.
 * The stage arrives as `stage` (the field requested in CONTRACT_REQUESTS.md) or as a
 * string `status`, which is what POST /v1/cases and a CaseView send today; a numeric
 * AgentReply.status is the vendor's HTTP status and is deliberately ignored here.
 */
export function toToolReply(raw: BackendAgentReply): ToolReply {
  const tested = raw.tested ?? { replay: false, vendor_tests: false, fresh_agent: false };
  const allProved = tested.replay && tested.vendor_tests && tested.fresh_agent;
  const stageText = typeof raw.stage === 'string' ? raw.stage : typeof raw.status === 'string' ? raw.status : undefined;
  const fromStage = stageText !== undefined ? AGENT_STATUS[stageText] : undefined;
  const status: AgentStatus = fromStage ?? (allProved ? 'answered' : 'working');

  const reply: ToolReply = {
    case_id: raw.case_id,
    status,
    ack_by: raw.ack_by,
    resolve_by: raw.resolve_by,
    queue_position: raw.queue_position,
    events: eventTopicsOf(raw.events),
  };
  if (status === 'answered') {
    reply.answer = {
      summary: strOr('', raw.snippet, raw.title),
      fix_steps: raw.fix_steps ?? [],
      docs: raw.docs_url ?? DOCS_URL,
      tested: { replay: tested.replay, vendor_tests: tested.vendor_tests, fresh_agent: tested.fresh_agent },
    };
    if (raw.outcome !== undefined && raw.outcome !== null) reply.outcome = recordOr(raw.outcome);
    if (raw.authority !== undefined) reply.authority = raw.authority;
  } else {
    reply.wait = raw.wait ?? DEFAULT_WAIT_S;
  }
  return reply;
}

/**
 * The four push topics, restricted to the ones this case really recorded — the same rule
 * product/desk/obs.ts pushTopicsFrom applies, so the edge never promises an event the
 * desk did not write.
 */
function topicsFromActions(events: readonly BackendEventRow[] | undefined): string[] {
  const actions = (events ?? []).map((e) => strOr('', e.action));
  return (EVENT_TOPICS as readonly string[]).filter((t) => actions.includes(t));
}

/**
 * Any case payload the backend sends -> the reply an agent gets. A stored AgentReply
 * (CaseView.reply, or the inline loop's result.reply) is the desk's own wording and wins;
 * only its stage is missing, so the payload's status supplies it. With no reply yet — a
 * case just opened, or still being worked — the committed times, the Attempt proof
 * booleans, the settled outcome, the grant envelope and the recorded topics are mapped
 * instead. Nothing here is invented: every field comes from the payload or is left out.
 */
export function toolReplyFromCase(body: unknown, op: string, requestId: string): ToolReply {
  const row = parseCase(body, op, requestId);
  const stage = row.result?.status ?? row.status;
  const stored = row.result?.reply ?? row.reply;
  const attempt = row.attempt;
  const candidate: unknown = stored
    ? { ...stored, stage: stored.stage ?? stage }
    : {
        case_id: strOr('', row.case_id, row.case?.id, row.id),
        ack_by: strOr('', row.ack_by, row.case?.ack_by),
        resolve_by: strOr('', row.resolve_by, row.case?.resolve_by),
        queue_position: numOr(row.queue_position ?? row.case?.queue_position, 1),
        stage,
        title: row.task ?? row.case?.task,
        tested: attempt
          ? {
              replay: attempt.proof_replay === true,
              vendor_tests: attempt.proof_vendor_tests === true,
              fresh_agent: attempt.proof_fresh_agent === true,
            }
          : undefined,
        outcome: row.outcome
          ? { action: strOr(row.outcome.shipped_as ?? 'answer', row.grant?.verb), agent_retry_ok: row.outcome.agent_retry_ok === true }
          : undefined,
        authority: row.grant?.envelope,
        events: topicsFromActions(row.events),
      };
  const parsed = backendReplySchema.safeParse(candidate);
  if (!parsed.success) throw contractError(op, requestId, `expected an AgentReply; ${issueText(parsed.error)}`);
  return validateToolReply(op, toToolReply(parsed.data), requestId);
}

/** Last gate before a reply reaches an agent: it must match the published outputSchema. */
export function validateToolReply(op: string, value: unknown, requestId: string, stage: string = UPSTREAM_STAGE): ToolReply {
  const parsed = reportOutputSchema.safeParse(value);
  if (!parsed.success) throw contractError(op, requestId, issueText(parsed.error), { stage });
  return parsed.data;
}

/** Accept a bare array or the usual {cases|items|events|rows: [...]} wrapper. */
function asList(op: string, body: unknown, requestId: string, keys: readonly string[]): unknown[] {
  if (Array.isArray(body)) return body;
  if (body !== null && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const key of keys) if (Array.isArray(o[key])) return o[key] as unknown[];
  }
  throw contractError(op, requestId, `expected an array (or an object with one of ${keys.join(', ')}), got ${preview(body)}`);
}

// ---- the client ----

export interface DeskClient {
  readonly mode: DeskMode;
  /** Open a case, or return the one already open for this request id / case id. */
  report(input: ReportInput, agentId: string): Promise<ToolReply>;
  getCase(id: string): Promise<Case>;
  listCases(): Promise<Case[]>;
  listEvents(id: string): Promise<ToolEvent[]>;
  /** The agent's retry result. The billable rule needs it: proofs AND a successful retry. */
  retry(caseId: string, ok: boolean, note?: string): Promise<RetryReceipt>;
  /** Change feed for /stream. Fake mode pushes from the store; live mode polls. Returns stop(). */
  watch(onChange: (change: StoreChange) => void, onError?: (err: DeskClientError) => void): () => void;
}

function agentSlug(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `agt_${slug || 'unknown'}`;
}

/**
 * The backend's retry answer -> the receipt report_retry_result promises. `agent_retry_ok`
 * is what POST /v1/cases/retry echoes; `ok` is the shorter name the tool uses. billable is
 * claimed only when the backend says so, so a partial answer can never over-state billing.
 */
export function retryReceiptFrom(row: RetryRow, caseId: string, ok: boolean): RetryReceipt {
  const receipt: RetryReceipt = {
    case_id: strOr(caseId, row.case_id),
    ok: row.agent_retry_ok ?? row.ok ?? ok,
    billable: row.billable === true,
  };
  const outcomeId = strOr('', row.outcome_id, row.outcome?.id);
  if (outcomeId.length > 0) receipt.outcome_id = outcomeId;
  const audit = strOr('', row.receipt, row.reply?.audit_receipt);
  if (audit.length > 0) receipt.receipt = audit;
  return receipt;
}

function createLiveClient(cfg: DeskClientConfig): DeskClient {
  const LIST_PATH = '/v1/cases?limit=200';
  const casePath = (id: string): string => `/v1/cases?id=${encodeURIComponent(id)}`;

  /**
   * One read of GET /v1/cases?id= gives both the ticket and its events, so the two can
   * never disagree. There is no separate events route on the backend yet; the ask is
   * filed in product/CONTRACT_REQUESTS.md.
   */
  async function readView(id: string): Promise<{ view: Case; events: ToolEvent[] }> {
    const op = 'GET /v1/cases';
    const res = await requestOk(cfg, 'GET', casePath(id));
    const row = parseCase(res.body, op, res.requestId);
    const view = toConsoleCase(row, op, res.requestId);
    const createdMs = Date.parse(view.created_at);
    return { view, events: (row.events ?? []).map((e) => toConsoleEvent(e, view.id, view.stage, createdMs)) };
  }

  /** The id of a case row, in whichever of the three shapes it arrived. */
  function idOf(row: unknown): string {
    if (row === null || typeof row !== 'object') return '';
    const o = row as Record<string, unknown>;
    const nested = o.case !== null && typeof o.case === 'object' ? (o.case as Record<string, unknown>) : null;
    return strOr('', nested?.id, o.id, o.case_id);
  }

  function stageOf(row: unknown): string {
    if (row === null || typeof row !== 'object') return '';
    const o = row as Record<string, unknown>;
    return strOr('', o.status, o.stage);
  }

  async function listRows(): Promise<{ rows: unknown[]; requestId: string }> {
    const res = await requestOk(cfg, 'GET', LIST_PATH);
    return { rows: asList('GET /v1/cases', res.body, res.requestId, ['cases', 'items', 'rows']), requestId: res.requestId };
  }

  return {
    mode: 'live',

    async report(input: ReportInput, agentId: string): Promise<ToolReply> {
      const slug = agentSlug(agentId);
      if (input.case_id) {
        const res = await requestOk(cfg, 'GET', casePath(input.case_id));
        return toolReplyFromCase(res.body, 'GET /v1/cases', res.requestId);
      }
      // ProblemReport has no request_id field yet (CONTRACT_REQUESTS.md), so the agent's
      // Request-Id travels inside `request` and doubles as the idempotency_key the
      // backend hashes into the case id: a repeated report replays the open case instead
      // of opening a twin, whichever channel it arrives on.
      const payload: CasePost = {
        vendor_hint: cfg.vendorHint,
        agent_id: slug,
        task: input.goal?.trim() || `Failure reported for ${input.request_id}`,
        request: {
          request_id: input.request_id,
          ...(input.tried ? { tried: input.tried } : {}),
          ...(input.contact ? { contact: input.contact } : {}),
        },
        response: null,
        channel: 'mcp',
        idempotency_key: input.request_id,
      };
      // The backend runs its resolver loop only when asked. 'background' (the default)
      // keeps the agent's reply immediate — committed times, 202 — while the desk works
      // the case; 'inline' waits for the answer and needs a longer AHD_DESK_TIMEOUT_MS.
      if (cfg.run !== 'off') {
        payload.run_loop = true;
        payload.background = cfg.run === 'background';
      }
      const op = 'POST /v1/cases';
      const res = await requestOk(cfg, 'POST', '/v1/cases', {
        body: payload,
        headers: { 'x-agent-id': slug, 'idempotency-key': input.request_id },
      });
      return toolReplyFromCase(res.body, op, res.requestId);
    },

    async getCase(id: string): Promise<Case> {
      return (await readView(id)).view;
    },

    async listCases(): Promise<Case[]> {
      const op = 'GET /v1/cases';
      const { rows, requestId } = await listRows();
      return rows.map((row) => toConsoleCase(row, op, requestId));
    },

    async listEvents(id: string): Promise<ToolEvent[]> {
      return (await readView(id)).events;
    },

    async retry(caseId: string, ok: boolean, note?: string): Promise<RetryReceipt> {
      const op = 'POST /v1/cases/retry';
      const res = await requestOk(cfg, 'POST', '/v1/cases/retry', {
        // The handler reads `id`; `case_id` travels too so the route can adopt the name
        // the agent-facing tool already uses without another edge release. `note` is not
        // read yet either — see product/CONTRACT_REQUESTS.md.
        body: { id: caseId, case_id: caseId, ok, ...(note ? { note } : {}) },
        headers: { 'idempotency-key': `retry_${caseId}_${ok ? 'ok' : 'no'}` },
      });
      // A body-less 2xx means "recorded": claim the receipt from the arguments and keep
      // billable false, which never over-states billing, rather than failing the call.
      const parsed = retryReceiptSchema.safeParse(res.body ?? { case_id: caseId, ok, billable: false });
      if (!parsed.success) throw contractError(op, res.requestId, issueText(parsed.error));
      return retryReceiptFrom(parsed.data, caseId, ok);
    },

    watch(onChange, onError) {
      // Per-connection diff caches. They hold no case state: the backend stays the only
      // source of truth and a reconnect simply re-reads it.
      const seenRows = new Map<string, string>();
      const seenEvents = new Map<string, Set<string>>();
      const reread = new Set<string>();
      const settled = new Set<string>();
      let polling = false;
      let primed = false;
      const fail = (err: unknown): void => {
        onError?.(asDeskClientError(err));
      };
      const poll = async (): Promise<void> => {
        if (polling) return;
        polling = true;
        try {
          const { rows } = await listRows();
          const changed: string[] = [];
          const stageById = new Map<string, string>();
          for (const row of rows) {
            const id = idOf(row);
            if (id.length === 0) continue;
            stageById.set(id, stageOf(row));
            const key = JSON.stringify(row);
            if (seenRows.get(id) === key) continue;
            seenRows.set(id, key);
            changed.push(id);
          }
          // First successful read is the baseline: the console already fetches it over
          // HTTP on `ready`, so pushing it again would announce old cases as new ones.
          if (!primed) {
            primed = true;
            for (const [id, stage] of stageById) if (TERMINAL_STAGES.includes(stage)) settled.add(id);
            return;
          }
          // A case that just went terminal is read once more on the next poll: the list
          // row stops changing there, but the billing and closing events land after it.
          const due = [...new Set([...changed, ...reread])];
          reread.clear();
          for (const id of due) {
            // One read per changed case, and the ticket and its events come from that same
            // read, so the console never replaces a rich ticket with the thin list row.
            const { view, events } = await readView(id);
            onChange({ type: 'case', case: view });
            const sent = seenEvents.get(id) ?? new Set<string>();
            seenEvents.set(id, sent);
            for (const e of events) {
              if (sent.has(e.id)) continue;
              sent.add(e.id);
              onChange({ type: 'event', event: e });
            }
            const stage = stageById.get(id) ?? '';
            if (TERMINAL_STAGES.includes(stage) && !settled.has(id)) {
              settled.add(id);
              reread.add(id);
            }
          }
        } catch (err) {
          // Keep the stream open across a backend blip: report it, then poll again.
          fail(err);
        } finally {
          polling = false;
        }
      };
      void poll();
      const timer = setInterval(() => {
        void poll();
      }, cfg.pollMs);
      return () => clearInterval(timer);
    },
  };
}

async function seedFakeStore(store: DeskStore): Promise<void> {
  if (!(await store.getCase(FAKE_CASE.id))) await store.putCase(FAKE_CASE);
  if ((await store.listEvents(FAKE_CASE.id)).length === 0) {
    for (const e of FAKE_EVENTS) await store.appendEvent(e);
  }
}

function createFakeClient(cfg: DeskClientConfig): DeskClient {
  const store = cfg.store ?? createStore();
  // Seed eagerly so the console has the fixture case before anyone calls a tool, and
  // log (never swallow) a failure: fake mode has no backend to fall back on either.
  const seeded: Promise<void> = seedFakeStore(store).catch((err: unknown) => {
    console.error('[desk-client] could not seed the offline fixtures:', asDeskClientError(err).message);
  });

  const notFound = (id: string): DeskClientError =>
    new DeskClientError({
      status: 404,
      code: 'case_not_found',
      message: `No case with id ${id}. Offline mode only knows the fixtures in mcp/src/fixtures/.`,
      stage: FAKE_STAGE,
      requestId: newRequestId(),
    });

  return {
    mode: 'fake',

    async report(input: ReportInput, agentId: string): Promise<ToolReply> {
      await seeded;
      const edgeRequestId = newRequestId();
      const op = 'report_problem(fake)';
      if (input.case_id) {
        const found = await store.getCase(input.case_id);
        if (!found) throw notFound(input.case_id);
        return validateToolReply(op, toAgentReply(found), edgeRequestId, FAKE_STAGE);
      }
      if (input.request_id === FAKE_CASE.request_id) {
        // The canned demo reply, byte for byte, on every call.
        return validateToolReply(op, FAKE_TOOL_REPLY, edgeRequestId, FAKE_STAGE);
      }
      const existing = (await store.listCases()).find((c) => c.request_id === input.request_id);
      if (existing) return validateToolReply(op, toAgentReply(existing), edgeRequestId, FAKE_STAGE);
      const goal = input.goal?.trim() || `Failure reported for ${input.request_id}`;
      const created = fakeUnknownCase(input.request_id, goal, agentSlug(agentId));
      await store.putCase(created);
      return validateToolReply(op, toAgentReply(created), edgeRequestId, FAKE_STAGE);
    },

    async getCase(id: string): Promise<Case> {
      await seeded;
      const found = await store.getCase(id);
      if (!found) throw notFound(id);
      return found;
    },

    async listCases(): Promise<Case[]> {
      await seeded;
      return store.listCases();
    },

    async listEvents(id: string): Promise<ToolEvent[]> {
      await seeded;
      return store.listEvents(id);
    },

    async retry(caseId: string, ok: boolean, note?: string): Promise<RetryReceipt> {
      await seeded;
      const found = await store.getCase(caseId);
      if (!found) throw notFound(caseId);
      const proofs = found.proofs;
      const billable = ok && proofs.replay.status === 'passed' && proofs.vendor_tests.status === 'passed' && proofs.fresh_agent.status === 'passed';
      const receipt: RetryReceipt = fakeRetryReceipt(caseId, ok, billable);
      // Replay appends nothing: the receipt is the same and the console shows one row.
      const row = fakeRetryEvent(caseId, ok, billable, note);
      const already = await store.listEvents(caseId);
      if (!already.some((e) => e.id === row.id)) await store.appendEvent(row);
      return receipt;
    },

    watch(onChange) {
      return store.subscribe(onChange);
    },
  };
}

/** Build the client for this process. Overrides exist for tests; env is what production reads. */
export function createDeskClient(overrides: DeskClientOverrides = {}): DeskClient {
  const cfg = resolveConfig(overrides.env ?? process.env, overrides);
  return cfg.mode === 'fake' ? createFakeClient(cfg) : createLiveClient(cfg);
}
