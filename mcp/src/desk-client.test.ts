// Tests for the MCP edge's backend client, FAKE mode only.
//
// No ports, no child processes, no clock dependence: fake mode reads the fixtures in
// src/fixtures/ into an in-memory store, and the loud-error path is tested by calling
// the pure error mappers directly (the machine rule forbids running node processes, so
// nothing here may point AHD_DESK_URL at a closed port and wait for a refusal).
//
// Run with: node --experimental-strip-types --test src/desk-client.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeskClientError,
  UPSTREAM_STAGE,
  asDeskClientError,
  createDeskClient,
  errorFromResponse,
  errorFromTransport,
  resolveConfig,
  retryReceiptFrom,
  toConsoleCase,
  toConsoleEvent,
  toolReplyFromCase,
  toToolReply,
  validateToolReply,
  validationError,
  type BackendAgentReply,
  type BackendEventRow,
  type DeskClient,
} from './desk-client.js';
import { memoryStore } from './store/index.js';
import { EVENT_TOPICS } from './desk.js';
import { reportOutputSchema } from './schemas.js';
import { DOCS_URL, FAKE_CASE_ID, FAKE_FIX_STEPS, FAKE_REQUEST_ID, FAKE_SUMMARY, FAKE_TOOL_REPLY } from './fixtures/index.js';

/** Hermetic client: explicit env {} so an ambient AHD_DESK_URL cannot change the test. */
function fakeClient(): DeskClient {
  return createDeskClient({ env: {}, mode: 'fake', store: memoryStore() });
}

const upstream = { baseUrl: 'http://127.0.0.1:8787', timeoutMs: 5000 };

describe('resolveConfig', () => {
  test('defaults to live mode against the local backend with a 5s timeout', () => {
    const cfg = resolveConfig({});
    assert.equal(cfg.mode, 'live');
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:8787');
    assert.equal(cfg.timeoutMs, 5000);
  });

  test('AHD_DESK_FAKE=1 selects fake mode and nothing else does', () => {
    assert.equal(resolveConfig({ AHD_DESK_FAKE: '1' }).mode, 'fake');
    assert.equal(resolveConfig({ AHD_DESK_FAKE: '0' }).mode, 'live');
    assert.equal(resolveConfig({ AHD_DESK_FAKE: '' }).mode, 'live');
  });

  test('AHD_DESK_URL is honoured and its trailing slash trimmed', () => {
    assert.equal(resolveConfig({ AHD_DESK_URL: 'http://10.0.0.4:9000/' }).baseUrl, 'http://10.0.0.4:9000');
  });

  test('a bad AHD_DESK_URL or timeout fails loud at config stage, not on the first call', () => {
    for (const env of [
      { AHD_DESK_URL: 'not a url' },
      { AHD_DESK_URL: 'ftp://127.0.0.1:8787' },
      { AHD_DESK_TIMEOUT_MS: 'soon' },
      { AHD_DESK_TIMEOUT_MS: '-1' },
    ]) {
      assert.throws(
        () => resolveConfig(env),
        (err: unknown) => err instanceof DeskClientError && err.code === 'bad_config' && err.stage === 'mcp.config',
      );
    }
  });
});

