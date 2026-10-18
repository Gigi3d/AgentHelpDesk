// inkbox/events.ts: what the desk does when Inkbox calls it.
//
//  a2a.task.created   another agent hands the desk a task  -> a case, an immediate `progress` reply
//  message.received   an email arrives at the desk mailbox -> a human's yes/no on an approval, or a new case
//
// Authentication is the desk's own bearer token: the webhook subscription is created with
// `auth_token` set to AHD_API_TOKEN (documented subscription field), so no extra scheme is needed.
// The payload layout of a2a.task.created is not documented, so ids are looked up in the few places
// they plausibly live and the task itself is fetched (documented) for its text.
import { intake } from '../desk/intake.ts';
import { recordStage } from '../desk/obs.ts';
import { applyReply, parseReply } from '../approvals/approvals.ts';
import type { InkboxClient } from '../approvals/inkbox-client.ts';
import type { Repository } from '../store/repository.ts';
import type { ProblemReport } from '../shared/types.ts';
import type { A2AClient } from './a2a.ts';
import type { MailReader } from './mail.ts';

export interface EventDeps {
  repo: Repository;
  a2a: A2AClient;
  mail: MailReader;
  mailer: InkboxClient;
  /** Start the loop for a case in the background. Injected by server.ts. */
  start: (caseId: string) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export interface EventResult {
  handled: 'a2a_task' | 'approval_reply' | 'email_case' | 'ignored';
  case_id?: string;
  detail: string;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** First non-empty string found at any of the given paths of an object. */
function pick(o: Record<string, unknown>, paths: string[][]): string {
  for (const p of paths) {
    let cur: unknown = o;
    for (const k of p) cur = rec(cur)[k];
    if (typeof cur === 'string' && cur !== '') return cur;
  }
  return '';
}

/** Turn an agent's words into a case report. A structured `data` part with task/request/response wins. */
export function reportFromTask(texts: string[], data: Record<string, unknown>[], via: 'a2a' | 'email', ref: string, sender: string): ProblemReport {
  const structured = data.find((d) => typeof d['task'] === 'string');
  if (structured) {
    return {
      agent_id: str(structured['agent_id']) || sender || `${via}-agent`,
      task: str(structured['task']),
      request: structured['request'] ?? { note: 'no request was attached' },
      response: structured['response'] ?? { note: 'no response was attached' },
      channel: via === 'a2a' ? 'forwarded' : 'email',
      vendor_hint: str(structured['vendor']) || undefined,
      idempotency_key: ref,
      channel_ref: ref,
    };
  }
  const text = texts.join('\n\n').trim();
  return {
    agent_id: sender || `${via}-agent`,
    task: text.slice(0, 3900) || '(empty message)',
    request: { note: `free text sent over ${via}; no structured request was attached` },
    response: { text: text.slice(0, 2000) },
    channel: via === 'a2a' ? 'forwarded' : 'email',
    idempotency_key: ref,
    channel_ref: ref,
  };
}

const receiptText = (c: { id: string; ack_by: string; resolve_by: string; queue_position: number }): string =>
  `AgentHelpDesk opened case ${c.id}. Committed: acknowledged by ${c.ack_by}, resolved by ${c.resolve_by}, queue position ${c.queue_position}. ` +
  `You will get one more message here when the fix is verified or a person takes over.`;

export async function handleEvent(body: unknown, deps: EventDeps): Promise<EventResult> {
  const env = deps.env ?? process.env;
  const ev = rec(body);
  const type = str(ev['event_type']) || str(ev['type']) || str(ev['event']);
  const data = rec(ev['data']);
  const handle = (env['AHD_INKBOX_HANDLE'] ?? 'agenthelpdesk').trim();

  if (type === 'a2a.task.created') {
    const taskId = pick(data, [['task_id'], ['taskId'], ['task', 'id'], ['id']]);
    if (!taskId) return { handled: 'ignored', detail: 'a2a.task.created carried no task id' };
    const task = await deps.a2a.getTask(handle, taskId);
    const sender = pick(data, [['requester_handle'], ['requester', 'handle'], ['from'], ['caller_handle']]);
    const report = reportFromTask(task.texts, task.data, 'a2a', `a2a:${handle}:${taskId}`, sender);
    const failure = await intake(report, deps.repo);
    await deps.start(failure.id);
    await deps.a2a.reply(handle, taskId, 'progress', receiptText(failure));
    return { handled: 'a2a_task', case_id: failure.id, detail: `case ${failure.id} opened for a2a task ${taskId}` };
  }

  if (type === 'message.received') {
    const m = rec(data['message']);
    const id = str(m['id']) || str(m['message_id']);
    const from = str(m['from_address']).toLowerCase();
    const mailbox = (env['AHD_INKBOX_MAILBOX'] ?? 'agenthelpdesk@inkboxmail.com').toLowerCase();
    if (!id || from === '' || from === mailbox) return { handled: 'ignored', detail: 'not an inbound message from another sender' };
    const mail = await deps.mail.read(id, { from, subject: str(m['subject']), snippet: str(m['snippet']) });

    // A yes or no to an approval request. The decision only counts from the address that was asked.
    const named = /apv_[a-f0-9]{8,}/i.exec(`${mail.subject}\n${mail.text}`);
    if (named) {
      const approvalId = named[0].toLowerCase();
      const approval = await deps.repo.getApproval(approvalId);
      const firstLines = mail.text.split(/\r?\n(?:>|On .* wrote:)/)[0] ?? mail.text; // ignore the quoted original
      const parsed = parseReply(firstLines, approvalId);
      const asked = [approval?.approver, env['AHD_APPROVALS_FALLBACK_EMAIL']].filter(Boolean).map((a) => String(a).toLowerCase());
      if (approval && parsed && asked.includes(from)) {
        await applyReply(approvalId, parsed.decision, from, deps.repo);
        await deps.start(approval.failure_id);
        return { handled: 'approval_reply', case_id: approval.failure_id, detail: `${parsed.decision} from ${from}` };
      }
      return { handled: 'ignored', detail: approval ? (asked.includes(from) ? 'reply was ambiguous; no decision recorded' : 'sender is not the approver; no decision recorded') : 'unknown approval id' };
    }

    // Otherwise it is an agent or person writing in a problem.
    const allowed = (env['AHD_INKBOX_ALLOWED_SENDERS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(from)) return { handled: 'ignored', detail: `sender ${from} is not on AHD_INKBOX_ALLOWED_SENDERS` };
    const ref = `email:${id}:${from}`;
    const report = reportFromTask([`${mail.subject}\n\n${mail.text}`], [], 'email', ref, from);
    const failure = await intake(report, deps.repo);
    await deps.start(failure.id);
    await deps.mailer.sendEmail(from, `Re: ${mail.subject || 'your report'} (case ${failure.id})`, receiptText(failure));
    return { handled: 'email_case', case_id: failure.id, detail: `case ${failure.id} opened from email` };
  }

  await recordStage(deps.repo, { ticketId: 'inkbox', stage: 'inkbox.webhook', tool: 'inkbox', action: 'webhook.ignored', result: 'skipped', payload: { type } }).catch(() => undefined);
  return { handled: 'ignored', detail: `event type ${type || '(none)'} is not used by the desk` };
}
