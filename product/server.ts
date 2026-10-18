// AgentHelpDesk backend entrypoint. Dependency-free (node:http only).
// Stateless by design: all state lives in the Repository, so N copies of this
// process can sit behind a load balancer. Modules register their own routes.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Ctx, Handler, Router } from './shared/http.ts';
import { HttpError } from './shared/http.ts';
import { MemoryRepository } from './store/memory.ts';
import type { Repository } from './store/repository.ts';
import { registerRoutes as registerDesk } from './desk/register.ts';
import type { DeskDeps } from './desk/register.ts';
import type { ApprovalAsk, ApprovalDecision } from './desk/gate.ts';
import { registerRoutes as registerBilling } from './billing/register.ts';
import { decide } from './billing/billable.ts';
import { onBillable } from './billing/meter.ts';
import { registerRoutes as registerApprovals } from './approvals/register.ts';
import { requestApproval } from './approvals/approvals.ts';
import { registerRoutes as registerEvals } from './evals/register.ts';
import { registerRoutes as registerEmail } from './email/register.ts';
import { getRunner } from './sandbox/runner.ts';
import { getProofRunner } from './proofs/proofs.ts';
import { liveLoopDeps, localRunnerFromEnv, normalizeBlaxelEnv, runtimeReport, seedLiveVendor } from './live.ts';
// Imported last on purpose: demo-seed.ts's module body turns on the offline fakes
// when AHD_SEED=demo, and that must happen before getRunner()/getProofRunner() run below.
import { demoSeedRequested, seedDemo } from './demo-seed.ts';

// Accept BL_API_KEY or BLAXEL_API_KEY before anything reads the sandbox key.
normalizeBlaxelEnv();

export const repo: Repository = new MemoryRepository();

const routes = new Map<string, Handler>();
const router: Router = {
  add(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  },
};

/** The approval channel. desk/ owns the gate and approvals/ owns the Inkbox
 * sender; neither imports the other, so this adapter is the only place they meet. */
async function askApproval(ask: ApprovalAsk, store: Repository): Promise<ApprovalDecision> {
  // A human may have replied between runs. A recorded decision wins: never re-ask,
  // never re-send, and never overwrite what they said.
  const existing = await store.getApproval(ask.approval_id);
  if (existing && (existing.decision === 'yes' || existing.decision === 'no')) {
    return { decision: existing.decision, approver: existing.approver, detail: 'decision recorded before this run' };
  }

  const approver =
    ask.approvers.find((a) => a.trim().length > 0)?.trim() ?? (process.env['AHD_APPROVALS_FALLBACK_EMAIL'] ?? '').trim();
  if (approver.length === 0) {
    // Nobody to ask. Hold the change — approving it ourselves is the one thing the
    // gate exists to prevent.
    return {
      decision: 'pending',
      approver: '',
      detail: 'no approver on the vendor row and AHD_APPROVALS_FALLBACK_EMAIL is unset; the change is held',
    };
  }

  const sent = await requestApproval(ask.failure_id, ask.change_summary, approver, store);
  const decision = sent.approval.decision;
  if (decision === 'yes' || decision === 'no') {
    return { decision, approver: sent.approval.approver, detail: 'answered on the approval channel' };
  }
  return {
    decision: 'pending',
    approver,
    detail: `${sent.replayed ? 'already sent' : 'sent'} on the ${sent.channel} channel; waiting for a one-reply approval`,
  };
}

const deskDeps: DeskDeps = {
  // Both take the repository so the sandbox and the proofs record their own
  // ToolEvents: the console shows what really ran, not what we intended to run.
  runner: getRunner(repo),
  proofs: getProofRunner(repo),
  // Opt-in real components (AHD_RESOLVER, AHD_PROVISION_DIR, AHD_FRESH_BASELINE); empty by default.
  ...liveLoopDeps(),
  ...(await localRunnerFromEnv()),
  askApproval,
  onBillable: async (notice, store) => {
    // billing/ picks the lane (it knows the vendor's rail and the exemptions); the
    // desk's own guess in `notice.lane` is only a hint.
    const decision = await decide(notice.failure_id, store);
    if (!decision.billable || decision.lane === null) {
      // Loud on purpose: the desk just recorded `billing.billable`, so a disagreement
      // is a real inconsistency and must surface as `billing.notify_failed`.
      throw new HttpError(
        409,
        'not_billable',
        `billing declined case ${notice.failure_id}: ${decision.reason}`,
        'billing.decide',
      );
    }
    const outcome = await store.getOutcomeById(notice.outcome_id);
    if (!outcome) {
      throw new HttpError(404, 'outcome_not_found', `no outcome ${notice.outcome_id}`, 'billing.meter');
    }
    const result = await onBillable(outcome, decision.lane, store);
    if (result.kind === 'payment_required') {
      // Priced and unpaid: the desk withholds the answer and hands back the 402.
      return { lane: result.lane, unlock: false, charged: false, payment_required: { status: result.status, ...result.requirement } };
    }
    if (result.kind === 'settled') {
      return { lane: result.lane, unlock: result.unlock === true, charged: true };
    }
    return { lane: result.lane, unlock: true, charged: true };
  },
};

