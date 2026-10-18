// sandbox/runner.test.ts — offline tests (node:test + node:assert/strict) against the
// Fake implementations. No network, no ports, no child processes (product/AGENTS.md).
// Covers: runner selection by env, create-once/resume-thereafter, fixture clone + the
// seeded broken flag, the 60s-cap background+poll convention, runCapped budget overrun,
// snapshot/fork isolation, destroy, and ToolEvent observability via the Repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../store/memory.ts';
import { poll, runCapped } from './client.ts';
import { FakeRunner } from './fake.ts';
import { blaxelRunner, fakeRunner, getRunner } from './runner.ts';

test('getRunner: fake without BLAXEL_API_KEY, real with it, fake when AHD_SANDBOX_FAKE=1', (t) => {
  const key = process.env.BLAXEL_API_KEY;
  const flag = process.env.AHD_SANDBOX_FAKE;
  t.after(() => {
    if (key === undefined) delete process.env.BLAXEL_API_KEY;
    else process.env.BLAXEL_API_KEY = key;
    if (flag === undefined) delete process.env.AHD_SANDBOX_FAKE;
    else process.env.AHD_SANDBOX_FAKE = flag;
  });

  delete process.env.AHD_SANDBOX_FAKE;
  delete process.env.BLAXEL_API_KEY;
  assert.equal(getRunner(), fakeRunner, 'no API key → fakeRunner');

  process.env.BLAXEL_API_KEY = 'test-key-placeholder-not-real';
  assert.equal(getRunner(), blaxelRunner, 'API key present → blaxelRunner (selection does no network I/O)');

  process.env.AHD_SANDBOX_FAKE = '1';
  assert.equal(getRunner(), fakeRunner, 'AHD_SANDBOX_FAKE=1 overrides the key');
});

test('createOrResume creates once, then resumes the same warm sandbox', async () => {
  const runner = new FakeRunner();
  const h1 = await runner.createOrResume('ahd-ticket-42');
  assert.equal(h1.name, 'ahd-ticket-42');
  await h1.write('/work/notes.txt', 'warm state');

  const h2 = await runner.createOrResume('ahd-ticket-42'); // resume, not rebuild
  assert.equal(await h2.read('/work/notes.txt'), 'warm state');

  await assert.rejects(() => runner.createOrResume('BAD NAME!'), /invalid sandbox name/);
});

test('git clone seeds fixtures; overwriting a seeded file clears the broken flag', async () => {
  const runner = new FakeRunner();
  const sb = await runner.createOrResume('ahd-clone-1');

  const clone = await sb.exec('git clone https://github.com/ledgerly/ledgerly.git');
  assert.equal(clone.exit_code, 0);
  assert.match(clone.stdout, /Cloning into 'ledgerly'/);
  assert.match(await sb.read('ledgerly/docs/quickstart.md'), /x-api-key/);

  const reproduced = await sb.exec('npm test');
  assert.equal(reproduced.exit_code, 1, 'seeded failure reproduces');

  await sb.write('ledgerly/docs/quickstart.md', '# Ledgerly quickstart\n\nUse Authorization: Bearer $LEDGERLY_KEY\n');
  const fixed = await sb.exec('npm test');
  assert.equal(fixed.exit_code, 0, 'the fix flipped the seeded flag');

  const noFixture = await sb.exec('git clone https://github.com/nosuch/repo.git');
  assert.equal(noFixture.exit_code, 128);
  assert.match(noFixture.stderr, /no fixture repository 'repo'/);

  const unsupported = await sb.exec('docker compose up');
  assert.equal(unsupported.exit_code, 127, 'unknown commands fail loud inside sandbox semantics');
  assert.match(unsupported.stderr, /not supported offline/);
});

test('background exec returns a pid immediately; poll reads the exit-code file', async () => {
  const runner = new FakeRunner(); // fixtures/config.json: background_ticks = 2
  const sb = await runner.createOrResume('ahd-bg-1');

  const started = await sb.exec('npm test', { background: true });
  assert.equal(started.exit_code, 0);
  const pid = started.stdout.trim();
  assert.match(pid, /^bg-/, 'stdout carries the pid token');

  assert.equal(await poll(sb, pid), null, 'first poll: still running');
  const done = await poll(sb, pid);
  assert.ok(done, 'second poll: finished');
  assert.equal(done.exit_code, 0);
  assert.match(done.stdout, /PASS/);

  await assert.rejects(() => poll(sb, 'bad;rm -rf /'), /sandbox\.poll/, 'poll refuses pids that are not tokens');
});

