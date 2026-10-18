// Evals module tests. node:test + node:assert/strict, handlers called directly with a
// constructed Ctx and a MemoryRepository: no ports bound, no processes spawned, no
// network (a FakeArmature is injected everywhere).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../shared/http.ts';
import type { Ctx, Handler, HttpResult } from '../shared/http.ts';
import type { ToolEvent } from '../shared/types.ts';
import { MemoryRepository } from '../store/memory.ts';
import type { Repository } from '../store/repository.ts';
import { FakeArmature } from './armature-client.ts';
import type { ArmaturePickRateReply } from './armature-client.ts';
import { DEFAULT_ERROR_BODY, DEFAULT_INSTALL_DOCS, DESK_HELP_URL } from './fixtures.ts';
import { ACTION_INSTALL, EVAL_TICKET, EVAL_TOOL, STAGE_INSTALL, runInstallEval } from './install-eval.ts';
import type { InstallEvalResult, StoredInstallRun } from './install-eval.ts';
import { ACTION_PICK, pickRate } from './pick-rate.ts';
import type { PickRateResult } from './pick-rate.ts';
import { installHandler, resultsHandler } from './register.ts';

/** A deterministic, strictly increasing clock so time_ms is asserted, not hoped for. */
function makeClock(startMs = 1_000, stepMs = 5): () => number {
  let t = startMs;
  return () => {
    t += stepMs;
    return t;
  };
}

function ctxOf(body: unknown, query: URLSearchParams = new URLSearchParams(), method: 'GET' | 'POST' = body === null ? 'GET' : 'POST'): Ctx {
  return {
    method,
    path: method === 'GET' ? '/v1/evals/results' : '/v1/evals/install',
    query,
    body,
    headers: {},
    requestId: 'req_evals_test',
    caller: null,
  };
}

function bodyOf(res: HttpResult): Record<string, unknown> {
  assert.equal(typeof res.body, 'object');
  assert.ok(res.body !== null);
  return res.body as Record<string, unknown>;
}

function payloadOf(e: ToolEvent): Record<string, unknown> {
  assert.equal(typeof e.payload, 'object');
  assert.ok(e.payload !== null);
  return e.payload as Record<string, unknown>;
}

async function eventsWithAction(repo: Repository, action: string): Promise<ToolEvent[]> {
  const all = await repo.toolEvents({ tool: EVAL_TOOL });
  return all.filter((e) => e.action === action);
}

/** Seed one eval.install ToolEvent by hand, in the documented payload shape. */
async function seedInstallEvent(
  repo: Repository,
  seed: { id: string; pass: boolean; at: string; time_ms: number; rung?: number; steps?: { name: string; ok: boolean }[] },
): Promise<void> {
  const steps = seed.steps ?? [
    { name: 'read_docs_root', ok: seed.pass },
    { name: 'read_error_body', ok: seed.pass },
    { name: 'read_help_page', ok: seed.pass },
    { name: 'install_desk', ok: seed.pass },
    { name: 'first_ticket', ok: seed.pass },
  ];
  await repo.appendToolEvent({
    id: seed.id,
    ticket_id: EVAL_TICKET,
    stage: STAGE_INSTALL,
    tool: EVAL_TOOL,
    action: ACTION_INSTALL,
    t_ms: 0,
    d_ms: seed.time_ms,
    result: seed.pass ? 'pass' : 'fail',
    payload: {
      run_id: seed.id,
      ticket_id: EVAL_TICKET,
      pass: seed.pass,
      step_count: steps.length,
      steps: steps.map((s, i) => ({ n: i + 1, name: s.name, ok: s.ok, found_in: null, evidence: '', detail: '', ms: 0 })),
      time_ms: seed.time_ms,
      rung: seed.rung ?? 1,
      simulated: true,
      mode: 'fake',
      leak: { detected: false, reason: null },
      idempotency_key: null,
      docs_read: [DESK_HELP_URL],
      armature: { mode: 'fake', submitted: false, run_ref: null, status: null, error: null, faked: true },
      disclaimer: 'seeded by evals.test.ts',
      recorded_at: seed.at,
    },
    at: seed.at,
  });
}