registerDesk(router, repo, deskDeps);
registerBilling(router, repo);
registerApprovals(router, repo);
registerEvals(router, repo);
registerEmail(router, repo);

// Says, from the environment as it really is, which components are real. Never returns secrets.
router.add('GET', '/v1/runtime', async () => ({ status: 200, body: runtimeReport() }));

// Token-bucket rate limit per client IP so one runaway agent cannot melt the desk.
const buckets = new Map<string, { tokens: number; ts: number }>();
const RATE_PER_SEC = Number(process.env.AHD_RATE_PER_SEC ?? 20);
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: RATE_PER_SEC, ts: now };
  b.tokens = Math.min(RATE_PER_SEC, b.tokens + ((now - b.ts) / 1000) * RATE_PER_SEC);
  b.ts = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return true;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  return false;
}

// The operator console is served from its own origin, so the API has to name who may
// call it from a browser. Loopback dev origins by default — 5180 is what web/vite.config.ts
// serves, 5173 is vite's own default, 5181 is the static bundle; set AHD_CORS_ORIGINS to a
// comma-separated list (or `*`) for anything else. An origin that is not on the list
// gets no CORS headers, and the browser refuses the call.
const CORS_ORIGINS = (
  process.env.AHD_CORS_ORIGINS ??
  'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5180,http://127.0.0.1:5180,http://localhost:5181,http://127.0.0.1:5181'
)
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o !== '');

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined) return {};
  const allow = CORS_ORIGINS.includes('*') ? '*' : CORS_ORIGINS.includes(origin) ? origin : null;
  if (allow === null) return {};
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-agent-id',
    'access-control-expose-headers': 'x-request-id,x-payment-required',
    vary: 'origin',
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'payload_too_large', 'body exceeds 1MB', 'http'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'body is not valid JSON', 'http'));
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res: ServerResponse) => {
  const requestId = randomUUID();
  const url = new URL(req.url ?? '/', 'http://localhost');
  const ip = req.socket.remoteAddress ?? 'unknown';
  res.setHeader('x-request-id', requestId);
  for (const [name, value] of Object.entries(corsHeaders(req.headers.origin))) res.setHeader(name, value);

  // Preflight carries no body and must not be throttled or routed.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (rateLimited(ip)) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down', stage: 'http', request_id: requestId } }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, request_id: requestId }));
    return;
  }

  const handler = routes.get(`${req.method} ${url.pathname}`);
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: `no route ${req.method} ${url.pathname}`, stage: 'http', request_id: requestId } }));
    return;
  }

  try {
    // GET carries no body; a bodyless DELETE resolves to null, so reading it is safe.
    const body = req.method === 'GET' ? null : await readBody(req);
    const ctx: Ctx = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body,
      headers: req.headers,
      requestId,
      caller: (req.headers['x-agent-id'] as string | undefined) ?? null,
    };
    const result = await handler(ctx);
    res.writeHead(result.status, { 'content-type': 'application/json', ...result.headers });
    res.end(JSON.stringify(result.body));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const body =
      err instanceof HttpError
        ? err.toBody(requestId)
        : { error: { code: 'internal', message: (err as Error).message, stage: 'http', request_id: requestId } };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
});

// Opt-in demo data. AHD_SEED=demo seeds the one vendor row no HTTP route can create
// plus four cases produced by the real intake/loop/gate/billing code, so a fresh boot
// has something for the console to show. Unset means today's empty repository. The
// seed's HttpError is deliberately not caught: a half-seeded demo must stop the boot.
if (demoSeedRequested()) {
  const seeded = await seedDemo(repo, { deps: deskDeps });
  process.stdout.write(
    `agenthelpdesk demo seed: vendor ${seeded.vendor_id} (${seeded.risk_policy}, lane ${seeded.lane}), ` +
      `${seeded.cases.length} case(s), ${seeded.meter_events} meter event(s), ${seeded.approvals_pending} awaiting approval\n`,
  );
}

const liveVendor = await seedLiveVendor(repo);
if (liveVendor) {
  process.stdout.write(`agenthelpdesk live vendor: ${liveVendor.id} (${liveVendor.risk_policy}, test: ${liveVendor.test_command ?? 'default'})\n`);
}
for (const c of runtimeReport().components) {
  process.stdout.write(`agenthelpdesk runtime: ${c.real ? 'REAL ' : 'fake '} ${c.name}: ${c.detail}\n`);
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1'; // set HOST=0.0.0.0 only behind a trusted network or proxy: the API has no auth
server.listen(port, host, () => {
  process.stdout.write(`agenthelpdesk desk api listening on ${host}:${port}\n`);
});
