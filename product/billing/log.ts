// Observability helper for the billing module.
//
// AGENTS.md: "every meaningful stage appends a ToolEvent via the Repository so the
// console can show it". Every billing stage therefore produces exactly one event
// through this builder, so stage/action/result naming stays consistent and nothing
// is swallowed. Stages are named `billing.*` so a failure always says which lane
// and which step it died in.
import { randomUUID } from 'node:crypto';
import type { ToolEvent } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';

/** The `tool` column value for every event this module writes. */
export const BILLING_TOOL = 'billing';

export type BillingStage =
  | 'billing.decide'
  | 'billing.meter'
  | 'billing.x402'
  | 'billing.mpp'
  | 'billing.invoice'
  | 'billing.stripe'
  | 'billing.prices';

export type BillingResult = 'ok' | 'skipped' | 'replayed' | 'error';

export interface BillingEventInput {
  /** Case key. The desk keys cases `ahd-<ticketId>`; billing writes the failure id. */
  ticketId: string;
  stage: BillingStage;
  /** Machine-readable action, e.g. `meter_event.created`, `billing.exempt`. */
  action: string;
  result: BillingResult;
  payload: unknown;
  /** Epoch ms when the stage started, so `d_ms` is real and not always 0. */
  startedAt?: number;
}

export function billingEvent(input: BillingEventInput): ToolEvent {
  const now = Date.now();
  const started = input.startedAt ?? now;
  return {
    id: randomUUID(),
    ticket_id: input.ticketId,
    stage: input.stage,
    tool: BILLING_TOOL,
    action: input.action,
    t_ms: started,
    d_ms: Math.max(0, now - started),
    result: input.result,
    payload: input.payload,
    at: new Date(now).toISOString(),
  };
}

/** Append and hand the event back so callers can return its id in a response body. */
export async function logBillingEvent(repo: Repository, input: BillingEventInput): Promise<ToolEvent> {
  const event = billingEvent(input);
  await repo.appendToolEvent(event);
  return event;
}
