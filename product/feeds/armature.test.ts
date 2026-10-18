import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../store/memory.ts';
import { FakeArmature, normalizeIssues, normalizeSession, reportFromIssue, RealArmature } from './armature.ts';
import { registerRoutes } from './register.ts';
import type { Handler } from '../shared/http.ts';

test('issues are matched loosely across field spellings', () => {
  const a = normalizeIssues({ issues: [{ issueId: 'i1', title: 'T', causeCategory: 'auth', affectedSessions: 4, exampleSessions: [{ id: 's1' }] }] });
  assert.deepEqual(a[0], { id: 'i1', title: 'T', summary: '', cause: 'auth', sessions: 4, example_session_ids: ['s1'] });
  assert.equal(normalizeIssues([{ id: 'x', title: 'y' }])[0]!.id, 'x');
  assert.deepEqual(normalizeIssues('nonsense'), []);
});

test('a session yields the last failing call', () => {
  const s = normalizeSession({ userIntent: 'do it', calls: [{ tool: 'a', outcome: 'ok' }, { tool: 'b', outcome: 'error: 401', input: { x: 1 }, result: { status: 401 } }] });
  assert.equal(s.intent, 'do it');
  assert.equal(s.failing_tool, 'b');
  assert.deepEqual(s.failing_input, { x: 1 });
});

test('the real client speaks MCP streamable HTTP with a bearer key', async () => {
  const seen: { method: string; auth: string | null; session: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body));
    seen.push({ method: body.method, auth: h.authorization ?? null, session: h['mcp-session-id'] ?? null });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { content: [{ type: 'text', text: JSON.stringify({ issues: [{ id: 'i9', title: 'Boom' }] }) }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' } });
  }) as typeof fetch;
  try {
    const issues = await new RealArmature('key-1').listIssues(5);
    assert.equal(issues[0]!.id, 'i9');
    assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/call']);
    assert.ok(seen.every((s) => s.auth === 'Bearer key-1'));
    assert.equal(seen[2]!.session, 'sess-1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('pull opens one case per issue, labelled simulated, and starts the loop; a repeat opens none', async () => {
  const repo = new MemoryRepository();
  const routes = new Map<string, Handler>();
  const started: string[] = [];
  registerRoutes({ add: (m, p, h) => void routes.set(`${m} ${p}`, h) }, repo, { start: async (id) => void started.push(id), source: new FakeArmature(), env: {} });
  const ctx = (body: unknown) => ({ method: 'POST', path: '', query: new URLSearchParams(), body, headers: {}, requestId: 'r', caller: null });
  const r1 = await routes.get('POST /v1/feeds/armature/pull')!(ctx({ limit: 2 }));
  assert.equal((r1.body as { count: number }).count, 2);
  assert.equal(started.length, 2);
  const f = await repo.getFailure((r1.body as { cases: { case_id: string }[] }).cases[0]!.case_id);
  assert.equal(f?.task, 'List my ledger entries');
  assert.equal(f?.channel_ref, 'armature:issue:sim-1');
  const r2 = await routes.get('POST /v1/feeds/armature/pull')!(ctx({ limit: 2 }));
  assert.equal((await repo.listFailures()).length, 2);
  assert.equal((r2.body as { count: number }).count, 2);
  assert.equal(reportFromIssue({ id: 'q', title: 'x', summary: '', cause: 'c', sessions: 0, example_session_ids: [] }, null, true, undefined).idempotency_key, 'armature:issue:q');
});