describe('report_problem in fake mode', () => {
  test('returns the canned reply: tested{} plus committed ack_by and resolve_by', async () => {
    const reply = await fakeClient().report({ request_id: FAKE_REQUEST_ID, goal: 'Apply the gift card and place the order.' }, 'hark-concierge/2.4');

    assert.equal(reply.case_id, FAKE_CASE_ID);
    assert.equal(reply.status, 'answered');
    assert.equal(typeof reply.ack_by, 'string');
    assert.equal(typeof reply.resolve_by, 'string');
    assert.ok(Number.isFinite(Date.parse(reply.ack_by ?? '')), 'ack_by must be a timestamp an agent can schedule against');
    assert.ok(Number.isFinite(Date.parse(reply.resolve_by ?? '')), 'resolve_by must be a timestamp an agent can schedule against');
    assert.deepEqual(reply.answer?.tested, { replay: true, vendor_tests: true, fresh_agent: true });
    assert.equal(reply.answer?.summary, FAKE_SUMMARY);
    assert.deepEqual(reply.answer?.fix_steps, FAKE_FIX_STEPS);
    assert.equal(reply.answer?.docs, DOCS_URL);
    assert.deepEqual(reply.authority, { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 });
    assert.deepEqual(reply.events, [...EVENT_TOPICS]);
    assert.equal(reply.wait, undefined, 'an answered case does not ask the agent to poll');
  });

  test('the canned reply satisfies the outputSchema an installed agent parses', async () => {
    const reply = await fakeClient().report({ request_id: FAKE_REQUEST_ID, goal: 'Apply the gift card.' }, 'claude-code/2.1');
    assert.equal(reportOutputSchema.safeParse(reply).success, true);
    // JSON round-trip so an absent optional key cannot masquerade as an explicit undefined.
    assert.deepEqual(JSON.parse(JSON.stringify(reply)), JSON.parse(JSON.stringify(FAKE_TOOL_REPLY)));
  });

  test('a repeat report of the same request id replays the same case and bills nothing new', async () => {
    const desk = fakeClient();
    const first = await desk.report({ request_id: FAKE_REQUEST_ID, goal: 'Apply the gift card.' }, 'hark-concierge/2.4');
    const second = await desk.report({ request_id: FAKE_REQUEST_ID, goal: 'Apply the gift card.' }, 'hark-concierge/2.4');
    assert.deepEqual(second, first);
    assert.equal(second.case_id, FAKE_CASE_ID);
  });

  test('case_id alone polls the case instead of opening one', async () => {
    const reply = await fakeClient().report({ request_id: 'req_ignored', case_id: FAKE_CASE_ID }, 'codex-cli/0.48');
    assert.equal(reply.case_id, FAKE_CASE_ID);
    assert.equal(reply.status, 'answered');
  });

  test('an unknown request id gets an acknowledged case with no answer yet, and a wait to poll on', async () => {
    const desk = fakeClient();
    const reply = await desk.report({ request_id: 'req_fx_unknown_1', goal: 'Post the entry to the ledger.' }, 'cursor-agent/1.9');
    assert.equal(reply.case_id, 'ahd_fx_req_fx_unknown_1');
    assert.equal(reply.status, 'opened');
    assert.equal(reply.answer, undefined);
    assert.equal(reply.wait, 30);
    assert.equal(typeof reply.ack_by, 'string');
    assert.equal(typeof reply.resolve_by, 'string');

    // Deterministic: the same request id replays the same case, it does not queue a second one.
    const again = await desk.report({ request_id: 'req_fx_unknown_1', goal: 'Post the entry to the ledger.' }, 'cursor-agent/1.9');
    assert.equal(again.case_id, reply.case_id);
    assert.equal((await desk.listCases()).filter((c) => c.request_id === 'req_fx_unknown_1').length, 1);
  });

  test('an unknown case id fails loud instead of returning an empty case', async () => {
    await assert.rejects(
      () => fakeClient().report({ request_id: 'req_fx_unknown_2', case_id: 'ahd_does_not_exist' }, 'codex-cli/0.48'),
      (err: unknown) => {
        assert.ok(err instanceof DeskClientError);
        const body = err.toEnvelope();
        assert.equal(body.error.code, 'case_not_found');
        assert.equal(body.error.stage, 'mcp.fake');
        assert.equal(err.status, 404);
        assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'request_id', 'stage']);
        return true;
      },
    );
  });

  test('the fixtures are seeded into the store so the console routes work offline', async () => {
    const desk = fakeClient();
    await desk.report({ request_id: FAKE_REQUEST_ID, goal: 'Apply the gift card.' }, 'hark-concierge/2.4');
    const cases = await desk.listCases();
    assert.ok(cases.some((c) => c.id === FAKE_CASE_ID));
    const events = await desk.listEvents(FAKE_CASE_ID);
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.ticket_id === FAKE_CASE_ID));
    assert.deepEqual(
      events.map((e) => e.action).slice(0, 2),
      ['report_problem.received', 'case.acknowledged'],
    );
    const fetched = await desk.getCase(FAKE_CASE_ID);
    assert.equal(fetched.stage, 'answered');
    assert.equal(fetched.proofs.replay.status, 'passed');
  });
});

