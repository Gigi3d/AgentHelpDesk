// approvals/register.ts — HTTP surface for the approval gate and the vendor reports.
//
//   POST /v1/approvals            {failure_id, change_summary, approver}
//   POST /v1/approvals/reply      {id, decision:'yes'|'no', approver}   (or {id, text, approver})
//   GET  /v1/approvals?id=apv_…
//   GET  /v1/reports/daily?vendor_id=…
//   GET  /v1/reports/weekly?vendor_id=…
//   POST /v1/reports/send-now     {vendor_id, kind:'daily'|'weekly'}     -> report + ToolEvent report.sent
//
// Handlers are exported individually so tests can call them with a constructed Ctx and a
// MemoryRepository, with no port bound and no process spawned (AGENTS.md).
import type { Ctx, HttpResult, Router } from '../shared/http.ts';
import { HttpError, badRequest, ok, str } from '../shared/http.ts';
import type { Repository } from '../store/repository.ts';
import type { InkboxClient } from './inkbox-client.ts';
import { applyReply, parseReply, requestApproval, storeGuard } from './approvals.ts';
import { buildReport, daily, sendReport, weekly, type ReportKind } from './reports.ts';
import { maskRecipient } from './events.ts';

const STAGE_CREATE = 'approvals.http.create';
const STAGE_REPLY = 'approvals.http.reply';
const STAGE_READ = 'approvals.http.read';
const STAGE_REPORT = 'approvals.http.report';
const STAGE_SEND_NOW = 'approvals.http.send_now';

type Env = Record<string, string | undefined>;

export interface RouteDeps {
  /** Injectable Inkbox client; defaults to createInkboxClient() (Fake when AHD_APPROVALS_FAKE=1). */
  client?: InkboxClient;
  env?: Env;
  now?: () => number;
  fallbackEmail?: string | null;
  /** Optional override for report delivery (a demo inbox instead of the vendor's contacts). */
  recipients?: string[];
}

function queryParam(ctx: Ctx, name: string, stage: string): string {
  const raw = ctx.query.get(name);
  if (raw === null || raw.trim() === '') throw badRequest(stage, `query parameter "${name}" is required`);
  return raw.trim();
}

function decisionFrom(ctx: Ctx, approvalId: string, stage: string): 'yes' | 'no' {
  const body = ctx.body as Record<string, unknown> | null;
  const decision = body?.['decision'];
  if (typeof decision === 'string') {
    if (decision === 'yes' || decision === 'no') return decision;
    throw badRequest(stage, `decision must be "yes" or "no", got ${decision.slice(0, 40)}`);
  }
  // Inbound text from the approver (an Inkbox reply forwarded verbatim) is untrusted: it is parsed
  // against this approval id and refused when it is not an unambiguous yes/no.
  const text = body?.['text'];
  if (typeof text !== 'string' || text.trim() === '') {
    throw badRequest(stage, 'either "decision" ("yes"|"no") or "text" (the raw reply) is required');
  }
  const parsed = parseReply(text, approvalId);
  if (!parsed) {
    throw badRequest(
      stage,
      'reply is not an unambiguous yes/no for this approval; ask the approver to reply "yes <id>" or "no <id>"',
    );
  }
  return parsed.decision;
}

