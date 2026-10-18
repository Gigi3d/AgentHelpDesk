// approvals/approvals.test.ts — golden path, replay/idempotency, failure paths and the report
// numbers. Handlers are called directly with a constructed Ctx + MemoryRepository: no ports, no
// child processes, no network (AGENTS.md). Run by the orchestrator, never by an editing agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRepository } from '../store/memory.ts';
import type { Repository } from '../store/repository.ts';
import { HttpError, type Ctx, type Router } from '../shared/http.ts';
import type { Attempt, CaseStage, Failure, FailureClass, Outcome, ToolEvent, Vendor } from '../shared/types.ts';
import { FakeInkbox, RealInkboxClient, channelForRecipient, createInkboxClient } from './inkbox-client.ts';
import { applyReply, approvalIdFor, parseReply, requestApproval } from './approvals.ts';
import { daily, failureSignature, weekly } from './reports.ts';
import {
  getApprovalById,
  getDailyReport,
  postApproval,
  postApprovalReply,
  postSendNow,
  registerRoutes,
} from './register.ts';

/** Fixed clock so windows and report text are deterministic. */
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const APPROVER = '+15551234567';
const FAKE_ENV = { AHD_APPROVALS_FAKE: '1' };

function isoHoursAgo(hours: number): string {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

function ctx(body: unknown, query: Record<string, string> = {}, method = 'POST'): Ctx {
  return {
    method,
    path: '/v1/approvals',
    query: new URLSearchParams(query),
    body,
    headers: {},
    requestId: 'req-test-1',
    caller: null,
  };
}

async function expectHttpError(p: Promise<unknown>, status: number, stage: string): Promise<void> {
  let caught: HttpError | null = null;
  try {
    await p;
  } catch (err) {
    if (!(err instanceof HttpError)) throw new Error(`expected an HttpError, got ${String(err)}`);
    caught = err;
  }
  if (caught === null) throw new Error(`expected HttpError ${status} at stage ${stage}, but the call succeeded`);
  assert.equal(caught.status, status);
  assert.equal(caught.stage, stage);
}

function vendor(id = 'ledgerly'): Vendor {
  return {
    id,
    name: 'Ledgerly',
    repo_url: 'https://github.com/ledgerly/ledgerly',
    sandbox_name: 'ahd-ledgerly',
    risk_policy: 'approve_first',
    stripe_customer_id: 'cus_test_ledgerly',
    payer_mode: 'vendor',
    report_contacts: ['+15559876543', 'ops@ledgerly.test'],
  };
}

interface SeedSpec {
  id: string;
  hoursAgo: number;
  status: CaseStage;
  klass: FailureClass;
  task: string;
  request: unknown;
  proofs?: [boolean, boolean, boolean];
  shippedAs?: Outcome['shipped_as'];
  retryOk?: boolean;
  /** True when ship.ts wrote this case a regression test, i.e. the trail has `regression.created`. */
  regression?: boolean;
}

function failureOf(spec: SeedSpec): Failure {
  return {
    id: spec.id,
    vendor_id: 'ledgerly',
    agent_id: 'agent-demo',
    task: spec.task,
    request: spec.request,
    response: { error: { code: 'forbidden' } },
    klass: spec.klass,
    status: spec.status,
    ack_by: isoHoursAgo(spec.hoursAgo - 0.1),
    resolve_by: isoHoursAgo(spec.hoursAgo - 8),
    queue_position: 1,
    created_at: isoHoursAgo(spec.hoursAgo),
  };
}

async function seed(repo: MemoryRepository, specs: SeedSpec[]): Promise<void> {
  await repo.putVendor(vendor());
  for (const spec of specs) {
    await repo.createFailure(failureOf(spec));
    if (spec.proofs) {
      const attempt: Attempt = {
        id: `att_${spec.id}`,
        failure_id: spec.id,
        diff: '--- a/docs/scopes.md\n+++ b/docs/scopes.md\n@@ orders.write is allowed for test keys @@',
        proof_replay: spec.proofs[0],
        proof_vendor_tests: spec.proofs[1],
        proof_fresh_agent: spec.proofs[2],
        log_url: `https://ci.example.invalid/${spec.id}`,
      };
      await repo.createAttempt(attempt);
    }
    if (spec.shippedAs) {
      const outcome: Outcome = {
        id: `out_${spec.id}`,
        failure_id: spec.id,
        shipped_as: spec.shippedAs,
        approved_by: spec.shippedAs === 'grant' ? APPROVER : null,
        agent_retry_ok: spec.retryOk ?? false,
        billable: spec.retryOk ?? false,
        payer: spec.retryOk ? 'vendor' : null,
        stripe_event_id: null,
        mpp_payment_id: null,
        x402_payment_id: null,
      };
      await repo.createOutcome(outcome);
    }
    if (spec.regression) {
      const t_ms = Date.parse(spec.hoursAgo === 0 ? isoHoursAgo(0) : isoHoursAgo(spec.hoursAgo - 0.2));
      const event: ToolEvent = {
        id: `evt_regression_${spec.id}`,
        ticket_id: spec.id,
        stage: spec.status,
        tool: 'regression',
        action: 'regression.created',
        t_ms,
        d_ms: 0,
        result: 'ok',
        payload: {
          id: `rt_${spec.id}`,
          failure_id: spec.id,
          vendor_id: 'ledgerly',
          name: `regression: case ${spec.id} (${spec.klass})`,
          path: `tests/regression/${spec.id}.test.mjs`,
          asserts: ['the reported call no longer fails'],
        },
        at: isoHoursAgo(spec.hoursAgo - 0.2),
      };
      await repo.appendToolEvent(event);
    }
  }
}

/** The approval case from the Build Plan: a risky scope/config change that waits for a human. */
const RISKY = {
  id: 'case-3',
  hoursAgo: 8,
  status: 'awaiting_approval' as CaseStage,
  klass: 'authority' as FailureClass,
  task: 'PUT /v1/keys/{id} returns 403 for a scope the docs say is allowed',
  request: { method: 'PUT', path: '/v1/keys/{id}' },
  proofs: [true, true, true] as [boolean, boolean, boolean],
};
const CHANGE = 'Grant scope orders.write to test keys and document it in docs/scopes.md';

async function seededApprovalRepo(): Promise<{ repo: MemoryRepository; fake: FakeInkbox }> {
  const repo = new MemoryRepository();
  await seed(repo, [RISKY]);
  return { repo, fake: new FakeInkbox() };
}

// ---------------------------------------------------------------- golden path

test('requestApproval texts the approver with the case, the change and all three proofs', async () => {
  const { repo, fake } = await seededApprovalRepo();

  const res = await requestApproval(RISKY.id, CHANGE, APPROVER, repo, {
    client: fake,
    env: FAKE_ENV,
    now: () => NOW,
  });

  assert.equal(res.replayed, false);
  assert.equal(res.channel, 'text');
  assert.equal(res.approval.id, approvalIdFor(RISKY.id, CHANGE));
  assert.equal(res.approval.decision, null);
  assert.equal(res.approval.replied_at, null);
  assert.equal(res.approval.channel, 'text');
  assert.equal(res.approval.sent_at, new Date(NOW).toISOString());

  // Exactly one text went out, to the approver, and it carries the proof results.
  assert.equal(fake.outbound.length, 1);
  assert.equal(fake.outbound[0].channel, 'text');
  assert.equal(fake.outbound[0].to, APPROVER);
  const body = fake.outbound[0].body;
  assert.equal(body, res.body);
  assert.match(body, /case-3/);
  assert.match(body, /Grant scope orders\.write to test keys/);
  assert.match(body, /replay PASS/);
  assert.match(body, /vendor tests PASS/);
  assert.match(body, /fresh agent PASS/);
  assert.match(body, new RegExp(`yes ${res.approval.id}`));

  const stored = await repo.getApproval(res.approval.id);
  assert.ok(stored);
  assert.equal(stored.decision, null);

  const events = await repo.toolEvents({ ticket_id: RISKY.id });
  const requested = events.find((e) => e.action === 'approval.requested');
  assert.ok(requested, 'approval.requested ToolEvent was not appended');
  assert.equal(requested.tool, 'inkbox');
  assert.equal(requested.stage, 'approvals.request');
  assert.equal(requested.result, 'ok');
  // The approver handle is masked in the audit trail.
  assert.equal(JSON.stringify(requested.payload).includes(APPROVER), false);
});

test('a human "yes" reply is parsed and stored as the decision', async () => {
  const { repo, fake } = await seededApprovalRepo();
  const res = await requestApproval(RISKY.id, CHANGE, APPROVER, repo, { client: fake, env: FAKE_ENV });
  assert.ok(res.receipt);

  // The reply arrives over the simulated channel, exactly as Inkbox would hand it back.
  fake.injectReply(res.receipt.message_id, `yes ${res.approval.id}`);
  const reply = await fake.receiveReply(res.receipt.message_id);
  assert.ok(reply);
  const parsed = parseReply(reply.body, res.approval.id);
  assert.ok(parsed);
  assert.equal(parsed.decision, 'yes');

  const applied = await applyReply(res.approval.id, parsed.decision, APPROVER, repo);
  assert.equal(applied.replayed, false);
  assert.equal(applied.approval.decision, 'yes');
  assert.notEqual(applied.approval.replied_at, null);

  // The desk loop reads the decision back from the store; nothing is held in this module.
  const stored = await repo.getApproval(res.approval.id);
  assert.ok(stored);
  assert.equal(stored.decision, 'yes');

  const decided = (await repo.toolEvents({ ticket_id: RISKY.id })).find((e) => e.action === 'approval.decided');
  assert.ok(decided, 'approval.decided ToolEvent was not appended');
  assert.equal(decided.result, 'ok');
  assert.equal(decided.stage, 'approvals.reply');
});

test('a "no" reply is stored and blocks the change', async () => {
  const { repo, fake } = await seededApprovalRepo();
  const res = await requestApproval(RISKY.id, CHANGE, APPROVER, repo, { client: fake, env: FAKE_ENV });

  const applied = await applyReply(res.approval.id, 'no', APPROVER, repo);
  assert.equal(applied.approval.decision, 'no');
  const stored = await repo.getApproval(res.approval.id);
  assert.ok(stored);
  assert.equal(stored.decision, 'no');
});

test('parseReply refuses ambiguity, negation and a reply aimed at another approval', () => {
  const id = approvalIdFor('case-3', CHANGE);
  assert.equal(parseReply('no', id)?.decision, 'no');
  assert.equal(parseReply('YES', id)?.decision, 'yes');
  assert.equal(parseReply(`nope ${id}`, id)?.decision, 'no');
  assert.equal(parseReply('not approved', id), null);
  assert.equal(parseReply('maybe later', id), null);
  assert.equal(parseReply('yes and no', id), null);
  assert.equal(parseReply('', id), null);
  // A stray text quoting a different approval id must never decide this one.
  assert.equal(parseReply(`yes ${approvalIdFor('case-9', 'something else')}`, id), null);
});

// ------------------------------------------------------- replay / idempotency

test('an identical approval request is a replay: one text, same id', async () => {
  const { repo, fake } = await seededApprovalRepo();
  const deps = { client: fake, env: FAKE_ENV };

  const first = await requestApproval(RISKY.id, CHANGE, APPROVER, repo, deps);
  const second = await requestApproval(RISKY.id, CHANGE, APPROVER, repo, deps);

  assert.equal(second.replayed, true);
  assert.equal(second.approval.id, first.approval.id);
  assert.equal(second.receipt, null);
  assert.equal(fake.outbound.length, 1, 'a replay must not text the approver a second time');

  const events = (await repo.toolEvents({ ticket_id: RISKY.id })).filter((e) => e.action === 'approval.requested');
  assert.equal(events.length, 2);
  assert.equal(events[0].result, 'ok');
  assert.equal(events[1].result, 'replayed');
});

test('a different change for the same case gets its own approval', async () => {
  const { repo, fake } = await seededApprovalRepo();
  const first = await requestApproval(RISKY.id, CHANGE, APPROVER, repo, { client: fake, env: FAKE_ENV });
  const second = await requestApproval(RISKY.id, `${CHANGE} (v2: also widen the rate limit)`, APPROVER, repo, {
    client: fake,
    env: FAKE_ENV,
  });
  assert.notEqual(second.approval.id, first.approval.id);
  assert.equal(second.replayed, false);
  assert.equal(fake.outbound.length, 2);
});

test('repeating the same decision is a replay; contradicting it is refused', async () => {
  const { repo, fake } = await seededApprovalRepo();
  const res = await requestApproval(RISKY.id, CHANGE, APPROVER, repo, { client: fake, env: FAKE_ENV });

  await applyReply(res.approval.id, 'yes', APPROVER, repo);
  const again = await applyReply(res.approval.id, 'yes', APPROVER, repo);
  assert.equal(again.replayed, true);

  const decided = (await repo.toolEvents({ ticket_id: RISKY.id })).filter((e) => e.action === 'approval.decided');
  assert.equal(decided.length, 2);
  assert.equal(decided[0].result, 'ok');
  assert.equal(decided[1].result, 'replayed');

  await expectHttpError(applyReply(res.approval.id, 'no', APPROVER, repo), 409, 'approvals.reply');
  const stored = await repo.getApproval(res.approval.id);
  assert.ok(stored);
  assert.equal(stored.decision, 'yes', 'a stored human decision must not be flipped by a second reply');
});

// ------------------------------------------------------------- failure paths

test('requestApproval fails loud on an unknown case, a bad handle and missing proofs', async () => {
  const repo = new MemoryRepository();
  await seed(repo, [RISKY, { ...RISKY, id: 'case-unproven', proofs: undefined }]);
  const fake = new FakeInkbox();

  await expectHttpError(
    requestApproval('case-nope', CHANGE, APPROVER, repo, { client: fake, env: FAKE_ENV }),
    404,
    'approvals.request',
  );
  await expectHttpError(
    requestApproval(RISKY.id, CHANGE, 'not-a-phone-or-email', repo, { client: fake, env: FAKE_ENV }),
    400,
    'approvals.request',
  );
  await expectHttpError(
    requestApproval(RISKY.id, '   ', APPROVER, repo, { client: fake, env: FAKE_ENV }),
    400,
    'approvals.request',
  );
  // No attempt => no proof results => nobody may be asked to approve blind.
  await expectHttpError(
    requestApproval('case-unproven', CHANGE, APPROVER, repo, { client: fake, env: FAKE_ENV }),
    409,
    'approvals.request',
  );
  assert.equal(fake.outbound.length, 0);
});

test('a failed text with no fallback stores no approval row', async () => {
  const { repo, fake } = await seededApprovalRepo();
  fake.armTextFailure(1);
  const id = approvalIdFor(RISKY.id, CHANGE);

  await expectHttpError(
    requestApproval(RISKY.id, CHANGE, APPROVER, repo, { client: fake, env: FAKE_ENV, fallbackEmail: null }),
    502,
    'approvals.inkbox.send_text',
  );
  assert.equal(await repo.getApproval(id), null, 'a send that failed must not leave an approval behind');

  // Retrying after the outage sends the text and stores the row.
  const res = await requestApproval(RISKY.id, CHANGE, APPROVER, repo, { client: fake, env: FAKE_ENV });
  assert.equal(res.replayed, false);
  assert.equal(fake.outbound.length, 1);
  assert.notEqual(await repo.getApproval(id), null);
});

test('a failed text falls back to the configured email address', async () => {
  const { repo, fake } = await seededApprovalRepo();
  fake.armTextFailure(1);

  const res = await requestApproval(RISKY.id, CHANGE, APPROVER, repo, {
    client: fake,
    env: FAKE_ENV,
    fallbackEmail: 'ops@ledgerly.test',
  });
  assert.equal(res.channel, 'email');
  assert.equal(res.approval.channel, 'email');
  assert.equal(fake.outbound.length, 1);
  assert.equal(fake.outbound[0].channel, 'email');
  assert.equal(fake.outbound[0].to, 'ops@ledgerly.test');
});

test('a failed email to an email-shaped approver is loud and stores nothing', async () => {
  const { repo, fake } = await seededApprovalRepo();
  fake.armEmailFailure(1);
  const id = approvalIdFor(RISKY.id, CHANGE);

  await expectHttpError(
    requestApproval(RISKY.id, CHANGE, 'ops@ledgerly.test', repo, { client: fake, env: FAKE_ENV }),
    502,
    'approvals.inkbox.send_email',
  );
  assert.equal(await repo.getApproval(id), null);
  assert.equal(fake.outbound.length, 0);
});

test('applyReply fails loud on an unknown approval and a bad decision', async () => {
  const repo = new MemoryRepository();
  await expectHttpError(applyReply('apv_missing', 'yes', APPROVER, repo), 404, 'approvals.reply');

  const { repo: seeded, fake } = await seededApprovalRepo();
  const res = await requestApproval(RISKY.id, CHANGE, APPROVER, seeded, { client: fake, env: FAKE_ENV });
  const badDecision = 'maybe' as unknown as 'yes';
  await expectHttpError(applyReply(res.approval.id, badDecision, APPROVER, seeded), 400, 'approvals.reply');
});

// ------------------------------------------------------------------ reports

/**
 * Six cases with hand-counted outcomes. Every number asserted below is counted here by a human,
 * so the test proves the report aggregates the store instead of inventing figures.
 * "regression" below means ship.ts wrote the case a `regression.created` trail row.
 *   f1  2h ago  closed            code      POST /v1/checkout   proofs ok  pr         retry ok -> billable, regression
 *   f2  5h ago  shipped           authority POST /v1/checkout   proofs ok  grant      retry ok -> billable, regression
 *   f3  8h ago  awaiting_approval authority PUT  /v1/keys/{id}  proofs ok  regression retry failed, NO trail row
 *   f4  30h ago escalated         knowledge POST /v1/checkout   no attempt
 *   f5  3h ago  answered          knowledge GET  /v1/orders     fresh agent failed   answer retry ok, regression
 *   f6  200h ago closed           code      POST /v1/checkout   proofs ok  pr        retry ok, regression (outside both windows)
 *
 * f3 is the negative control: `shipped_as` names the channel the FIX travelled by, and ship.ts
 * never emits 'regression' there, so a counter keyed off it reported zero for every real case.
 */
const REPORT_SEED: SeedSpec[] = [
  {
    id: 'f1',
    hoursAgo: 2,
    status: 'closed',
    klass: 'code',
    task: 'apply a valid entitlement at checkout',
    request: { method: 'POST', path: '/v1/checkout' },
    proofs: [true, true, true],
    shippedAs: 'pr',
    retryOk: true,
    regression: true,
  },
  {
    id: 'f2',
    hoursAgo: 5,
    status: 'shipped',
    klass: 'authority',
    task: 'reissue an entitlement that will not apply',
    request: { method: 'POST', path: '/v1/checkout' },
    proofs: [true, true, true],
    shippedAs: 'grant',
    retryOk: true,
    regression: true,
  },
  {
    id: 'f3',
    hoursAgo: 8,
    status: 'awaiting_approval',
    klass: 'authority',
    task: 'widen the test key scope',
    request: { method: 'PUT', path: '/v1/keys/{id}' },
    proofs: [true, true, true],
    shippedAs: 'regression',
    retryOk: false,
  },
  {
    id: 'f4',
    hoursAgo: 30,
    status: 'escalated',
    klass: 'knowledge',
    task: 'checkout returns 403 with no appeal path',
    request: { method: 'POST', path: '/v1/checkout' },
  },
  {
    id: 'f5',
    hoursAgo: 3,
    status: 'answered',
    klass: 'knowledge',
    task: 'list orders with a cursor',
    request: { method: 'GET', url: 'https://api.ledgerly.test/v1/orders?cursor=2' },
    proofs: [true, true, false],
    shippedAs: 'answer',
    retryOk: true,
    regression: true,
  },
  {
    id: 'f6',
    hoursAgo: 200,
    status: 'closed',
    klass: 'code',
    task: 'apply a valid entitlement at checkout',
    request: { method: 'POST', path: '/v1/checkout' },
    proofs: [true, true, true],
    shippedAs: 'pr',
    retryOk: true,
    regression: true,
  },
];

async function reportRepo(): Promise<MemoryRepository> {
  const repo = new MemoryRepository();
  await seed(repo, REPORT_SEED);
  return repo;
}

test('the daily report reproduces the seeded counts exactly', async () => {
  const repo = await reportRepo();
  const report = await daily('ledgerly', repo, { now: NOW, unitPriceUsd: 0.5 }, {});

  assert.equal(report.kind, 'daily');
  assert.equal(report.vendor_id, 'ledgerly');
  assert.equal(report.window_start, isoHoursAgo(24));
  assert.equal(report.window_end, new Date(NOW).toISOString());

  // f1, f2, f3, f5 fall inside 24h; f4 (30h) and f6 (200h) do not.
  assert.deepEqual(report.numbers, {
    cases_opened: 4,
    cases_fixed: 3, // f1 closed, f2 shipped, f5 answered
    cases_escalated: 0, // f4 is outside the window
    awaiting_approval: 1, // f3, a live snapshot
    agent_retries_ok: 3, // f1, f2, f5
    fixes_merged: 1, // f1 shipped_as pr
    regression_tests_added: 3, // f1, f2, f5 have a trail row; f3 does not, whatever its shipped_as says
    grants_issued: 1, // f2
    billable_cases: 2, // f1, f2 (all three proofs AND the retry succeeded)
    expected_bill_usd: 1, // 2 x 0.50
    top_failures: [
      { signature: 'code POST /v1/checkout', count: 2, example_failure_id: 'f1' },
      { signature: 'authority POST /v1/checkout', count: 1, example_failure_id: 'f2' },
      { signature: 'authority PUT /v1/keys/{id}', count: 1, example_failure_id: 'f3' },
    ],
    waiting_on_vendor: ['f3'],
  });

  // The sentences are built from those numbers, so the text can never disagree with the JSON.
  assert.equal(report.lines.length, 5);
  assert.match(report.text, /Waiting on you first: 1 case\(s\) need an approval reply \(f3\)\./);
  assert.match(report.text, /Cases opened: 4\. Fixed and verified: 3\. Escalated: 0\. Awaiting approval: 1\./);
  assert.match(report.text, /Agents that finished their task after a fix: 3\./);
  assert.match(report.text, /no count in this report was written by a language model/);
  // A daily report does not carry the weekly-only sections.
  assert.equal(/Fixes merged/.test(report.text), false);
  assert.equal(/Expected bill/.test(report.text), false);
});

test('the weekly report adds merges, grants, top failures and the expected bill', async () => {
  const repo = await reportRepo();
  const report = await weekly('ledgerly', repo, { now: NOW, unitPriceUsd: 1 }, {});

  assert.equal(report.kind, 'weekly');
  assert.equal(report.window_start, isoHoursAgo(168));
  // f4 (30h) is inside a week; f6 (200h) is not.
  assert.equal(report.numbers.cases_opened, 5);
  assert.equal(report.numbers.cases_fixed, 3);
  assert.equal(report.numbers.cases_escalated, 1);
  assert.equal(report.numbers.awaiting_approval, 1);
  assert.equal(report.numbers.fixes_merged, 1);
  assert.equal(report.numbers.regression_tests_added, 3);
  assert.equal(report.numbers.grants_issued, 1);
  assert.equal(report.numbers.billable_cases, 2);
  assert.equal(report.numbers.expected_bill_usd, 2);
  // Repeating failures are grouped over every case on record, so f6 still counts.
  assert.deepEqual(report.numbers.top_failures, [
    { signature: 'code POST /v1/checkout', count: 2, example_failure_id: 'f1' },
    { signature: 'authority POST /v1/checkout', count: 1, example_failure_id: 'f2' },
    { signature: 'authority PUT /v1/keys/{id}', count: 1, example_failure_id: 'f3' },
  ]);

  assert.match(report.text, /Fixes merged: 1\. Regression tests added: 3\. Grants issued under the envelope: 1\./);
  assert.match(report.text, /Top repeating failures: 1\) code POST \/v1\/checkout \(2 cases, e\.g\. f1\)/);
  assert.match(report.text, /Expected bill: 2\.00 USD for 2 billable case\(s\) at 1\.00 per verified fix/);
  assert.ok(report.assumptions.some((a) => /Stripe meter is authoritative/.test(a)));
  assert.ok(report.assumptions.some((a) => /regression\.created/.test(a)));
});

