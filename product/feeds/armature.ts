// feeds/armature.ts: Armature's view of what people and agents do at a client's MCP server,
// turned into AgentHelpDesk cases.
//
// What Armature documents (https://docs.armature.tech):
//   * An SDK wraps a client's MCP server and records sessions: the user's intent, the agent's
//     reasoning and every tool call, with outcome ok or the error (tool_call: user_intent,
//     agent_thinking, user_frustration, input and result previews).
//   * Armature is itself an MCP server (US https://mcp.armature.tech/mcp), read-only analytics:
//     list_issues { range, status: open|archived, server }, get_issue { issueId },
//     get_session { sessionId }, list_sessions, list_use_cases, request_capability. Auth: a workspace
//     API key as a bearer token (Settings, API keys).
// What it does not document: the output schemas of those tools. So every mapping below looks for
// several plausible field names and keeps the raw issue on the case. Treat the first real pull as
// the moment to confirm the field names.
import { HttpError } from '../shared/http.ts';
import type { ProblemReport } from '../shared/types.ts';

export interface ArmatureIssue {
  id: string;
  title: string;
  summary: string;
  cause: string;
  sessions: number;
  example_session_ids: string[];
}

export interface ArmatureSession {
  intent: string;
  frustration: string;
  failing_tool: string;
  failing_input: unknown;
  failing_result: unknown;
}

export interface ArmatureSource {
  readonly simulated: boolean;
  listIssues(limit: number): Promise<ArmatureIssue[]>;
  getSession(id: string): Promise<ArmatureSession | null>;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (...vs: unknown[]): string => {
  for (const v of vs) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return '';
};
const num = (...vs: unknown[]): number => {
  for (const v of vs) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
};

/** The first array found at a known key (or the value itself, if it is an array). */
function listOf(v: unknown, keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  const r = rec(v);
  for (const k of keys) if (Array.isArray(r[k])) return r[k] as unknown[];
  for (const x of Object.values(r)) if (Array.isArray(x)) return x;
  return [];
}

export function normalizeIssues(raw: unknown): ArmatureIssue[] {
  return listOf(raw, ['issues', 'items', 'data', 'results']).map((x, i) => {
    const r = rec(x);
    const ex = listOf(r['exampleSessions'] ?? r['example_sessions'] ?? r['sessions'] ?? r['examples'], []);
    return {
      id: str(r['id'], r['issueId'], r['issue_id']) || `issue-${i}`,
      title: str(r['title'], r['name'], r['summary']) || 'Untitled issue',
      summary: str(r['summary'], r['oneLine'], r['description'], r['rootCause'], r['root_cause']),
      cause: str(r['cause'], r['causeCategory'], r['cause_category'], r['category']) || 'unknown',
      sessions: num(r['affectedSessions'], r['affected_sessions'], r['sessionCount'], r['sessions'] as number),
      example_session_ids: ex.map((e) => (typeof e === 'string' ? e : str(rec(e)['id'], rec(e)['sessionId'], rec(e)['session_id']))).filter(Boolean),
    };
  });
}

export function normalizeSession(raw: unknown): ArmatureSession {
  const r = rec(raw);
  const calls = listOf(r['calls'] ?? r['toolCalls'] ?? r['tool_calls'] ?? r['events'], []);
  const failed = [...calls].reverse().find((c) => {
    const o = rec(c);
    const outcome = str(o['outcome'], o['status']).toLowerCase();
    return outcome !== '' && outcome !== 'ok' && outcome !== 'success';
  });
  const f = rec(failed);
  return {
    intent: str(r['intent'], r['userIntent'], r['user_intent'], r['ask']),
    frustration: str(r['frustration'], r['userFrustration'], r['user_frustration']) || 'unknown',
    failing_tool: str(f['tool'], f['toolName'], f['name']),
    failing_input: f['input'] ?? f['inputPreview'] ?? f['input_preview'] ?? null,
    failing_result: f['result'] ?? f['resultPreview'] ?? f['result_preview'] ?? f['error'] ?? null,
  };
}

/** Minimal MCP streamable-HTTP client: initialize, then tools/call. Reads JSON or SSE replies. */
export class RealArmature implements ArmatureSource {
  readonly simulated = false;
  private session: string | null = null;
  private seq = 0;
  private readonly key: string;
  private readonly url: string;
  constructor(key: string, url = 'https://mcp.armature.tech/mcp') {
    this.key = key;
    this.url = url;
  }

  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const id = notify ? undefined : ++this.seq;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
      signal: AbortSignal.timeout(15000),
    }).catch((err: unknown) => {
      throw new HttpError(502, 'upstream_unreachable', `Armature MCP failed: ${err instanceof Error ? err.message : String(err)}`, 'feeds.armature');
    });
    if (!res.ok) throw new HttpError(502, 'upstream_error', `Armature MCP ${method} returned ${res.status}`, 'feeds.armature');
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (notify) return null;
    const text = await res.text();
    const ctype = res.headers.get('content-type') ?? '';
    let msg: unknown = null;
    if (ctype.includes('text/event-stream')) {
      for (const line of text.split('\n')) if (line.startsWith('data:')) { try { msg = JSON.parse(line.slice(5).trim()); } catch { /* keep scanning */ } }
    } else {
      try { msg = JSON.parse(text); } catch { msg = null; }
    }
    const m = rec(msg);
    if (m['error']) throw new HttpError(502, 'upstream_error', `Armature MCP ${method}: ${str(rec(m['error'])['message'])}`, 'feeds.armature');
    return m['result'];
  }

  private async ready(): Promise<void> {
    if (this.session !== null) return;
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agenthelpdesk', version: '1' } });
    await this.rpc('notifications/initialized', {}, true);
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ready();
    const result = rec(await this.rpc('tools/call', { name, arguments: args }));
    if (result['structuredContent'] !== undefined) return result['structuredContent'];
    const first = rec(listOf(result['content'], [])[0]);
    const text = str(first['text']);
    try { return JSON.parse(text); } catch { return text; }
  }

  async listIssues(limit: number): Promise<ArmatureIssue[]> {
    return normalizeIssues(await this.tool('list_issues', { status: 'open' })).slice(0, limit);
  }

  async getSession(id: string): Promise<ArmatureSession | null> {
    const raw = await this.tool('get_session', { sessionId: id });
    return typeof raw === 'string' ? null : normalizeSession(raw);
  }
}