test('golden path: a fresh-agent install eval passes and is stored as an Armature eval.install event', async () => {
  const repo = new MemoryRepository();
  const result = await runInstallEval(repo, {
    client: new FakeArmature(),
    now: makeClock(),
    idempotency_key: 'idem-golden-1',
  });

  assert.equal(result.pass, true);
  assert.equal(result.step_count, 5);
  assert.equal(result.steps.length, 5);
  assert.deepEqual(
    result.steps.map((s) => s.name),
    ['read_docs_root', 'read_error_body', 'read_help_page', 'install_desk', 'first_ticket'],
  );
  assert.ok(result.steps.every((s) => s.ok), 'every step should be ok on the golden path');
  assert.equal(typeof result.time_ms, 'number');
  assert.ok(result.time_ms > 0, 'time_ms must be measured, not zero-filled');
  assert.equal(result.simulated, true, 'the run must be labelled simulated');
  assert.deepEqual(result.docs_read, DEFAULT_INSTALL_DOCS.map((d) => d.url));

  // Honest sponsor receipt: the Fake sends nothing and says so.
  assert.equal(result.armature.mode, 'fake');
  assert.equal(result.armature.faked, true);
  assert.equal(result.armature.submitted, false);
  assert.equal(result.armature.run_ref, null);

  const events = await eventsWithAction(repo, ACTION_INSTALL);
  assert.equal(events.length, 1);
  const stored = events[0];
  if (!stored) throw new Error('expected one stored eval.install event');
  assert.equal(stored.tool, 'Armature');
  assert.equal(stored.action, 'eval.install');
  assert.equal(stored.stage, 'evals.install');
  assert.equal(stored.ticket_id, EVAL_TICKET);
  assert.equal(stored.result, 'pass');
  assert.equal(stored.d_ms, result.time_ms);
  const payload = payloadOf(stored);
  assert.equal(payload['pass'], true);
  assert.equal(payload['time_ms'], result.time_ms);
  assert.equal(payload['simulated'], true);
  assert.equal(payload['run_id'], result.run_id);
  assert.equal(payload['idempotency_key'], 'idem-golden-1');
});

test('replay: the same idempotency key returns the stored run and writes no second event', async () => {
  const repo = new MemoryRepository();
  const client = new FakeArmature();
  const first = await runInstallEval(repo, { client, now: makeClock(), idempotency_key: 'idem-replay-1' });
  const second = await runInstallEval(repo, { client, now: makeClock(9_000), idempotency_key: 'idem-replay-1' });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.run_id, first.run_id);
  assert.equal(second.pass, first.pass);
  assert.equal(second.time_ms, first.time_ms, 'a replay returns the original measurement');
  assert.equal(second.simulated, first.simulated);
  assert.deepEqual(second.steps.map((s) => s.name), first.steps.map((s) => s.name));

  const events = await eventsWithAction(repo, ACTION_INSTALL);
  assert.equal(events.length, 1, 'a replay must not append a second eval.install row');
});

test('failure path: docs with nothing for agents store pass:false instead of throwing', async () => {
  const repo = new MemoryRepository();
  const result = await runInstallEval(repo, {
    client: new FakeArmature(),
    now: makeClock(),
    docs: [{ name: 'README.md', url: 'https://ledgerly.example/README.md', body: '# Ledgerly\n\nNothing here for agents.\n' }],
    error_body: { status: 422, error: { code: 'invalid_request', message: 'date must be an ISO-8601 timestamp' } },
  });

  assert.equal(result.pass, false);
  assert.equal(result.steps.length, 5);
  assert.ok(result.steps.every((s) => !s.ok), 'no step can pass when the docs name no desk');
  assert.ok(result.steps[0]?.detail.includes('llms.txt'), 'the first failure should say which document was missing');

  const events = await eventsWithAction(repo, ACTION_INSTALL);
  assert.equal(events.length, 1, 'a failing eval is recorded, not swallowed');
  const stored = events[0];
  if (!stored) throw new Error('expected the failing eval.install event');
  assert.equal(stored.result, 'fail');
  assert.equal(payloadOf(stored)['pass'], false);
});

test('leak guard: resolver reasoning reaching the agent invalidates the run', async () => {
  const repo = new MemoryRepository();
  const leakedDoc = {
    name: 'resolver-notes.md',
    url: 'https://ledgerly.example/internal/resolver-notes.md',
    body: 'resolver_reasoning: the quickstart used x-api-key, so rewrite the header to Bearer.',
  };
  const result = await runInstallEval(repo, {
    client: new FakeArmature(),
    now: makeClock(),
    docs: [...DEFAULT_INSTALL_DOCS, leakedDoc],
  });

  assert.equal(result.leak.detected, true);
  assert.match(result.leak.reason ?? '', /resolver_reasoning/);
  assert.equal(result.pass, false, 'a leaked fix can never count as a pass');
  const events = await eventsWithAction(repo, ACTION_INSTALL);
  assert.equal(events.length, 1);
  const stored = events[0];
  if (!stored) throw new Error('expected the invalidated eval.install event');
  assert.equal(stored.result, 'fail');
  assert.equal(payloadOf(stored)['leak'], result.leak as unknown);
});

