// approvals/inkbox-client.ts — the ONE network seam for Inkbox (sponsor: approval gate + reports).
//
// Cited sponsor facts (AgentHelpDesk Build Plan.md, sponsor fact-check row for Inkbox):
//   install  : `pip install inkbox` or `npm install @inkbox/sdk`
//   auth     : an `INKBOX_API_KEY`
//   send     : `identity.send_text` / `sendText`
//   OPEN     : the quickstart does NOT say whether texts go over SMS or iMessage
//              (see README.md -> "Open question"). We therefore default the channel to
//              text and treat email as the fallback.
//
// product/ has zero runtime dependencies (AGENTS.md: Node built-ins only), so we cannot
// `npm install @inkbox/sdk` here. RealInkboxClient calls the documented `send_text` over
// HTTPS instead, with a timeout and a size cap on every call.
//
// ASSUMPTION (flagged, not cited): the REST base URL and paths below are our reading of the
// `identity.send_text` SDK call; the cited quickstart names the SDK method, not an HTTP route.
// Confirm with Inkbox and change it HERE ONLY — no other file in product/ touches the network
// for approvals or reports.
import { createHash } from 'node:crypto';
import { HttpError, badRequest } from '../shared/http.ts';

const STAGE = 'approvals.inkbox';

export type DeliveryChannel = 'text' | 'email';

export interface InkboxConfig {
  apiKey: string | null;
  baseUrl: string;
  /** Documented Mail API (inkbox.ai/docs/api/mail/messages): POST /mailboxes/{address}/messages. */
  mailBaseUrl: string;
  /** The identity's own mailbox, the From address of every email the desk sends. */
  mailbox: string;
  timeoutMs: number;
  maxChars: number;
}

export interface SendReceipt {
  message_id: string;
  channel: DeliveryChannel;
  /** Masked by callers before it lands in a ToolEvent; raw here because delivery needs it. */
  to: string;
  fake: boolean;
}

export interface OutboundMessage {
  message_id: string;
  channel: DeliveryChannel;
  to: string;
  subject: string | null;
  body: string;
  at: string;
}

export interface InkboxReply {
  message_id: string;
  from: string;
  body: string;
  received_at: string;
}

export interface InkboxClient {
  /** Inkbox `identity.send_text` / `sendText` (quickstart, cited above). */
  sendText(to: string, body: string): Promise<SendReceipt>;
  /**
   * Email fallback. The cited Inkbox quickstart documents only `send_text`; it documents no
   * email call, so RealInkboxClient refuses loudly rather than pretending to deliver.
   * Inject an adapter (e.g. the product/email module) if an email transport is confirmed.
   */
  sendEmail(to: string, subject: string, body: string): Promise<SendReceipt>;
  /** Reply simulation / poll. A human "yes"/"no" arrives here, or via POST /v1/approvals/reply. */
  receiveReply(messageId: string): Promise<InkboxReply | null>;
}

type Env = Record<string, string | undefined>;

function intFromEnv(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new HttpError(500, 'bad_config', `${key} must be an integer`, `${STAGE}.config`);
  if (n < min || n > max) {
    throw new HttpError(500, 'bad_config', `${key} must be between ${min} and ${max}`, `${STAGE}.config`);
  }
  return n;
}

export function readConfig(env: Env = process.env): InkboxConfig {
  const apiKey = env['INKBOX_API_KEY'];
  const baseUrl = (env['AHD_INKBOX_BASE_URL'] ?? 'https://api.inkbox.ai/v1').replace(/\/+$/, '');
  return {
    apiKey: apiKey !== undefined && apiKey.trim() !== '' ? apiKey.trim() : null,
    baseUrl,
    mailBaseUrl: (env['AHD_INKBOX_MAIL_BASE_URL'] ?? 'https://inkbox.ai/api/v1/mail').replace(/\/+$/, ''),
    mailbox: (env['AHD_INKBOX_MAILBOX'] ?? 'agenthelpdesk@inkboxmail.com').trim(),
    timeoutMs: intFromEnv(env, 'AHD_INKBOX_TIMEOUT_MS', 8000, 500, 30000),
    maxChars: intFromEnv(env, 'AHD_INKBOX_MAX_CHARS', 1400, 160, 4000),
  };
}

/**
 * FakeInkbox: selected when `AHD_APPROVALS_FAKE=1` or when no `INKBOX_API_KEY` is present, so the
 * whole approval loop and the send-now report button run offline. It records outbound messages on
 * the instance (never in a module global — the service stays stateless) and lets a test inject a
 * reply, then hand it back through `receiveReply`.
 */
export class FakeInkbox implements InkboxClient {
  readonly outbound: OutboundMessage[] = [];
  private readonly queued = new Map<string, InkboxReply[]>();
  private textFailures = 0;
  private emailFailures = 0;
  private readonly maxChars: number;

