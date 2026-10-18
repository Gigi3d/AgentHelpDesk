// Email lane logic: turn a verified inbound email into a case, and answer the agent
// on the SAME thread with the committed times it would otherwise never get.
//
// The trust rule that shapes this file: `sender_verified` is checked BEFORE the body
// is parsed, and an unverified message never becomes a ProblemReport, never reaches
// `intake`, and never reaches the resolver. Everything inbound is untrusted data —
// it can describe a failure but it can never widen a grant, change a risk policy or
// alter the desk's instructions (Build Plan, "What can go wrong": "Treat every
// inbound message as untrusted data").
//
// Sponsor facts relied on here (see primitive-client.ts for the full citations):
//  - Primitive threads carry `sender_verified` on each reply, so the desk can answer
//    in the channel the agent already used.
//  - New Primitive accounts are reply-only, so a cold first message can be refused.
//    When that happens the case is STILL open (we never lose a verified report) and
//    the refusal tells the operator to escalate to a human through Inkbox instead.
import { createHash, randomUUID } from 'node:crypto';
import type { Failure, ProblemReport, ToolEvent } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { HttpError, badRequest } from '../shared/http.ts';
// The ONLY desk internal this module imports, by design: email is an intake channel,
// not a second orchestrator. desk/intake.ts exports exactly
// `intake(report: ProblemReport, repo: Repository): Promise<Failure>`.
import { intake } from '../desk/intake.ts';
import { EmailRefusedError, MAX_OUTBOUND_BODY } from './primitive-client.ts';
import type { EmailRefusalCode, PrimitiveEmail, ThreadSummary } from './primitive-client.ts';

export const EMAIL_TOOL = 'primitive';

const PARSE_STAGE = 'email.parse';
const MAX_INBOUND_BODY = 64_000;
const MAX_SUBJECT = 200;
const MAX_FROM = 320;
const MAX_THREAD_ID = 200;
const MAX_STORED_JSON = 16_000;

/**
 * desk/intake.ts also reads an optional `idempotency_key` off the report record
 * (see normalizeReport -> optStr(rec,'idempotency_key')) and dedupes on it, but the
 * shared ProblemReport type does not declare it. Declared locally rather than editing
 * product/shared/types.ts; asked for in CONTRACT_REQUESTS.md.
 *
 * This is the email lane's replay protection: a provider retry of the same message
 * maps to the same key, so intake returns the original case and the agent gets the
 * same committed times instead of a second ticket.
 */
export interface EmailProblemReport extends ProblemReport {
  idempotency_key?: string;
}

export interface InboundEmail {
  from: string;
  /** The provider's own stamp. Anything other than the boolean `true` is unverified. */
  sender_verified: boolean;
  subject: string;
  body: string;
  /** Present when the provider told us which thread this message arrived on. When it
   * is absent the desk must open the thread, which a reply-only account can refuse. */
  thread_id?: string;
}

export interface EmailDeps {
  repo: Repository;
  client: PrimitiveEmail;
  /** Overridable so tests do not depend on the desk's live intake. Defaults to it. */
  intakeFn?: IntakeFn;
}

export type IntakeFn = (report: ProblemReport, repo: Repository) => Promise<Failure>;

export interface InboundAccepted {
  accepted: true;
  case_id: string;
  ack_by: string;
  resolve_by: string;
  queue_position: number;
  agent_id: string;
  task: string;
  inbound_id: string;
  /** null when the channel refused delivery (see `delivery`). */
  thread_id: string | null;
  message_id: string | null;
  /** The provider's stamp on OUR reply, not on the inbound message. */
  sender_verified: boolean;
  /** 'sent' = the ack reached the agent's thread. 'refused' = the case is open but
   * the channel would not carry it (e.g. a reply-only new account). */
  delivery: 'sent' | 'refused';
  delivery_code: EmailRefusalCode | null;
  delivery_message: string | null;
}

export interface InboundRefused {
  accepted: false;
  code: 'sender_unverified';
  message: string;
  inbound_id: string;
  case_id: null;
}

