// approvals/approvals.ts — the human approval gate for risky changes (code / config / schema / grants).
//
// Flow (Build Plan, "Tickets, approval modes and the daily report" -> approve_first):
//   the desk proves a risky change three ways, then pauses; this module texts the vendor's
//   approver through Inkbox with the case id, the change and the three proof results, so the
//   human never approves blind. The approver replies yes/no, `applyReply` stores the decision,
//   and the desk loop (another module) reads it back with `repo.getApproval(id)`.
//   This file deliberately does NOT import desk/ — the case lifecycle has one writer.
import { createHash } from 'node:crypto';
import type { ApprovalRequest, Attempt, Failure } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { HttpError, badRequest } from '../shared/http.ts';
import { toolEvent, maskRecipient } from './events.ts';
import {
  channelForRecipient,
  createInkboxClient,
  isEmail,
  type DeliveryChannel,
  type InkboxClient,
  type SendReceipt,
} from './inkbox-client.ts';

const STAGE_REQUEST = 'approvals.request';
const STAGE_REPLY = 'approvals.reply';
const STAGE_DELIVER = 'approvals.deliver';
const STAGE_STORE = 'approvals.store';

type Env = Record<string, string | undefined>;

export interface ApprovalDeps {
  /** Injectable client; defaults to `createInkboxClient()` (Fake when AHD_APPROVALS_FAKE=1 or no key). */
  client?: InkboxClient;
  /** Where to fall back if the text channel is unavailable. Defaults to AHD_APPROVALS_FALLBACK_EMAIL. */
  fallbackEmail?: string | null;
  env?: Env;
  now?: () => number;
}

export interface ApprovalResult {
  approval: ApprovalRequest;
  /** The exact text that was (or would be) sent, so the console can show what the human saw. */
  body: string;
  channel: DeliveryChannel;
  receipt: SendReceipt | null;
  /** True when an identical request already existed: nothing was sent again. */
  replayed: boolean;
}

export interface ReplyResult {
  approval: ApprovalRequest;
  replayed: boolean;
}

export interface ParsedReply {
  decision: 'yes' | 'no';
  approval_id: string | null;
}

/**
 * Wrap a Repository call so a store failure names our stage instead of surfacing as a
 * generic 500 from the HTTP layer. HttpError passes through untouched.
 */
export async function storeGuard<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, 'store_failed', `${stage}: ${err instanceof Error ? err.message : String(err)}`, stage);
  }
}

/**
 * Deterministic approval id: sha256(failure id + change summary). Two identical requests for the
 * same change therefore collapse to the same row, which is what makes a replay send nothing —
 * the same trick the Repository uses for grant idempotency keys and meter identifiers.
 * (CONTRACT_REQUESTS.md asks for `listApprovals({failure_id})`; until then the id carries it.)
 */
export function approvalIdFor(failureId: string, changeSummary: string): string {
  const digest = createHash('sha256').update(`${failureId}\n${changeSummary}`).digest('hex');
  return `apv_${digest.slice(0, 24)}`;
}

function proofWord(pass: boolean): string {
  return pass ? 'PASS' : 'FAIL';
}

/** Trim the change summary to a budget, keeping its first line intact. */
export function fitSummary(summary: string, budget: number): string {
  if (budget < 24) throw new HttpError(500, 'compose_overflow', `summary budget ${budget} is too small`, STAGE_REQUEST);
  const flat = summary.replace(/\s+/g, ' ').trim();
  if (flat.length <= budget) return flat;
  // The Build Plan addendum requires an envelope grant's cap and per-user limit to sit in the
  // first line, because a human is approving a spend limit, not a diff. So the first line survives
  // the trim and only the tail is cut.
  const rawFirst = summary.split('\n')[0];
  const firstLine = rawFirst.trim();
  if (firstLine.length >= budget) return `${firstLine.slice(0, budget - 1)}…`;
  const rest = summary.slice(rawFirst.length).replace(/\s+/g, ' ').trim();
  const remaining = budget - firstLine.length - 1;
  const head = remaining > 1 && rest.length > 0 ? `${firstLine} ${rest.slice(0, remaining - 1).trim()}…` : firstLine;
  return head.length > budget ? head.slice(0, budget) : head;
}