describe('report_retry_result in fake mode', () => {
  test('a successful retry on a fully proved case is billable and returns a receipt', async () => {
    const desk = fakeClient();
    const receipt = await desk.retry(FAKE_CASE_ID, true);
    assert.equal(receipt.case_id, FAKE_CASE_ID);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.billable, true);
    assert.equal(typeof receipt.receipt, 'string');
  });

  test('a replayed retry returns the same receipt and writes no second event', async () => {
    const desk = fakeClient();
    const first = await desk.retry(FAKE_CASE_ID, true);
    const before = (await desk.listEvents(FAKE_CASE_ID)).length;
    const second = await desk.retry(FAKE_CASE_ID, true);
    assert.deepEqual(second, first);
    assert.equal((await desk.listEvents(FAKE_CASE_ID)).length, before);
  });

  test('a failed retry is never billable', async () => {
    const receipt = await fakeClient().retry(FAKE_CASE_ID, false, 'still 409 on the second attempt');
    assert.equal(receipt.ok, false);
    assert.equal(receipt.billable, false);
  });
});

describe('the loud upstream error (mappers, no network)', () => {
  test('an unreachable backend yields a machine-readable envelope naming stage mcp.upstream', () => {
    const err = errorFromTransport('POST /v1/cases', new TypeError('fetch failed'), upstream);
    const body = err.toEnvelope();
    assert.equal(body.error.stage, UPSTREAM_STAGE);
    assert.equal(body.error.stage, 'mcp.upstream');
    assert.equal(body.error.code, 'upstream_unreachable');
    assert.equal(err.status, 502);
    assert.ok(body.error.message.includes('http://127.0.0.1:8787'), 'the message must name the backend it could not reach');
    assert.ok(body.error.message.includes('fetch failed'), 'the message must carry the transport cause');
    assert.ok(body.error.message.includes('AHD_DESK_FAKE=1'), 'the message must say how to get the offline demo instead');
    assert.equal(typeof body.error.request_id, 'string');
    assert.ok(body.error.request_id.length > 0);
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'request_id', 'stage']);
  });

  test('a backend that hangs yields upstream_timeout at 504', () => {
    const timedOut = new Error('The operation was aborted due to timeout');
    timedOut.name = 'TimeoutError';
    const err = errorFromTransport('GET /v1/cases', timedOut, upstream);
    assert.equal(err.code, 'upstream_timeout');
    assert.equal(err.status, 504);
    assert.equal(err.stage, 'mcp.upstream');
    assert.ok(err.message.includes('5000ms'));
  });

  test("a backend error envelope is passed through with its own code, stage and request_id", () => {
    const err = errorFromResponse('POST /v1/cases', {
      status: 422,
      requestId: 'edge-generated',
      body: { error: { code: 'unreproducible', message: 'could not replay the failure', stage: 'sandbox.exec', request_id: 'backend-123' } },
    });
    assert.equal(err.code, 'unreproducible');
    assert.equal(err.stage, 'sandbox.exec');
    assert.equal(err.status, 422);
    assert.equal(err.toEnvelope().error.request_id, 'backend-123');
    assert.ok(err.message.includes('POST /v1/cases'), 'the message must say which call failed');
    assert.ok(err.message.includes('could not replay the failure'));
  });

  test('a non-envelope failure says so rather than inventing a reason', () => {
    const err = errorFromResponse('GET /v1/cases', { status: 500, requestId: 'edge-1', body: '<html>bad gateway</html>' });
    assert.equal(err.code, 'upstream_error');
    assert.equal(err.stage, 'mcp.upstream');
    assert.equal(err.status, 500);
    assert.ok(err.message.includes('no error envelope'));
  });

  test('a missing case maps to case_not_found so the edge can answer 404', () => {
    const err = errorFromResponse('GET /v1/cases', { status: 404, requestId: 'edge-2', body: null });
    assert.equal(err.code, 'case_not_found');
    assert.equal(err.status, 404);
  });

  test('an unknown HTTP status is normalised into one the edge is allowed to send', () => {
    assert.equal(errorFromResponse('GET /v1/cases', { status: 599, requestId: 'edge-3', body: null }).status, 502);
    assert.equal(errorFromResponse('GET /v1/cases', { status: 418, requestId: 'edge-4', body: null }).status, 400);
  });

  test('anything thrown inside the edge becomes the same envelope, never a bare string', () => {
    const wrapped = asDeskClientError(new Error('boom'));
    assert.equal(wrapped.code, 'edge_internal');
    assert.equal(wrapped.stage, 'mcp.edge');
    assert.equal(wrapped.status, 500);
    assert.ok(wrapped.message.includes('boom'));
    const original = errorFromTransport('POST /v1/cases', new TypeError('fetch failed'), upstream);
    assert.equal(asDeskClientError(original), original);
    assert.equal(asDeskClientError('a string').stage, 'mcp.edge');
    assert.equal(validationError('request_id: Required').status, 400);
    assert.equal(validationError('request_id: Required').code, 'invalid_input');
  });

  test('a backend payload that breaks the tool contract is refused, not reshaped silently', () => {
    assert.throws(
      () => validateToolReply('POST /v1/cases', { case_id: 'ahd_1', ack_by: 'tomorrow' }, 'edge-5'),
      (err: unknown) => err instanceof DeskClientError && err.code === 'upstream_contract' && err.stage === 'mcp.upstream',
    );
  });

  test('live mode is the default, so an absent backend is an error and never fake data', () => {
    const desk = createDeskClient({ env: {} });
    assert.equal(desk.mode, 'live');
  });
});

