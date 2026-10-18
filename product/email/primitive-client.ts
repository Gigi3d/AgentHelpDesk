// Primitive email client — the ONLY file in product/ that touches the network for
// the email lane. Every other email file talks to the `PrimitiveEmail` interface,
// so the lane can be swapped or faked without touching desk logic (AGENTS.md:
// "Every external call sits behind one small module so it can be swapped or faked").
//
// WHY THIS LANE EXISTS (Build Plan, sponsor table, "Primitive" row): an agent that
// has not installed the MCP tool has no way in; the address in an error response
// works for any agent. Primitive carries agent-to-agent email threads with
// `sender_verified` on each reply, which is the signal the desk's verify step needs
// (Research Dossier, "Build list" step 2: "Check sender_verified on the inbound
// message").
//
// SPONSOR FACTS CITED (not invented):
//  1. Agent-to-agent email threads, `sender_verified` on each reply.
//     -> Build Plan sponsor table, Primitive row + fact-check bullet (primitive.dev);
//        Frontend and Product Surface Plan sponsor table ("Agent-to-agent email
//        threads with verified senders").
//  2. New agent accounts start REPLY-ONLY, so a first message to a new recipient can
//     be refused. The desk replies to inbound mail, which fits; outbound escalation
//     to humans goes through Inkbox, not Primitive.
//     -> Build Plan fact-check bullet: "new agent accounts start reply-only, so a
//        first message to a new recipient can be refused ... outbound escalation to
//        humans should go through Inkbox (primitive.dev)".
//  3. ~1,000 messages/hour limit.
//     -> Build Plan "Check before promising": "Primitive limits: new accounts reply
//        only, with a 1,000 messages an hour limit."
//
// DOC PAGES READ FOR THE WIRE SHAPE:
//  - https://primitive.dev — names `POST /v1/send-mail`, the MCP tools `sendEmail`
//    and `replyToEmail`, and auth `Authorization: Bearer prim_<api_key>`.
//  - https://docs.primitive.dev/docs/api — base `https://api.primitive.dev/v1`,
//    `POST /send-mail`, `GET /emails`, `POST /emails/{id}/reply`, response envelope
//    `{ success, data, meta.cursor }`, and the fields `sender_verified`, `thread_id`,
//    `message_id`, `from`, `to`, `subject`, `body`.
//
// HONESTY — WHAT IS *NOT* CONFIRMED (also logged in CONTRACT_REQUESTS.md):
//  - The request-body field names for `POST /send-mail` and `POST /emails/{id}/reply`
//    are not published on the page I could read, so they are marked ASSUMPTION below
//    and live in exactly one place (`PrimitiveClient.send`) to fix at the venue.
//  - The "Limits & Quotas" page did not state a number; the 1,000/hour figure is the
//    Build Plan's fact-check, not the API page. It is enforced provider-side and
//    surfaced here as a `rate_limited` refusal, never re-implemented as local state
//    (the service must stay stateless).
//  - The reply-only rule is not restated on the API page, so a provider refusal of a
//    cold send is mapped to `reply_only_new_account` only when the provider says so;
//    otherwise we fail closed to `refused` and surface the provider's own message.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Provider-side send cap cited from the Build Plan fact-check (~1,000 messages/hour). */
export const PRIMITIVE_MESSAGES_PER_HOUR = 1_000;

export const DEFAULT_PRIMITIVE_BASE_URL = 'https://api.primitive.dev/v1';
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Cap on one outbound message body. The inbound cap lives in threads.ts. */
export const MAX_OUTBOUND_BODY = 64_000;

export type EmailRefusalCode =
  | 'reply_only_new_account'
  | 'rate_limited'
  | 'unauthorized'
  | 'refused'
  | 'network'
  | 'provider_error'
  | 'payload_too_large';

/** A provider-side refusal or transport failure. Never swallowed: callers either
 * surface it as a machine-readable refusal or rethrow it as an HttpError. */
export class EmailRefusedError extends Error {
  readonly code: EmailRefusalCode;
  readonly status: number;
  readonly stage: string;

  constructor(code: EmailRefusalCode, message: string, status = 502, stage = 'email.primitive') {
    super(message);
    this.name = 'EmailRefusedError';
    this.code = code;
    this.status = status;
    this.stage = stage;
  }
}

/** What the provider stamps on a message it accepted. `sender_verified` is the
 * sponsor's own signal (fact 1); we default it to false and never infer true. */
export interface ThreadRef {
  thread_id: string;
  message_id: string;
  sender_verified: boolean;
}

/** One row of `GET /v1/email/threads`. */
export interface ThreadSummary {
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  sender_verified: boolean;
  created_at: string;
  message_count: number;
}

