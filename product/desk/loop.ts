// The case state machine:
//
//   opened -> reproducing -> fix_drafted -> proving
//          -> (awaiting_approval, only when the risk policy says so)
//          -> answered | shipped
//   and -> escalated when the failure cannot be reproduced, when the proofs
//          repeatedly fail, when the sandbox is unreachable, or when the loop
//          runs out of budget.
//
// Two invariants from the build plan:
//   * "The failure cannot be reproduced. Then the desk replies that it could not
//     confirm the problem and escalates to a human, and does not guess."
//   * "A failed proof sends it back for another attempt, and repeated failure
//     goes to a human."
//
// sandbox/ and proofs/ are reached THROUGH THEIR INTERFACES ONLY
// (getRunner / getProofRunner). This module never imports their internals, so
// they can be replaced or faked without touching the loop.
//
// Nothing here is held in module scope: every run reads the case from the
// Repository and writes it back, so N stateless replicas can run cases at once.
// Sandboxes are keyed by case id (`ahd-<caseId>`), never by a global.
import type { Repository } from '../store/repository.ts';
import { HttpError } from '../shared/http.ts';
import type {
  AgentReply,
  Attempt,
  CaseStage,
  ExecResult,
  Failure,
  Grant,
  Outcome,
  ProofName,
  ProofResult,
  Proofs,
  ProofRunner,
  SandboxHandle,
  SandboxRunner,
  Vendor,
} from '../shared/types.ts';
import { getRunner } from '../sandbox/runner.ts';
import { getProofRunner } from '../proofs/proofs.ts';
import { recordStage, shortHash } from './obs.ts';
import { clip, envInt } from './inspect.ts';
import { resolveVendor } from './intake.ts';
import { changeKindOf, runGate } from './gate.ts';
import type { AskApproval, ChangeKind, GateDecision } from './gate.ts';
import { draftFix, reproFixture, reproHarness, reproPaths } from './resolve.ts';
import type { DraftFix, DraftFn } from './resolve.ts';
import { allProofsPass, replyFromStore, shipCase } from './ship.ts';
import type { PrDescriptor, RegressionTest } from './ship.ts';

/** Stages from which the loop may (re)start. Anything else is already owned by a
 * human or finished, so re-entry rebuilds the answer from the store instead of
 * re-running the loop. */
const RESUMABLE: readonly CaseStage[] = ['opened', 'reproducing', 'fix_drafted', 'proving'];

/** `awaiting_approval` is parked on a human, so it re-enters the loop only once
 * that human has actually replied. Re-running is deliberate rather than jumping
 * straight to shipping: the sandbox may be gone and nothing should ship on proofs
 * that are no longer reproducible. */
async function approvalDecided(repo: Repository, caseId: string): Promise<boolean> {
  return (await repo.listApprovals({ failure_id: caseId, decided: true })).length > 0;
}

const PROOF_ORDER: readonly ProofName[] = ['replay', 'vendor_tests', 'fresh_agent'];

/** What counts as "the failure reproduced".
 *  - `nonzero` (production, real vendor checkout): the generated repro test must
 *    FAIL, because the failure is real.
 *  - `zero`: the vendor's own test command is expected to exit 0 while still
 *    exercising the reported call.
 *  - `any` (offline default): the harness only has to be written and executed
 *    inside the sandbox without erroring or timing out. The offline fake sandbox
 *    has no vendor repo, so demanding a specific exit code would escalate every
 *    case; escalation still fires when the sandbox is unreachable or the command
 *    times out. */
export type ReproExpectation = 'nonzero' | 'zero' | 'any';

export function envReproExpect(): ReproExpectation {
  const raw = (process.env['AHD_REPRO_EXPECT'] ?? 'any').toLowerCase();
  return raw === 'nonzero' || raw === 'zero' ? raw : 'any';
}