test('an empty vendor reports zeroes, not guesses', async () => {
  const repo = new MemoryRepository();
  await repo.putVendor(vendor());
  const report = await daily('ledgerly', repo, { now: NOW }, {});
  assert.equal(report.numbers.cases_opened, 0);
  assert.equal(report.numbers.cases_fixed, 0);
  assert.equal(report.numbers.awaiting_approval, 0);
  assert.equal(report.numbers.expected_bill_usd, 0);
  assert.deepEqual(report.numbers.top_failures, []);
  assert.match(report.text, /Waiting on you first: 0 case\(s\) need an approval reply \(none\)\./);
});

test('reports fail loud for an unknown vendor', async () => {
  const repo = await reportRepo();
  await expectHttpError(daily('nope', repo, { now: NOW }, {}), 404, 'approvals.report.daily');
  await expectHttpError(weekly('nope', repo, { now: NOW }, {}), 404, 'approvals.report.weekly');
});

test('failure signatures group by endpoint and fall back to the task', () => {
  assert.equal(failureSignature(failureOf(REPORT_SEED[0])), 'code POST /v1/checkout');
  assert.equal(failureSignature(failureOf(REPORT_SEED[4])), 'knowledge GET /v1/orders');
  assert.equal(failureSignature(failureOf(REPORT_SEED[3])), 'knowledge POST /v1/checkout');
});

