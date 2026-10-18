// Deterministic offline fixtures for AHD_DESK_FAKE=1.
//
// Nothing here is random and nothing here reads the clock: the same input always
// produces the same case id, the same committed ack_by/resolve_by and the same
// verified answer, so the MCP tool can be demoed and tested with no backend, no
// ports and no processes. The data mirrors the seeded Ledgerly failure
// `req_8hT2kq` that src/data/request_log.json and web/src/data/tickets.json carry,
// with credentials and user ids left out (no secrets, no PII in fixtures).
//
// This module must not import values from desk-client.ts (that module imports this
// one); type-only imports are fine.
import { EVENT_TOPICS } from '../desk.js';
import type { Case, Proof, ToolEvent } from '../store/index.js';
import type { BackendAgentReply } from '../desk-client.js';
import type { ToolReply } from '../schemas.js';

/** Fixed clock for every fixture, so ids, timings and deadlines never move. */
export const FAKE_NOW = '2026-10-18T03:12:00.000Z';
export const FAKE_ACK_BY = '2026-10-18T03:17:00.000Z';
export const FAKE_RESOLVE_BY = '2026-10-18T04:12:00.000Z';

/** The agent help page the reply points at. Same constant src/desk.ts uses. */
export const DOCS_URL = 'https://help.ledgerly.example/agents';

export const FAKE_CASE_ID = 'ahd_01JBH4RK7Q';
export const FAKE_REQUEST_ID = 'req_8hT2kq';

// Held as typed constants because Case keeps `fix` behind its index signature: reading
// FAKE_CASE.fix back would give `unknown`, not the string the reply needs.
export const FAKE_SUMMARY =
  'Your card is valid. We reissued it to a fresh hold you can apply once. Retry checkout with the new entitlement id and the same idempotency key.';
export const FAKE_FIX_STEPS: string[] = [
  'Call POST /v1/entitlements/ent_9QX2/reissue with Idempotency-Key reiss_ent_9QX2',
  'Retry POST /v1/checkout with the returned entitlement id',
];

const passed = (detail: string, duration_ms: number): Proof => ({ status: 'passed', duration_ms, detail });
const pending = (): Proof => ({ status: 'pending', duration_ms: 0, detail: '' });

/** The flagship case: an entitlement no human would reissue at 3 a.m., answered with a bounded grant. */
export const FAKE_CASE: Case = {
  id: FAKE_CASE_ID,
  title: 'A valid one-per-person gift card will not apply at checkout, and the agent has no way to reissue it',
  stage: 'answered',
  failure_class: 'authority',
  endpoint: 'POST /v1/entitlements/{id}/apply',
  agent_id: 'agt_concierge',
  created_at: FAKE_NOW,
  ack_by: FAKE_ACK_BY,
  resolve_by: FAKE_RESOLVE_BY,
  acked_at: '2026-10-18T03:12:01.000Z',
  resolved_at: '2026-10-18T03:31:04.000Z',
  queue_position: 1,
  sla: 'blocked_order',
  goal: 'Apply the gift card and place the order.',
  tried: 'Retried POST /v1/checkout twice with the same Idempotency-Key.',
  request_id: FAKE_REQUEST_ID,
  mode: 'approve_first',
  risk: 'high',
  change_type: 'grant',
  affected_agents: 38,
  request: {
    method: 'POST',
    url: 'https://api.ledgerly.example/v1/entitlements/ent_9QX2/apply',
    headers: { 'AHD-Agent-Id': 'agt_concierge', 'Idempotency-Key': 'chk_77a1', 'Content-Type': 'application/json' },
    body: { order_id: 'ord_5521', amount: 3000, currency: 'usd' },
  },
  response: {
    status: 409,
    headers: { 'Request-Id': FAKE_REQUEST_ID },
    body: {
      error: { code: 'entitlement_hold_conflict', message: 'This one-per-person entitlement is already on a stale hold.' },
      help: { desk: DOCS_URL, tool: 'report_problem', request_id: FAKE_REQUEST_ID },
    },
  },
  cause: 'The hold from the first attempt never expired, and reissuing needs an authority the agent does not have.',
  fix: {
    kind: 'grant',
    summary: 'Publish entitlements.reissue behind an authority envelope: one reissue per user, $30 cap per case, idempotency key required.',
    file: 'authority/entitlements.reissue.json',
    diff: [
      '+{',
      '+  "verb": "POST /v1/entitlements/{id}/reissue",',
      '+  "enabled": true,',
      '+  "envelope": { "per_user": 1, "cap_usd_per_case": 30, "idempotency_key": "required" },',
      '+  "writes_receipt": true',
      '+}',
    ],
    reply_text: FAKE_SUMMARY,
  },
  proofs: {
    replay: passed('Replayed the failing apply inside the vendor sandbox: 409 before the change, 200 after.', 1840),
    vendor_tests: passed("The vendor's own entitlement tests pass on the patched branch.", 42_100),
    fresh_agent: passed('A clean-context agent completed checkout with the patched docs and no hints.', 96_500),
  },
  grants: [
    {
      id: 'grt_01JBH5',
      verb: 'entitlements.reissue',
      status: 'issued',
      cap_usd: 30,
      per_user: 1,
      spent_usd: 0,
      idempotency_key: 'reiss_ent_9QX2',
      receipt: 'rcpt_01JBH5',
    },
  ],
  price_usd: 1,
  billed: true,
  reply: {
    type: 'problem/entitlement-hold-conflict',
    title: 'Your gift card is valid; the hold is stale',
    status: 409,
    retryable: true,
    fix_steps: FAKE_FIX_STEPS,
    tested: { replay: true, vendor_tests: true, fresh_agent: true },
    authority: { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 },
    regression_test_id: 'rt_0004',
    audit_receipt: 'ahd_audit_01JBH4RK7Q',
  },
  outcome: { action: 'entitlements.reissue', agent_retry_ok: true },
};

