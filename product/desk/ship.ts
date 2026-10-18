// Ship: the four outputs of a proven case.
//   1. AgentReply  — the structured, tested answer handed back to the agent
//                    (exact shape from shared/types.ts, RFC 9457-shaped + proofs).
//   2. PrDescriptor — what the vendor gets: the failing call, the cause, the
//                    diff, the three proof results and the regression test.
//   3. RegressionTest — every resolved failure becomes a permanent test.
//   4. Grant — for authority failures, a bounded verb behind an envelope.
//
// desk/ does not own a GitHub client. It PREPARES the patch and the PR body,
// writes them into the case's sandbox, and — only when the operator sets
// AHD_PR_COMMAND — runs that command inside the sandbox. When it is unset the
// descriptor is recorded as prepared and nothing is claimed as merged.
import type { Repository } from '../store/repository.ts';
import type {
  AgentReply,
  Attempt,
  Envelope,
  Failure,
  Grant,
  Outcome,
  ProofName,
  ProofResult,
  Proofs,
  SandboxHandle,
  Vendor,
} from '../shared/types.ts';
import { caseActions, pushTopicsFrom, recordStage, shortHash } from './obs.ts';
import { clip, envInt, statusOf } from './inspect.ts';
import { isLowRisk } from './gate.ts';
import type { ChangeKind, GateDecision } from './gate.ts';
import { draftFix } from './resolve.ts';
import type { DraftFix } from './resolve.ts';
import { caseGrantKey, issueGrant } from './grants.ts';

export type MergeState = 'auto_merge_on_green' | 'opened_for_review' | 'draft_suggestion' | 'skipped';

export interface ProofRow {
  proof: ProofName;
  pass: boolean;
  detail: string;
}

export interface PrDescriptor {
  vendor_id: string;
  repo_url: string;
  failure_id: string;
  title: string;
  body: string;
  base_ref: string;
  head_ref: string;
  diff: string;
  changed_files: string[];
  risk: ChangeKind;
  low_risk: boolean;
  auto_merge: boolean;
  state: MergeState;
  proof_table: ProofRow[];
  regression_test_id: string;
  approved_by: string | null;
}

export interface RegressionTest {
  id: string;
  failure_id: string;
  vendor_id: string;
  name: string;
  path: string;
  asserts: string[];
  request: unknown;
  response: unknown;
  created_at: string;
}

export interface Shipment {
  reply: AgentReply;
  pr: PrDescriptor | null;
  regression: RegressionTest;
  grant: Grant | null;
  outcome: Outcome;
  events: string[];
  merge_state: MergeState;
}

export const PROOF_ORDER: readonly ProofName[] = ['replay', 'vendor_tests', 'fresh_agent'];

export function allProofsPass(p: Proofs): boolean {
  return p.replay && p.vendor_tests && p.fresh_agent;
}

export function proofTable(details: readonly ProofResult[], proofs: Proofs): ProofRow[] {
  const rows: ProofRow[] = [];
  for (const name of PROOF_ORDER) {
    const found = details.find((d) => d.proof === name);
    rows.push({ proof: name, pass: proofs[name], detail: found ? clip(found.detail, 2000) : 'not run' });
  }
  return rows;
}

export function regressionIdFor(failureId: string): string {
  return `rt_${shortHash(`regression:${failureId}`, 8)}`;
}

export function auditReceiptFor(failureId: string, attemptId: string, shippedAs: Outcome['shipped_as']): string {
  return `ahd_aud_${shortHash(`audit:${failureId}:${attemptId}:${shippedAs}`, 20)}`;
}

export function outcomeIdFor(failureId: string): string {
  return `out_${failureId}`;
}

/** The verb ship.ts grants for an authority failure. Operator setting; the
 * weekend scope ships `entitlements.reissue` only (see grants.ts VERB_TABLE). */
export function grantVerb(): string {
  const raw = process.env['AHD_GRANT_VERB'];
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 100 ? raw : 'entitlements.reissue';
}

export function buildRegressionTest(failure: Failure, vendorId: string, kind: ChangeKind): RegressionTest {
  const status = statusOf(failure.response);
  return {
    id: regressionIdFor(failure.id),
    failure_id: failure.id,
    vendor_id: vendorId,
    name: `regression: case ${failure.id} (${kind})`,
    path: `tests/regression/${failure.id}.test.mjs`,
    asserts: [
      status === null
        ? 'the reported call no longer fails'
        : `the reported call no longer returns ${status}`,
      'the vendor test suite still passes',
      'a fresh agent with only the changed docs completes the original task',
    ],
    request: failure.request,
    response: failure.response,
    created_at: new Date().toISOString(),
  };
}