export type InboundOutcome = InboundAccepted | InboundRefused;

export type OutboundResult =
  | { delivered: true; status: number; thread_id: string; message_id: string; sender_verified: boolean }
  | { delivered: false; status: number; thread_id: string; code: EmailRefusalCode; message: string };

const REFUSAL_UNVERIFIED =
  'AgentHelpDesk did not open a case: Primitive did not verify this sender. Unverified mail is never parsed into a ' +
  'report and never reaches the resolver. Send again from a mailbox Primitive verifies (sender_verified), or ask the ' +
  "vendor's operator to forward the report. Escalation to a human goes through Inkbox, not this lane.";

// ---------------------------------------------------------------------------
// Parsing untrusted inbound text
// ---------------------------------------------------------------------------

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const SUBJECT_TAG = /^\[([A-Za-z0-9_-]{1,64})\]/;
const REPLY_PREFIX = /^(?:(?:re|fwd|fw|aw|sv|tr)\s*:\s*)+/i;
const JSON_FENCE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i;
const AGENT_PREFIX = /^(?:agent|ahd|bot)[-_]/;

export interface ParsedSubject {
  task: string;
  vendor_hint?: string;
}

export interface ParsedBody {
  request: unknown;
  response: unknown;
  /** True when a JSON block was found; false means the raw text is the response. */
  json_found: boolean;
  raw: string;
}

/** Drop C0 controls and DEL (keep tab/newline/CR) so a crafted message cannot
 * smuggle terminal or log escapes into the audit trail. The character class is
 * written with escapes on purpose: this is sanitisation of untrusted input, not a
 * stray control character in the source. */
export function sanitize(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function shortDigest(input: string, len = 64): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `Name <addr@host>` -> `addr@host`. Lower-cased and trimmed. */
export function parseSenderAddress(from: string, stage = PARSE_STAGE): string {
  if (typeof from !== 'string' || from.length > MAX_FROM) {
    throw badRequest(stage, `field "from" must be a sender address of at most ${MAX_FROM} characters`);
  }
  const m = /<([^>]*)>/.exec(from);
  const addr = (m ? m[1] : from).trim().toLowerCase();
  if (!ADDRESS.test(addr)) throw badRequest(stage, 'field "from" is not a usable sender address');
  return addr;
}

/**
 * The agent id is the verified mailbox's local part, minus the conventional
 * `agent-` / `ahd-` / `bot_` prefix. Derived ONLY from a sender Primitive verified:
 * the id is what the case, the queue and the billing lane are keyed by, so it must
 * not be claimable from the message body.
 */
export function parseAgentId(from: string, stage = PARSE_STAGE): string {
  const addr = parseSenderAddress(from, stage);
  const local = addr.split('@')[0] ?? '';
  const bare = local.replace(AGENT_PREFIX, '');
  if (!/^[a-z0-9._-]{1,64}$/.test(bare)) {
    throw badRequest(stage, `cannot derive an agent id from the verified sender "${addr}"`);
  }
  return bare;
}

/** Subject -> task, plus an optional `[vendor]` tag. Reply/forward prefixes and the
 * tag are stripped so "Re: [ledgerly] 401 on /v1/entries" becomes a clean task. */
export function parseSubject(subject: string, stage = PARSE_STAGE): ParsedSubject {
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    throw badRequest(stage, 'field "subject" must carry the task the agent was attempting');
  }
  const collapsed = sanitize(subject).replace(/\s+/g, ' ').trim();
  if (collapsed.length > MAX_SUBJECT) throw badRequest(stage, `field "subject" must be at most ${MAX_SUBJECT} characters`);

  let rest = collapsed.replace(REPLY_PREFIX, '').trim();
  let vendorHint: string | undefined;
  const tag = SUBJECT_TAG.exec(rest);
  if (tag) {
    vendorHint = tag[1].toLowerCase();
    rest = rest.slice(tag[0].length).trim();
  }
  rest = rest.replace(REPLY_PREFIX, '').trim();
  if (rest.length === 0) throw badRequest(stage, 'field "subject" carries no task text after stripping reply prefixes');

  const parsed: ParsedSubject = { task: rest };
  if (vendorHint) parsed.vendor_hint = vendorHint;
  return parsed;
}

