import type { Case, Stage } from './store/index.js';

// The vocabulary the agent-facing reply is written in, shared by the edge, the
// fixtures and the tests: the pushable topics, the stage→status map and the
// projection from a stored ticket to an AgentReply.
//
// The in-process worker that used to live here (intake, SLA clocks, the recorded
// request log and the stage-by-stage pipeline) is gone on purpose: case state and
// the pipeline belong to the backend service in product/, and this server reaches
// it only through src/desk-client.ts. What is left is the offline projection the
// AHD_DESK_FAKE=1 fixtures still need, so a demo reply looks exactly like a real one.

export interface ReportInput {
  request_id: string;
  /** Optional only when `case_id` is present, which makes the call a status poll. */
  goal?: string;
  tried?: string;
  contact?: string;
  case_id?: string;
}

export const EVENT_TOPICS = ['case.acknowledged', 'case.needs_user_input', 'case.resolved', 'case.breached_sla'] as const;

type AgentStatus = 'opened' | 'working' | 'needs_user_input' | 'answered' | 'handed_off';

/**
 * The ten console stages collapsed to the five an agent can act on. AGENT_STATUS in
 * src/desk-client.ts applies the same collapse to the backend's CaseStage, which
 * also has 'escalated' (it lands on 'handed_off').
 */
const STATUS: Record<Stage, AgentStatus> = {
  opened: 'opened',
  reproducing: 'working',
  fix_drafted: 'working',
  proving: 'working',
  awaiting_approval: 'working',
  answered: 'answered',
  shipped: 'answered',
  closed: 'answered',
  failed_proof: 'handed_off',
  rejected: 'handed_off',
};

/** The structured reply an agent gets back, per report_problem's outputSchema. */
export function toAgentReply(c: Case) {
  const status = STATUS[c.stage];
  const reply = (c.reply ?? {}) as { fix_steps?: string[]; authority?: Record<string, unknown> };
  const fix = c.fix as { reply_text?: string } | undefined;
  const answered = status === 'answered';
  const issued = Array.isArray(c.grants) && c.grants.some((g: { status?: string }) => g.status === 'issued');
  return {
    case_id: c.id,
    status,
    ack_by: c.ack_by,
    resolve_by: c.resolve_by,
    queue_position: c.queue_position,
    ...(answered && {
      answer: {
        summary: fix?.reply_text ?? '',
        fix_steps: reply.fix_steps ?? [],
        docs: 'https://help.ledgerly.example/agents',
        tested: {
          replay: c.proofs.replay.status === 'passed',
          vendor_tests: c.proofs.vendor_tests.status === 'passed',
          fresh_agent: c.proofs.fresh_agent.status === 'passed',
        },
      },
    }),
    ...(answered && c.outcome && { outcome: c.outcome as Record<string, unknown> }),
    ...(issued && reply.authority && { authority: reply.authority }),
    events: [...EVENT_TOPICS],
    ...(!answered && { wait: 30 }),
  };
}

export type AgentReply = ReturnType<typeof toAgentReply>;
