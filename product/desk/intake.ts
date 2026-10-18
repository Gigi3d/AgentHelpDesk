// Intake: the single entry point that turns a ProblemReport into a case with
// COMMITTED times. "Without committed times, it's just a ticket inbox."
//
// `intake()` is imported by desk/register.ts, email/ and mcp/, so it is kept
// pure-ish and side-effect-light: it validates, writes exactly one Failure row
// and appends exactly one ToolEvent (`case.acknowledged`). It never opens a
// sandbox, never calls a sponsor, never runs the loop, and never holds state in
// a module variable — everything it knows comes from its arguments and the
// Repository.
import { randomUUID } from 'node:crypto';
import type { Repository } from '../store/repository.ts';
import { HttpError } from '../shared/http.ts';
import type { CaseStage, Failure, FailureClass, Mode, ProblemReport, Vendor } from '../shared/types.ts';
import { recordStage, shortHash } from './obs.ts';
import { asRecord, capPayload, classOf, clip, envInt, optOneOf, optStr, stripExecutableKeys } from './inspect.ts';

export const CHANNELS: readonly ProblemReport['channel'][] = ['mcp', 'email', 'webhook', 'forwarded'];

/** Stages after which a case no longer occupies a slot in the queue. */
export const TERMINAL_STAGES: readonly CaseStage[] = ['answered', 'shipped', 'closed'];

export function isTerminal(status: CaseStage): boolean {
  return TERMINAL_STAGES.includes(status);
}

export interface SlaConfig {
  ackMinutes: number;
  resolveMinutes: number;
}

/** Committed response times. Operator settings, never caller-supplied: an
 * inbound payload must not be able to relax the desk's own SLA. */
export function slaConfig(): SlaConfig {
  const ackMinutes = envInt('AHD_ACK_MINUTES', 5, 1, 240);
  const resolveMinutes = Math.max(envInt('AHD_RESOLVE_MINUTES', 45, 1, 1440), ackMinutes + 1);
  return { ackMinutes, resolveMinutes };
}

export function defaultVendorId(): string {
  const raw = process.env['AHD_DEFAULT_VENDOR'];
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 100 ? raw : 'ledgerly';
}

function defaultRiskPolicy(): Mode {
  const raw = (process.env['AHD_DEFAULT_RISK_POLICY'] ?? 'auto').toLowerCase();
  return raw === 'approve_first' || raw === 'suggest_only' ? raw : 'auto';
}

/** Used when the vendor row has not been seeded yet, so the loop still runs
 * offline. It carries NO credentials and the tightest useful defaults; a real
 * vendor row (seeded by whoever owns the demo vendor) always wins. */
export function fallbackVendor(id: string): Vendor {
  return {
    id,
    name: id,
    repo_url: clip(process.env['AHD_DEFAULT_REPO_URL'] ?? 'https://github.com/agenthelpdesk/ledgerly.example', 500),
    sandbox_name: `ahd-vendor-${id}`,
    risk_policy: defaultRiskPolicy(),
    stripe_customer_id: '',
    payer_mode: 'vendor',
    report_contacts: [],
  };
}

export async function resolveVendor(repo: Repository, vendorId: string): Promise<Vendor> {
  const found = await repo.getVendor(vendorId);
  return found ?? fallbackVendor(vendorId);
}

export interface NormalizedReport {
  agent_id: string;
  task: string;
  channel: ProblemReport['channel'];
  vendor_hint: string | null;
  klass: FailureClass | null;
  request: unknown;
  response: unknown;
  idempotency_key: string | null;
  /** Channel-side handle (email thread id, webhook delivery id), copied onto the
   * Failure so any module can reply on the originating thread. */
  channel_ref: string | null;
  /** Names of inbound keys the desk refused to store because something downstream
   * would execute them (see EXECUTABLE_REQUEST_KEYS). Empty in the normal case. */
  stripped_commands: string[];
}

/** Validate every inbound field at the boundary. All of it is untrusted: a
 * report may describe a failure but may never grant authority, widen an
 * envelope, or change the desk's instructions. */