test('leak guard: a caller-supplied forbidden string is screened too', async () => {
  const repo = new MemoryRepository();
  const result = await runInstallEval(repo, {
    client: new FakeArmature(),
    now: makeClock(),
    docs: [
      ...DEFAULT_INSTALL_DOCS,
      { name: 'notes.md', url: 'https://ledgerly.example/notes.md', body: 'the diff renames the auth header' },
    ],
    forbidden: ['the diff renames the auth header'],
  });
  assert.equal(result.leak.detected, true);
  assert.equal(result.pass, false);
});

test('rung gating: rung 4 fails when no document states the repo install path', async () => {
  const repo = new MemoryRepository();
  const docsWithoutRung4 = DEFAULT_INSTALL_DOCS.filter((d) => !d.name.includes('install'));
  const result = await runInstallEval(repo, {
    client: new FakeArmature(),
    now: makeClock(),
    rung: 4,
    docs: docsWithoutRung4,
    error_body: DEFAULT_ERROR_BODY,
  });
  const install = result.steps.find((s) => s.name === 'install_desk');
  assert.ok(install);
  assert.equal(install.ok, false);
  assert.match(install.detail, /rung 4/);
  assert.equal(result.pass, false);

  // Same bundle at rung 1 needs no repo access, so it still passes.
  const rungOne = await runInstallEval(repo, {
    client: new FakeArmature(),
    now: makeClock(),
    rung: 1,
    docs: docsWithoutRung4,
    error_body: DEFAULT_ERROR_BODY,
  });
  assert.equal(rungOne.pass, true);
});

test('validation: invalid input throws HttpError naming stage evals.validate', async () => {
  const repo = new MemoryRepository();
  const client = new FakeArmature();
  await assert.rejects(
    () => runInstallEval(repo, { client, now: makeClock(), rung: 9 }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.stage, 'evals.validate');
      assert.match(err.message, /rung/);
      return true;
    },
  );
  await assert.rejects(
    () => runInstallEval(repo, { client, now: makeClock(), docs: [] }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.stage, 'evals.validate');
      return true;
    },
  );
  await assert.rejects(
    () => runInstallEval(repo, { client, now: makeClock(), forbidden: ['short'] }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.stage, 'evals.validate');
      return true;
    },
  );
  await assert.rejects(
    () => runInstallEval(repo, { client, now: makeClock(), error_body: 'not an object' }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.stage, 'evals.validate');
      return true;
    },
  );
});

test('pick rate: computed exactly from two seeded eval.install events', async () => {
  const repo = new MemoryRepository();
  await seedInstallEvent(repo, { id: 'evr_seed_pass', pass: true, at: '2026-10-18T09:00:00.000Z', time_ms: 1_200 });
  await seedInstallEvent(repo, { id: 'evr_seed_fail', pass: false, at: '2026-10-18T09:05:00.000Z', time_ms: 4_800 });

  const pick = await pickRate(repo, { now: makeClock() });
  assert.equal(pick.runs, 2);
  assert.equal(pick.passed, 1);
  assert.equal(pick.failed, 1);
  assert.equal(pick.pick_rate, 0.5, 'exact fraction, not a rounded or invented number');
  assert.equal(pick.pick_rate_pct, 50);
  assert.equal(pick.median_time_ms, 3_000);
  assert.equal(pick.source, 'tool_events');
  assert.equal(pick.simulated_runs, 2);
  assert.equal(pick.armature_submitted_runs, 0);
  assert.equal(pick.skipped_malformed, 0);
  assert.equal(pick.step_pass['first_ticket']?.ok_rate, 0.5);
  assert.equal(pick.rungs['rung_1']?.runs, 2);

  const pickEvents = await eventsWithAction(repo, ACTION_PICK);
  assert.equal(pickEvents.length, 1, 'the aggregate is stored as eval.pick');
  const stored = pickEvents[0];
  if (!stored) throw new Error('expected the eval.pick event');
  assert.equal(stored.tool, 'Armature');
  assert.equal(stored.action, 'eval.pick');
  assert.equal(stored.stage, 'evals.pick');
  assert.equal(payloadOf(stored)['pick_rate'], 0.5);
  assert.equal(payloadOf(stored)['runs'], 2);
  assert.equal(pick.pick_event_recorded, true);
  assert.equal(pick.pick_event_id, stored.id);
});