export interface ApprovalTextInput {
  failure: Failure;
  approvalId: string;
  changeSummary: string;
  attempt: Attempt | null;
  maxChars: number;
}

/**
 * Build the approval text out of stored facts only. The three proof results always appear, and if
 * no attempt is recorded the text says so rather than implying the change was proven.
 */
export function composeApprovalText(input: ApprovalTextInput): string {
  const { failure, approvalId, attempt, maxChars } = input;
  const head = `AgentHelpDesk approval needed - case ${failure.id} (${failure.vendor_id}, ${failure.klass}).`;
  const proofs = attempt
    ? `Proofs: replay ${proofWord(attempt.proof_replay)}, vendor tests ${proofWord(
        attempt.proof_vendor_tests,
      )}, fresh agent ${proofWord(attempt.proof_fresh_agent)}.`
    : 'Proofs: none recorded. Do not approve blind.';
  const task = `Task: ${failure.task.length > 120 ? `${failure.task.slice(0, 119)}…` : failure.task}`;
  const reply = `Reply "yes ${approvalId}" to ship, or "no ${approvalId}" to hold.`;
  const fixed = [head, task, proofs, reply].join('\n');
  const budget = maxChars - fixed.length - '\nChange: '.length;
  const summary = fitSummary(input.changeSummary, budget);
  return [head, task, `Change: ${summary}`, proofs, reply].join('\n');
}

async function deliver(
  client: InkboxClient,
  channel: DeliveryChannel,
  approver: string,
  fallbackEmail: string | null,
  body: string,
): Promise<{ receipt: SendReceipt; channel: DeliveryChannel }> {
  if (channel === 'email') {
    return { receipt: await client.sendEmail(approver, 'AgentHelpDesk approval needed', body), channel: 'email' };
  }
  try {
    return { receipt: await client.sendText(approver, body), channel: 'text' };
  } catch (textErr) {
    // Default channel is text; email is the documented fallback (Inkbox's quickstart does not say
    // whether its texts are SMS or iMessage, so the fallback matters). No fallback configured =>
    // rethrow the original loud error.
    if (!fallbackEmail || !isEmail(fallbackEmail)) throw textErr;
    try {
      return {
        receipt: await client.sendEmail(fallbackEmail, 'AgentHelpDesk approval needed', body),
        channel: 'email',
      };
    } catch (emailErr) {
      throw new HttpError(
        502,
        'delivery_failed',
        `text to ${maskRecipient(approver)} failed (${
          textErr instanceof Error ? textErr.message : String(textErr)
        }); email fallback to ${maskRecipient(fallbackEmail)} failed (${
          emailErr instanceof Error ? emailErr.message : String(emailErr)
        })`,
        STAGE_DELIVER,
      );
    }
  }
}

/**
 * Open the approval gate for one risky change: store-intent -> text the approver -> record the row
 * and the ToolEvent. Returns the approval and the exact body sent.
 *
 * Fails loud when: the inputs are malformed (400), the case does not exist (404), no attempt has
 * been proven yet (409 — approving without proofs is exactly what the gate exists to prevent),
 * the approver handle is unusable (400), or delivery fails (502).
 */