test('runCapped waits directly within the cap and backgrounds+polls beyond it', async () => {
  const runner = new FakeRunner();
  const sb = await runner.createOrResume('ahd-cap-1');

  const direct = await runCapped(sb, 'echo hello', { timeout_ms: 5_000 });
  assert.equal(direct.stdout, 'hello');

  const state = runner.inspect('ahd-cap-1');
  assert.ok(state);
  assert.equal(state.execLog.some((e) => e.background), false, 'within-cap runs never background');

  const bg = await runCapped(sb, 'npm test', { timeout_ms: 90_000, poll_interval_ms: 1 });
  assert.equal(bg.exit_code, 0);
  assert.ok(state.execLog.some((e) => e.background && e.cmd === 'npm test'), 'over-cap run started backgrounded');
  assert.ok(state.execLog.some((e) => e.cmd.startsWith(`cat '/tmp/ahd-bg-`)), 'poll read the exit-code file');
});

test('runCapped fails loud with stage sandbox.exec when the budget is exhausted', async () => {
  const runner = new FakeRunner({ backgroundTicks: 1_000_000 }); // never finishes in time
  const sb = await runner.createOrResume('ahd-cap-2');
  await assert.rejects(
    () => runCapped(sb, 'npm test', { timeout_ms: 30, cap_ms: 10, poll_interval_ms: 1 }),
    /sandbox\.exec: command still running after 30ms/,
  );
});

test('fork restores the snapshot and cannot inherit post-snapshot resolver state', async () => {
  const runner = new FakeRunner();
  const parent = await runner.createOrResume('ahd-fork-1');
  await parent.write('/ahd/resolver/early.md', 'draft at snapshot time');
  const snap = await parent.snapshot();
  await parent.write('/ahd/resolver/late.md', 'reasoning written AFTER the snapshot');

  const forked = await runner.fork(snap, 'ahd-fork-1-fresh');
  assert.equal(await forked.read('/ahd/resolver/early.md'), 'draft at snapshot time');
  await assert.rejects(() => forked.read('/ahd/resolver/late.md'), /not found/, 'post-snapshot state did not leak into the fork');

  await forked.write('/fork-only.md', 'x');
  await assert.rejects(() => parent.read('/fork-only.md'), /not found/, 'fork writes do not leak back to the parent');

  await assert.rejects(() => runner.fork('snap-does-not-exist', 'ahd-x1'), /unknown snapshot/);
});

test('destroy removes the sandbox; a later createOrResume starts clean', async () => {
  const runner = new FakeRunner();
  const sb = await runner.createOrResume('ahd-dest-1');
  await sb.write('/keep.txt', 'state');
  await runner.destroy('ahd-dest-1');
  await assert.rejects(() => runner.destroy('ahd-dest-1'), /no fake sandbox/);
  const fresh = await runner.createOrResume('ahd-dest-1');
  await assert.rejects(() => fresh.read('/keep.txt'), /not found/);
});

test('getRunner(repo) appends ToolEvents for create/resume, fork and destroy (ok and error)', async (t) => {
  const flag = process.env.AHD_SANDBOX_FAKE;
  t.after(() => {
    if (flag === undefined) delete process.env.AHD_SANDBOX_FAKE;
    else process.env.AHD_SANDBOX_FAKE = flag;
  });
  process.env.AHD_SANDBOX_FAKE = '1';

  const repo = new MemoryRepository();
  const runner = getRunner(repo);
  const sb = await runner.createOrResume('ahd-obs-7');
  const snap = await sb.snapshot();
  await runner.fork(snap, 'ahd-obs-7-fresh');
  await runner.destroy('ahd-obs-7-fresh');
  await runner.destroy('ahd-obs-7');
  await assert.rejects(() => runner.destroy('ahd-obs-never-existed'), /no fake sandbox/);

  const events = await repo.toolEvents({ tool: 'sandbox' });
  assert.deepEqual(
    events.map((e) => [e.stage, e.result]),
    [
      ['sandbox.createOrResume', 'ok'],
      ['sandbox.fork', 'ok'],
      ['sandbox.destroy', 'ok'],
      ['sandbox.destroy', 'ok'],
      ['sandbox.destroy', 'error'],
    ],
  );
  assert.equal(events[0].ticket_id, 'obs-7', 'ticket id is the sandbox name minus the ahd- prefix');
  assert.equal(events[1].stage, 'sandbox.fork');
  for (const e of events) {
    assert.ok(e.id.length > 0);
    assert.ok(e.d_ms >= 0);
    assert.ok(e.at.length > 0);
  }
});