/** What report_problem returns offline. Identical on every call: that is the point of fake mode. */
export const FAKE_TOOL_REPLY: ToolReply = {
  case_id: FAKE_CASE_ID,
  status: 'answered',
  ack_by: FAKE_ACK_BY,
  resolve_by: FAKE_RESOLVE_BY,
  queue_position: 1,
  answer: {
    summary: FAKE_SUMMARY,
    fix_steps: FAKE_FIX_STEPS,
    docs: DOCS_URL,
    tested: { replay: true, vendor_tests: true, fresh_agent: true },
  },
  outcome: { action: 'entitlements.reissue', agent_retry_ok: true },
  authority: { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 },
  events: [...EVENT_TOPICS],
};

/** The same case as the backend service would return it (product/shared/types.ts AgentReply). */
export const FAKE_BACKEND_REPLY: BackendAgentReply = {
  type: 'problem/entitlement-hold-conflict',
  title: 'Your gift card is valid; the hold is stale',
  status: 409,
  retryable: true,
  fix_steps: FAKE_FIX_STEPS,
  snippet: FAKE_SUMMARY,
  tested: { replay: true, vendor_tests: true, fresh_agent: true },
  regression_test_id: 'rt_0004',
  case_id: FAKE_CASE_ID,
  ack_by: FAKE_ACK_BY,
  resolve_by: FAKE_RESOLVE_BY,
  queue_position: 1,
  outcome: { action: 'entitlements.reissue', agent_retry_ok: true, billable: true },
  authority: { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 },
  // The last entry is not a topic this server advertises: the edge must drop it, not fail on it.
  events: ['case.acknowledged', 'case.resolved', 'internal.proof.passed'],
  audit_receipt: 'ahd_audit_01JBH4RK7Q',
  stage: 'answered',
};

/** The tool_events rows the console renders for the fixture case. */
export const FAKE_EVENTS: ToolEvent[] = [
  {
    id: 'ev_fx_401', ticket_id: FAKE_CASE_ID, stage: 'opened', tool: 'Manufact', action: 'report_problem.received',
    t_ms: 0, d_ms: 380, result: 'ok',
    payload: { mcp_server: 'ledgerly-desk.manufact.app', client: 'hark-concierge/2.4', request_id: FAKE_REQUEST_ID, goal: FAKE_CASE.goal },
  },
  {
    id: 'ev_fx_402', ticket_id: FAKE_CASE_ID, stage: 'opened', tool: 'AgentHelpDesk', action: 'case.acknowledged',
    t_ms: 400, d_ms: 1, result: 'returned',
    payload: { topic: 'case.acknowledged', case_id: FAKE_CASE_ID, ack_by: FAKE_ACK_BY, resolve_by: FAKE_RESOLVE_BY, queue_position: 1 },
  },
  {
    id: 'ev_fx_403', ticket_id: FAKE_CASE_ID, stage: 'reproducing', tool: 'AgentHelpDesk', action: 'request_log.lookup',
    t_ms: 1200, d_ms: 40, result: 'found', payload: { request_id: FAKE_REQUEST_ID, status: 409, code: 'entitlement_hold_conflict' },
  },
  {
    id: 'ev_fx_404', ticket_id: FAKE_CASE_ID, stage: 'reproducing', tool: 'Blaxel', action: 'sandbox.reproduce',
    t_ms: 2400, d_ms: 1840, result: 'reproduced', payload: { sandbox: `ahd-${FAKE_CASE_ID}`, exit_code: 0, observed: 409 },
  },
  {
    id: 'ev_fx_405', ticket_id: FAKE_CASE_ID, stage: 'fix_drafted', tool: 'AgentHelpDesk', action: 'fix.drafted',
    t_ms: 5200, d_ms: 2100, result: 'drafted', payload: { kind: 'grant', file: 'authority/entitlements.reissue.json' },
  },
  {
    id: 'ev_fx_406', ticket_id: FAKE_CASE_ID, stage: 'proving', tool: 'Blaxel', action: 'proof.replay',
    t_ms: 8100, d_ms: 1840, result: 'passed', payload: { proof: 'replay', before: 409, after: 200 },
  },
  {
    id: 'ev_fx_407', ticket_id: FAKE_CASE_ID, stage: 'proving', tool: 'Blaxel', action: 'proof.vendor_tests',
    t_ms: 12_400, d_ms: 42_100, result: 'passed', payload: { proof: 'vendor_tests', passed: 148, failed: 0 },
  },
  {
    id: 'ev_fx_408', ticket_id: FAKE_CASE_ID, stage: 'proving', tool: 'AgentHelpDesk', action: 'proof.fresh_agent',
    t_ms: 55_000, d_ms: 96_500, result: 'passed', payload: { proof: 'fresh_agent', clean_context: true },
  },
  {
    id: 'ev_fx_409', ticket_id: FAKE_CASE_ID, stage: 'awaiting_approval', tool: 'Inkbox', action: 'gate.approval',
    t_ms: 152_000, d_ms: 900, result: 'approved', gate: true, payload: { channel: 'text', approver: 'on-call@ledgerly.example', decision: 'yes' },
  },
  {
    id: 'ev_fx_410', ticket_id: FAKE_CASE_ID, stage: 'answered', tool: 'AgentHelpDesk', action: 'grant.issued',
    t_ms: 153_200, d_ms: 60, result: 'issued', after_gate: true,
    payload: { grant_id: 'grt_01JBH5', verb: 'entitlements.reissue', cap_usd: 30, per_user: 1, idempotency_key: 'reiss_ent_9QX2', receipt: 'rcpt_01JBH5' },
  },
  {
    id: 'ev_fx_411', ticket_id: FAKE_CASE_ID, stage: 'answered', tool: 'AgentHelpDesk', action: 'case.resolved',
    t_ms: 154_000, d_ms: 4, result: 'resolved', after_gate: true,
    payload: { topic: 'case.resolved', case_id: FAKE_CASE_ID, regression_test_id: 'rt_0004' },
  },
  {
    id: 'ev_fx_412', ticket_id: FAKE_CASE_ID, stage: 'shipped', tool: 'Stripe', action: 'meter_event.created',
    t_ms: 155_000, d_ms: 220, result: 'recorded', after_gate: true, cost_usd: 1,
    payload: { event_name: 'agenthelpdesk.verified_fix', identifier: `verified_${FAKE_CASE_ID}`, value: 1, mode: 'test' },
  },
];