/**
 * Request/response come from a JSON block in the body when there is one, so the desk
 * gets a replayable failure instead of prose; otherwise the raw text is stored as the
 * response and the request is null. The parsed value is stored as OPAQUE data on the
 * case — it is never interpreted as instructions, and nothing in it can change a
 * permission, an envelope or the resolver's prompt.
 */
export function parseBody(body: string, stage = PARSE_STAGE): ParsedBody {
  if (typeof body !== 'string' || body.length > MAX_INBOUND_BODY) {
    throw badRequest(
      stage,
      `field "body" must be at most ${MAX_INBOUND_BODY} characters; resend the failing request and response as one JSON block`,
    );
  }
  const raw = sanitize(body).trim();
  if (raw.length === 0) throw badRequest(stage, 'field "body" is empty after sanitising');

  const candidate = extractJson(raw);
  if (candidate === null) return { request: null, response: raw, json_found: false, raw };

  const { request, response } = splitRequestResponse(candidate, stage);
  return { request, response, json_found: true, raw };
}

/** A fenced ```json block wins; otherwise a body that IS one JSON object/array.
 * Returns null when there is no JSON, so prose stays prose. */
function extractJson(raw: string): unknown {
  const fenced = JSON_FENCE.exec(raw);
  const candidates: string[] = [];
  if (fenced && typeof fenced[1] === 'string') candidates.push(fenced[1].trim());
  const firstChar = raw.trimStart().charAt(0);
  if (firstChar === '{' || firstChar === '[') candidates.push(raw.trim());

  for (const c of candidates) {
    if (c.length === 0) continue;
    const parsed = tryParseJson(c);
    if (parsed !== undefined && (isRecord(parsed) || Array.isArray(parsed))) return parsed;
  }
  return null;
}

/** One JSON probe. A failed probe is NOT swallowed: it is the reason the case is
 * stored with `json_found: false` and the raw text as the response, which is what the
 * `email.received` event records. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function splitRequestResponse(value: unknown, stage: string): { request: unknown; response: unknown } {
  if (isRecord(value) && ('request' in value || 'response' in value)) {
    return { request: capJson(value['request'] ?? null, stage), response: capJson(value['response'] ?? null, stage) };
  }
  return { request: null, response: capJson(value, stage) };
}

function capJson(value: unknown, stage: string): unknown {
  if (value === null) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch (err) {
    throw badRequest(stage, `the JSON block in the body cannot be serialised: ${errMessage(err)}`);
  }
  if (serialized.length > MAX_STORED_JSON) {
    throw badRequest(stage, `the JSON block in the body exceeds ${MAX_STORED_JSON} characters; trim it to the failing call`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Observability. Mirrors desk/obs.ts conventions (t_ms = epoch ms the stage
// started, d_ms = duration, id = evt_<uuid>) without importing a desk internal.
// ---------------------------------------------------------------------------

export type EmailEventResult = 'ok' | 'error' | 'skipped' | 'pending';

interface EmailEventInput {
  ticket_id: string;
  stage: string;
  action: string;
  result?: EmailEventResult;
  payload?: unknown;
  startedAtMs?: number;
}

export function buildEmailEvent(i: EmailEventInput): ToolEvent {
  const nowMs = Date.now();
  const start = typeof i.startedAtMs === 'number' && Number.isFinite(i.startedAtMs) ? i.startedAtMs : nowMs;
  return {
    id: `evt_${randomUUID()}`,
    ticket_id: i.ticket_id,
    stage: i.stage,
    tool: EMAIL_TOOL,
    action: i.action,
    t_ms: start,
    d_ms: Math.max(0, nowMs - start),
    result: i.result ?? 'ok',
    payload: i.payload ?? null,
    at: new Date(nowMs).toISOString(),
  };
}

/** Append an email-lane event. A desk that cannot write its audit trail must not
 * pretend the stage ran, so a write failure is loud and names its stage. */