export interface PrimitiveEmail {
  /** Start a thread with a recipient. A reply-only new account can refuse this. */
  openThread(to: string, subject: string, body: string): Promise<ThreadRef>;
  /** Reply on an existing thread. This is the call a reply-only account CAN make. */
  reply(threadId: string, body: string): Promise<ThreadRef>;
  /** List threads, optionally filtered to one sender address. */
  listThreads(from?: string): Promise<ThreadSummary[]>;
}

// ---------------------------------------------------------------------------
// Defensive readers. The provider envelope is `{ success, data, meta }`; nothing
// here trusts a field to exist or to have the documented type.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Narrow to an array without leaning on `Array.isArray` inference (which yields
 * `any[]`); the module bans `any`, so every row is handled as `unknown`. */
function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? (v as unknown[]) : null;
}

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readBool(rec: Record<string, unknown>, key: string): boolean | null {
  const v = rec[key];
  return typeof v === 'boolean' ? v : null;
}

function readNumber(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Unwrap `{ success, data }` when present, else treat the payload as the data. */
function unwrapData(json: unknown, stage: string): Record<string, unknown> {
  if (Array.isArray(json)) throw new EmailRefusedError('provider_error', `${stage}: expected an object, got an array`, 502, stage);
  if (!isRecord(json)) throw new EmailRefusedError('provider_error', `${stage}: provider returned no JSON object`, 502, stage);
  if (json['success'] === false) {
    const message = isRecord(json['error']) ? readString(json['error'], 'message') : null;
    throw new EmailRefusedError('refused', `${stage}: provider reported failure${message ? `: ${message}` : ''}`, 502, stage);
  }
  const data = json['data'];
  if (isRecord(data)) return data;
  return json;
}

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortDigest(input: string, len: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

// ---------------------------------------------------------------------------
// Live client
// ---------------------------------------------------------------------------

export interface PrimitiveClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

export class PrimitiveClient implements PrimitiveEmail {
  private readonly cfg: PrimitiveClientConfig;

  constructor(cfg: PrimitiveClientConfig) {
    this.cfg = cfg;
  }

  /** `POST /send-mail` (docs.primitive.dev/docs/api). ASSUMPTION: the body field
   * names `to` / `subject` / `body` are not published; they are isolated here so a
   * single edit at the venue fixes the live lane without touching the desk. */
  async openThread(to: string, subject: string, body: string): Promise<ThreadRef> {
    return this.send('email.primitive.open_thread', '/send-mail', { to, subject, body });
  }

  /** `POST /emails/{id}/reply` (docs.primitive.dev/docs/api). ASSUMPTION: the reply
   * body field name `body` is not published; isolated here for the same reason. */
  async reply(threadId: string, body: string): Promise<ThreadRef> {
    if (threadId.trim().length === 0) {
      throw new EmailRefusedError('refused', 'email.primitive.reply: thread id is empty', 400, 'email.primitive.reply');
    }
    return this.send('email.primitive.reply', `/emails/${encodeURIComponent(threadId)}/reply`, { body });
  }

  /** `GET /emails` (docs.primitive.dev/docs/api). ASSUMPTION: the `from` filter is a
   * query param; the page documents the path but not its params. */
  async listThreads(from?: string): Promise<ThreadSummary[]> {
    const stage = 'email.primitive.list_threads';
    const suffix = typeof from === 'string' && from.trim().length > 0 ? `?from=${encodeURIComponent(from.trim())}` : '';
    const json = await this.request(stage, `/emails${suffix}`, 'GET');
    const rows = isRecord(json) ? asArray(json['data']) ?? asArray(json['emails']) ?? asArray(json) : asArray(json);
    if (!rows) throw new EmailRefusedError('provider_error', `${stage}: provider returned no thread list`, 502, stage);
    const out: ThreadSummary[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const threadId = readString(row, 'thread_id') ?? readString(row, 'id');
      if (!threadId) continue;
      out.push({
        thread_id: threadId,
        from: readString(row, 'from') ?? '',
        to: readString(row, 'to') ?? '',
        subject: readString(row, 'subject') ?? '',
        // Fail closed: an absent flag is NOT a verified sender.
        sender_verified: readBool(row, 'sender_verified') ?? false,
        created_at: readString(row, 'created_at') ?? new Date().toISOString(),
        message_count: readNumber(row, 'message_count') ?? 1,
      });
    }
    return out;
  }

  private async send(stage: string, path: string, payload: Record<string, unknown>): Promise<ThreadRef> {
    const body = payload['body'];
    if (typeof body === 'string' && body.length > MAX_OUTBOUND_BODY) {
      throw new EmailRefusedError('payload_too_large', `${stage}: message body exceeds ${MAX_OUTBOUND_BODY} characters`, 413, stage);
    }
    const json = unwrapData(await this.request(stage, path, 'POST', payload), stage);

    const threadId = readString(json, 'thread_id') ?? (isRecord(json['thread']) ? readString(json['thread'], 'id') : null) ?? readString(json, 'id');
    if (!threadId) {
      throw new EmailRefusedError('provider_error', `${stage}: provider response carried no thread id`, 502, stage);
    }
    return {
      thread_id: threadId,
      // A provider that does not return a message id still accepted the message;
      // derive a stable one so the audit trail has something to point at.
      message_id: readString(json, 'message_id') ?? `msg_${shortDigest(`${threadId}|${typeof body === 'string' ? body : ''}`, 16)}`,
      // Fail closed on the sponsor's trust signal (fact 1): unknown means NOT verified.
      sender_verified: readBool(json, 'sender_verified') ?? false,
    };
  }

  private async request(stage: string, path: string, method: 'GET' | 'POST', payload?: Record<string, unknown>): Promise<unknown> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.apiKey}`,
      accept: 'application/json',
    };
    if (payload) headers['content-type'] = 'application/json';

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload ? JSON.stringify(payload) : undefined,
        // Hard cap on every external call (AGENTS.md). AbortSignal.timeout is
        // declared by @types/node's web-globals/abortcontroller.d.ts.
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      throw new EmailRefusedError('network', `${stage}: could not reach Primitive at ${url}: ${errMessage(err)}`, 502, stage);
    }

    const text = await res.text().catch((err: unknown) => {
      throw new EmailRefusedError('network', `${stage}: could not read the Primitive response: ${errMessage(err)}`, 502, stage);
    });

    if (!res.ok) throw this.refusalFor(stage, res.status, text);
    if (text.trim().length === 0) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new EmailRefusedError('provider_error', `${stage}: Primitive returned non-JSON (HTTP ${res.status}): ${errMessage(err)}`, 502, stage);
    }
  }

  /** Map a provider status onto a refusal code. Fail closed: a 403 is only called
   * `reply_only_new_account` when the provider itself says so (fact 2). */
  private refusalFor(stage: string, status: number, text: string): EmailRefusedError {
    const detail = text.slice(0, 300);
    if (status === 401) {
      return new EmailRefusedError('unauthorized', `${stage}: Primitive rejected PRIMITIVE_KEY (HTTP 401): ${detail}`, 401, stage);
    }
    if (status === 429) {
      return new EmailRefusedError(
        'rate_limited',
        `${stage}: Primitive rate limit hit (HTTP 429). The documented cap is about ${PRIMITIVE_MESSAGES_PER_HOUR} messages/hour: ${detail}`,
        429,
        stage,
      );
    }
    if (status === 403 && /reply[- _]?only|new account|cannot (?:initiate|send first)/i.test(text)) {
      return new EmailRefusedError(
        'reply_only_new_account',
        `${stage}: Primitive refused a first message to this recipient — new agent accounts are reply-only (HTTP 403): ${detail}`,
        403,
        stage,
      );
    }
    if (status === 403 || status === 404) {
      return new EmailRefusedError('refused', `${stage}: Primitive refused the message (HTTP ${status}): ${detail}`, status, stage);
    }
    return new EmailRefusedError('provider_error', `${stage}: Primitive returned HTTP ${status}: ${detail}`, 502, stage);
  }
}

// ---------------------------------------------------------------------------
// Offline fake
// ---------------------------------------------------------------------------

export interface FakePrimitiveOptions {
  /** Seeded thread list. Defaults to email/fixtures/threads.json. */
  fixturePath?: string;
  /** Simulate fact 2 (new accounts are reply-only) so the refusal path is testable. */
  replyOnly?: boolean;
}

const DEFAULT_FIXTURE = fileURLToPath(new URL('./fixtures/threads.json', import.meta.url));

/**
 * Offline Primitive. No network, no module-level mutable state: ids are pure
 * functions of their inputs, so a replayed `openThread` returns the SAME thread id
 * (that is the email lane's idempotency story at the client level) and `listThreads`
 * re-reads the fixture on every call. What the desk actually sent is audited in
 * `tool_events` through the Repository, never in this class.
 */
export class FakePrimitive implements PrimitiveEmail {
  private readonly fixturePath: string;
  private readonly replyOnly: boolean;

  constructor(opts: FakePrimitiveOptions = {}) {
    this.fixturePath = opts.fixturePath ?? DEFAULT_FIXTURE;
    this.replyOnly = opts.replyOnly ?? false;
  }

  async openThread(to: string, subject: string, body: string): Promise<ThreadRef> {
    const stage = 'email.primitive.open_thread';
    this.guardBody(stage, body);
    if (to.trim().length === 0) throw new EmailRefusedError('refused', `${stage}: recipient is empty`, 400, stage);
    if (this.replyOnly) {
      throw new EmailRefusedError(
        'reply_only_new_account',
        `${stage}: refused (fake) — new Primitive accounts are reply-only, so a first message to ${to} cannot be sent. Escalate to a human through Inkbox instead.`,
        403,
        stage,
      );
    }
    return {
      thread_id: `thr_${shortDigest(`thread|${to.toLowerCase()}|${subject}`, 16)}`,
      message_id: `msg_${shortDigest(`message|${to.toLowerCase()}|${subject}|${body}`, 16)}`,
      // The desk's own outbound mailbox is verified in the fake; see README "what is faked".
      sender_verified: true,
    };
  }

  async reply(threadId: string, body: string): Promise<ThreadRef> {
    const stage = 'email.primitive.reply';
    this.guardBody(stage, body);
    if (threadId.trim().length === 0) throw new EmailRefusedError('refused', `${stage}: thread id is empty`, 400, stage);
    return {
      thread_id: threadId,
      message_id: `msg_${shortDigest(`reply|${threadId}|${body}`, 16)}`,
      sender_verified: true,
    };
  }

  async listThreads(from?: string): Promise<ThreadSummary[]> {
    const stage = 'email.primitive.list_threads';
    let raw: string;
    try {
      raw = await readFile(this.fixturePath, 'utf8');
    } catch (err) {
      throw new EmailRefusedError('provider_error', `${stage}: cannot read the fake thread fixture at ${this.fixturePath}: ${errMessage(err)}`, 500, stage);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      throw new EmailRefusedError('provider_error', `${stage}: thread fixture is not valid JSON: ${errMessage(err)}`, 500, stage);
    }
    const rows = isRecord(parsed) ? asArray(parsed['threads']) : null;
    if (!rows) throw new EmailRefusedError('provider_error', `${stage}: thread fixture has no "threads" array`, 500, stage);

    const filter = typeof from === 'string' ? from.trim().toLowerCase() : '';
    const out: ThreadSummary[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const summary: ThreadSummary = {
        thread_id: readString(row, 'thread_id') ?? '',
        from: readString(row, 'from') ?? '',
        to: readString(row, 'to') ?? '',
        subject: readString(row, 'subject') ?? '',
        sender_verified: readBool(row, 'sender_verified') ?? false,
        created_at: readString(row, 'created_at') ?? '',
        message_count: readNumber(row, 'message_count') ?? 1,
      };
      if (summary.thread_id.length === 0) continue;
      if (filter.length > 0 && !matchesSender(summary.from, filter)) continue;
      out.push(summary);
    }
    return out;
  }

  private guardBody(stage: string, body: string): void {
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new EmailRefusedError('refused', `${stage}: message body is empty`, 400, stage);
    }
    if (body.length > MAX_OUTBOUND_BODY) {
      throw new EmailRefusedError('payload_too_large', `${stage}: message body exceeds ${MAX_OUTBOUND_BODY} characters`, 413, stage);
    }
  }
}

/** Accepts `addr`, `Name <addr>` and a bare mailbox name, so an operator can filter
 * the thread list by any of the forms that appear in a real From header. */
function matchesSender(from: string, filter: string): boolean {
  const needle = addressOf(from).toLowerCase();
  const want = addressOf(filter).toLowerCase();
  if (needle.length > 0 && needle === want) return true;
  return from.toLowerCase().includes(filter);
}

function addressOf(v: string): string {
  const m = /<([^>]*)>/.exec(v);
  return (m ? m[1] : v).trim();
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** 'fake' when AHD_EMAIL_FAKE=1 or no PRIMITIVE_KEY is present (AGENTS.md rule). */
export function emailLaneMode(env: NodeJS.ProcessEnv = process.env): 'fake' | 'live' {
  const key = typeof env['PRIMITIVE_KEY'] === 'string' ? env['PRIMITIVE_KEY'].trim() : '';
  return env['AHD_EMAIL_FAKE'] === '1' || key.length === 0 ? 'fake' : 'live';
}

/** The one place the email lane picks an implementation. Reads env at call time so a
 * test can flip AHD_EMAIL_FAKE without touching module state. */
export function createPrimitiveEmail(env: NodeJS.ProcessEnv = process.env): PrimitiveEmail {
  if (emailLaneMode(env) === 'fake') {
    return new FakePrimitive({ replyOnly: env['AHD_EMAIL_FAKE_REPLY_ONLY'] === '1' });
  }
  const apiKey = (env['PRIMITIVE_KEY'] ?? '').trim();
  const baseUrlRaw = (env['PRIMITIVE_BASE_URL'] ?? '').trim();
  return new PrimitiveClient({
    apiKey,
    baseUrl: baseUrlRaw.length > 0 ? baseUrlRaw : DEFAULT_PRIMITIVE_BASE_URL,
    timeoutMs: envInt(env['AHD_EMAIL_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS, 1_000, 120_000),
  });
}
