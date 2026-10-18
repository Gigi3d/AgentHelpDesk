import { MCPServer } from 'mcp-use';
import { streamSSE } from 'hono/streaming';
import {
  reportInputSchema,
  reportOutputSchema,
  retryInputSchema,
  retryOutputSchema,
  type RetryReceipt,
  type ToolReply,
} from './src/schemas.js';
import { asDeskClientError, createDeskClient, issueText, validationError, type DeskClientError } from './src/desk-client.js';
import type { StoreChange } from './src/store/index.js';

const server = new MCPServer({
  name: 'ledgerly-desk',
  title: 'Ledgerly Agent Help Desk',
  version: '0.2.0',
  description:
    'report_problem for agents that fail on the Ledgerly API, plus the case API the console reads. This server is a thin MCP edge: case state belongs to the AgentHelpDesk backend service, and the edge never invents a case.',
  cors: {},
});

// One client per process. It is stateless with respect to cases: every call is
// forwarded to AHD_DESK_URL (default http://127.0.0.1:8787), or served from the
// deterministic fixtures in src/fixtures/ when AHD_DESK_FAKE=1.
const desk = createDeskClient();

const summarize = (r: ToolReply) =>
  r.status === 'answered'
    ? `Case ${r.case_id} is answered: ${r.answer?.summary}`
    : `Case ${r.case_id} is ${r.status}. A person or the desk will acknowledge by ${r.ack_by} and resolve by ${r.resolve_by}. Queue position ${r.queue_position}. Check again in ${r.wait}s with case_id.`;

const summarizeRetry = (r: RetryReceipt) =>
  r.billable
    ? `Case ${r.case_id} is closed as fixed and billable. Receipt ${r.receipt ?? 'recorded'}.`
    : r.ok
      ? `Case ${r.case_id} recorded your successful retry. It is not billable until all three proofs pass.`
      : `Case ${r.case_id} recorded that the fix did not work. The desk goes back to it and will answer again or hand off to a person.`;

/** Errors go back as the backend's envelope, not as prose: an agent branches on code and stage. */
const errorResult = (err: unknown) => {
  const e = asDeskClientError(err);
  return { content: [{ type: 'text' as const, text: JSON.stringify(e.toEnvelope()) }], isError: true };
};

const envelopeOf = (err: unknown): { body: unknown; status: DeskClientError['status'] } => {
  const e = asDeskClientError(err);
  return { body: e.toEnvelope(), status: e.status };
};

const jsonObject = (raw: unknown): Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

// Same schema as web/src/data/report_problem.tool.json, now held in src/schemas.ts.

export const reportProblem = server.tool(
  {
    name: 'report_problem',
    description:
      'Call this when a Ledgerly API call fails and retrying does not help. Returns a case with committed ack_by and resolve_by times right away, then a verified answer, an executable outcome, or a bounded grant you may call yourself.',
    inputSchema: reportInputSchema,
    outputSchema: reportOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input, ctx) => {
    try {
      const reply = await desk.report(input, ctx.client.info().name ?? 'unknown');
      return { content: [{ type: 'text', text: summarize(reply) }], structuredContent: reply };
    } catch (err) {
      return errorResult(err);
    }
  },
);

export const reportRetryResult = server.tool(
  {
    name: 'report_retry_result',
    description:
      'Tell the desk whether the fix it gave you actually worked when you retried the failing call. A case is billable only when all three proofs passed and your retry succeeded, so this is what closes the loop. Replaying it returns the same receipt and bills nothing extra.',
    inputSchema: retryInputSchema,
    outputSchema: retryOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    try {
      const receipt = await desk.retry(input.case_id, input.ok, input.note);
      return { content: [{ type: 'text', text: summarizeRetry(receipt) }], structuredContent: receipt };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// Case API for the console (and curl). Live mode proxies the backend; fake mode reads
// the local store the fixtures were seeded into. Either way the edge holds no state.

server.get('/cases', async (c) => {
  try {
    const cases = await desk.listCases();
    return c.json(cases.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
  } catch (err) {
    const { body, status } = envelopeOf(err);
    return c.json(body, status);
  }
});

server.get('/cases/:id', async (c) => {
  try {
    return c.json(await desk.getCase(c.req.param('id')));
  } catch (err) {
    const { body, status } = envelopeOf(err);
    return c.json(body, status);
  }
});

server.get('/cases/:id/events', async (c) => {
  try {
    return c.json(await desk.listEvents(c.req.param('id')));
  } catch (err) {
    const { body, status } = envelopeOf(err);
    return c.json(body, status);
  }
});

/** The agent's retry result over plain HTTP, for agents without an MCP client. */
server.post('/cases/:id/retry', async (c) => {
  const body = jsonObject(await c.req.json().catch(() => ({})));
  const parsed = retryInputSchema.safeParse({ ...body, case_id: c.req.param('id') });
  if (!parsed.success) {
    const e = validationError(issueText(parsed.error));
    return c.json(e.toEnvelope(), e.status);
  }
  try {
    return c.json(await desk.retry(parsed.data.case_id, parsed.data.ok, parsed.data.note));
  } catch (err) {
    const { body: errBody, status } = envelopeOf(err);
    return c.json(errBody, status);
  }
});

/**
 * Server-sent events: `case` carries a whole ticket, `event` one tool_events row,
 * `error` an envelope when the backend went away mid-stream (the stream stays open
 * and keeps retrying, so the console recovers without a reconnect).
 */
server.get('/stream', (c) =>
  streamSSE(c, async (stream) => {
    const queue: StoreChange[] = [];
    const failures: DeskClientError[] = [];
    let wake: (() => void) | undefined;
    const nudge = () => {
      wake?.();
    };
    const stop = desk.watch(
      (change) => {
        queue.push(change);
        nudge();
      },
      (err) => {
        failures.push(err);
        nudge();
      },
    );
    stream.onAbort(stop);
    await stream.writeSSE({ event: 'ready', data: JSON.stringify({ mode: desk.mode }) });
    try {
      while (!stream.aborted) {
        if (!queue.length && !failures.length) {
          // heartbeat every 15s keeps proxies from closing an idle stream
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 15000);
          });
          wake = undefined;
          if (!queue.length && !failures.length) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
        }
        const failure = failures.shift();
        if (failure) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify(failure.toEnvelope()) });
          continue;
        }
        const change = queue.shift();
        if (!change) continue;
        await stream.writeSSE({ event: change.type, data: JSON.stringify(change.type === 'case' ? change.case : change.event) });
      }
    } finally {
      stop();
    }
  }),
);

/** Plain HTTP twin of the MCP tool, for curl and for agents without an MCP client. */
server.post('/report_problem', async (c) => {
  const parsed = reportInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const e = validationError(issueText(parsed.error));
    return c.json(e.toEnvelope(), e.status);
  }
  try {
    return c.json(await desk.report(parsed.data, c.req.header('user-agent')?.split(' ')[0] ?? 'http'));
  } catch (err) {
    const { body, status } = envelopeOf(err);
    return c.json(body, status);
  }
});

export default server;