test('pick rate: re-reading unchanged inputs records no second eval.pick event', async () => {
  const repo = new MemoryRepository();
  await seedInstallEvent(repo, { id: 'evr_seed_a', pass: true, at: '2026-10-18T09:00:00.000Z', time_ms: 900 });
  await seedInstallEvent(repo, { id: 'evr_seed_b', pass: false, at: '2026-10-18T09:01:00.000Z', time_ms: 1_100 });

  const first = await pickRate(repo, { now: makeClock() });
  const second = await pickRate(repo, { now: makeClock() });
  assert.equal(first.pick_event_recorded, true);
  assert.equal(second.pick_event_recorded, false);
  assert.equal(second.pick_event_id, first.pick_event_id);
  assert.equal(second.pick_rate, first.pick_rate);
  assert.equal((await eventsWithAction(repo, ACTION_PICK)).length, 1);

  // A new run changes the inputs, so a new aggregate row is written.
  await seedInstallEvent(repo, { id: 'evr_seed_c', pass: true, at: '2026-10-18T09:02:00.000Z', time_ms: 1_000 });
  const third = await pickRate(repo, { now: makeClock() });
  assert.equal(third.runs, 3);
  assert.equal(third.passed, 2);
  assert.equal(third.pick_rate, 2 / 3);
  assert.equal(third.pick_event_recorded, true);
  assert.equal((await eventsWithAction(repo, ACTION_PICK)).length, 2);
});

test('pick rate: no runs means null, never an invented number', async () => {
  const repo = new MemoryRepository();
  const pick = await pickRate(repo, { now: makeClock() });
  assert.equal(pick.runs, 0);
  assert.equal(pick.pick_rate, null);
  assert.equal(pick.pick_rate_pct, null);
  assert.equal(pick.median_time_ms, null);
  assert.equal(pick.pick_event_recorded, false);
  assert.equal((await eventsWithAction(repo, ACTION_PICK)).length, 0);
});

test('pick rate: malformed eval.install payloads are counted, not silently dropped', async () => {
  const repo = new MemoryRepository();
  await seedInstallEvent(repo, { id: 'evr_good', pass: true, at: '2026-10-18T09:00:00.000Z', time_ms: 800 });
  await repo.appendToolEvent({
    id: 'evr_junk',
    ticket_id: EVAL_TICKET,
    stage: STAGE_INSTALL,
    tool: EVAL_TOOL,
    action: ACTION_INSTALL,
    t_ms: 0,
    d_ms: 1,
    result: 'pass',
    payload: { nope: true },
    at: '2026-10-18T09:01:00.000Z',
  });
  const pick = await pickRate(repo, { now: makeClock() });
  assert.equal(pick.runs, 1);
  assert.equal(pick.pick_rate, 1);
  assert.equal(pick.skipped_malformed, 1);
});

test('POST /v1/evals/install runs the eval, stores it and returns the result with the pick rate', async () => {
  const repo = new MemoryRepository();
  const handler: Handler = installHandler(repo, { client: new FakeArmature(), now: makeClock() });
  const res = await handler(ctxOf({ idempotency_key: 'http-golden-1', rung: 1 }));

  assert.equal(res.status, 200);
  const body = bodyOf(res);
  const run = body['run'] as InstallEvalResult;
  const pick = body['pick'] as PickRateResult;
  assert.equal(run.pass, true);
  assert.equal(run.simulated, true);
  assert.equal(run.replayed, false);
  assert.equal(pick.runs, 1);
  assert.equal(pick.pick_rate, 1);
  assert.equal(typeof body['disclaimer'], 'string');
  assert.equal(body['request_id'], 'req_evals_test');

  assert.equal((await eventsWithAction(repo, ACTION_INSTALL)).length, 1);
  assert.equal((await eventsWithAction(repo, ACTION_PICK)).length, 1);
});

