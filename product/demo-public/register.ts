// demo-public/register.ts: a public, read-mostly door so anyone (judges) can run the demo without a desk key.
//   GET  /v1/public/demo       the current run: phase, every case with status/proofs/memory hit, and whether a run may start
//   POST /v1/public/demo/run   start the full demo: four x402 failures as agent alpha, then the same four as agent beta
//
// Off unless AHD_PUBLIC_DEMO=1. Everything else on the desk keeps its token. The run is bounded so a public
// button cannot burn the Blaxel quota or the model budget: one run at a time, a cooldown after each,
// an hourly cap, a fixed scenario set, and the sandboxes of earlier public runs are deleted before a new one.
import type { HttpResult, Router } from '../shared/http.ts';
import { HttpError } from '../shared/http.ts';
import type { Repository } from '../store/repository.ts';
import { DEFAULT_IDS } from '../scenarios/catalog.ts';
import { runRows, startScenarios } from '../scenarios/register.ts';
import * as blaxel from '../blaxel/register.ts';

export const publicDemoOn = (env: NodeJS.ProcessEnv = process.env): boolean => env['AHD_PUBLIC_DEMO'] === '1';

type Phase = 'idle' | 'alpha' | 'beta' | 'done' | 'failed';
interface Run {
  id: string;
  phase: Phase;
  started_at: string;
  finished_at: string | null;
  cases: string[];
  note: string;
}

const WORKING = new Set(['opened', 'reproducing', 'fix_drafted', 'proving']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (v: string | undefined, d: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export interface PublicDemoDeps {
  start: (caseId: string) => Promise<void>;
  /** Overridable in tests. */
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function registerRoutes(router: Router, repo: Repository, deps: PublicDemoDeps): void {
  const env = deps.env ?? process.env;
  const pollMs = deps.pollMs ?? 2000;
  const cooldownMs = num(env['AHD_PUBLIC_COOLDOWN_S'], 60) * 1000;
  const maxPerHour = num(env['AHD_PUBLIC_MAX_PER_HOUR'], 8);
  const waitMs = num(env['AHD_PUBLIC_RUN_TIMEOUT_S'], 600) * 1000;
  let current: Run | null = null;
  const starts: number[] = [];
  const earlierCases = new Set<string>();

  const running = (): boolean => current !== null && (current.phase === 'alpha' || current.phase === 'beta');
  const verdict = (now: number): { can_run: boolean; why: string | null; runs_left: number; wait_s: number } => {
    const recent = starts.filter((t) => now - t < 3_600_000);
    const runsLeft = Math.max(0, maxPerHour - recent.length);
    if (running()) return { can_run: false, why: 'A run is in progress.', runs_left: runsLeft, wait_s: 0 };
    const since = current?.finished_at ? now - Date.parse(current.finished_at) : Infinity;
    if (since < cooldownMs) return { can_run: false, why: 'Cooling down before the next run.', runs_left: runsLeft, wait_s: Math.ceil((cooldownMs - since) / 1000) };
    if (runsLeft === 0) return { can_run: false, why: 'Hourly limit reached. Try again later.', runs_left: 0, wait_s: 0 };
    return { can_run: true, why: null, runs_left: runsLeft, wait_s: 0 };
  };

  async function settle(ids: string[], deadline: number): Promise<void> {
    for (;;) {
      const live = await Promise.all(ids.map((id) => repo.getFailure(id)));
      if (live.every((f) => f !== null && !WORKING.has(f.status))) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for the cases to finish');
      await sleep(pollMs);
    }
  }

  async function prune(): Promise<void> {
    if (earlierCases.size === 0 || env['AHD_SANDBOX_FAKE'] === '1' || !env['BLAXEL_API_KEY']) return;
    try {
      const all = await blaxel.listSandboxes();
      for (const s of all) {
        const caseId = s.name.replace(/-fresh$/, '').slice(4);
        if (s.role !== 'desk' && earlierCases.has(caseId)) await blaxel.deleteSandboxByName(repo, s.name, 'public-demo').catch(() => undefined);
      }
    } catch {
      // pruning is housekeeping; a failed list must not block the demo
    }
  }

  async function orchestrate(run: Run): Promise<void> {
    try {
      await prune();
      const deadline = Date.now() + waitMs;
      for (const agent of ['alpha', 'beta'] as const) {
        run.phase = agent;
        const started = await startScenarios(repo, deps.start, DEFAULT_IDS, agent);
        for (const s of started) run.cases.push(s.case_id);
        await settle(started.map((s) => s.case_id), deadline);
      }
      run.phase = 'done';
      run.note = 'Finished. Nobody approved anything.';
    } catch (err) {
      run.phase = 'failed';
      run.note = err instanceof Error ? err.message.slice(0, 200) : 'The run failed.';
    } finally {
      run.finished_at = new Date().toISOString();
      for (const id of run.cases) earlierCases.add(id);
    }
  }

  router.add('GET', '/v1/public/demo', async (): Promise<HttpResult> => {
    if (!publicDemoOn(env)) throw new HttpError(404, 'not_found', 'the public demo is not enabled on this desk', 'demo.public');
    const rows = (await runRows(repo)).filter((r) => current !== null && current.cases.includes(r.case_id));
    return { status: 200, body: { run: current, rows, ...verdict(Date.now()) } };
  });

  router.add('POST', '/v1/public/demo/run', async (): Promise<HttpResult> => {
    if (!publicDemoOn(env)) throw new HttpError(404, 'not_found', 'the public demo is not enabled on this desk', 'demo.public');
    const now = Date.now();
    const v = verdict(now);
    if (!v.can_run) throw new HttpError(429, 'demo_busy', v.why ?? 'Not now.', 'demo.public');
    starts.push(now);
    const run: Run = { id: `run-${now.toString(36)}`, phase: 'alpha', started_at: new Date(now).toISOString(), finished_at: null, cases: [], note: 'Agent alpha is reporting four failures.' };
    current = run;
    void orchestrate(run);
    return { status: 202, body: { run } };
  });
}
