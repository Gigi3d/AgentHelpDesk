// proofs/proofs.test.ts — offline tests (node:test + node:assert/strict) for the three
// proofs against the Fake sandbox + fake proof runner. No network, no ports, no child
// processes. Covers: golden path (all three pass, in order), replay-fails → ProofResult
// pass:false (never a throw), >60s exec goes background+poll, fork isolation for the
// fresh agent, fresh-agent failure paths, ToolEvent observability, and runner selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Failure, SandboxHandle } from '../shared/types.ts';
import { MemoryRepository } from '../store/memory.ts';
import { FakeRunner } from '../sandbox/fake.ts';
import { fakeProofRunner, getProofRunner, proofRunner } from './proofs.ts';

function makeFailure(over?: Partial<Failure>): Failure {
  return {
    id: 'case-1',
    vendor_id: 'ledgerly',
    agent_id: 'agent-7',
    task: 'Create a ledger entry via POST /v1/entries',
    request: { method: 'POST', path: '/v1/entries', headers: { 'x-api-key': '<LEDGERLY_KEY>' } },
    response: { status: 401, body: { error: 'unauthorized' } },
    klass: 'knowledge',
    status: 'proving',
    ack_by: '2026-10-18T09:00:00.000Z',
    resolve_by: '2026-10-18T12:00:00.000Z',
    queue_position: 1,
    created_at: '2026-10-18T08:59:00.000Z',
    ...over,
  };
}

const FIXED_QUICKSTART = '# Ledgerly quickstart\n\nUse Authorization: Bearer $LEDGERLY_KEY\n';

async function seededCase(name: string): Promise<{ runner: FakeRunner; sb: SandboxHandle }> {
  const runner = new FakeRunner();
  const sb = await runner.createOrResume(name);
  const clone = await sb.exec('git clone https://github.com/ledgerly/ledgerly.git');
  assert.equal(clone.exit_code, 0, 'fixture repo cloned into the fake sandbox');
  return { runner, sb };
}

test('golden path: replay → vendorTests → freshAgent all pass after the fix', async () => {
  const { runner, sb } = await seededCase('ahd-golden-1');
  const f = makeFailure();

  await sb.write('ledgerly/docs/quickstart.md', FIXED_QUICKSTART); // the resolver's fix

  const replay = await fakeProofRunner.replay(sb, f);
  assert.equal(replay.proof, 'replay');
  assert.equal(replay.pass, true, replay.detail);

  const vendor = await fakeProofRunner.vendorTests(sb);
  assert.equal(vendor.proof, 'vendor_tests');
  assert.equal(vendor.pass, true, vendor.detail);

  const snap = await sb.snapshot();
  const forked = await runner.fork(snap, 'ahd-golden-1-fresh');
  const fresh = await fakeProofRunner.freshAgent(forked, f.task, ['ledgerly/docs/quickstart.md']);
  assert.equal(fresh.proof, 'fresh_agent');
  assert.equal(fresh.pass, true, fresh.detail);

  // The fresh agent was given ONLY the task + the changed docs.
  assert.equal(await forked.read('/ahd/fresh/task.md'), f.task);
  const brief: unknown = JSON.parse(await forked.read('/ahd/fresh/changed.json'));
  assert.ok(Array.isArray(brief));
  assert.equal(brief.length, 1);
  const first = brief[0] as { path: string; content: string };
  assert.equal(first.path, 'ledgerly/docs/quickstart.md');
  assert.equal(first.content, FIXED_QUICKSTART);
});

test('replay before the fix resolves with pass:false naming the failure — it never throws', async () => {
  const { sb } = await seededCase('ahd-replay-fail');
  const f = makeFailure({ id: 'case-2' });

  const replay = await fakeProofRunner.replay(sb, f); // resolving at all proves "no throw"
  assert.equal(replay.proof, 'replay');
  assert.equal(replay.pass, false);
  assert.match(replay.detail, /replay of case-2 still fails/);
  assert.match(replay.detail, /exited 1/);

  const vendor = await fakeProofRunner.vendorTests(sb);
  assert.equal(vendor.pass, false);
  assert.match(vendor.detail, /vendor tests failed/);
  assert.equal(vendor.proof, 'vendor_tests');
});

test('vendorTests over the 60s cap starts backgrounded and polls the exit-code file', async () => {
  const { runner, sb } = await seededCase('ahd-longrun');
  await sb.write('ledgerly/docs/quickstart.md', FIXED_QUICKSTART);

  const res = await fakeProofRunner.vendorTests(sb); // budget 90s > 60s cap → background+poll
  assert.equal(res.pass, true, res.detail);

  const state = runner.inspect('ahd-longrun');
  assert.ok(state);
  assert.ok(
    state.execLog.some((e) => e.background && e.cmd === 'npm test'),
    'the vendor test command was started with background:true',
  );
  const catPolls = state.execLog.filter((e) => e.cmd.startsWith(`cat '/tmp/ahd-bg-`));
  assert.ok(catPolls.length >= 2, `poll read the exit-code file until it appeared (saw ${catPolls.length} cat polls)`);
});

