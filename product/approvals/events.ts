// Internal observability helper for the approvals module.
// Every meaningful stage (a text sent, a decision stored, a report delivered) appends a
// ToolEvent through the Repository so the provider console can show it. Kept in one place
// so approvals.ts, reports.ts and register.ts all emit identically shaped events.
import { randomUUID } from 'node:crypto';
import type { ToolEvent } from '../shared/types.ts';

/** Tool name every Inkbox-backed stage reports under. */
export const INKBOX_TOOL = 'inkbox';

export interface ToolEventInput {
  /** Case id for approval stages; vendor id for report stages (reports are not per case). */
  ticket_id: string;
  /** `approvals.*` — the stage that failed or succeeded, e.g. `approvals.request`. */
  stage: string;
  /** Stable action name the console filters on: `approval.requested`, `approval.decided`, `report.sent`. */
  action: string;
  /** Epoch ms when the stage started, so `d_ms` is a real duration. */
  t_ms: number;
  /** `ok`, `replayed`, `error` — never free text from an untrusted caller. */
  result: string;
  payload: unknown;
}

export function toolEvent(input: ToolEventInput): ToolEvent {
  return {
    id: randomUUID(),
    ticket_id: input.ticket_id,
    stage: input.stage,
    tool: INKBOX_TOOL,
    action: input.action,
    t_ms: input.t_ms,
    d_ms: Math.max(0, Date.now() - input.t_ms),
    result: input.result,
    payload: input.payload,
    at: new Date().toISOString(),
  };
}

/**
 * Approvers are reached at a personal handle (a phone number or an email address).
 * Events and logs keep only the last four characters so the audit trail cannot be
 * used as a contact list.
 */
export function maskRecipient(to: string): string {
  const trimmed = to.trim();
  if (trimmed.length <= 4) return '****';
  return `****${trimmed.slice(-4)}`;
}