test('POST /v1/evals/install returns 200 with pass:false when the eval fails', async () => {
  const repo = new MemoryRepository();
  const handler = installHandler(repo, { client: new FakeArmature(), now: makeClock() });
  const res = await handler(
    ctxOf({
      docs: [{ name: 'README.md', url: 'https://ledgerly.example/README.md', body: '# Ledgerly\n' }],
      error_body: { status: 500, error: { code: 'boom', message: 'boom' } },
    }),
  );
  assert.equal(res.status, 200, 'a failed measurement is not an HTTP error');
  const run = bodyOf(res)['run'] as InstallEvalResult;
  assert.equal(run.pass, false);
  const stored = await eventsWithAction(repo, ACTION_INSTALL);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.result, 'fail');
});

test('POST /v1/evals/install validates the boundary', async () => {
  const repo = new MemoryRepository();
  const handler = installHandler(repo, { client: new FakeArmature(), now: makeClock() });

  await assert.rejects(
    () => handler(ctxOf({ rung: 7 })),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.stage, 'evals.validate');
      return true;
    },
  );
  await assert.rejects(
    () => handler(ctxOf('a string body')),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      return true;
    },
  );
  await assert.rejects(
    () => handler(ctxOf({ docs: [{ name: 'x', url: 'ftp://nope', body: 'y' }] })),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.match(err.message, /url/);
      return true;
    },
  );
  assert.equal((await repo.toolEvents({ tool: EVAL_TOOL })).length, 0, 'rejected input stores nothing');
});

test('GET /v1/evals/results returns the stored events and the computed pick rate', async () => {
  const repo = new MemoryRepository();
  await seedInstallEvent(repo, { id: 'evr_old', pass: false, at: '2026-10-18T08:00:00.000Z', time_ms: 2_000 });
  await seedInstallEvent(repo, { id: 'evr_new', pass: true, at: '2026-10-18T09:00:00.000Z', time_ms: 1_000 });

  const handler = resultsHandler(repo, { client: new FakeArmature(), now: makeClock() });
  const res = await handler(ctxOf(null, new URLSearchParams()));
  assert.equal(res.status, 200);

  const body = bodyOf(res);
  assert.equal(body['count'], 2);
  assert.equal(body['returned'], 2);
  assert.equal(body['skipped_malformed'], 0);
  assert.equal(body['simulated'], true);

  const runs = body['runs'] as StoredInstallRun[];
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((r) => r.run_id),
    ['evr_new', 'evr_old'],
    'newest first',
  );
  assert.equal(runs[0]?.steps.length, 5);

  const pick = body['pick'] as PickRateResult;
  assert.equal(pick.runs, 2);
  assert.equal(pick.passed, 1);
  assert.equal(pick.pick_rate, 0.5);

  const armaturePick = body['armature_pick'] as ArmaturePickRateReply;
  assert.equal(armaturePick.mode, 'fake');
  assert.equal(armaturePick.faked, true);
  assert.equal(armaturePick.pick_rate, null, 'the Fake never supplies a number');
});

test('GET /v1/evals/results honours limit and ticket_id and validates them', async () => {
  const repo = new MemoryRepository();
  await seedInstallEvent(repo, { id: 'evr_a', pass: true, at: '2026-10-18T08:00:00.000Z', time_ms: 700 });
  await seedInstallEvent(repo, { id: 'evr_b', pass: true, at: '2026-10-18T08:01:00.000Z', time_ms: 700 });
  await seedInstallEvent(repo, { id: 'evr_c', pass: false, at: '2026-10-18T08:02:00.000Z', time_ms: 700 });

  const handler = resultsHandler(repo, { client: new FakeArmature(), now: makeClock() });
  const limited = await handler(ctxOf(null, new URLSearchParams('limit=2')));
  const limitedBody = bodyOf(limited);
  assert.equal(limitedBody['count'], 3);
  assert.equal(limitedBody['returned'], 2);
  assert.equal((limitedBody['runs'] as StoredInstallRun[]).length, 2);

  const scoped = await handler(ctxOf(null, new URLSearchParams(`ticket_id=${EVAL_TICKET}`)));
  assert.equal(bodyOf(scoped)['count'], 3);
  const empty = await handler(ctxOf(null, new URLSearchParams('ticket_id=ahd-other-ticket')));
  assert.equal(bodyOf(empty)['count'], 0);
  assert.equal((bodyOf(empty)['pick'] as PickRateResult).pick_rate, null);

  await assert.rejects(
    () => handler(ctxOf(null, new URLSearchParams('limit=0'))),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.stage, 'evals.validate');
      return true;
    },
  );
  await assert.rejects(
    () => handler(ctxOf(null, new URLSearchParams('ticket_id=bad%20id'))),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      return true;
    },
  );
});