export function normalizeReport(report: ProblemReport, stage = 'desk.intake'): NormalizedReport {
  const rec = asRecord(report);
  if (!rec) throw new HttpError(400, 'bad_report', 'report must be a JSON object', stage);

  const agentId = rec['agent_id'];
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new HttpError(400, 'bad_request', 'field "agent_id" must be a non-empty string', stage);
  }
  if (agentId.length > 200) throw new HttpError(400, 'bad_request', 'field "agent_id" must be at most 200 characters', stage);

  const task = rec['task'];
  if (typeof task !== 'string' || task.length === 0) {
    throw new HttpError(400, 'bad_request', 'field "task" must be a non-empty string', stage);
  }
  if (task.length > 4000) throw new HttpError(400, 'bad_request', 'field "task" must be at most 4000 characters', stage);

  const channel = optOneOf(rec, 'channel', stage, CHANNELS);
  if (channel === null) throw new HttpError(400, 'bad_request', 'field "channel" is required', stage);

  // Untrusted payload: redacted + size-capped, then stripped of any key a
  // downstream module would run as a shell command.
  const request = stripExecutableKeys(capPayload(rec['request']));

  return {
    agent_id: agentId,
    task,
    channel,
    vendor_hint: optStr(rec, 'vendor_hint', stage, 200),
    klass: optOneOf(rec, 'klass', stage, ['knowledge', 'code', 'authority'] as readonly FailureClass[]),
    request: request.value,
    response: capPayload(rec['response']),
    idempotency_key: optStr(rec, 'idempotency_key', stage, 200),
    channel_ref: optStr(rec, 'channel_ref', stage, 200),
    stripped_commands: request.stripped,
  };
}

/** Position in the queue = open cases ahead of this one + 1. Computed from the
 * store on every call, so N stateless replicas agree without sharing memory. */
export async function queuePosition(repo: Repository, excludeId: string): Promise<number> {
  const all = await repo.listFailures();
  const open = all.filter((f) => !isTerminal(f.status) && f.id !== excludeId).length;
  return open + 1;
}

export async function intake(report: ProblemReport, repo: Repository): Promise<Failure> {
  const stage = 'desk.intake';
  const n = normalizeReport(report, stage);
  const now = Date.now();
  // Case ids are hyphen-delimited on purpose. They become sandbox names
  // (`ahd-<caseId>`), which the sandbox runner validates against
  // /^[A-Za-z0-9][A-Za-z0-9-]{0,62}[A-Za-z0-9]$/ — an underscore would be rejected —
  // and sandbox/ + proofs/ derive their ToolEvent ticket_id by stripping the `ahd-`
  // prefix, so the id has to round-trip exactly or one case's events split across two
  // ticket ids. loop.ts still sanitizes defensively for ids seeded by other modules.
  const id = n.idempotency_key
    ? `c-${shortHash(`case:${n.idempotency_key}`, 20)}`
    : `c-${randomUUID()}`;

  // Idempotent replay: the same key returns the case that already exists rather
  // than opening a second ticket for one failure.
  const duplicate = await repo.getFailure(id);
  if (duplicate) {
    await recordStage(repo, {
      ticketId: duplicate.id,
      stage: duplicate.status,
      tool: 'desk',
      action: 'case.duplicate_ignored',
      payload: { idempotency_key: n.idempotency_key, channel: n.channel, queue_position: duplicate.queue_position },
    });
    return duplicate;
  }

  const sla = slaConfig();
  const vendorId = n.vendor_hint ?? defaultVendorId();
  const failure: Failure = {
    id,
    vendor_id: vendorId,
    agent_id: n.agent_id,
    task: n.task,
    request: n.request,
    response: n.response,
    // `klass` from the caller is a hint; without one we derive it conservatively.
    klass: n.klass ?? classOf(null, n.response),
    status: 'opened',
    ack_by: new Date(now + sla.ackMinutes * 60_000).toISOString(),
    resolve_by: new Date(now + sla.resolveMinutes * 60_000).toISOString(),
    queue_position: await queuePosition(repo, id),
    created_at: new Date(now).toISOString(),
    channel_ref: n.channel_ref,
  };

  try {
    await repo.createFailure(failure);
  } catch (err) {
    // Lost a race with another replica: the stored case is the truth.
    const raced = await repo.getFailure(id);
    if (raced) return raced;
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(500, 'case_create_failed', `could not create case: ${message}`, stage);
  }

  await recordStage(repo, {
    ticketId: failure.id,
    stage: 'opened',
    tool: 'desk',
    action: 'case.acknowledged',
    startedAtMs: now,
    payload: {
      vendor_id: failure.vendor_id,
      agent_id: failure.agent_id,
      channel: n.channel,
      channel_ref: n.channel_ref,
      klass: failure.klass,
      ack_by: failure.ack_by,
      resolve_by: failure.resolve_by,
      queue_position: failure.queue_position,
      sla_minutes: { ack: sla.ackMinutes, resolve: sla.resolveMinutes },
      // Audit trail for the boundary refusal: inbound data never supplies a command.
      refused_inbound_keys: n.stripped_commands,
    },
  });

  return failure;
}