export async function requestApproval(
  failureId: string,
  changeSummary: string,
  approver: string,
  repo: Repository,
  deps: ApprovalDeps = {},
): Promise<ApprovalResult> {
  const started = Date.now();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;

  if (typeof failureId !== 'string' || failureId.trim() === '') {
    throw badRequest(STAGE_REQUEST, 'failure_id must be a non-empty string');
  }
  if (typeof changeSummary !== 'string' || changeSummary.trim() === '') {
    throw badRequest(STAGE_REQUEST, 'change_summary must be a non-empty string');
  }
  if (typeof approver !== 'string' || approver.trim() === '') {
    throw badRequest(STAGE_REQUEST, 'approver must be a non-empty phone number or email address');
  }

  const caseId = failureId.trim();
  const summary = changeSummary.trim();
  const approvalId = approvalIdFor(caseId, summary);

  const failure = await storeGuard(STAGE_REQUEST, () => repo.getFailure(caseId));
  if (!failure) throw new HttpError(404, 'not_found', `failure ${caseId} not found`, STAGE_REQUEST);

  // Replay: an identical request already exists, so return the original and send nothing.
  const existing = await storeGuard(STAGE_REQUEST, () => repo.getApproval(approvalId));
  if (existing) {
    const attempt = await storeGuard(STAGE_REQUEST, () => repo.latestAttempt(caseId));
    const replayEvent = toolEvent({
      ticket_id: caseId,
      stage: STAGE_REQUEST,
      action: 'approval.requested',
      t_ms: started,
      result: 'replayed',
      payload: {
        approval_id: approvalId,
        failure_id: caseId,
        decision: existing.decision,
        sent_at: existing.sent_at,
        reason: 'identical change_summary already requested; nothing sent again',
      },
    });
    await storeGuard(STAGE_REQUEST, () => repo.appendToolEvent(replayEvent));
    return {
      approval: existing,
      body: composeApprovalText({
        failure,
        approvalId,
        changeSummary: existing.change_summary,
        attempt,
        maxChars: maxCharsFrom(env),
      }),
      channel: existing.channel,
      receipt: null,
      replayed: true,
    };
  }

  const attempt = await storeGuard(STAGE_REQUEST, () => repo.latestAttempt(caseId));
  if (!attempt) {
    throw new HttpError(
      409,
      'proofs_missing',
      `failure ${caseId} has no attempt, so there are no proof results to approve against`,
      STAGE_REQUEST,
    );
  }

  const override = env['AHD_APPROVALS_CHANNEL'];
  const channel: DeliveryChannel =
    override === 'text' || override === 'email' ? override : channelForRecipient(approver, STAGE_REQUEST);
  const client = deps.client ?? createInkboxClient(env);
  const maxChars = maxCharsFrom(env);
  const body = composeApprovalText({ failure, approvalId, changeSummary: summary, attempt, maxChars });

  const fallbackEmail =
    deps.fallbackEmail !== undefined ? deps.fallbackEmail : (env['AHD_APPROVALS_FALLBACK_EMAIL'] ?? null);

  // Send before storing: a failed send must not leave an approval row that a replay would then
  // refuse to re-send. A crash between the two costs one duplicate text, which is the cheaper fault.
  const { receipt, channel: usedChannel } = await deliver(client, channel, approver.trim(), fallbackEmail, body);

  const approval: ApprovalRequest = {
    id: approvalId,
    failure_id: caseId,
    change_summary: summary,
    channel: usedChannel,
    sent_at: new Date(now()).toISOString(),
    replied_at: null,
    decision: null,
    approver: approver.trim(),
  };
  await storeGuard(STAGE_STORE, () => repo.createApproval(approval));

  const event = toolEvent({
    ticket_id: caseId,
    stage: STAGE_REQUEST,
    action: 'approval.requested',
    t_ms: started,
    result: 'ok',
    payload: {
      approval_id: approvalId,
      failure_id: caseId,
      vendor_id: failure.vendor_id,
      klass: failure.klass,
      channel: usedChannel,
      to: maskRecipient(approver),
      message_id: receipt.message_id,
      fake: receipt.fake,
      proofs: {
        replay: attempt.proof_replay,
        vendor_tests: attempt.proof_vendor_tests,
        fresh_agent: attempt.proof_fresh_agent,
      },
      decision: null,
      body_chars: body.length,
    },
  });
  await storeGuard(STAGE_REQUEST, () => repo.appendToolEvent(event));

  return { approval, body, channel: usedChannel, receipt, replayed: false };
}

function maxCharsFrom(env: Env): number {
  const raw = env['AHD_INKBOX_MAX_CHARS'];
  if (raw === undefined || raw.trim() === '') return 1400;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 160 || n > 4000) {
    throw new HttpError(500, 'bad_config', 'AHD_INKBOX_MAX_CHARS must be an integer between 160 and 4000', STAGE_REQUEST);
  }
  return n;
}

/**
 * Parse an untrusted inbound reply body into a decision. Conservative on purpose:
 * only an explicit yes/no word counts, and a reply that names a DIFFERENT approval id is
 * refused, so one stray text can never decide another vendor's change.
 */
