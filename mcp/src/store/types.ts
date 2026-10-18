// Shapes shared with the console. A case is stored in the same shape as a
// ticket in web/src/data/tickets.json, and an event in the same shape as a row
// in web/src/data/tool_events.json, so the console renders either source.

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
  | 'closed';

export type ProofStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface Proof {
  status: ProofStatus;
  duration_ms: number;
  detail: string;
}

/** A ticket. Loosely typed past the fields the desk itself reads and writes. */
export interface Case {
  id: string;
  title: string;
  stage: Stage;
  failure_class: 'knowledge' | 'code' | 'authority';
  endpoint: string;
  agent_id: string;
  created_at: string;
  ack_by: string;
  resolve_by: string;
  acked_at?: string;
  resolved_at?: string;
  queue_position: number;
  sla: 'blocked_order' | 'default';
  goal: string;
  tried: string;
  contact?: string;
  request_id: string;
  response: { status?: number; headers: Record<string, string>; body: unknown };
  proofs: { replay: Proof; vendor_tests: Proof; fresh_agent: Proof };
  reply?: Record<string, unknown>;
  outcome?: { action: string; agent_retry_ok: boolean } | null;
  [k: string]: unknown;
}

export interface ToolEvent {
  id: string;
  ticket_id: string;
  stage: Stage;
  tool: string;
  action: string;
  /** Milliseconds after the case was created. */
  t_ms: number;
  d_ms: number;
  result: string;
  cost_usd?: number;
  payload: Record<string, unknown>;
  gate?: boolean;
  after_gate?: boolean;
}

export type StoreChange =
  | { type: 'case'; case: Case }
  | { type: 'event'; event: ToolEvent };

/**
 * Everything the desk persists. One implementation per backend: a JSON file
 * today, an in-memory fake for tests, InsForge later. Nothing else in the
 * server touches storage directly.
 */
export interface DeskStore {
  listCases(): Promise<Case[]>;
  getCase(id: string): Promise<Case | undefined>;
  findOpenCaseByRequestId(requestId: string): Promise<Case | undefined>;
  putCase(c: Case): Promise<void>;
  listEvents(caseId: string): Promise<ToolEvent[]>;
  appendEvent(e: ToolEvent): Promise<void>;
  /** Called after every write. Returns an unsubscribe function. */
  subscribe(fn: (change: StoreChange) => void): () => void;
}