export interface LoopDeps {
  runner?: SandboxRunner;
  proofs?: ProofRunner;
  /** Injected approval channel. Defaults to gate.localApprovalStub. */
  askApproval?: AskApproval;
  /** Injected resolver. Defaults to the deterministic draftFix stand-in. */
  draft?: DraftFn;
  reproExpect?: ReproExpectation;
  maxAttempts?: number;
  /** Per-command sandbox timeout. Clamped to 60s: one Blaxel command may wait
   * at most 60 seconds, so anything longer must go background+poll. */
  timeoutMs?: number;
  /** Whole-loop budget. Exceeding it escalates instead of hanging. */
  budgetMs?: number;
}

export interface LoopError {
  code: string;
  stage: string;
  message: string;
}

export interface LoopResult {
  case_id: string;
  status: CaseStage;
  reason: string;
  attempts: number;
  proofs: Proofs;
  proof_details: ProofResult[];
  reply: AgentReply | null;
  pr: PrDescriptor | null;
  regression: RegressionTest | null;
  grant: Grant | null;
  outcome: Outcome | null;
  gate: GateDecision | null;
  error: LoopError | null;
}

/** The sandbox-name-safe form of a case id.
 *
 * The runner validates names against /^[A-Za-z0-9][A-Za-z0-9-]{0,62}[A-Za-z0-9]$/
 * and throws otherwise, so an id seeded by another module (underscores, slashes,
 * over-long) would fail every reproduction with an opaque `sandbox_unavailable`.
 * desk's own ids are hyphen-delimited by construction, so this is a no-op for
 * them; it only rescues foreign ids. One 50-char budget for both names so the
 * parent and its fork share a token and both stay inside the runner's 64-char
 * cap (`ahd-` + 50 = 54, `ahd-` + 50 + `-fresh` = 60). */
function nameToken(caseId: string, budget = 50): string {
  const flat = caseId
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  const head = flat.slice(0, budget).replace(/-+$/, '');
  // Nothing usable survived: fall back to a stable hash so the name is still
  // deterministic (one sandbox per case, never a shared global).
  return head.length >= 2 ? head : `case-${shortHash(`sandbox-name:${caseId}`, 16)}`;
}

export function sandboxName(caseId: string): string {
  return `ahd-${nameToken(caseId)}`;
}

/** The fresh-agent proof runs in a FORK of the case snapshot so it cannot
 * inherit the resolver's state. */
export function freshSandboxName(caseId: string): string {
  return `ahd-${nameToken(caseId)}-fresh`;
}

export function logBase(): string {
  const raw = process.env['AHD_LOG_BASE_URL'];
  return typeof raw === 'string' && raw.length > 0 ? clip(raw, 300).replace(/\/+$/, '') : 'https://logs.agenthelpdesk.example';
}

export function logUrlFor(caseId: string, attemptId: string): string {
  return `${logBase()}/cases/${caseId}/attempts/${attemptId}`;
}

/** The repro command. Reproduction targets the vendor's test file / test
 * command, not a full stack: standing up the vendor's database and queues is
 * later work. Placeholders let an operator point at the vendor's own runner. */
export function reproCommand(caseId: string, fixture: string, harness: string): string {
  const raw = process.env['AHD_REPRO_COMMAND'];
  const template = typeof raw === 'string' && raw.length > 0 ? raw : 'node --test {harness}';
  return template
    .replaceAll('{case}', caseId)
    .replaceAll('{harness}', harness)
    .replaceAll('{fixture}', fixture)
    .replaceAll('{sandbox}', sandboxName(caseId));
}

function toLoopError(err: unknown, code: string, stage: string): LoopError {
  return { code, stage, message: err instanceof Error ? err.message : String(err) };
}

/** Sandbox file the vendor_tests proof reads its command from (proofs/proofs.ts
 * falls back to `npm test` when it is missing or empty). desk writes it only from
 * operator configuration. */
export const VENDOR_TEST_COMMAND_FILE = '/ahd/test-command';