// ------------------------------------------------------------------- routes

test('POST /v1/reports/send-now delivers the report and records report.sent', async () => {
  const repo: Repository = await reportRepo();
  const fake = new FakeInkbox();

  const res = await postSendNow(ctx({ vendor_id: 'ledgerly', kind: 'daily' }), repo, {
    client: fake,
    env: FAKE_ENV,
    now: () => NOW,
  });

  assert.equal(res.status, 200);
  const body = res.body as { report: { kind: string; numbers: { cases_opened: number } }; delivered: unknown[] };
  assert.equal(body.report.kind, 'daily');
  assert.equal(body.report.numbers.cases_opened, 4);
  assert.equal(body.delivered.length, 2, 'both vendor report_contacts were used');

  // A phone contact went by text, an email contact by email.
  assert.deepEqual(
    fake.outbound.map((m) => m.channel),
    ['text', 'email'],
  );
  assert.match(fake.outbound[0].body, /Cases opened: 4/);

  const events = await repo.toolEvents({ tool: 'inkbox' });
  const sent = events.filter((e) => e.action === 'report.sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].result, 'ok');
  assert.equal(sent[0].stage, 'approvals.report.send_now');
  assert.equal(sent[0].ticket_id, 'ledgerly');
  const payload = sent[0].payload as { kind: string; numbers: { cases_opened: number }; recipients: string[] };
  assert.equal(payload.kind, 'daily');
  assert.equal(payload.numbers.cases_opened, 4, 'the event carries the same computed numbers as the report');
  assert.deepEqual(payload.recipients, ['****6543', '****test']);
});

test('POST /v1/reports/send-now refuses a vendor with no contacts and an unknown kind', async () => {
  const repo = new MemoryRepository();
  await repo.putVendor({ ...vendor(), report_contacts: [] });
  const fake = new FakeInkbox();

  await expectHttpError(
    postSendNow(ctx({ vendor_id: 'ledgerly', kind: 'daily' }), repo, { client: fake, env: FAKE_ENV, now: () => NOW }),
    422,
    'approvals.report.send_now',
  );
  assert.equal(fake.outbound.length, 0);

  const seeded = await reportRepo();
  await expectHttpError(
    postSendNow(ctx({ vendor_id: 'ledgerly', kind: 'monthly' }), seeded, { client: fake, env: FAKE_ENV }),
    400,
    'approvals.http.send_now',
  );
  await expectHttpError(
    postSendNow(ctx({ vendor_id: 'ledgerly' }), seeded, { client: fake, env: FAKE_ENV }),
    400,
    'approvals.http.send_now',
  );
});

test('the approval routes round-trip a request and a reply', async () => {
  const repo = new MemoryRepository();
  await seed(repo, [RISKY]);
  const fake = new FakeInkbox();
  const deps = { client: fake, env: FAKE_ENV, now: () => NOW };

  const created = await postApproval(
    ctx({ failure_id: RISKY.id, change_summary: CHANGE, approver: APPROVER }),
    repo,
    deps,
  );
  assert.equal(created.status, 201);
  const createdBody = created.body as { approval: { id: string }; text_sent: { channel: string; to: string } };
  const id = createdBody.approval.id;
  assert.equal(createdBody.text_sent.channel, 'text');
  assert.equal(createdBody.text_sent.to, '****4567');

  const replay = await postApproval(
    ctx({ failure_id: RISKY.id, change_summary: CHANGE, approver: APPROVER }),
    repo,
    deps,
  );
  assert.equal(replay.status, 200, 'a replay returns 200, not a second 201');
  assert.equal(fake.outbound.length, 1);

  const read = await getApprovalById(ctx(null, { id }, 'GET'), repo);
  assert.equal(read.status, 200);
  assert.equal((read.body as { approval: { decision: string | null } }).approval.decision, null);

  // The raw inbound text is accepted as well as a structured decision.
  const replied = await postApprovalReply(ctx({ id, text: `yes ${id}`, approver: APPROVER }), repo);
  assert.equal(replied.status, 200);
  assert.equal((replied.body as { approval: { decision: string } }).approval.decision, 'yes');

  const reread = await getApprovalById(ctx(null, { id }, 'GET'), repo);
  assert.equal((reread.body as { approval: { decision: string } }).approval.decision, 'yes');
});

test('the routes validate every inbound field at the boundary', async () => {
  const repo = new MemoryRepository();
  await seed(repo, [RISKY]);
  const fake = new FakeInkbox();
  const deps = { client: fake, env: FAKE_ENV };

  await expectHttpError(postApproval(ctx({ failure_id: RISKY.id }), repo, deps), 400, 'approvals.http.create');
  await expectHttpError(
    postApproval(ctx({ failure_id: '', change_summary: CHANGE, approver: APPROVER }), repo, deps),
    400,
    'approvals.http.create',
  );
  await expectHttpError(postApprovalReply(ctx({ id: 'apv_x' }), repo), 400, 'approvals.http.reply');
  await expectHttpError(
    postApprovalReply(ctx({ id: 'apv_x', decision: 'maybe', approver: APPROVER }), repo),
    400,
    'approvals.http.reply',
  );
  await expectHttpError(
    postApprovalReply(ctx({ id: 'apv_x', text: 'sure thing', approver: APPROVER }), repo),
    400,
    'approvals.http.reply',
  );
  await expectHttpError(getApprovalById(ctx(null, {}, 'GET'), repo), 400, 'approvals.http.read');
  await expectHttpError(getApprovalById(ctx(null, { id: 'apv_nope' }, 'GET'), repo), 404, 'approvals.http.read');
  await expectHttpError(getDailyReport(ctx(null, {}, 'GET'), repo, deps), 400, 'approvals.http.report');
  await expectHttpError(postSendNow(ctx({ vendor_id: 'ledgerly' }), repo, deps), 400, 'approvals.http.send_now');
  assert.equal(fake.outbound.length, 0);
});

test('registerRoutes wires the six approval and report routes', () => {
  const routes = new Map<string, unknown>();
  const router: Router = {
    add(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
  };
  registerRoutes(router, new MemoryRepository());
  assert.deepEqual([...routes.keys()].sort(), [
    'GET /v1/approvals',
    'GET /v1/reports/daily',
    'GET /v1/reports/weekly',
    'POST /v1/approvals',
    'POST /v1/approvals/reply',
    'POST /v1/reports/send-now',
  ]);
});

// ------------------------------------------------------------- client wiring

test('the fake client is chosen when AHD_APPROVALS_FAKE=1 or no key is present', () => {
  assert.ok(createInkboxClient({ AHD_APPROVALS_FAKE: '1', INKBOX_API_KEY: 'k' }) instanceof FakeInkbox);
  assert.ok(createInkboxClient({}) instanceof FakeInkbox);
  assert.ok(createInkboxClient({ INKBOX_API_KEY: 'k' }) instanceof RealInkboxClient);
});

test('recipient handles pick the channel, defaulting to text', () => {
  assert.equal(channelForRecipient(APPROVER), 'text');
  assert.equal(channelForRecipient('+44 20 7946 0958'), 'text');
  assert.equal(channelForRecipient('ops@ledgerly.test'), 'email');
  assert.throws(() => channelForRecipient('slack-handle'), HttpError);
});

test('the real client refuses the undocumented email channel instead of pretending', async () => {
  const client = new RealInkboxClient({ apiKey: 'k', baseUrl: 'https://inkbox.invalid/v1', timeoutMs: 500, maxChars: 1400 });
  await expectHttpError(client.sendEmail('ops@ledgerly.test', 's', 'b'), 502, 'approvals.inkbox.send_email');
});
