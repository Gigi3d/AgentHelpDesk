import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../store/memory.ts';
import { makeClaudeResolver } from './resolver-claude.ts';
import type { Failure, Vendor } from '../shared/types.ts';
import type { DraftContext } from './resolve.ts';

const answer = '<fix_steps>\n- Send Authorization: Bearer\n</fix_steps>\n<snippet>\ncurl -H "Authorization: Bearer $K" https://x\n</snippet>\n<file>\n# Quickstart\nUse Authorization: Bearer.\n</file>';

const failure = (id: string): Failure => ({
  id, vendor_id: 'ledgerly', agent_id: 'a', task: 'List my ledger entries', klass: 'knowledge', status: 'reproducing',
  request: { method: 'GET', url: 'https://api.ledgerly.test/v1/entries', headers: {} },
  response: { status: 401, error: { code: 'unauthorized', message: 'Invalid or missing credentials.' } },
  ack_by: '', resolve_by: '', queue_position: 0, created_at: new Date().toISOString(),
});

test('the second agent with the same failure is answered from memory, with no model call', async () => {
  const repo = new MemoryRepository();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: answer }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'request-id': 'req_x' } });
  }) as typeof fetch;
  const resolve = makeClaudeResolver({ apiKey: 'k', fetchImpl, contextFiles: [] });
  const sandbox = { name: 's', read: async () => '# Quickstart\nSend x-api-key.\n', write: async () => {}, exec: async () => ({ stdout: '', stderr: '', exit_code: 0 }), snapshot: async () => 'x' };
  const mk = (f: Failure): DraftContext => ({ sandbox: sandbox as never, vendor: { id: 'ledgerly' } as Vendor, repo });

  const first = failure('c1');
  await repo.createFailure(first);
  await resolve(first, 1, mk(first));
  assert.equal(calls, 1);
  // The first case passes all three proofs, which is what makes its fix memory.
  await repo.createAttempt({ id: 'a1', failure_id: 'c1', diff: '', proof_replay: true, proof_vendor_tests: true, proof_fresh_agent: true, log_url: '' });

  const second = failure('c2');
  await repo.createFailure(second);
  const fix = await resolve(second, 1, mk(second));
  assert.equal(calls, 1, 'no second model call');
  assert.match(fix.diff, /Authorization: Bearer/);
  const hits = await repo.toolEvents({ ticket_id: 'c2', action: 'resolver.memory_hit' });
  assert.equal(hits.length, 1);
  assert.equal((hits[0]?.payload as { source_case: string }).source_case, 'c1');
});

test('an unproven first case is not memory, so the second case asks the model again', async () => {
  const repo = new MemoryRepository();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: answer }] }), { status: 200 });
  }) as typeof fetch;
  const resolve = makeClaudeResolver({ apiKey: 'k', fetchImpl, contextFiles: [] });
  const sandbox = { name: 's', read: async () => '# Quickstart\nSend x-api-key.\n' };
  const ctx = (): DraftContext => ({ sandbox: sandbox as never, vendor: { id: 'ledgerly' } as Vendor, repo });
  const a = failure('c1'); await repo.createFailure(a); await resolve(a, 1, ctx());
  await repo.createAttempt({ id: 'a1', failure_id: 'c1', diff: '', proof_replay: true, proof_vendor_tests: false, proof_fresh_agent: true, log_url: '' });
  const b = failure('c2'); await repo.createFailure(b); await resolve(b, 1, ctx());
  assert.equal(calls, 2);
});
