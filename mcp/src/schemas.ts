// The agent-facing contract of this MCP server: the Zod schemas behind
// report_problem's inputSchema/outputSchema plus the small retry tool.
//
// They live here (and not in index.ts) so the edge, the fixtures and the tests all
// validate against the exact schema an already-installed agent sees. The shapes are
// unchanged from the previous release and still match
// web/src/data/report_problem.tool.json, so agents installed against the old server
// keep working.
import { z } from 'zod';
import { EVENT_TOPICS } from './desk.js';

/** Pushable case topics, advertised to the agent in every reply. */
export const eventTopics = z.enum(EVENT_TOPICS);
export type EventTopic = z.infer<typeof eventTopics>;

export const reportInputSchema = z
  .object({
    request_id: z.string().describe('The Request-Id header or help.request_id from the failing response.'),
    goal: z.string().optional().describe('What you were trying to do, in one sentence. Required to open a case; omit it when you send case_id to check status.'),
    tried: z.string().optional().describe('What you already tried.'),
    contact: z.string().optional().describe('Optional. How to reach your operator, such as an email.'),
    case_id: z.string().optional().describe('Optional. Pass an existing case id to check its status instead of opening a new case.'),
  })
  .refine((v) => Boolean(v.case_id) || Boolean(v.goal?.trim()), {
    message: 'Send goal to open a case, or case_id alone to check an existing one.',
    path: ['goal'],
  });

export type ReportArgs = z.infer<typeof reportInputSchema>;

export const reportOutputSchema = z.object({
  case_id: z.string().optional(),
  status: z.enum(['opened', 'working', 'needs_user_input', 'answered', 'handed_off']).optional(),
  ack_by: z.iso.datetime().optional(),
  resolve_by: z.iso.datetime().optional(),
  queue_position: z.number().int().optional(),
  answer: z
    .object({
      summary: z.string().optional(),
      fix_steps: z.array(z.string()).optional(),
      docs: z.string().optional(),
      tested: z.object({ replay: z.boolean().optional(), vendor_tests: z.boolean().optional(), fresh_agent: z.boolean().optional() }).optional(),
    })
    .optional(),
  outcome: z.record(z.string(), z.unknown()).optional().describe('Executable result: action, amount, currency, expires_at.'),
  authority: z.record(z.string(), z.unknown()).optional().describe('Verbs you may now call, each with its cap and per-user limit.'),
  events: z.array(eventTopics).optional(),
  wait: z.number().int().optional().describe('Seconds before polling again. Fallback when you cannot receive push.'),
});

/** The structured reply an agent gets back from report_problem. */
export type ToolReply = z.infer<typeof reportOutputSchema>;

/** The five statuses the tool may report. */
export type AgentStatus = NonNullable<ToolReply['status']>;

export const retryInputSchema = z.object({
  case_id: z.string().describe('The case_id report_problem gave you.'),
  ok: z.boolean().describe('true when the failing call now succeeds after you applied the fix.'),
  note: z.string().optional().describe('Optional. The error you still get, when ok is false.'),
});

export type RetryArgs = z.infer<typeof retryInputSchema>;

export const retryOutputSchema = z.object({
  case_id: z.string(),
  ok: z.boolean(),
  billable: z.boolean().describe('True only when all three proofs passed and your retry succeeded. Rungs 0-3 never bill.'),
  outcome_id: z.string().optional(),
  receipt: z.string().optional().describe('Audit receipt for this retry report. A replay returns the same receipt and bills nothing extra.'),
});

export type RetryReceipt = z.infer<typeof retryOutputSchema>;
