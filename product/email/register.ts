// Email lane routes. `registerRoutes(router, repo)` is the module entry point that
// product/server.ts calls; the three handlers are exported separately so tests can
// call them directly with a constructed Ctx (AGENTS.md: no ports, no processes).
//
//   POST /v1/email/inbound   simulate an inbound verified email -> thread + case
//   POST /v1/email/outbound  desk-to-agent reply on an existing thread
//   GET  /v1/email/threads   thread list, optionally filtered by ?from=
//
// This module holds no state: the Repository is the only source of truth and the
// Primitive client is re-selected from env per registration, so N replicas behave
// identically.
import type { Repository } from '../store/repository.ts';
import type { Ctx, HttpResult, Router } from '../shared/http.ts';
import { HttpError, badRequest, ok, str } from '../shared/http.ts';
import { createPrimitiveEmail, emailLaneMode } from './primitive-client.ts';
import { listThreadsFor, processInboundEmail, recordBoundaryRejection, sendOutboundReply } from './threads.ts';
import type { EmailDeps, InboundEmail, OutboundArgs } from './threads.ts';

const INBOUND_STAGE = 'email.parse';
const OUTBOUND_STAGE = 'email.outbound';

/** Build the lane's dependencies. Exported so a test can swap in a stub client. */
export function createEmailDeps(repo: Repository): EmailDeps {
  return { repo, client: createPrimitiveEmail() };
}

function optString(body: unknown, field: string, stage: string): string | null {
  const v = (body as Record<string, unknown> | null)?.[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw badRequest(stage, `field "${field}" must be a string when present`);
  return v;
}

/** Validate every inbound field at the boundary. All of it is untrusted: a message
 * may describe a failure but may never grant authority or change the desk's rules. */
function readInbound(body: unknown): InboundEmail {
  const from = str(body, 'from', INBOUND_STAGE);
  const subject = str(body, 'subject', INBOUND_STAGE);
  const text = str(body, 'body', INBOUND_STAGE);

  const verified = (body as Record<string, unknown> | null)?.['sender_verified'];
  if (typeof verified !== 'boolean') {
    throw badRequest(
      INBOUND_STAGE,
      'field "sender_verified" must be a boolean: it is the provider\'s stamp on the message, and the desk never infers it',
    );
  }

  const inbound: InboundEmail = { from, sender_verified: verified, subject, body: text };
  const threadId = optString(body, 'thread_id', INBOUND_STAGE);
  if (threadId !== null && threadId.trim().length > 0) inbound.thread_id = threadId;
  return inbound;
}

/**
 * POST /v1/email/inbound — body { from, sender_verified, subject, body, thread_id? }.
 * `sender_verified` must be the boolean Primitive stamps; it is never inferred from
 * the address or the body, and an unverified message opens NO case (403 refusal).
 * A verified message opens a case through desk/intake and is answered on the same
 * thread with the committed ack_by/resolve_by.
 */
export async function handleInbound(deps: EmailDeps, ctx: Ctx): Promise<HttpResult> {
  let inbound: InboundEmail;
  try {
    inbound = readInbound(ctx.body);
  } catch (err) {
    // Every inbound email leaves an audit trace — including one the boundary validator
    // refused before the lane's own parser ever saw it.
    if (err instanceof HttpError) await recordBoundaryRejection(deps.repo, ctx.body, err);
    throw err;
  }

  const outcome = await processInboundEmail(deps, inbound);

  if (!outcome.accepted) {
    // A refusal is an expected outcome for untrusted mail, not a server fault: it is
    // machine-readable, names the reason, and confirms that no case was opened.
    return ok(
      {
        accepted: false,
        code: outcome.code,
        message: outcome.message,
        case_id: null,
        inbound_id: outcome.inbound_id,
        lane: emailLaneMode(),
      },
      403,
    );
  }

  return ok(
    {
      accepted: true,
      case_id: outcome.case_id,
      ack_by: outcome.ack_by,
      resolve_by: outcome.resolve_by,
      queue_position: outcome.queue_position,
      agent_id: outcome.agent_id,
      task: outcome.task,
      thread_id: outcome.thread_id,
      message_id: outcome.message_id,
      // The provider's stamp on OUR reply, so the agent can trust the ack.
      sender_verified: outcome.sender_verified,
      delivery: outcome.delivery,
      delivery_code: outcome.delivery_code,
      delivery_message: outcome.delivery_message,
      inbound_id: outcome.inbound_id,
      lane: emailLaneMode(),
    },
    201,
  );
}

/**
 * POST /v1/email/outbound — body { thread_id, body, case_id? }. The desk answering an
 * agent on a thread it did not originate. Replying is the direction a reply-only
 * Primitive account is allowed to use, so this works even for a new agent account.
 */
export async function handleOutbound(deps: EmailDeps, ctx: Ctx): Promise<HttpResult> {
  const threadId = str(ctx.body, 'thread_id', OUTBOUND_STAGE);
  const body = str(ctx.body, 'body', OUTBOUND_STAGE);
  const caseId = optString(ctx.body, 'case_id', OUTBOUND_STAGE);

  const args: OutboundArgs = { thread_id: threadId, body };
  if (caseId !== null && caseId.trim().length > 0) args.case_id = caseId;

  const result = await sendOutboundReply(deps, args);
  if (result.delivered) {
    return ok(
      {
        delivered: true,
        thread_id: result.thread_id,
        message_id: result.message_id,
        sender_verified: result.sender_verified,
        lane: emailLaneMode(),
      },
      result.status,
    );
  }
  return ok(
    {
      delivered: false,
      thread_id: result.thread_id,
      code: result.code,
      message: result.message,
      lane: emailLaneMode(),
    },
    result.status,
  );
}

/** GET /v1/email/threads?from=<address> — the console's thread view (Frontend and
 * Product Surface Plan, Primitive row: "Thread view with verified sender, linked to
 * the ticket"). */
export async function handleThreads(deps: EmailDeps, ctx: Ctx): Promise<HttpResult> {
  const from = ctx.query.get('from');
  const threads = await listThreadsFor(deps, from ?? undefined);
  return ok({
    threads,
    count: threads.length,
    filtered_by: from ?? null,
    lane: emailLaneMode(),
  });
}

export function registerRoutes(router: Router, repo: Repository): void {
  const deps = createEmailDeps(repo);
  router.add('POST', '/v1/email/inbound', (ctx) => handleInbound(deps, ctx));
  router.add('POST', '/v1/email/outbound', (ctx) => handleOutbound(deps, ctx));
  router.add('GET', '/v1/email/threads', (ctx) => handleThreads(deps, ctx));
}