function recipientsFrom(ctx: Ctx, stage: string): string[] | undefined {
  const body = ctx.body as Record<string, unknown> | null;
  const raw = body?.['recipients'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw badRequest(stage, 'recipients must be an array of phone numbers or email addresses');
  if (raw.length === 0 || raw.length > 10) throw badRequest(stage, 'recipients must hold between 1 and 10 entries');
  return raw.map((r, i) => {
    if (typeof r !== 'string' || r.trim() === '') throw badRequest(stage, `recipients[${i}] must be a non-empty string`);
    return r.trim();
  });
}

export async function postApproval(ctx: Ctx, repo: Repository, deps: RouteDeps = {}): Promise<HttpResult> {
  const failureId = str(ctx.body, 'failure_id', STAGE_CREATE);
  const changeSummary = str(ctx.body, 'change_summary', STAGE_CREATE);
  const approver = str(ctx.body, 'approver', STAGE_CREATE);
  const result = await requestApproval(failureId, changeSummary, approver, repo, {
    client: deps.client,
    env: deps.env ?? process.env,
    now: deps.now,
    fallbackEmail: deps.fallbackEmail,
  });
  return ok(
    {
      approval: result.approval,
      replayed: result.replayed,
      text_sent: {
        channel: result.channel,
        message_id: result.receipt?.message_id ?? null,
        fake: result.receipt?.fake ?? true,
        to: maskRecipient(result.approval.approver),
        body_chars: result.body.length,
      },
      body: result.body,
    },
    result.replayed ? 200 : 201,
  );
}

export async function postApprovalReply(ctx: Ctx, repo: Repository): Promise<HttpResult> {
  const id = str(ctx.body, 'id', STAGE_REPLY);
  const approver = str(ctx.body, 'approver', STAGE_REPLY);
  const decision = decisionFrom(ctx, id, STAGE_REPLY);
  const result = await applyReply(id, decision, approver, repo);
  return ok({ approval: result.approval, replayed: result.replayed });
}

export async function getApprovalById(ctx: Ctx, repo: Repository): Promise<HttpResult> {
  const id = queryParam(ctx, 'id', STAGE_READ);
  const approval = await storeGuard(STAGE_READ, () => repo.getApproval(id));
  if (!approval) throw new HttpError(404, 'not_found', `approval ${id} not found`, STAGE_READ);
  return ok({ approval });
}

export async function getDailyReport(ctx: Ctx, repo: Repository, deps: RouteDeps = {}): Promise<HttpResult> {
  const vendorId = queryParam(ctx, 'vendor_id', STAGE_REPORT);
  const report = await daily(vendorId, repo, { now: deps.now?.() }, deps.env ?? process.env);
  return ok({ report });
}

export async function getWeeklyReport(ctx: Ctx, repo: Repository, deps: RouteDeps = {}): Promise<HttpResult> {
  const vendorId = queryParam(ctx, 'vendor_id', STAGE_REPORT);
  const report = await weekly(vendorId, repo, { now: deps.now?.() }, deps.env ?? process.env);
  return ok({ report });
}

/** The demo's "send today's report" button: build it, deliver it, and record report.sent. */
export async function postSendNow(ctx: Ctx, repo: Repository, deps: RouteDeps = {}): Promise<HttpResult> {
  const vendorId = str(ctx.body, 'vendor_id', STAGE_SEND_NOW);
  const kindRaw = str(ctx.body, 'kind', STAGE_SEND_NOW);
  if (kindRaw !== 'daily' && kindRaw !== 'weekly') {
    throw badRequest(STAGE_SEND_NOW, `kind must be "daily" or "weekly", got ${kindRaw.slice(0, 40)}`);
  }
  const kind: ReportKind = kindRaw;
  const recipients = recipientsFrom(ctx, STAGE_SEND_NOW) ?? deps.recipients;
  const report = await buildReport(kind, vendorId, repo, { now: deps.now?.() }, deps.env ?? process.env);
  const sent = await sendReport(report, repo, { client: deps.client, env: deps.env ?? process.env, recipients });
  return ok({
    report: sent.report,
    delivered: sent.delivered.map((d) => ({ message_id: d.message_id, channel: d.channel, to: maskRecipient(d.to), fake: d.fake })),
  });
}

export function registerRoutes(router: Router, repo: Repository, deps: RouteDeps = {}): void {
  router.add('POST', '/v1/approvals', (ctx) => postApproval(ctx, repo, deps));
  router.add('POST', '/v1/approvals/reply', (ctx) => postApprovalReply(ctx, repo));
  router.add('GET', '/v1/approvals', (ctx) => getApprovalById(ctx, repo));
  router.add('GET', '/v1/reports/daily', (ctx) => getDailyReport(ctx, repo, deps));
  router.add('GET', '/v1/reports/weekly', (ctx) => getWeeklyReport(ctx, repo, deps));
  router.add('POST', '/v1/reports/send-now', (ctx) => postSendNow(ctx, repo, deps));
}