describe('toToolReply: backend AgentReply -> report_problem outputSchema', () => {
  const base: BackendAgentReply = {
    case_id: 'ahd_01JBH4RK7Q',
    ack_by: '2026-10-18T03:17:00.000Z',
    resolve_by: '2026-10-18T04:12:00.000Z',
    queue_position: 1,
  };

  test('three passed proofs answer the case and carry the executable outcome and envelope', () => {
    const reply = toToolReply({
      ...base,
      title: 'Your gift card is valid; the hold is stale',
      snippet: FAKE_SUMMARY,
      fix_steps: FAKE_FIX_STEPS,
      tested: { replay: true, vendor_tests: true, fresh_agent: true },
      outcome: { action: 'entitlements.reissue', agent_retry_ok: true },
      authority: { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 },
      events: ['case.acknowledged', 'case.resolved', 'internal.proof.passed'],
    });
    assert.equal(reply.status, 'answered');
    assert.equal(reply.answer?.summary, FAKE_SUMMARY);
    assert.equal(reply.answer?.docs, DOCS_URL);
    assert.deepEqual(reply.answer?.tested, { replay: true, vendor_tests: true, fresh_agent: true });
    assert.deepEqual(reply.outcome, { action: 'entitlements.reissue', agent_retry_ok: true });
    assert.deepEqual(reply.authority, { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 });
    // The outputSchema is an enum, so an unadvertised backend topic is dropped, not fatal.
    assert.deepEqual(reply.events, ['case.acknowledged', 'case.resolved']);
    assert.equal(reply.wait, undefined);
    assert.equal(reportOutputSchema.safeParse(reply).success, true);
  });

  test('a case still being proved reports working, with no answer and a wait to poll on', () => {
    const reply = toToolReply({ ...base, tested: { replay: true, vendor_tests: false, fresh_agent: false }, events: [] });
    assert.equal(reply.status, 'working');
    assert.equal(reply.answer, undefined);
    assert.equal(reply.outcome, undefined);
    assert.equal(reply.wait, 30);
    assert.deepEqual(reply.events, [...EVENT_TOPICS], 'with nothing recognised, advertise every topic');
    assert.equal(reportOutputSchema.safeParse(reply).success, true);
  });

  test('the backend stage wins over the proof heuristic, including handoff', () => {
    assert.equal(toToolReply({ ...base, stage: 'awaiting_approval', tested: { replay: true, vendor_tests: true, fresh_agent: true } }).status, 'working');
    assert.equal(toToolReply({ ...base, stage: 'escalated' }).status, 'handed_off');
    assert.equal(toToolReply({ ...base, stage: 'shipped', tested: { replay: true, vendor_tests: true, fresh_agent: true } }).status, 'answered');
  });

  test('a backend wait is passed through instead of the default', () => {
    assert.equal(toToolReply({ ...base, stage: 'opened', wait: 90 }).wait, 90);
  });
});