test('freshAgent runs in the fork and cannot see resolver state written after the snapshot', async () => {
  const { runner, sb } = await seededCase('ahd-isolate');
  await sb.write('ledgerly/docs/quickstart.md', FIXED_QUICKSTART);
  const snap = await sb.snapshot();
  await sb.write('/ahd/resolver/reasoning.md', 'resolver private chain of thought');

  const forked = await runner.fork(snap, 'ahd-isolate-fresh');
  await assert.rejects(() => forked.read('/ahd/resolver/reasoning.md'), /not found/);

  const fresh = await fakeProofRunner.freshAgent(forked, 'retry the task', ['ledgerly/docs/quickstart.md']);
  assert.equal(fresh.pass, true, fresh.detail);
  // Still isolated after the run: the fresh agent got task+docs only, no reasoning.
  await assert.rejects(() => forked.read('/ahd/resolver/reasoning.md'), /not found/);
});

test('freshAgent fails (pass:false) on missing changed docs or unsafe paths', async () => {
  const { runner, sb } = await seededCase('ahd-fresh-fail');
  const snap = await sb.snapshot();
  const forked = await runner.fork(snap, 'ahd-fresh-fail-fresh');

  const missing = await fakeProofRunner.freshAgent(forked, 'task text', ['docs/never-written.md']);
  assert.equal(missing.proof, 'fresh_agent');
  assert.equal(missing.pass, false);
  assert.match(missing.detail, /docs\/never-written\.md/);
  assert.match(missing.detail, /could not be read/);

  const unsafe = await fakeProofRunner.freshAgent(forked, 'task text', ['../escape.md']);
  assert.equal(unsafe.pass, false);
  assert.match(unsafe.detail, /not a safe relative path/);

  await assert.rejects(() => fakeProofRunner.freshAgent(forked, '   ', []), /task text is required/);
});

test('Failure.request.replay_cmd overrides the replay harness when present', async () => {
  const { sb } = await seededCase('ahd-cmd-override');
  const f = makeFailure({ id: 'case-cmd', request: { replay_cmd: 'echo replayed-ok' } });
  const res = await fakeProofRunner.replay(sb, f);
  assert.equal(res.pass, true);
  assert.match(res.detail, /replayed-ok/);
});

test('proofRunner (real budgets) replays directly within the cap — no background, no polling', async () => {
  const { runner, sb } = await seededCase('ahd-real-budgets');
  const f = makeFailure({ id: 'case-real' });

  const before = await proofRunner.replay(sb, f);
  assert.equal(before.pass, false);

  await sb.write('ledgerly/docs/quickstart.md', FIXED_QUICKSTART);
  const after = await proofRunner.replay(sb, f);
  assert.equal(after.pass, true, after.detail);

  const state = runner.inspect('ahd-real-budgets');
  assert.ok(state);
  assert.equal(state.execLog.some((e) => e.background), false, '30s replay budget ≤ 60s cap → direct exec');
});

test('getProofRunner: fake via AHD_PROOFS_FAKE=1, and one ToolEvent per proof via the repo', async (t) => {
  const saved = process.env.AHD_PROOFS_FAKE;
  t.after(() => {
    if (saved === undefined) delete process.env.AHD_PROOFS_FAKE;
    else process.env.AHD_PROOFS_FAKE = saved;
  });

  delete process.env.AHD_PROOFS_FAKE;
  assert.equal(getProofRunner(), proofRunner, 'no fake flag → proofRunner');
  process.env.AHD_PROOFS_FAKE = '1';
  assert.equal(getProofRunner(), fakeProofRunner, 'AHD_PROOFS_FAKE=1 → fakeProofRunner');

  const repo = new MemoryRepository();
  const observed = getProofRunner(repo);
  const { runner, sb } = await seededCase('ahd-obs-proof');
  const f = makeFailure({ id: 'case-9' });

  const failFirst = await observed.replay(sb, f);
  assert.equal(failFirst.pass, false, 'proof fails before the fix');

  await sb.write('ledgerly/docs/quickstart.md', FIXED_QUICKSTART);
  const replay = await observed.replay(sb, f);
  assert.equal(replay.pass, true);
  const vendor = await observed.vendorTests(sb);
  assert.equal(vendor.pass, true);
  const snap = await sb.snapshot();
  const forked = await runner.fork(snap, 'ahd-obs-proof-fresh');
  const fresh = await observed.freshAgent(forked, f.task, ['ledgerly/docs/quickstart.md']);
  assert.equal(fresh.pass, true);

  const events = await repo.toolEvents({ tool: 'proofs' });
  assert.deepEqual(
    events.map((e) => [e.action, e.result]),
    [
      ['replay', 'fail'],
      ['replay', 'pass'],
      ['vendor_tests', 'pass'],
      ['fresh_agent', 'pass'],
    ],
  );
  assert.equal(events[0].stage, 'proofs.replay');
  assert.equal(events[0].ticket_id, 'case-9', 'replay events key on the failure/case id');
  assert.equal(events[2].ticket_id, 'obs-proof', 'sandbox-bound proofs key on the sandbox name minus ahd-');
  assert.equal(events[2].stage, 'proofs.vendor_tests');
  assert.equal(events[3].stage, 'proofs.fresh_agent');
  for (const e of events) {
    assert.ok(e.id.length > 0);
    assert.ok(e.d_ms >= 0);
    assert.ok(typeof e.payload === 'object' && e.payload !== null);
  }
});