  constructor(maxChars = 1400) {
    this.maxChars = maxChars;
  }

  /** Test hook: make the next N text sends fail, so the email fallback / loud failure is exercised. */
  armTextFailure(times = 1): void {
    this.textFailures = times;
  }

  armEmailFailure(times = 1): void {
    this.emailFailures = times;
  }

  async sendText(to: string, body: string): Promise<SendReceipt> {
    if (this.textFailures > 0) {
      this.textFailures -= 1;
      throw new HttpError(502, 'upstream_unavailable', 'FakeInkbox: send_text armed to fail', `${STAGE}.send_text`);
    }
    return this.record('text', to, null, body);
  }

  async sendEmail(to: string, subject: string, body: string): Promise<SendReceipt> {
    if (this.emailFailures > 0) {
      this.emailFailures -= 1;
      throw new HttpError(502, 'upstream_unavailable', 'FakeInkbox: send_email armed to fail', `${STAGE}.send_email`);
    }
    return this.record('email', to, subject, body);
  }

  async receiveReply(messageId: string): Promise<InkboxReply | null> {
    const q = this.queued.get(messageId);
    if (!q || q.length === 0) return null;
    const next = q.shift();
    return next ?? null;
  }

  /** Test hook: queue the reply a human would have typed. Unknown message ids fail loud. */
  injectReply(messageId: string, body: string, from?: string): InkboxReply {
    const sent = this.outbound.find((m) => m.message_id === messageId);
    if (!sent) {
      throw new HttpError(404, 'unknown_message', `no outbound message ${messageId}`, `${STAGE}.fake_inject`);
    }
    const reply: InkboxReply = {
      message_id: messageId,
      from: from ?? sent.to,
      body,
      received_at: new Date().toISOString(),
    };
    const q = this.queued.get(messageId) ?? [];
    q.push(reply);
    this.queued.set(messageId, q);
    return reply;
  }

  private record(channel: DeliveryChannel, to: string, subject: string | null, body: string): SendReceipt {
    if (to.trim() === '') throw badRequest(`${STAGE}.send`, 'recipient "to" must be a non-empty string');
    if (body.trim() === '') throw badRequest(`${STAGE}.send`, 'message body must be a non-empty string');
    if (body.length > this.maxChars) {
      throw new HttpError(413, 'message_too_long', `body is ${body.length} chars, cap is ${this.maxChars}`, `${STAGE}.send`);
    }
    const message_id = `msg_${channel}_${this.outbound.length + 1}_${Date.now().toString(36)}`;
    this.outbound.push({ message_id, channel, to, subject, body, at: new Date().toISOString() });
    return { message_id, channel, to, fake: true };
  }
}

/** Pull the first non-empty string under any of `keys`, one level of nesting deep. */
function firstString(payload: unknown, keys: string[]): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const rec = payload as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'object' && v !== null) {
      const nested = firstString(v, ['id', 'message_id']);
      if (nested) return nested;
    }
  }
  return null;
}