/** Offline stand-in with the shape of what a pull yields. Marked simulated on every case it creates. */
export class FakeArmature implements ArmatureSource {
  readonly simulated = true;
  async listIssues(limit: number): Promise<ArmatureIssue[]> {
    return [
      { id: 'sim-1', title: 'Agents send x-api-key and get 401', summary: 'Agents follow the quickstart header and every call returns 401 although the key is valid.', cause: 'auth', sessions: 14, example_session_ids: ['sim-s1'] },
      { id: 'sim-2', title: 'List entries called with a page size over the cap', summary: 'limit=500 returns 422 with no hint of the maximum.', cause: 'error message', sessions: 6, example_session_ids: [] },
      { id: 'sim-3', title: 'Paid report called without an X-PAYMENT header', summary: 'Agents call GET /v1/premium/report as the quickstart shows and get 402 with no hint of the header format.', cause: 'docs', sessions: 11, example_session_ids: [] },
      { id: 'sim-4', title: 'x402 payment rejected as quote expired', summary: 'Agents reuse a quote from an earlier call and the paid endpoint answers 402 quote_expired.', cause: 'docs', sessions: 4, example_session_ids: [] },
    ].slice(0, limit);
  }
  async getSession(id: string): Promise<ArmatureSession | null> {
    if (id !== 'sim-s1') return null;
    return { intent: 'List my ledger entries', frustration: 'medium', failing_tool: 'ledgerly_get', failing_input: { method: 'GET', url: 'https://api.ledgerly.test/v1/entries', headers: { 'x-api-key': 'redacted' } }, failing_result: { status: 401, error: { code: 'unauthorized' } } };
  }
}

export function createArmature(env: Record<string, string | undefined> = process.env): ArmatureSource {
  const key = (env['ARMATURE_KEY'] ?? '').trim();
  if (key === '' || env['AHD_ARMATURE_FAKE'] === '1') return new FakeArmature();
  return new RealArmature(key, (env['ARMATURE_MCP_URL'] ?? 'https://mcp.armature.tech/mcp').trim());
}

/** An Armature issue plus, when there is one, a session that hit it, as a case report. */
export function reportFromIssue(issue: ArmatureIssue, session: ArmatureSession | null, simulated: boolean, vendor: string | undefined): ProblemReport {
  const ref = `armature:issue:${issue.id}`;
  return {
    agent_id: `armature:${issue.cause}`,
    task: (session?.intent || issue.title).slice(0, 3900),
    request: session?.failing_input ?? { note: 'Armature did not return the failing call', tool: session?.failing_tool ?? null },
    response: session?.failing_result ?? { issue: issue.title, summary: issue.summary },
    channel: 'webhook',
    vendor_hint: vendor,
    idempotency_key: ref,
    channel_ref: ref,
    ...(simulated ? {} : {}),
  };
}