export function parseReply(body: string, expectedApprovalId: string | null = null): ParsedReply | null {
  if (typeof body !== 'string') return null;
  const text = body.trim();
  if (text === '') return null;

  const named = text.match(/apv_[a-f0-9]{8,}/i);
  const approvalId = named ? named[0].toLowerCase() : null;
  if (approvalId && expectedApprovalId && approvalId !== expectedApprovalId.toLowerCase()) return null;

  const lower = text.toLowerCase();
  // "not approved" is not a yes. Any negation makes the reply ambiguous, and an ambiguous reply
  // is refused so a human is asked again rather than a change shipping on a misread.
  if (/\b(not|never|cannot|can't|cant|don't|dont|nobody|nothing)\b/.test(lower)) return null;
  const yes = /\b(yes|y|approve|approved|ship|confirm|go)\b/.test(lower);
  const no = /\b(no|n|nope|deny|denied|reject|rejected|hold|stop|cancel)\b/.test(lower);
  if (yes === no) return null; // neither, or both: ambiguous is not a decision
  return { decision: yes ? 'yes' : 'no', approval_id: approvalId };
}

/**
 * Store the human's decision. The desk loop reads it back with `repo.getApproval(id)`; this module
 * never touches case status, so the lifecycle keeps one writer.
 *
 * A repeat of the SAME decision is a replay (returns the stored row, writes no second decision).
 * A CONTRADICTORY second decision is refused with 409: a human's yes must not be silently flipped.
 */
export async function applyReply(
  approvalId: string,
  decision: 'yes' | 'no',
  approver: string,
  repo: Repository,
): Promise<ReplyResult> {
  const started = Date.now();
  if (typeof approvalId !== 'string' || approvalId.trim() === '') {
    throw badRequest(STAGE_REPLY, 'id must be a non-empty string');
  }
  if (decision !== 'yes' && decision !== 'no') {
    throw badRequest(STAGE_REPLY, `decision must be "yes" or "no", got ${String(decision).slice(0, 40)}`);
  }
  if (typeof approver !== 'string' || approver.trim() === '') {
    throw badRequest(STAGE_REPLY, 'approver must be a non-empty string');
  }

  const id = approvalId.trim();
  const who = approver.trim();
  const approval = await storeGuard(STAGE_REPLY, () => repo.getApproval(id));
  if (!approval) throw new HttpError(404, 'not_found', `approval ${id} not found`, STAGE_REPLY);

  if (approval.decision !== null) {
    if (approval.decision === decision) {
      const replayEvent = toolEvent({
        ticket_id: approval.failure_id,
        stage: STAGE_REPLY,
        action: 'approval.decided',
        t_ms: started,
        result: 'replayed',
        payload: { approval_id: id, decision, approver: who, decided_at: approval.replied_at },
      });
      await storeGuard(STAGE_REPLY, () => repo.appendToolEvent(replayEvent));
      return { approval, replayed: true };
    }
    throw new HttpError(
      409,
      'decision_conflict',
      `approval ${id} was already decided "${approval.decision}" at ${approval.replied_at ?? 'unknown'}; it cannot become "${decision}"`,
      STAGE_REPLY,
    );
  }

  await storeGuard(STAGE_REPLY, () => repo.setApprovalDecision(id, decision, who));
  const decided = await storeGuard(STAGE_REPLY, () => repo.getApproval(id));
  if (!decided) throw new HttpError(500, 'store_failed', `approval ${id} vanished after the decision was stored`, STAGE_REPLY);

  const event = toolEvent({
    ticket_id: decided.failure_id,
    stage: STAGE_REPLY,
    action: 'approval.decided',
    t_ms: started,
    result: 'ok',
    payload: {
      approval_id: id,
      failure_id: decided.failure_id,
      decision,
      approver: who,
      approver_matches_request: who === approval.approver,
      channel: decided.channel,
      replied_at: decided.replied_at,
    },
  });
  await storeGuard(STAGE_REPLY, () => repo.appendToolEvent(event));
  return { approval: decided, replayed: false };
}