const slug = (raw: string): string => raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'unknown';
const plusMinutes = (isoDate: string, minutes: number): string => new Date(Date.parse(isoDate) + minutes * 60_000).toISOString();

/**
 * The case fake mode opens for a request id it has no fixture for: acknowledged and
 * queued, with no answer yet, exactly like the real desk before it has proved anything.
 * Deterministic per request id, so a repeated call replays the same case.
 */
export function fakeUnknownCase(requestId: string, goal: string, agentId: string): Case {
  return {
    id: `ahd_fx_${slug(requestId)}`,
    title: goal,
    stage: 'opened',
    failure_class: 'knowledge',
    endpoint: 'Unknown endpoint',
    agent_id: agentId,
    created_at: FAKE_NOW,
    ack_by: plusMinutes(FAKE_NOW, 15),
    resolve_by: plusMinutes(FAKE_NOW, 240),
    queue_position: 2,
    sla: 'default',
    goal,
    tried: '',
    request_id: requestId,
    mode: 'approve_first',
    risk: 'medium',
    change_type: 'docs',
    affected_agents: 1,
    request: { headers: {}, body: null },
    response: { headers: { 'Request-Id': requestId }, body: null },
    cause: 'Not known yet. Offline mode has no backend to reproduce this against.',
    fix: { kind: 'none', summary: '', file: '', diff: [], reply_text: '' },
    proofs: { replay: pending(), vendor_tests: pending(), fresh_agent: pending() },
    grants: [],
    price_usd: 1,
  };
}

/** The retry receipt fake mode returns: deterministic, and billable only when the proofs passed. */
export function fakeRetryReceipt(caseId: string, ok: boolean, billable: boolean): { case_id: string; ok: boolean; billable: boolean; outcome_id: string; receipt: string } {
  return { case_id: caseId, ok, billable, outcome_id: `out_fx_${slug(caseId)}`, receipt: `rcpt_fx_${slug(caseId)}_${ok ? 'ok' : 'no'}` };
}

/** The tool_events row fake mode appends when an agent reports its retry result. */
export function fakeRetryEvent(caseId: string, ok: boolean, billable: boolean, note?: string): ToolEvent {
  return {
    id: `ev_fx_retry_${slug(caseId)}_${ok ? 'ok' : 'no'}`,
    ticket_id: caseId,
    stage: ok ? 'shipped' : 'failed_proof',
    tool: 'AgentHelpDesk',
    action: 'agent_retry.reported',
    t_ms: 156_000,
    d_ms: 2,
    result: ok ? 'ok' : 'failed',
    payload: {
      agent_retry_ok: ok,
      billable,
      rule: 'billable only when all three proofs passed AND the agent retry succeeded',
      ...(note ? { note } : {}),
    },
  };
}