export function reproVerdict(res: ExecResult, expect: ReproExpectation): { reproduced: boolean; reason: string } {
  // 124 is the conventional "command timed out" exit code.
  if (res.exit_code === 124) return { reproduced: false, reason: 'the repro command timed out' };
  if (expect === 'nonzero') {
    return {
      reproduced: res.exit_code !== 0,
      reason: `exit_code ${res.exit_code}; expected non-zero because the reported failure must reproduce`,
    };
  }
  if (expect === 'zero') {
    return { reproduced: res.exit_code === 0, reason: `exit_code ${res.exit_code}; expected zero from the vendor test command` };
  }
  return { reproduced: true, reason: `exit_code ${res.exit_code}; AHD_REPRO_EXPECT=any only requires the harness to run` };
}

export async function runLoop(repo: Repository, caseId: string, deps: LoopDeps = {}): Promise<LoopResult> {
  const stage = 'loop.run';
  if (typeof caseId !== 'string' || caseId.length === 0) {
    throw new HttpError(400, 'bad_case_id', 'case id must be a non-empty string', stage);
  }
  const startedAt = Date.now();
  const timeoutMs = Math.min(deps.timeoutMs ?? envInt('AHD_SANDBOX_TIMEOUT_MS', 45_000, 1_000, 60_000), 60_000);
  const maxAttempts = deps.maxAttempts ?? envInt('AHD_MAX_ATTEMPTS', 3, 1, 10);
  const budgetMs = deps.budgetMs ?? envInt('AHD_LOOP_BUDGET_MS', 240_000, 1_000, 3_600_000);
  const reproExpect = deps.reproExpect ?? envReproExpect();
  const draft = deps.draft ?? draftFix;

  const stored = await repo.getFailure(caseId);
  if (!stored) throw new HttpError(404, 'case_not_found', `no case ${caseId}`, 'loop.load');

  let attemptsMade = 0;
  let proofs: Proofs = { replay: false, vendor_tests: false, fresh_agent: false };
  let proofDetails: ProofResult[] = [];

  /** The single escalation path. It always writes the status and the audit
   * event before returning, so an escalated case is never silent. */
  const escalate = async (reason: string, error: LoopError | null, extra?: Record<string, unknown>): Promise<LoopResult> => {
    await repo.setFailureStatus(caseId, 'escalated');
    await recordStage(repo, {
      ticketId: caseId,
      stage: 'escalated',
      tool: 'desk',
      action: 'case.escalated',
      result: 'error',
      startedAtMs: startedAt,
      payload: { reason, error, attempts: attemptsMade, proofs, proof_details: proofDetails, ...(extra ?? {}) },
    });
    return {
      case_id: caseId,
      status: 'escalated',
      reason,
      attempts: attemptsMade,
      proofs,
      proof_details: proofDetails,
      reply: null,
      pr: null,
      regression: null,
      grant: null,
      outcome: null,
      gate: null,
      error,
    };
  };

  // ---- re-entry: a finished or human-owned case is answered from the store ----
  if (!RESUMABLE.includes(stored.status) && !(stored.status === 'awaiting_approval' && (await approvalDecided(repo, caseId)))) {
    return rebuildFromStore(repo, stored, `already_${stored.status}`);
  }

  const vendor: Vendor = await resolveVendor(repo, stored.vendor_id);
  // Passing the repo opts into sandbox/'s and proofs/' own observability wrappers:
  // they append a ToolEvent per create/resume/fork/destroy and per proof, with
  // timings desk would otherwise have to guess at.
  const runner: SandboxRunner = deps.runner ?? getRunner(repo);
  const proofRunner: ProofRunner = deps.proofs ?? getProofRunner(repo);

  // ================= stage: reproducing =================
  await repo.setFailureStatus(caseId, 'reproducing');
  await recordStage(repo, {
    ticketId: caseId,
    stage: 'reproducing',
    tool: 'sandbox',
    action: 'case.reproducing',
    result: 'pending',
    payload: { sandbox: sandboxName(caseId), vendor_id: vendor.id, expect: reproExpect, timeout_ms: timeoutMs },
  });

  let sb: SandboxHandle;
  try {
    sb = await runner.createOrResume(sandboxName(caseId));
  } catch (err) {
    return escalate('sandbox_unavailable', toLoopError(err, 'sandbox_unavailable', 'sandbox.createOrResume'));
  }

  const paths = reproPaths(stored);
  const command = reproCommand(caseId, paths.fixture, paths.harness);
  // proofs/proofs.ts reads the vendor test command from /ahd/test-command and falls
  // back to `npm test`. Only an operator can say what the vendor's suite is, so the
  // file is written only when AHD_VENDOR_TEST_COMMAND is set — never from inbound
  // report data, which may not supply a command line.
  const vendorTestCommand = clip(process.env['AHD_VENDOR_TEST_COMMAND'] ?? '', 500).trim();
  let verdict: { reproduced: boolean; reason: string };
  try {
    await sb.write(paths.fixture, reproFixture(stored));
    await sb.write(paths.harness, reproHarness(stored));
    if (vendorTestCommand.length > 0) await sb.write(VENDOR_TEST_COMMAND_FILE, vendorTestCommand);
    const execStartedAt = Date.now();
    const res = await sb.exec(command, { timeout_ms: timeoutMs });
    verdict = reproVerdict(res, reproExpect);
    await recordStage(repo, {
      ticketId: caseId,
      stage: 'reproducing',
      tool: 'sandbox',
      action: 'sandbox.exec',
      result: verdict.reproduced ? 'ok' : 'error',
      startedAtMs: execStartedAt,
      payload: {
        command,
        exit_code: res.exit_code,
        stdout: clip(res.stdout, 2000),
        stderr: clip(res.stderr, 2000),
        expect: reproExpect,
        verdict: verdict.reason,
        vendor_test_command_file: vendorTestCommand.length > 0 ? VENDOR_TEST_COMMAND_FILE : null,
      },
    });
  } catch (err) {
    return escalate('sandbox_exec_failed', toLoopError(err, 'sandbox_exec_failed', 'sandbox.exec'), { command });
  }

  if (!verdict.reproduced) {
    // Never guess: an unreproduced failure goes to a human with the evidence.
    return escalate('not_reproduced', null, { command, detail: verdict.reason });
  }
  await recordStage(repo, {
    ticketId: caseId,
    stage: 'reproducing',
    tool: 'sandbox',
    action: 'case.reproduced',
    payload: { command, detail: verdict.reason },
  });

  // ================= stages: fix_drafted + proving, up to N attempts =================
  let attemptRow: Attempt | null = null;
  let currentDraft: DraftFix | null = null;

  for (let n = 1; n <= maxAttempts; n += 1) {
    if (Date.now() - startedAt > budgetMs) {
      return escalate('budget_exhausted', null, { budget_ms: budgetMs, attempts: attemptsMade });
    }

    let drafted: DraftFix;
    try {
      drafted = draft(stored, n);
    } catch (err) {
      return escalate('resolver_failed', toLoopError(err, 'resolver_failed', 'resolver.draft'));
    }
    currentDraft = drafted;

    // The patch AND the patched files. proofs/ reads every `changed` path out of
    // the sandbox for the fresh-agent check, so writing only the diff would fail
    // that proof on a missing doc.
    const writes: Array<{ path: string; content: string }> = drafted.files.map((file) => ({
      path: file.path,
      content: file.content,
    }));
    if (drafted.diff.length > 0) writes.unshift({ path: `ahd/patches/${caseId}-${n}.patch`, content: drafted.diff });
    for (const write of writes) {
      try {
        await sb.write(write.path, write.content);
      } catch (err) {
        return escalate('patch_write_failed', toLoopError(err, 'patch_write_failed', 'sandbox.write'), {
          path: write.path,
        });
      }
    }

    await repo.setFailureStatus(caseId, 'fix_drafted');
    await recordStage(repo, {
      ticketId: caseId,
      stage: 'fix_drafted',
      tool: 'resolver',
      action: 'case.fix_drafted',
      payload: { attempt: n, kind: drafted.kind, changed: drafted.changed, summary: drafted.summary },
    });

    await repo.setFailureStatus(caseId, 'proving');
    await recordStage(repo, {
      ticketId: caseId,
      stage: 'proving',
      tool: 'proofs',
      action: 'case.proving',
      result: 'pending',
      payload: { attempt: n, order: PROOF_ORDER },
    });

    const results: ProofResult[] = [];
    for (const name of PROOF_ORDER) {
      const alreadyFailed = results.some((r) => !r.pass);
      if (alreadyFailed) {
        const skipped: ProofResult = { proof: name, pass: false, detail: 'skipped: an earlier proof failed' };
        results.push(skipped);
        await recordStage(repo, {
          ticketId: caseId,
          stage: 'proving',
          tool: 'proofs',
          action: `proof.${name}`,
          result: 'skipped',
          payload: { attempt: n, detail: skipped.detail },
        });
        continue;
      }
      const started = Date.now();
      let result: ProofResult;
      try {
        result =
          name === 'replay'
            ? await proofRunner.replay(sb, stored)
            : name === 'vendor_tests'
              ? await proofRunner.vendorTests(sb)
              : await runFreshAgent({
                  runner,
                  proofRunner,
                  sb,
                  caseId,
                  task: stored.task,
                  changed: drafted.changed,
                  repo,
                });
      } catch (err) {
        result = {
          proof: name,
          pass: false,
          detail: `proof runner failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const normalised: ProofResult = { proof: name, pass: result.pass === true, detail: clip(result.detail ?? '', 2000) };
      results.push(normalised);
      await recordStage(repo, {
        ticketId: caseId,
        stage: 'proving',
        tool: 'proofs',
        action: `proof.${name}`,
        result: normalised.pass ? 'ok' : 'error',
        startedAtMs: started,
        payload: { attempt: n, detail: normalised.detail },
      });
    }

    proofs = {
      replay: results[0]?.pass === true,
      vendor_tests: results[1]?.pass === true,
      fresh_agent: results[2]?.pass === true,
    };
    proofDetails = results;
    attemptsMade = n;

    const attemptId = `att_${caseId}_${n}`;
    const attempt: Attempt = {
      id: attemptId,
      failure_id: caseId,
      diff: drafted.diff,
      proof_replay: proofs.replay,
      proof_vendor_tests: proofs.vendor_tests,
      proof_fresh_agent: proofs.fresh_agent,
      log_url: logUrlFor(caseId, attemptId),
    };
    await repo.createAttempt(attempt);

    if (allProofsPass(proofs)) {
      attemptRow = attempt;
      break;
    }
    await recordStage(repo, {
      ticketId: caseId,
      stage: 'proving',
      tool: 'proofs',
      action: 'case.proof_failed',
      result: 'error',
      payload: { attempt: n, proofs, details: results },
    });
  }

  if (!attemptRow || !currentDraft) {
    return escalate('proofs_failed', null, { attempts: attemptsMade, max_attempts: maxAttempts });
  }

  // ================= stage: awaiting_approval (only if the policy says so) =================
  const kind: ChangeKind = changeKindOf(stored.klass, stored.response);
  let gate: GateDecision;
  try {
    gate = await runGate({
      repo,
      failureId: caseId,
      vendor,
      kind,
      proofs,
      diff: currentDraft.diff,
      changeSummary: currentDraft.summary,
      resolveBy: stored.resolve_by,
      askApproval: deps.askApproval,
    });
  } catch (err) {
    const loopError =
      err instanceof HttpError
        ? { code: err.code, stage: err.stage, message: err.message }
        : toLoopError(err, 'gate_failed', 'gate.evaluate');
    return escalate('approval_channel_failed', loopError);
  }

  // ================= stage: answered | shipped =================
  if (gate.status === 'awaiting_approval') {
    // Held for a human: nothing ships and no outcome is written, so an
    // unapproved change can never be billed. Resume with POST /v1/cases/run
    // after POST /v1/approvals/reply records the decision.
    await recordStage(repo, {
      ticketId: caseId,
      stage: 'awaiting_approval',
      tool: 'desk',
      action: 'loop.parked',
      result: 'pending',
      startedAtMs: startedAt,
      payload: { approval_id: gate.approval_id, reason: gate.reason, attempts: attemptsMade, proofs },
    });
    return {
      case_id: caseId,
      status: 'awaiting_approval',
      reason: gate.reason,
      attempts: attemptsMade,
      proofs,
      proof_details: proofDetails,
      reply: null,
      pr: null,
      regression: null,
      grant: null,
      outcome: null,
      gate,
      error: null,
    };
  }

  const shipment = await shipCase({
    repo,
    failure: stored,
    vendor,
    attempt: attemptRow,
    draft: currentDraft,
    proofs,
    proofDetails,
    gate,
    sandbox: sb,
  });

  await recordStage(repo, {
    ticketId: caseId,
    stage: gate.status,
    tool: 'desk',
    action: 'loop.completed',
    startedAtMs: startedAt,
    payload: { status: gate.status, reason: gate.reason, attempts: attemptsMade, shipped_as: shipment.outcome.shipped_as },
  });

  return {
    case_id: caseId,
    status: gate.status,
    reason: gate.reason,
    attempts: attemptsMade,
    proofs,
    proof_details: proofDetails,
    reply: shipment.reply,
    pr: shipment.pr,
    regression: shipment.regression,
    grant: shipment.grant,
    outcome: shipment.outcome,
    gate,
    error: null,
  };
}

/** The fresh-agent proof, isolated in a fork of the case snapshot so it cannot
 * inherit the resolver's state. If the runner cannot fork, we degrade loudly in
 * the audit trail rather than silently claiming isolation. */
async function runFreshAgent(args: {
  runner: SandboxRunner;
  proofRunner: ProofRunner;
  sb: SandboxHandle;
  caseId: string;
  task: string;
  changed: string[];
  repo: Repository;
}): Promise<ProofResult> {
  let handle: SandboxHandle;
  const forkName = freshSandboxName(args.caseId);
  try {
    const snapshotId = await args.sb.snapshot();
    handle = await args.runner.fork(snapshotId, forkName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordStage(args.repo, {
      ticketId: args.caseId,
      stage: 'proving',
      tool: 'sandbox',
      action: 'proof.fresh_agent_isolation',
      result: 'error',
      payload: {
        sandbox: forkName,
        error: message,
        note: 'could not fork a clean sandbox; the proof is FAILED rather than run in the parent',
      },
    });
    // Never fall back to the parent handle: it still holds the resolver's state, so
    // an unisolated run can pass on knowledge the agent will not have. A false pass
    // here is what makes an unproven fix billable.
    return {
      proof: 'fresh_agent',
      pass: false,
      detail: `fresh-agent check could not be isolated: fork of '${forkName}' failed: ${message}`,
    };
  }
  try {
    // Only the task and the changed file names cross this boundary.
    return await args.proofRunner.freshAgent(handle, args.task, args.changed);
  } finally {
    try {
      await args.runner.destroy(forkName);
    } catch (err) {
      await recordStage(args.repo, {
        ticketId: args.caseId,
        stage: 'proving',
        tool: 'sandbox',
        action: 'sandbox.destroy_failed',
        result: 'error',
        payload: { sandbox: forkName, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

/** Answer a case that has already been through the loop, from stored state only. */
export async function rebuildFromStore(repo: Repository, failure: Failure, reason: string): Promise<LoopResult> {
  const kind = changeKindOf(failure.klass, failure.response);
  const attempt = await repo.latestAttempt(failure.id);
  const outcome = await repo.getOutcome(failure.id);
  const reply = await replyFromStore(repo, failure, kind);
  return {
    case_id: failure.id,
    status: failure.status,
    reason,
    attempts: attempt ? 1 : 0,
    proofs: attempt
      ? {
          replay: attempt.proof_replay,
          vendor_tests: attempt.proof_vendor_tests,
          fresh_agent: attempt.proof_fresh_agent,
        }
      : { replay: false, vendor_tests: false, fresh_agent: false },
    proof_details: [],
    reply,
    pr: null,
    regression: null,
    grant: null,
    outcome,
    gate: null,
    error: null,
  };
}