async function observe(repo: Repository, i: EmailEventInput): Promise<ToolEvent> {
  try {
    const e = buildEmailEvent(i);
    await repo.appendToolEvent(e);
    return e;
  } catch (err) {
    throw new HttpError(500, 'audit_write_failed', `could not record ${i.action}: ${errMessage(err)}`, 'email.observe');
  }
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/** One digest of the message as it arrived, shared by the audit id and the
 * idempotency key so the two can never disagree about what "the same email" means.
 * Sanitising first means a provider retry that differs only by a stripped control
 * character still dedupes. */
function inboundDigest(from: string, subject: string, body: string): string {
  return shortDigest(`${sanitize(from).trim().toLowerCase()}|${sanitize(subject)}|${sanitize(body)}`);
}

/** Deterministic id for one inbound message. Pre-case events (unverified, rejected,
 * intake failed) hang off it, because there is no case id yet. */
export function inboundId(from: string, subject: string, body: string): string {
  return `eml_${inboundDigest(from, subject, body).slice(0, 20)}`;
}

/** Replay protection for the email lane: desk/intake.ts dedupes on this key, so a
 * provider retry returns the original case and the agent gets the SAME committed
 * times instead of a second ticket. */
export function idempotencyKeyFor(from: string, subject: string, body: string): string {
  return `email:${inboundDigest(from, subject, body).slice(0, 40)}`;
}

/** Best-effort audit id for a message refused at the HTTP boundary, before the lane
 * could validate it. Never trusts a field to exist or to be a string. */
export function boundaryInboundId(body: unknown): string {
  const rec = isRecord(body) ? body : {};
  const from = typeof rec['from'] === 'string' ? rec['from'] : '';
  const subject = typeof rec['subject'] === 'string' ? rec['subject'] : '';
  const text = typeof rec['body'] === 'string' ? rec['body'] : '';
  return inboundId(from, subject, text);
}

/** Record a boundary refusal so every inbound email leaves an audit trace, even one
 * that never reached the lane's own parser. */
export async function recordBoundaryRejection(repo: Repository, body: unknown, err: HttpError): Promise<void> {
  await observe(repo, {
    ticket_id: boundaryInboundId(body),
    stage: err.stage,
    action: 'email.rejected',
    result: 'error',
    payload: { code: err.code, message: err.message, boundary: true, case_opened: false },
  });
}

/** Everything the lane needs out of a verified message, parsed in one place. */
export interface ParsedInbound {
  from: string;
  agent_id: string;
  subject: ParsedSubject;
  body: ParsedBody;
}

export function parseVerifiedInbound(rawFrom: string, subjectRaw: string, bodyRaw: string): ParsedInbound {
  return {
    from: parseSenderAddress(rawFrom, PARSE_STAGE),
    agent_id: parseAgentId(rawFrom, PARSE_STAGE),
    subject: parseSubject(subjectRaw, PARSE_STAGE),
    body: parseBody(bodyRaw, PARSE_STAGE),
  };
}

/** Run a parser and, when it refuses the message, leave an audit trace before the
 * refusal propagates. Every inbound email is accounted for, including the junk. */
async function traceParseFailure<T>(
  repo: Repository,
  ticketId: string,
  rawFrom: string,
  startedAtMs: number,
  run: () => T,
): Promise<T> {
  try {
    return run();
  } catch (err) {
    if (err instanceof HttpError) {
      await observe(repo, {
        ticket_id: ticketId,
        stage: PARSE_STAGE,
        action: 'email.rejected',
        result: 'error',
        startedAtMs,
        payload: { from: rawFrom.slice(0, MAX_FROM), code: err.code, message: err.message, case_opened: false },
      });
    }
    throw err;
  }
}

/**
 * Hand the report to the desk's ONE intake function. It owns the case id, the
 * committed ack_by/resolve_by and the queue position — this lane never invents an
 * SLA and never writes a Failure row itself. A fault here is loud and names its
 * stage; the desk's own HttpError is propagated intact so its message reaches the
 * sender unchanged.
 */
async function runIntake(
  deps: EmailDeps,
  report: EmailProblemReport,
  ticketId: string,
  from: string,
  startedAtMs: number,
): Promise<Failure> {
  const intakeFn = deps.intakeFn ?? intake;
  try {
    return await intakeFn(report, deps.repo);
  } catch (err) {
    await observe(deps.repo, {
      ticket_id: ticketId,
      stage: 'email.intake',
      action: 'email.intake_failed',
      result: 'error',
      startedAtMs,
      payload: {
        inbound_id: ticketId,
        from: from.slice(0, MAX_FROM),
        agent_id: report.agent_id,
        task: report.task,
        message: errMessage(err),
      },
    });
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, 'intake_failed', `email intake could not open a case: ${errMessage(err)}`, 'email.intake');
  }
}

