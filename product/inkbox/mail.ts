// inkbox/mail.ts: read one message of our own mailbox.
// Documented (https://inkbox.ai/docs/api/mail/messages): GET /mailboxes/{address}/messages/{message_id}
// returns the metadata plus body_text. Fetching an inbound message with an API key marks it read.
import { HttpError } from '../shared/http.ts';

export interface InboundMail {
  id: string;
  from: string;
  subject: string;
  text: string;
}

export interface MailReader {
  read(messageId: string, hint?: { from?: string; subject?: string; snippet?: string }): Promise<InboundMail>;
}

export class RealMailReader implements MailReader {
  private readonly apiKey: string;
  private readonly mailbox: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  constructor(apiKey: string, mailbox: string, base = 'https://inkbox.ai/api/v1/mail', timeoutMs = 8000) {
    this.apiKey = apiKey;
    this.mailbox = mailbox;
    this.base = base;
    this.timeoutMs = timeoutMs;
  }
  async read(messageId: string, hint: { from?: string; subject?: string; snippet?: string } = {}): Promise<InboundMail> {
    const res = await fetch(`${this.base}/mailboxes/${encodeURIComponent(this.mailbox)}/messages/${encodeURIComponent(messageId)}`, {
      headers: { 'x-api-key': this.apiKey },
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      throw new HttpError(502, 'upstream_unreachable', `Inkbox mail read failed: ${err instanceof Error ? err.message : String(err)}`, 'inkbox.mail.read');
    });
    if (!res.ok) throw new HttpError(502, 'upstream_error', `Inkbox mail read returned ${res.status}`, 'inkbox.mail.read');
    const m = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const s = (k: string): string => (typeof m[k] === 'string' ? (m[k] as string) : '');
    return {
      id: messageId,
      from: s('from_address') || hint.from || '',
      subject: s('subject') || hint.subject || '',
      text: s('body_text') || s('snippet') || hint.snippet || '',
    };
  }
}

export class FakeMailReader implements MailReader {
  readonly mails = new Map<string, InboundMail>();
  async read(messageId: string, hint: { from?: string; subject?: string; snippet?: string } = {}): Promise<InboundMail> {
    return this.mails.get(messageId) ?? { id: messageId, from: hint.from ?? '', subject: hint.subject ?? '', text: hint.snippet ?? '' };
  }
}

export function createMailReader(env: Record<string, string | undefined> = process.env): MailReader {
  const key = (env['INKBOX_API_KEY'] ?? '').trim();
  if (key === '' || env['AHD_APPROVALS_FAKE'] === '1' || env['AHD_INKBOX_FAKE'] === '1') return new FakeMailReader();
  return new RealMailReader(key, (env['AHD_INKBOX_MAILBOX'] ?? 'agenthelpdesk@inkboxmail.com').trim(), (env['AHD_INKBOX_MAIL_BASE_URL'] ?? 'https://inkbox.ai/api/v1/mail').replace(/\/+$/, ''));
}
