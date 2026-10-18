// Observability helpers for desk/. Every meaningful stage of the loop appends a
// ToolEvent through the Repository so the console (and the grants-and-audit
// block on the ticket page) can show it. Nothing here holds case state: the
// Repository is the only source of truth, so the service stays stateless.
import { createHash, randomUUID } from 'node:crypto';
import type { Repository } from '../store/repository.ts';
import type { ToolEvent } from '../shared/types.ts';

export type StageResult = 'ok' | 'error' | 'skipped' | 'pending';

export interface StageInput {
  ticketId: string;
  /** Loop stage the event belongs to: opened | reproducing | fix_drafted | proving | ... */
  stage: string;
  /** Subsystem that did the work: desk | sandbox | resolver | proofs | approvals | ship | stripe | inkbox | privacy */
  tool: string;
  /** Push-topic shaped action, e.g. `case.acknowledged`, `proof.replay`. */
  action: string;
  result?: StageResult;
  payload?: unknown;
  /** Epoch ms the stage started; defaults to "now". */
  startedAtMs?: number;
  /** Explicit duration; defaults to now - startedAtMs. */
  durationMs?: number;
}

/** Stable short digest used for receipts (audit, grant, deletion) so a replay of
 * the same logical action always produces the same receipt string. */
export function shortHash(input: string, len = 20): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

export function buildStageEvent(i: StageInput): ToolEvent {
  const nowMs = Date.now();
  const start = typeof i.startedAtMs === 'number' && Number.isFinite(i.startedAtMs) ? i.startedAtMs : nowMs;
  const duration =
    typeof i.durationMs === 'number' && Number.isFinite(i.durationMs)
      ? Math.max(0, Math.round(i.durationMs))
      : Math.max(0, nowMs - start);
  return {
    id: `evt_${randomUUID()}`,
    ticket_id: i.ticketId,
    stage: i.stage,
    tool: i.tool,
    action: i.action,
    t_ms: start,
    d_ms: duration,
    result: i.result ?? 'ok',
    payload: i.payload ?? null,
    at: new Date(nowMs).toISOString(),
  };
}

/** Append a stage event. Failures are deliberately NOT swallowed: a desk that
 * cannot write its audit trail must not pretend it ran the stage. */
export async function recordStage(repo: Repository, i: StageInput): Promise<ToolEvent> {
  const e = buildStageEvent(i);
  await repo.appendToolEvent(e);
  return e;
}

/** Ordered, de-duplicated list of actions recorded for a case. Feeds AgentReply.events. */
export async function caseActions(repo: Repository, ticketId: string): Promise<string[]> {
  const events = await repo.toolEvents({ ticket_id: ticketId });
  const seen: string[] = [];
  for (const e of events) {
    if (!seen.includes(e.action)) seen.push(e.action);
  }
  return seen;
}

/** The four push topics from the build plan, restricted to the ones that really
 * happened on this case (never a promised event we did not record). */
export const PUSH_TOPICS: readonly string[] = [
  'case.acknowledged',
  'case.needs_user_input',
  'case.resolved',
  'case.breached_sla',
];

export function pushTopicsFrom(actions: readonly string[]): string[] {
  return PUSH_TOPICS.filter((t) => actions.includes(t));
}