/**
 * The whole inbound path: verify -> parse -> intake -> reply on the same thread with
 * the committed times. Returns a refusal (never throws) for the one expected-but-
 * untrusted outcome — an unverified sender. Genuine faults throw an HttpError naming
 * an `email.*` stage.
 */
export async function processInboundEmail(deps: EmailDeps, inbound: InboundEmail): Promise<InboundOutcome> {
  const rawFrom = sanitize(typeof inbound.from === 'string' ? inbound.from : '').trim();
  const subjectRaw = sanitize(typeof inbound.subject === 'string' ? inbound.subject : '');
  const bodyRaw = sanitize(typeof inbound.body === 'string' ? inbound.body : '');
  const id = inboundId(rawFrom, subjectRaw, bodyRaw);

  // 1. Trust gate FIRST — before the address is parsed, before the body is read, and
  //    therefore before anything can reach intake, a sandbox or the resolver. Fail
  //    closed: only the boolean `true` counts, never a truthy string or a number.
  if (inbound.sender_verified !== true) {
    await observe(deps.repo, {
      ticket_id: id,
      stage: 'email.verify',
      action: 'email.unverified',
      result: 'error',
      payload: {
        from: rawFrom.slice(0, MAX_FROM),
        subject: subjectRaw.slice(0, MAX_SUBJECT),
        // The untrusted body is recorded as a digest and a length, never echoed.
        body_chars: bodyRaw.length,
        body_sha256: shortDigest(bodyRaw, 32),
        reason: 'sender_verified is not true',
        case_opened: false,
      },
    });
    return { accepted: false, code: 'sender_unverified', message: REFUSAL_UNVERIFIED, inbound_id: id, case_id: null };
  }

  // 2. Parse the verified message. A malformed report is refused loudly and still
  //    leaves an audit trace, so the console can show why nothing was opened.
  const parseStart = Date.now();
  const parsed = await traceParseFailure(deps.repo, id, rawFrom, parseStart, () =>
    parseVerifiedInbound(rawFrom, subjectRaw, bodyRaw),
  );
  const from = parsed.from;
  const agentId = parsed.agent_id;

  const report: EmailProblemReport = {
    agent_id: agentId,
    task: parsed.subject.task,
    request: parsed.body.request,
    response: parsed.body.response,
    channel: 'email',
    // Replay protection: a provider retry of the same message returns the same case.
    idempotency_key: idempotencyKeyFor(rawFrom, subjectRaw, bodyRaw),
  };
  if (parsed.subject.vendor_hint) report.vendor_hint = parsed.subject.vendor_hint;

  // 3. Open the case through the desk's one intake function.
  const intakeStart = Date.now();
  const failure = await runIntake(deps, report, id, from, intakeStart);

  await observe(deps.repo, {
    ticket_id: failure.id,
    stage: 'email.intake',
    action: 'email.received',
    startedAtMs: intakeStart,
    payload: {
      inbound_id: id,
      from,
      agent_id: failure.agent_id,
      vendor_id: failure.vendor_id,
      task: failure.task,
      subject: subjectRaw.slice(0, MAX_SUBJECT),
      sender_verified: true,
      channel: 'email',
      json_found: parsed.body.json_found,
      body_chars: bodyRaw.length,
      idempotency_key: report.idempotency_key,
      case_id: failure.id,
      ack_by: failure.ack_by,
      resolve_by: failure.resolve_by,
      queue_position: failure.queue_position,
    },
  });

  // 4. Answer on the SAME thread with the committed times, so the agent gets a
  //    deadline in the channel it already used ("Agents get a reply in the channel
  //    they already use" — Frontend and Product Surface Plan, Primitive row).
  const ack = ackMessage(failure);
  let threadId = typeof inbound.thread_id === 'string' ? inbound.thread_id.trim().slice(0, MAX_THREAD_ID) : '';
  const replyStart = Date.now();
  try {
    let openedHere = false;
    if (threadId.length === 0) {
      // No thread id from the provider means a cold send, which a reply-only new
      // account can refuse (Build Plan fact-check bullet).
      const opened = await deps.client.openThread(
        from,
        subjectRaw.length > 0 ? subjectRaw : parsed.subject.task,
        bodyRaw.length > 0 ? bodyRaw : ack,
      );
      threadId = opened.thread_id;
      openedHere = true;
    }
    const sent = await deps.client.reply(threadId, ack);
    await observe(deps.repo, {
      ticket_id: failure.id,
      stage: 'email.reply',
      action: 'email.replied',
      startedAtMs: replyStart,
      payload: {
        thread_id: sent.thread_id,
        message_id: sent.message_id,
        sender_verified: sent.sender_verified,
        direction: 'desk_to_agent',
        opened_here: openedHere,
        chars: ack.length,
        case_id: failure.id,
        ack_by: failure.ack_by,
        resolve_by: failure.resolve_by,
      },
    });
    return {
      accepted: true,
      case_id: failure.id,
      ack_by: failure.ack_by,
      resolve_by: failure.resolve_by,
      queue_position: failure.queue_position,
      agent_id: agentId,
      task: parsed.subject.task,
      inbound_id: id,
      thread_id: sent.thread_id,
      message_id: sent.message_id,
      sender_verified: sent.sender_verified,
      delivery: 'sent',
      delivery_code: null,
      delivery_message: null,
    };
  } catch (err) {
    if (err instanceof EmailRefusedError) {
      const message =
        err.code === 'reply_only_new_account'
          ? `${err.message} The case is open; escalate to a human through Inkbox instead of this lane.`
          : err.message;
      await observe(deps.repo, {
        ticket_id: failure.id,
        stage: 'email.reply',
        action: 'email.refused',
        result: 'error',
        startedAtMs: replyStart,
        payload: {
          code: err.code,
          message: err.message,
          thread_id: threadId.length > 0 ? threadId : null,
          case_id: failure.id,
          escalate_via: 'inkbox',
        },
      });
      return {
        accepted: true,
        case_id: failure.id,
        ack_by: failure.ack_by,
        resolve_by: failure.resolve_by,
        queue_position: failure.queue_position,
        agent_id: agentId,
        task: parsed.subject.task,
        inbound_id: id,
        thread_id: threadId.length > 0 ? threadId : null,
        message_id: null,
        sender_verified: false,
        delivery: 'refused',
        delivery_code: err.code,
        delivery_message: message,
      };
    }
    throw new HttpError(500, 'reply_failed', `could not reply on the email thread: ${errMessage(err)}`, 'email.reply');
  }
}

