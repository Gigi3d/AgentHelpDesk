// scenarios/register.ts: the x402 scenario board.
//   GET  /v1/scenarios       every scenario with the cases that ran it: status, proofs, whether the fix came
//                            from memory, and how long it took. Read-only.
//   POST /v1/scenarios/run   { ids?: string[], agent?: string } files each scenario's failure as an agent would and
//                            starts the loop in the background. No approval step: the vendor runs autonomous.
import type { Ctx, HttpResult, Router } from '../shared/http.ts';
import { HttpError } from '../shared/http.ts';
import { intake } from '../desk/intake.ts';
import { sandboxName } from '../desk/loop.ts';
import type { Failure } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { SCENARIOS, reportFor, scenarioById } from './catalog.ts';

export interface ScenarioDeps {
  start: (caseId: string) => Promise<void>;
}

function codeOf(f: Failure): string | null {
  const r = f.response;
  const e = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)['error'] : null;
  const c = typeof e === 'object' && e !== null ? (e as Record<string, unknown>)['code'] : null;
  return typeof c === 'string' ? c : null;
}

export function registerRoutes(router: Router, repo: Repository, deps: ScenarioDeps): void {
  router.add('GET', '/v1/scenarios', async (): Promise<HttpResult> => {
    const cases = (await repo.listFailures()).filter((f) => f.agent_id.startsWith('scn:'));
    const hits = new Set((await repo.toolEvents({ action: 'resolver.memory_hit' })).map((e) => e.ticket_id));
    const rows = await Promise.all(
      cases.map(async (f) => {
        const [attempt, outcome, events] = await Promise.all([repo.latestAttempt(f.id), repo.getOutcome(f.id), repo.toolEvents({ ticket_id: f.id })]);
        const last = events.reduce((m, e) => Math.max(m, Date.parse(e.at)), 0);
        return {
          case_id: f.id,
          scenario: codeOf(f),
          agent: f.agent_id.slice(4),
          status: f.status,
          created_at: f.created_at,
          ms: last > 0 ? Math.max(0, last - Date.parse(f.created_at)) : null,
          memory_hit: hits.has(f.id),
          sandbox: sandboxName(f.id),
          proofs: attempt ? { replay: attempt.proof_replay, vendor_tests: attempt.proof_vendor_tests, fresh_agent: attempt.proof_fresh_agent } : null,
          billable: outcome ? outcome.billable === true : false,
        };
      }),
    );
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { status: 200, body: { scenarios: SCENARIOS.map((s) => ({ ...s, runs: rows.filter((r) => r.scenario === s.id) })) } };
  });

  router.add('POST', '/v1/scenarios/run', async (ctx: Ctx): Promise<HttpResult> => {
    const b = (typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {}) as Record<string, unknown>;
    const ids = Array.isArray(b['ids']) && b['ids'].length > 0 ? (b['ids'] as unknown[]).map(String) : SCENARIOS.map((s) => s.id);
    const agent = typeof b['agent'] === 'string' && /^[a-z0-9-]{1,32}$/.test(b['agent']) ? b['agent'] : 'alpha';
    const picked = ids.map((id) => {
      const s = scenarioById(id);
      if (!s) throw new HttpError(400, 'bad_request', `unknown scenario '${id}'`, 'scenarios.run');
      return s;
    });
    const stamp = Date.now().toString(36);
    const started: { scenario: string; case_id: string }[] = [];
    for (const s of picked) {
      const f = await intake(reportFor(s, `scn:${agent}`, `scn-${s.id}-${agent}-${stamp}`), repo);
      started.push({ scenario: s.id, case_id: f.id });
      void deps.start(f.id);
    }
    return { status: 202, body: { started } };
  });
}