export class RealInkboxClient implements InkboxClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly mailBaseUrl: string;
  private readonly mailbox: string;
  private readonly timeoutMs: number;
  private readonly maxChars: number;

  constructor(cfg: InkboxConfig) {
    if (!cfg.apiKey) {
      throw new HttpError(500, 'missing_api_key', 'INKBOX_API_KEY is not set', `${STAGE}.config`);
    }
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl;
    this.mailBaseUrl = cfg.mailBaseUrl;
    this.mailbox = cfg.mailbox;
    this.timeoutMs = cfg.timeoutMs;
    this.maxChars = cfg.maxChars;
  }

  async sendText(to: string, body: string): Promise<SendReceipt> {
    this.checkSize(body);
    // Documented call: Inkbox `identity.send_text` / `sendText` (quickstart).
    const payload = await this.call('POST', '/identity/send_text', { to, body }, `${STAGE}.send_text`);
    const id = firstString(payload, ['id', 'message_id']);
    if (!id) {
      throw new HttpError(502, 'bad_upstream_body', 'Inkbox send_text returned no message id', `${STAGE}.send_text`);
    }
    return { message_id: id, channel: 'text', to, fake: false };
  }

  /**
   * Documented call (https://inkbox.ai/docs/api/mail/messages): POST /mailboxes/{address}/messages
   * with header X-API-Key and body { recipients: { to: [...] }, subject, body_text }. A 201 returns the
   * created message's metadata. The Idempotency-Key makes a retry send the same email once.
   */
  async sendEmail(to: string, subject: string, body: string): Promise<SendReceipt> {
    this.checkSize(body);
    const stage = `${STAGE}.send_email`;
    const key = createHash('sha256').update(`${to}\n${subject}\n${body}`).digest('hex').slice(0, 48);
    const res = await fetch(`${this.mailBaseUrl}/mailboxes/${encodeURIComponent(this.mailbox)}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ recipients: { to: [to], cc: null, bcc: null }, subject, body_text: body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      throw new HttpError(502, 'upstream_unreachable', `Inkbox email failed: ${err instanceof Error ? err.message : String(err)}`, stage);
    });
    if (!res.ok) {
      const detail = await res.text().then((t) => t.slice(0, 400)).catch(() => '');
      throw new HttpError(502, 'upstream_error', `Inkbox email returned ${res.status}${detail ? `: ${detail}` : ''}`, stage);
    }
    const payload: unknown = await res.json().catch(() => null);
    const id = firstString(payload, ['id', 'message_id']);
    if (!id) throw new HttpError(502, 'bad_upstream_body', 'Inkbox email returned no message id', stage);
    return { message_id: id, channel: 'email', to, fake: false };
  }

  async receiveReply(messageId: string): Promise<InkboxReply | null> {
    // ASSUMPTION (flagged): reply polling path for the cited identity inbox.
    const payload = await this.call(
      'GET',
      `/identity/messages/${encodeURIComponent(messageId)}/replies?limit=1`,
      undefined,
      `${STAGE}.receive_reply`,
    );
    const list = Array.isArray(payload) ? payload : repliesOf(payload);
    const first = list[0];
    if (!first) return null;
    return {
      message_id: messageId,
      from: firstString(first, ['from', 'sender']) ?? 'unknown',
      body: firstString(first, ['body', 'text', 'message']) ?? '',
      received_at: firstString(first, ['received_at', 'created_at']) ?? new Date().toISOString(),
    };
  }

  private checkSize(body: string): void {
    if (body.trim() === '') throw badRequest(`${STAGE}.send_text`, 'message body must be a non-empty string');
    if (body.length > this.maxChars) {
      throw new HttpError(
        413,
        'message_too_long',
        `body is ${body.length} chars, cap is ${this.maxChars}`,
        `${STAGE}.send_text`,
      );
    }
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    stage: string,
  ): Promise<unknown> {
    if (typeof fetch !== 'function') {
      throw new HttpError(500, 'no_fetch', 'global fetch is unavailable on this Node runtime', stage);
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      throw new HttpError(
        502,
        'upstream_unreachable',
        `Inkbox ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        stage,
      );
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 400);
      } catch (err) {
        detail = `<unreadable body: ${err instanceof Error ? err.message : String(err)}>`;
      }
      throw new HttpError(502, 'upstream_error', `Inkbox ${path} returned ${res.status}${detail ? `: ${detail}` : ''}`, stage);
    }
    try {
      return await res.json();
    } catch (err) {
      throw new HttpError(
        502,
        'bad_upstream_body',
        `Inkbox ${path} did not return JSON: ${err instanceof Error ? err.message : String(err)}`,
        stage,
      );
    }
  }
}

function repliesOf(payload: unknown): unknown[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const rec = payload as Record<string, unknown>;
  for (const key of ['replies', 'messages', 'data', 'items']) {
    const v = rec[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * Client selection. Fake when `AHD_APPROVALS_FAKE=1` or when no `INKBOX_API_KEY` is configured,
 * so the loop always runs offline. A NEW instance is returned per call on purpose: no module-level
 * client, no module-level approval cache (AGENTS.md: the service must stay stateless).
 */
export function createInkboxClient(env: Env = process.env): InkboxClient {
  const cfg = readConfig(env);
  if (env['AHD_APPROVALS_FAKE'] === '1' || !cfg.apiKey) return new FakeInkbox(cfg.maxChars);
  return new RealInkboxClient(cfg);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s().-]{6,24}$/;

export function isEmail(to: string): boolean {
  return EMAIL_RE.test(to.trim());
}

export function isPhone(to: string): boolean {
  const trimmed = to.trim();
  if (!PHONE_RE.test(trimmed)) return false;
  return trimmed.replace(/\D/g, '').length >= 7;
}

/**
 * Default channel is text (Inkbox's documented `send_text`); an email address falls back to email.
 * Fails loud on anything else — an unrecognised handle must never be silently dropped.
 */
export function channelForRecipient(to: string, stage = `${STAGE}.recipient`): DeliveryChannel {
  if (typeof to !== 'string' || to.trim() === '') {
    throw badRequest(stage, 'approver must be a non-empty phone number or email address');
  }
  if (isPhone(to)) return 'text';
  if (isEmail(to)) return 'email';
  throw badRequest(stage, `approver "${to.slice(0, 80)}" is neither a phone number nor an email address`);
}