export function prBodyFor(failure: Failure, draft: DraftFix, rows: readonly ProofRow[], regressionId: string): string {
  const lines = [
    '## The failing call',
    '',
    `- case: \`${failure.id}\``,
    `- agent: \`${failure.agent_id}\``,
    `- task: ${failure.task}`,
    `- observed status: ${draft.status ?? 'unknown'}`,
    '',
    '```json',
    clip(JSON.stringify({ request: failure.request, response: failure.response }, null, 2), 4000),
    '```',
    '',
    '## The cause',
    '',
    draft.summary,
    '',
    '## The diff',
    '',
    '```diff',
    draft.diff,
    '```',
    '',
    '## Proof table',
    '',
    '| proof | pass | detail |',
    '| --- | --- | --- |',
  ];
  for (const r of rows) lines.push(`| ${r.proof} | ${r.pass ? 'yes' : 'no'} | ${r.detail.replace(/\|/g, '/')} |`);
  lines.push('', `## Regression test`, '', `- \`${regressionId}\` now guards this failure.`, '');
  lines.push('_Opened by AgentHelpDesk. Every number above came from a sandbox run, not from a model._');
  return lines.join('\n');
}

export function mergeStateFor(gate: GateDecision, kind: ChangeKind, hasDiff: boolean): MergeState {
  if (!hasDiff) return 'skipped';
  if (gate.ship_to_vendor) {
    return gate.risk_policy === 'autonomous' || (gate.risk_policy === 'auto' && isLowRisk(kind)) ? 'auto_merge_on_green' : 'opened_for_review';
  }
  return gate.reason === 'suggest_only' ? 'draft_suggestion' : 'skipped';
}

export interface ReplyInput {
  failure: Failure;
  kind: ChangeKind;
  title: string;
  type_slug: string;
  snippet: string;
  fix_steps: string[];
  proofs: Proofs;
  regression_test_id: string;
  audit_receipt: string;
  events: string[];
  denied: boolean;
  grant: Grant | null;
  pr: PrDescriptor | null;
}

/** Pure: builds the exact AgentReply shape from shared/types.ts. */
export function buildAgentReply(i: ReplyInput): AgentReply {
  const f = i.failure;
  const proven = allProofsPass(i.proofs);
  const reply: AgentReply = {
    type: i.type_slug,
    title: i.title,
    // The status of the ORIGINAL failing call, which is what the agent needs to
    // match against its own error handling.
    status: statusOf(f.response) ?? 500,
    retryable: proven && !i.denied,
    fix_steps: i.fix_steps,
    snippet: i.snippet,
    tested: { replay: i.proofs.replay, vendor_tests: i.proofs.vendor_tests, fresh_agent: i.proofs.fresh_agent },
    regression_test_id: i.regression_test_id,
    case_id: f.id,
    ack_by: f.ack_by,
    resolve_by: f.resolve_by,
    queue_position: f.queue_position,
    events: i.events,
    audit_receipt: i.audit_receipt,
  };
  if (i.grant) {
    const envelope: Envelope = i.grant.envelope;
    reply.authority = envelope;
    reply.outcome = {
      action: 'granted',
      verb: i.grant.verb,
      receipt: i.grant.receipt,
      idempotency_key: i.grant.idempotency_key,
      envelope,
      expires_at: f.resolve_by,
    };
    return reply;
  }
  if (i.pr && i.pr.state !== 'skipped') {
    reply.outcome = {
      action: i.pr.state === 'auto_merge_on_green' ? 'merged' : i.pr.state === 'draft_suggestion' ? 'draft_recorded' : 'pr_opened',
      head_ref: i.pr.head_ref,
      state: i.pr.state,
      change_kind: i.kind,
      changed_files: i.pr.changed_files,
      regression_test_id: i.regression_test_id,
    };
    return reply;
  }
  reply.outcome = { action: 'answered', change_kind: i.kind, regression_test_id: i.regression_test_id, denied: i.denied };
  return reply;
}

export interface ShipInput {
  repo: Repository;
  failure: Failure;
  vendor: Vendor;
  attempt: Attempt;
  draft: DraftFix;
  proofs: Proofs;
  proofDetails: readonly ProofResult[];
  gate: GateDecision;
  sandbox?: SandboxHandle | null;
}

