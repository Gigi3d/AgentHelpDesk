// The ship gate. Only a proven change reaches it, and the gate decides whether
// the change may touch the vendor's product or whether the agent merely gets a
// safe answer.
//
// Policy (from the build plan, "Tickets, approval modes and the daily report"
// and "What the vendor gets"):
//   - risk_policy `auto`          -> low-risk kinds (docs, error text) ship on green;
//                                    anything riskier still waits for a human.
//   - risk_policy `approve_first` -> everything waits for a one-reply approval.
//   - risk_policy `suggest_only`  -> nothing ships; the case is answered and the
//                                    draft is handed to the provider's team.
//
// The approval channel is INJECTED (`askApproval`). The default is a local stub
// so the loop runs offline; the Inkbox agent's real text sender is wired in by
// passing its function to `runLoop`/`registerRoutes`. desk/ never imports
// approvals/ or any sponsor SDK, which keeps this module HTTP-free and testable.
import type { Repository } from '../store/repository.ts';
import { HttpError } from '../shared/http.ts';
import type { ApprovalRequest, CaseStage, FailureClass, Mode, Proofs, Vendor } from '../shared/types.ts';
import { recordStage, shortHash } from './obs.ts';
import { statusOf } from './inspect.ts';

export type ChangeKind = 'docs' | 'error_text' | 'code' | 'config' | 'schema' | 'grant';

export const CHANGE_KINDS: readonly ChangeKind[] = ['docs', 'error_text', 'code', 'config', 'schema', 'grant'];

/** "Docs and error-text changes merge on green. Anything that touches config,
 * scopes, permissions, billing or an authority envelope waits for a one-reply
 * approval by text." */
export const LOW_RISK_KINDS: readonly ChangeKind[] = ['docs', 'error_text'];

export function isLowRisk(kind: ChangeKind): boolean {
  return LOW_RISK_KINDS.includes(kind);
}

/** Map a failure to the kind of change that fixes it. Deterministic and derived
 * from the stored case only — an inbound payload cannot pick a low-risk kind to
 * dodge the gate, because `klass` is validated and a grant always needs approval. */
export function changeKindOf(klass: FailureClass, response: unknown): ChangeKind {
  if (klass === 'authority') return 'grant';
  const status = statusOf(response);
  if (klass === 'code') return status === 422 || status === 400 ? 'error_text' : 'code';
  return 'docs';
}

export interface ApprovalAsk {
  approval_id: string;
  failure_id: string;
  vendor_id: string;
  kind: ChangeKind;
  change_summary: string;
  diff: string;
  proofs: Proofs;
  channel: 'text' | 'email';
  /** Contacts from the vendor row; the sender picks one. Never trust the caller. */
  approvers: readonly string[];
  resolve_by: string;
}

export interface ApprovalDecision {
  /** `pending` means the ask really went out and no human has replied yet: the
   * case parks at `awaiting_approval` and resumes on the next run. The local stub
   * never returns it — only a real channel can. */
  decision: 'yes' | 'no' | 'pending';
  approver: string;
  detail?: string;
}

export type AskApproval = (ask: ApprovalAsk, repo: Repository) => Promise<ApprovalDecision>;

export const STUB_APPROVER = 'desk-local-stub';

/** Default injection: records the decision locally and returns it. The decision
 * comes from OPERATOR config (`AHD_APPROVAL_STUB_DECISION`), never from inbound
 * data, so an agent cannot approve its own risky change. */
export async function localApprovalStub(ask: ApprovalAsk, repo: Repository): Promise<ApprovalDecision> {
  const raw = (process.env['AHD_APPROVAL_STUB_DECISION'] ?? 'yes').toLowerCase();
  const decision: 'yes' | 'no' = raw === 'no' ? 'no' : 'yes';
  await recordStage(repo, {
    ticketId: ask.failure_id,
    stage: 'awaiting_approval',
    tool: 'approvals',
    action: 'approval.stub_decision',
    result: 'ok',
    payload: {
      approval_id: ask.approval_id,
      kind: ask.kind,
      decision,
      note: 'no approval channel wired; decision came from AHD_APPROVAL_STUB_DECISION',
    },
  });
  return { decision, approver: STUB_APPROVER, detail: 'local stub (no Inkbox sender wired)' };
}

export interface GateInput {
  repo: Repository;
  failureId: string;
  vendor: Vendor;
  kind: ChangeKind;
  proofs: Proofs;
  diff: string;
  changeSummary: string;
  resolveBy: string;
  askApproval?: AskApproval;
}

export interface GateDecision {
  needs_approval: boolean;
  approved_by: string | null;
  approval_id: string | null;
  /** May the change touch the vendor's product (PR merged/opened, grant issued)? */
  ship_to_vendor: boolean;
  /** The agent always gets the tested answer or workaround, even when the change
   * is held: the safe answer changes nothing in production. */
  answer_agent: boolean;
  status: CaseStage;
  reason: string;
  risk_policy: Mode;
  low_risk: boolean;
}

export function gateWouldNeedApproval(policy: Mode, kind: ChangeKind): boolean {
  if (policy === 'suggest_only') return false;
  // autonomous: no human in the loop. The three proofs are the gate; green ships.
  if (policy === 'autonomous') return false;
  if (policy === 'approve_first') return true;
  return !isLowRisk(kind);
}

/** One approval row per (case, change). This is deliberately the SAME formula
 * approvals/approvals.ts uses (`apv_` + sha256(failureId + "\n" + summary)[0:24])
 * so a case gated here and a request sent through the real Inkbox sender collapse
 * onto one row: `createApproval` upserts by id, and a replay sends nothing. */