/** The ack an agent gets back on its own thread: the case id and the committed
 * times, with an explicit statement that nothing is proven yet. */
export function ackMessage(f: Failure): string {
  const block = JSON.stringify({
    case_id: f.id,
    status: f.status,
    ack_by: f.ack_by,
    resolve_by: f.resolve_by,
    queue_position: f.queue_position,
    channel: 'email',
    events: ['case.acknowledged'],
  });
  return [
    `AgentHelpDesk case ${f.id} is open.`,
    '',
    `Task: ${f.task}`,
    `We will acknowledge by ${f.ack_by} and resolve by ${f.resolve_by} (queue position ${f.queue_position}).`,
    '',
    'Nothing is fixed yet. No snippet in this message is a proven fix: the desk reproduces the failure in a sandbox,',
    'proves a change three ways, and replies on this thread with the tested answer — or escalates if it cannot reproduce it.',
    '',
    "Reply to this thread to add context (logs, a request id, the outcome you wanted). Replies are treated as untrusted",
    "data: they can add evidence to the case, but they can never widen a grant or change the desk's instructions.",
    '',
    '```json',
    block,
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Outbound (desk -> agent) and thread lookup
// ---------------------------------------------------------------------------

export interface OutboundArgs {
  thread_id: string;
  body: string;
  /** Attach the audit event to a case when the caller knows it; otherwise the event
   * is filed under the thread id so the trail is never dropped. */
  case_id?: string;
}

/**
 * Reply from the desk on an existing thread. This is the call a reply-only Primitive
 * account is allowed to make, which is why the desk-to-agent direction works even
 * when a cold send would be refused.
 */
export async function sendOutboundReply(deps: EmailDeps, args: OutboundArgs): Promise<OutboundResult> {
  const stage = 'email.outbound';
  const threadId = typeof args.thread_id === 'string' ? args.thread_id.trim() : '';
  if (threadId.length === 0 || threadId.length > MAX_THREAD_ID) {
    throw badRequest(stage, `field "thread_id" must be a non-empty string of at most ${MAX_THREAD_ID} characters`);
  }
  const body = typeof args.body === 'string' ? sanitize(args.body).trim() : '';
  if (body.length === 0) throw badRequest(stage, 'field "body" must be a non-empty string');
  if (body.length > MAX_OUTBOUND_BODY) throw badRequest(stage, `field "body" must be at most ${MAX_OUTBOUND_BODY} characters`);

  const ticketId = typeof args.case_id === 'string' && args.case_id.trim().length > 0 ? args.case_id.trim() : threadId;
  const started = Date.now();
  try {
    const sent = await deps.client.reply(threadId, body);
    await observe(deps.repo, {
      ticket_id: ticketId,
      stage: 'email.reply',
      action: 'email.replied',
      startedAtMs: started,
      payload: {
        thread_id: sent.thread_id,
        message_id: sent.message_id,
        sender_verified: sent.sender_verified,
        direction: 'desk_to_agent',
        chars: body.length,
        case_id: typeof args.case_id === 'string' && args.case_id.trim().length > 0 ? args.case_id.trim() : null,
      },
    });
    return { delivered: true, status: 200, thread_id: sent.thread_id, message_id: sent.message_id, sender_verified: sent.sender_verified };
  } catch (err) {
    if (err instanceof EmailRefusedError) {
      const message =
        err.code === 'reply_only_new_account'
          ? `${err.message} Escalate to a human through Inkbox instead of this lane.`
          : err.message;
      await observe(deps.repo, {
        ticket_id: ticketId,
        stage: 'email.reply',
        action: 'email.refused',
        result: 'error',
        startedAtMs: started,
        payload: { code: err.code, message: err.message, thread_id: threadId, direction: 'desk_to_agent' },
      });
      return { delivered: false, status: err.status, thread_id: threadId, code: err.code, message };
    }
    throw new HttpError(500, 'reply_failed', `could not send the desk reply: ${errMessage(err)}`, 'email.reply');
  }
}

/** Thread list for the console. A provider outage is loud, never an empty list that
 * looks like "no threads". */
export async function listThreadsFor(deps: EmailDeps, from?: string): Promise<ThreadSummary[]> {
  const stage = 'email.threads';
  const filter = typeof from === 'string' ? from.trim() : '';
  if (filter.length > MAX_FROM) throw badRequest(stage, `query "from" must be at most ${MAX_FROM} characters`);
  try {
    return await deps.client.listThreads(filter.length > 0 ? filter : undefined);
  } catch (err) {
    if (err instanceof EmailRefusedError) {
      throw new HttpError(err.status, 'threads_unavailable', `Primitive thread list unavailable: ${err.message}`, stage);
    }
    throw new HttpError(500, 'threads_unavailable', `Primitive thread list failed: ${errMessage(err)}`, stage);
  }
}
