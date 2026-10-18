export type Stage =
  | 'opened'
  | 'reproducing'
  | 'fix_drafted'
  | 'proving'
  | 'awaiting_approval'
  | 'answered'
  | 'shipped'
  | 'failed_proof'
  | 'rejected'
  | 'closed'
  | 'escalated';

export type FailureClass = 'knowledge' | 'code' | 'authority';
export type Mode = 'auto' | 'approve_first' | 'suggest_only';
export type ProofStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface Proof {
  status: ProofStatus;
  duration_ms: number;
  detail: string;
}

export interface Grant {
  id: string;
  verb: string;
  status: 'drafted' | 'issued' | 'denied';
  cap_usd: number;
  per_user: number;
  spent_usd: number;
  idempotency_key: string;
  receipt: string | null;
}

export interface HttpExchange {
  method?: string;
  url?: string;
  status?: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface Ticket {
  id: string;
  seeded?: number;
  title: string;
  stage: Stage;
  failure_class: FailureClass;
  endpoint: string;
  agent_id: string;
  created_at: string;
  ack_by: string;
  resolve_by: string;
  acked_at?: string;
  resolved_at?: string;
  queue_position: number;
  sla?: string;
  mode: Mode;
  risk: 'low' | 'medium' | 'high';
  change_type: 'docs' | 'error_text' | 'config' | 'grant' | 'code';
  affected_agents: number;
  goal: string;
  tried: string;
  contact?: string;
  request: HttpExchange;
  response: HttpExchange;
  cause: string;
  fix: { kind: string; summary: string; file: string; diff: string[]; reply_text: string };
  proofs: { replay: Proof; vendor_tests: Proof; fresh_agent: Proof };
  grants: Grant[];
  reply?: Record<string, unknown>;
  outcome?: { action: string; agent_retry_ok: boolean } | null;
  pr?: { number: number; title: string; merged: boolean };
  regression_test_id?: string;
  rejected_reason?: string;
  price_usd: number;
  billed?: boolean;
  not_billable_reason?: string;
}

export interface ToolEvent {
  id: string;
  ticket_id: string;
  /** Fixtures only ever use `Stage`. The backend records free-form stage strings
   * (`billing.decide`, `proofs.replay`, `ship.emitted`), and live mode shows them
   * as recorded rather than forcing them into a stage it does not have. */
  stage: Stage | (string & {});
  tool: string;
  action: string;
  t_ms: number;
  d_ms: number;
  result: string;
  cost_usd?: number;
  payload: Record<string, unknown>;
  gate?: boolean;
  after_gate?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  client: string;
  kind: string;
  calls_7d: number;
  failures_7d: number;
  tickets: number;
  status: 'helped' | 'won' | 'lost';
  partner: boolean;
  identified: boolean;
  muted?: boolean;
  last_seen: string;
}