export function approvalIdFor(failureId: string, changeSummary: string): string {
  return `apv_${shortHash(`${failureId.trim()}\n${changeSummary.trim()}`, 24)}`;
}

export async function runGate(input: GateInput): Promise<GateDecision> {
  const stage = 'gate.evaluate';
  const { repo, failureId, vendor, kind, proofs } = input;
  const lowRisk = isLowRisk(kind);
  const needsApproval = gateWouldNeedApproval(vendor.risk_policy, kind);

  if (vendor.risk_policy === 'suggest_only') {
    await recordStage(repo, {
      ticketId: failureId,
      stage: 'awaiting_approval',
      tool: 'desk',
      action: 'gate.suggest_only',
      payload: { kind, reason: 'vendor risk_policy is suggest_only: nothing ships, the draft goes to the provider team' },
    });
    return {
      needs_approval: false,
      approved_by: null,
      approval_id: null,
      ship_to_vendor: false,
      answer_agent: true,
      status: 'answered',
      reason: 'suggest_only',
      risk_policy: vendor.risk_policy,
      low_risk: lowRisk,
    };
  }

  if (!needsApproval) {
    await recordStage(repo, {
      ticketId: failureId,
      stage: 'awaiting_approval',
      tool: 'desk',
      action: 'gate.auto_green',
      payload: { kind, low_risk: lowRisk, risk_policy: vendor.risk_policy, proofs },
    });
    return {
      needs_approval: false,
      approved_by: null,
      approval_id: null,
      ship_to_vendor: true,
      answer_agent: true,
      status: 'shipped',
      reason: 'auto_ship_on_green',
      risk_policy: vendor.risk_policy,
      low_risk: lowRisk,
    };
  }

  // ---- approval required: hold the change, keep the agent informed ----
  const approvalId = approvalIdFor(failureId, input.changeSummary);
  const approval: ApprovalRequest = {
    id: approvalId,
    failure_id: failureId,
    change_summary: input.changeSummary,
    channel: 'text',
    sent_at: new Date().toISOString(),
    replied_at: null,
    decision: null,
    approver: '',
  };
  await repo.setFailureStatus(failureId, 'awaiting_approval');
  await repo.createApproval(approval);
  await recordStage(repo, {
    ticketId: failureId,
    stage: 'awaiting_approval',
    tool: 'approvals',
    action: 'case.needs_user_input',
    result: 'pending',
    payload: { approval_id: approvalId, kind, risk_policy: vendor.risk_policy, change_summary: input.changeSummary },
  });

  const ask: ApprovalAsk = {
    approval_id: approvalId,
    failure_id: failureId,
    vendor_id: vendor.id,
    kind,
    change_summary: input.changeSummary,
    diff: input.diff,
    proofs,
    channel: 'text',
    approvers: vendor.report_contacts,
    resolve_by: input.resolveBy,
  };

  let decision: ApprovalDecision;
  try {
    decision = await (input.askApproval ?? localApprovalStub)(ask, repo);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordStage(repo, {
      ticketId: failureId,
      stage: 'awaiting_approval',
      tool: 'approvals',
      action: 'approval.channel_failed',
      result: 'error',
      payload: { approval_id: approvalId, error: message },
    });
    throw new HttpError(502, 'approval_channel_failed', `approval channel failed: ${message}`, 'gate.askApproval');
  }

  if (decision.decision !== 'yes' && decision.decision !== 'no' && decision.decision !== 'pending') {
    throw new HttpError(502, 'approval_invalid_decision', 'approval channel returned an unusable decision', stage);
  }

  if (decision.decision === 'pending') {
    // The ask went out and no human has replied. Hold the change: nothing ships
    // and no outcome is written, so an unapproved change can never be billed.
    // The case resumes on the next run, when the approval row carries a decision.
    await recordStage(repo, {
      ticketId: failureId,
      stage: 'awaiting_approval',
      tool: 'approvals',
      action: 'approval.pending',
      result: 'pending',
      payload: {
        approval_id: approvalId,
        kind,
        detail: decision.detail ?? null,
        resume: 'POST /v1/cases/run {"id":"<case_id>"} after POST /v1/approvals/reply',
      },
    });
    return {
      needs_approval: true,
      approved_by: null,
      approval_id: approvalId,
      ship_to_vendor: false,
      answer_agent: false,
      status: 'awaiting_approval',
      reason: 'awaiting_human_reply',
      risk_policy: vendor.risk_policy,
      low_risk: lowRisk,
    };
  }

  await repo.setApprovalDecision(approvalId, decision.decision, decision.approver);
  await recordStage(repo, {
    ticketId: failureId,
    stage: 'awaiting_approval',
    tool: 'approvals',
    action: 'approval.received',
    payload: { approval_id: approvalId, decision: decision.decision, approver: decision.approver, detail: decision.detail ?? null },
  });

  if (decision.decision === 'no') {
    return {
      needs_approval: true,
      approved_by: decision.approver,
      approval_id: approvalId,
      ship_to_vendor: false,
      answer_agent: true,
      status: 'answered',
      reason: 'approval_denied',
      risk_policy: vendor.risk_policy,
      low_risk: lowRisk,
    };
  }
  return {
    needs_approval: true,
    approved_by: decision.approver,
    approval_id: approvalId,
    ship_to_vendor: true,
    answer_agent: true,
    status: 'shipped',
    reason: 'approved',
    risk_policy: vendor.risk_policy,
    low_risk: lowRisk,
  };
}