// The shapes below are the ones product/desk/register.ts really answers with: a CaseView
// for GET /v1/cases?id=, a bare Failure inside GET /v1/cases' {cases: [...]}, the intake
// answer for POST /v1/cases and the settled outcome for POST /v1/cases/retry.

describe('the backend payload mappers (pure, no network)', () => {
  const createdAt = '2026-10-18T03:12:00.000Z';
  const createdMs = Date.parse(createdAt);
  const ackBy = '2026-10-18T03:17:00.000Z';
  const resolveBy = '2026-10-18T04:12:00.000Z';

  const failure = {
    id: 'c_9f2a1c',
    vendor_id: 'ledgerly',
    agent_id: 'agt_hark_concierge',
    task: 'Apply the gift card and place the order.',
    request: {
      request_id: FAKE_REQUEST_ID,
      tried: 'Applied the entitlement three times.',
      contact: 'operator@concierge.example',
      method: 'POST',
      path: '/v1/entitlements/ent_9QX2/apply',
    },
    response: { status: 409, headers: { 'Request-Id': FAKE_REQUEST_ID }, body: { error: { code: 'entitlement_hold_conflict' } } },
    klass: 'authority',
    status: 'answered',
    ack_by: ackBy,
    resolve_by: resolveBy,
    queue_position: 1,
    created_at: createdAt,
  };

  const storedReply = {
    type: 'authority',
    title: 'Your card is valid; the hold is stale',
    status: 409,
    retryable: true,
    fix_steps: FAKE_FIX_STEPS,
    snippet: FAKE_SUMMARY,
    tested: { replay: true, vendor_tests: true, fresh_agent: true },
    regression_test_id: 'rt_c_9f2a1c',
    case_id: 'c_9f2a1c',
    ack_by: ackBy,
    resolve_by: resolveBy,
    queue_position: 1,
    outcome: { action: 'entitlements.reissue', agent_retry_ok: true },
    authority: { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 },
    events: ['case.acknowledged', 'case.resolved'],
    audit_receipt: 'ahd_audit_9f2a1c',
  };

  const view = {
    case: failure,
    status: 'answered',
    vendor_id: 'ledgerly',
    klass: 'authority',
    ack_by: ackBy,
    resolve_by: resolveBy,
    queue_position: 1,
    sla_breached: false,
    billable: true,
    attempt: {
      id: 'att_1',
      diff: '+  "enabled": true',
      proof_replay: true,
      proof_vendor_tests: true,
      proof_fresh_agent: true,
      log_url: 'https://logs.example/att_1',
    },
    outcome: { id: 'out_1', shipped_as: 'grant', agent_retry_ok: true, billable: true, payer: 'vendor' },
    grant: {
      id: 'grt_1',
      verb: 'entitlements.reissue',
      idempotency_key: 'reiss_ent_9QX2',
      receipt: 'ahd_grant_1',
      spent: false,
      envelope: { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 },
    },
    approval: null,
    reply: storedReply,
    events: [
      {
        id: 'evt_1',
        ticket_id: 'c_9f2a1c',
        stage: 'opened',
        tool: 'desk',
        action: 'case.acknowledged',
        t_ms: createdMs + 1000,
        d_ms: 1,
        result: 'ok',
        payload: { queue_position: 1 },
        at: new Date(createdMs + 1000).toISOString(),
      },
      {
        id: 'evt_2',
        ticket_id: 'c_9f2a1c',
        stage: 'billing',
        tool: 'stripe',
        action: 'billing.billable',
        t_ms: 4200,
        d_ms: 3,
        result: 'ok',
        payload: { lane: 'b2b_meter' },
        at: new Date(createdMs + 4200).toISOString(),
      },
    ],
    // A console field the backend does not model: it must survive untouched.
    cause: 'The hold was re-extended, so checkout still references a stale hold id.',
  };

  test('a CaseView becomes the ticket the console renders, with nothing invented', () => {
    const c = toConsoleCase(view, 'GET /v1/cases', 'req-view');
    assert.equal(c.id, 'c_9f2a1c');
    assert.equal(c.title, failure.task, 'Failure has no title, so the task is the title');
    assert.equal(c.stage, 'answered');
    assert.equal(c.failure_class, 'authority');
    assert.equal(c.endpoint, 'POST /v1/entitlements/ent_9QX2/apply', 'derived from the request the agent reported');
    assert.equal(c.goal, failure.task);
    assert.equal(c.tried, 'Applied the entitlement three times.');
    assert.equal(c.contact, 'operator@concierge.example');
    assert.equal(c.request_id, FAKE_REQUEST_ID);
    assert.equal(c.sla, 'blocked_order', 'a 5m/1h committed window is the console blocked_order class');
    assert.equal(c.created_at, createdAt);
    assert.equal(c.ack_by, ackBy);
    assert.equal(c.resolve_by, resolveBy);
    assert.deepEqual(c.response, { status: 409, headers: { 'Request-Id': FAKE_REQUEST_ID }, body: { error: { code: 'entitlement_hold_conflict' } } });
    assert.deepEqual(
      [c.proofs.replay.status, c.proofs.vendor_tests.status, c.proofs.fresh_agent.status],
      ['passed', 'passed', 'passed'],
    );
    assert.deepEqual(c.outcome, { action: 'entitlements.reissue', agent_retry_ok: true }, 'the grant verb names the action');
    const grants = c.grants as Record<string, unknown>[];
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.status, 'issued');
    assert.equal(grants[0]?.cap_usd, 30);
    assert.equal(grants[0]?.per_user, 1);
    assert.equal(grants[0]?.receipt, 'ahd_grant_1');
    assert.equal(c.billed, true);
    assert.equal(c.reply?.title, storedReply.title);
    assert.equal(c.proof_log_url, 'https://logs.example/att_1');
    const fix = c.fix as { diff: string[]; reply_text: string };
    assert.deepEqual(fix.diff, ['+  "enabled": true']);
    assert.equal(fix.reply_text, FAKE_SUMMARY);
    assert.equal(c.cause, view.cause, 'unknown console-shaped fields are carried through');
    assert.equal(c.attempt, undefined, 'nested backend objects are mapped, not copied');
  });

  test('backend events are rebased to ms since the case opened, and unknown stages fall back', () => {
    const ack = toConsoleEvent(view.events[0] as BackendEventRow, 'c_9f2a1c', 'answered', createdMs);
    assert.equal(ack.t_ms, 1000, 'product/ writes an epoch; the console adds t_ms to created_at');
    assert.equal(ack.stage, 'opened');
    assert.equal(ack.action, 'case.acknowledged');
    const billing = toConsoleEvent(view.events[1] as BackendEventRow, 'c_9f2a1c', 'answered', createdMs);
    assert.equal(billing.t_ms, 4200, 'an already-relative t_ms is passed through');
    assert.equal(billing.stage, 'answered', "'billing' is not a console stage, so the case's own stage stands");
    assert.deepEqual(billing.payload, { lane: 'b2b_meter' });
  });

  test('a stored AgentReply is the desk wording an agent polls, with the view supplying the stage', () => {
    const reply = toolReplyFromCase(view, 'GET /v1/cases', 'req-poll');
    assert.equal(reply.case_id, 'c_9f2a1c');
    assert.equal(reply.status, 'answered');
    assert.equal(reply.answer?.summary, FAKE_SUMMARY);
    assert.deepEqual(reply.answer?.fix_steps, FAKE_FIX_STEPS);
    assert.equal(reply.answer?.docs, DOCS_URL);
    assert.deepEqual(reply.answer?.tested, { replay: true, vendor_tests: true, fresh_agent: true });
    assert.deepEqual(reply.outcome, { action: 'entitlements.reissue', agent_retry_ok: true });
    assert.deepEqual(reply.authority, { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 });
    assert.deepEqual(reply.events, ['case.acknowledged', 'case.resolved']);
    assert.equal(reply.wait, undefined);
    assert.equal(reportOutputSchema.safeParse(reply).success, true);
  });

  test('the intake answer gives committed times at once, with a wait to poll on', () => {
    const posted = {
      case_id: 'c_new1',
      ack_by: ackBy,
      resolve_by: resolveBy,
      queue_position: 3,
      status: 'opened',
      case: { id: 'c_new1', created_at: createdAt },
      run: 'background',
      poll: '/v1/cases?id=c_new1',
    };
    const reply = toolReplyFromCase(posted, 'POST /v1/cases', 'req-post');
    assert.equal(reply.case_id, 'c_new1');
    assert.equal(reply.status, 'opened');
    assert.equal(reply.ack_by, ackBy);
    assert.equal(reply.resolve_by, resolveBy);
    assert.equal(reply.queue_position, 3);
    assert.equal(reply.answer, undefined, 'nothing is answered yet, so nothing is claimed');
    assert.equal(reply.wait, 30);
    assert.deepEqual(reply.events, [...EVENT_TOPICS], 'no recorded topics yet, so every topic stays advertised');
    assert.equal(reportOutputSchema.safeParse(reply).success, true);
  });

  test('a case with no stored reply yet still reports its proofs, outcome and recorded topics', () => {
    const working = {
      case: { ...failure, status: 'proving' },
      status: 'proving',
      ack_by: ackBy,
      resolve_by: resolveBy,
      queue_position: 1,
      attempt: { id: 'att_2', proof_replay: true, proof_vendor_tests: true, proof_fresh_agent: false },
      reply: null,
      events: [{ id: 'evt_3', stage: 'opened', tool: 'desk', action: 'case.acknowledged', t_ms: createdMs, d_ms: 0, result: 'ok', payload: null }],
    };
    const reply = toolReplyFromCase(working, 'GET /v1/cases', 'req-working');
    assert.equal(reply.status, 'working');
    assert.equal(reply.answer, undefined);
    assert.equal(reply.wait, 30);
    assert.deepEqual(reply.events, ['case.acknowledged'], 'only the topic really recorded is advertised');
  });

  test('a bare Failure from the list maps too, with proofs pending and nothing billed', () => {
    const c = toConsoleCase({ ...failure, status: 'opened' }, 'GET /v1/cases', 'req-list');
    assert.equal(c.id, 'c_9f2a1c');
    assert.equal(c.stage, 'opened');
    assert.deepEqual(
      [c.proofs.replay.status, c.proofs.vendor_tests.status, c.proofs.fresh_agent.status],
      ['pending', 'pending', 'pending'],
    );
    assert.equal(c.fix, undefined);
    assert.equal(c.billed, false);
  });

  test('a case payload with no id or created_at is refused, never padded out', () => {
    assert.throws(
      () => toConsoleCase({ status: 'opened', task: 'no id here' }, 'GET /v1/cases', 'req-bad'),
      (err: unknown) =>
        err instanceof DeskClientError && err.code === 'upstream_contract' && err.stage === UPSTREAM_STAGE && err.status === 502,
    );
    assert.throws(
      () => toolReplyFromCase({ ack_by: ackBy }, 'POST /v1/cases', 'req-bad'),
      (err: unknown) => err instanceof DeskClientError && err.code === 'upstream_contract',
    );
  });

  test('the retry receipt takes the settled outcome and the audit receipt, and never claims billing', () => {
    const settled = retryReceiptFrom(
      {
        case_id: 'c_9f2a1c',
        status: 'closed',
        agent_retry_ok: true,
        billable: true,
        outcome: { id: 'out_1', shipped_as: 'grant', agent_retry_ok: true, billable: true },
        reply: storedReply,
      },
      'c_9f2a1c',
      true,
    );
    assert.deepEqual(settled, {
      case_id: 'c_9f2a1c',
      ok: true,
      billable: true,
      outcome_id: 'out_1',
      receipt: 'ahd_audit_9f2a1c',
    });

    const partial = retryReceiptFrom({}, 'c_9f2a1c', false);
    assert.equal(partial.case_id, 'c_9f2a1c');
    assert.equal(partial.ok, false, 'with nothing echoed back, the agent argument stands');
    assert.equal(partial.billable, false, 'billable is claimed only when the backend says so');
    assert.equal(partial.outcome_id, undefined);
    assert.equal(partial.receipt, undefined);
  });
});