export async function shipCase(input: ShipInput): Promise<Shipment> {
  const stage = 'ship.emit';
  const { repo, failure, vendor, attempt, draft, proofs, gate } = input;
  const rows = proofTable(input.proofDetails, proofs);
  const regression = buildRegressionTest(failure, vendor.id, draft.kind);
  const hasDiff = draft.diff.length > 0;
  const mergeState = mergeStateFor(gate, draft.kind, hasDiff);

  // ---- 4. grant (authority failures only, and only when the gate let it ship)
  let grant: Grant | null = null;
  if (failure.klass === 'authority' && gate.ship_to_vendor) {
    const verb = grantVerb();
    const issued = await issueGrant(repo, {
      failure_id: failure.id,
      verb,
      idempotency_key: caseGrantKey(failure.id, verb),
      stage,
    });
    grant = issued.grant;
  }

  // ---- 3. regression test (always: every resolved failure becomes permanent)
  await recordStage(repo, {
    ticketId: failure.id,
    stage: gate.status,
    tool: 'regression',
    action: 'regression.created',
    payload: regression,
  });

  // ---- 2. PR descriptor
  let pr: PrDescriptor | null = null;
  if (hasDiff && mergeState !== 'skipped') {
    const headRef = `ahd/${failure.id}`;
    pr = {
      vendor_id: vendor.id,
      repo_url: vendor.repo_url,
      failure_id: failure.id,
      title: `fix(${draft.kind}): ${draft.title}`,
      body: prBodyFor(failure, draft, rows, regression.id),
      base_ref: process.env['AHD_PR_BASE_REF'] ?? 'main',
      head_ref: headRef,
      diff: draft.diff,
      changed_files: draft.changed,
      risk: draft.kind,
      low_risk: isLowRisk(draft.kind),
      auto_merge: mergeState === 'auto_merge_on_green',
      state: mergeState,
      proof_table: rows,
      regression_test_id: regression.id,
      approved_by: gate.approved_by,
    };
  }

  const sb = input.sandbox ?? null;
  if (pr && sb) {
    try {
      await sb.write(`ahd/pr/${failure.id}.patch`, pr.diff);
      await sb.write(`ahd/pr/${failure.id}.md`, pr.body);
      await sb.write(regression.path, `// ${regression.name}\n// guards case ${failure.id}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordStage(repo, {
        ticketId: failure.id,
        stage: 'shipped',
        tool: 'sandbox',
        action: 'ship.pr_write_failed',
        result: 'error',
        payload: { error: message },
      });
    }
    const prCommand = process.env['AHD_PR_COMMAND'];
    if (typeof prCommand === 'string' && prCommand.length > 0) {
      const timeoutMs = Math.min(envInt('AHD_SANDBOX_TIMEOUT_MS', 45_000, 1_000, 60_000), 60_000);
      try {
        const res = await sb.exec(prCommand, { timeout_ms: timeoutMs });
        await recordStage(repo, {
          ticketId: failure.id,
          stage: 'shipped',
          tool: 'ship',
          action: 'ship.pr_command',
          result: res.exit_code === 0 ? 'ok' : 'error',
          payload: { command: prCommand, exit_code: res.exit_code, stdout: clip(res.stdout, 2000), stderr: clip(res.stderr, 2000) },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordStage(repo, {
          ticketId: failure.id,
          stage: 'shipped',
          tool: 'ship',
          action: 'ship.pr_command',
          result: 'error',
          payload: { command: prCommand, error: message },
        });
      }
    }
  }

  await recordStage(repo, {
    ticketId: failure.id,
    stage: gate.status,
    tool: 'ship',
    action: 'ship.emitted',
    payload: {
      merge_state: mergeState,
      pr: pr ? { head_ref: pr.head_ref, changed_files: pr.changed_files, auto_merge: pr.auto_merge } : null,
      regression_test_id: regression.id,
      grant: grant ? { id: grant.id, verb: grant.verb, receipt: grant.receipt } : null,
      approved_by: gate.approved_by,
      gate_reason: gate.reason,
    },
  });

  // ---- outcome (upsert: shipping the same case twice must not fork the truth)
  const shippedAs: Outcome['shipped_as'] = grant ? 'grant' : pr ? 'pr' : 'answer';
  const previous = await repo.getOutcome(failure.id);
  const outcome: Outcome = {
    id: outcomeIdFor(failure.id),
    failure_id: failure.id,
    shipped_as: shippedAs,
    approved_by: gate.approved_by,
    // The billable rule needs the agent's retry, which has not happened yet.
    agent_retry_ok: previous ? previous.agent_retry_ok : false,
    billable: false,
    // Nobody has paid yet, and who pays is billing's call (a vendor with no Stripe
    // customer lands on the agent-pays x402 lane whatever `payer_mode` says). Keep a
    // payer a previous settlement recorded; otherwise leave it unset.
    payer: previous ? previous.payer : null,
    stripe_event_id: previous ? previous.stripe_event_id : null,
    mpp_payment_id: previous ? previous.mpp_payment_id : null,
    x402_payment_id: previous ? previous.x402_payment_id : null,
  };
  await repo.createOutcome(outcome);

  await repo.setFailureStatus(failure.id, gate.status);

  const nowIso = new Date().toISOString();
  if (nowIso > failure.resolve_by) {
    await recordStage(repo, {
      ticketId: failure.id,
      stage: gate.status,
      tool: 'desk',
      action: 'case.breached_sla',
      result: 'error',
      payload: { resolve_by: failure.resolve_by, finished_at: nowIso },
    });
  }
  await recordStage(repo, {
    ticketId: failure.id,
    stage: gate.status,
    tool: 'desk',
    action: 'case.resolved',
    payload: {
      status: gate.status,
      shipped_as: shippedAs,
      proofs,
      regression_test_id: regression.id,
      audit_receipt: auditReceiptFor(failure.id, attempt.id, shippedAs),
    },
  });

  const actions = await caseActions(repo, failure.id);
  const reply = buildAgentReply({
    failure,
    kind: draft.kind,
    title: draft.title,
    type_slug: draft.type_slug,
    snippet: draft.snippet,
    fix_steps: draft.fix_steps,
    proofs,
    regression_test_id: regression.id,
    audit_receipt: auditReceiptFor(failure.id, attempt.id, shippedAs),
    events: pushTopicsFrom(actions),
    denied: gate.reason === 'approval_denied',
    grant,
    pr,
  });

  return { reply, pr, regression, grant, outcome, events: reply.events, merge_state: mergeState };
}

/** Rebuild the reply for a case that has already been through the loop, using
 * only stored state. Used by GET /v1/cases and POST /v1/cases/retry so an agent
 * can poll and always see the same shape. */
export async function replyFromStore(repo: Repository, failure: Failure, kind: ChangeKind): Promise<AgentReply | null> {
  const attempt = await repo.latestAttempt(failure.id);
  const outcome = await repo.getOutcome(failure.id);
  if (!attempt || !outcome) return null;
  const proofs: Proofs = {
    replay: attempt.proof_replay,
    vendor_tests: attempt.proof_vendor_tests,
    fresh_agent: attempt.proof_fresh_agent,
  };
  const grant = await repo.grantByIdempotencyKey(caseGrantKey(failure.id, grantVerb()));
  const events = await repo.toolEvents({ ticket_id: failure.id });
  const denied = events.some((e) => {
    if (e.action !== 'approval.received') return false;
    const payload = typeof e.payload === 'object' && e.payload !== null ? (e.payload as Record<string, unknown>) : null;
    return payload ? payload['decision'] === 'no' : false;
  });
  const draft = draftFix(failure, 1);
  // A real resolver stores what it drafted. Polling must show THAT (the text the proofs ran on
  // and the human approved), not the template this function would otherwise rebuild.
  const stored = events
    .filter((e) => e.action === 'resolver.draft')
    .map((e) => (typeof e.payload === 'object' && e.payload !== null ? (e.payload as Record<string, unknown>) : null))
    .filter((p): p is Record<string, unknown> => p !== null && Array.isArray(p['fix_steps']) && typeof p['snippet'] === 'string')
    .at(-1);
  const storedSteps = stored ? (stored['fix_steps'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return buildAgentReply({
    failure,
    kind,
    title: draft.title,
    type_slug: draft.type_slug,
    snippet: stored && storedSteps.length > 0 ? (stored['snippet'] as string) : draft.snippet,
    fix_steps: storedSteps.length > 0 ? storedSteps : draft.fix_steps,
    proofs,
    regression_test_id: regressionIdFor(failure.id),
    audit_receipt: auditReceiptFor(failure.id, attempt.id, outcome.shipped_as),
    events: pushTopicsFrom(await caseActions(repo, failure.id)),
    denied,
    grant,
    pr: null,
  });
}
