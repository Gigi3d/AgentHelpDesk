import test from 'node:test';
import assert from 'node:assert/strict';
import './../desk/testenv.ts';
import { MemoryRepository } from '../store/memory.ts';
import type { Handler, Router } from '../shared/http.ts';
import { registerRoutes } from './register.ts';
import { HttpError } from '../shared/http.ts';

const ctx = (body: unknown = null) => ({ method: 'POST', path: '/', query: new URLSearchParams(), body, headers: {}, requestId: 't', caller: null });

async function setup(env: Record<string, string>) {
  const repo = new MemoryRepository();
  await repo.putVendor({ id: 'ledgerly', name: 'Ledgerly', repo_url: '', sandbox_name: 'ahd-vendor-ledgerly', risk_policy: 'autonomous', stripe_customer_id: '', payer_mode: 'vendor', report_contacts: [] });
  const routes = new Map<string, Handler>();
  const router: Router = { add: (m, p, h) => void routes.set(`${m} ${p}`, h) };
  const started: string[] = [];
  registerRoutes(router, repo, {
    pollMs: 5,
    env: { AHD_SANDBOX_FAKE: '1', ...env } as NodeJS.ProcessEnv,
    start: async (id) => {
      started.push(id);
      await repo.setFailureStatus(id, 'shipped');
    },
  });
  const get = routes.get('GET /v1/public/demo')!;
  const run = routes.get('POST /v1/public/demo/run')!;
  return { get, run, started };
}

test('the public door is closed unless it is switched on', async () => {
  const { get, run } = await setup({});
  await assert.rejects(() => get(ctx()), (e) => e instanceof HttpError && e.status === 404);
  await assert.rejects(() => run(ctx()), (e) => e instanceof HttpError && e.status === 404);
});

test('a run files four failures as alpha then four as beta, and a second click is refused while cooling down', async () => {
  const { get, run, started } = await setup({ AHD_PUBLIC_DEMO: '1', AHD_PUBLIC_COOLDOWN_S: '60' });
  const first = await run(ctx());
  assert.equal(first.status, 202);
  await assert.rejects(() => run(ctx()), (e) => e instanceof HttpError && e.status === 429);
  for (let i = 0; i < 50; i += 1) {
    const s = (await get(ctx())).body as { run: { phase: string } };
    if (s.run.phase === 'done') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const done = (await get(ctx())).body as { run: { phase: string; cases: string[] }; can_run: boolean; wait_s: number };
  assert.equal(done.run.phase, 'done');
  assert.equal(done.run.cases.length, 8);
  assert.equal(started.length, 8);
  assert.equal(done.can_run, false);
  assert.ok(done.wait_s > 0);
});

test('the hourly cap stops a run even with no cooldown', async () => {
  const { run } = await setup({ AHD_PUBLIC_DEMO: '1', AHD_PUBLIC_COOLDOWN_S: '0.001', AHD_PUBLIC_MAX_PER_HOUR: '1' });
  await run(ctx());
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(() => run(ctx()), (e) => e instanceof HttpError && e.status === 429);
});
