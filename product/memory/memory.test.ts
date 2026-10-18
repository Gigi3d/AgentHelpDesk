import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../store/memory.ts';
import { findMemoryDraft, listMemory, normalizePath, signatureOf } from './memory.ts';
import type { Failure } from '../shared/types.ts';

const mk = (id: string, url = 'https://api.ledgerly.test/v1/entries'): Failure => ({
  id, vendor_id: 'ledgerly', agent_id: 'a', task: 't', klass: 'knowledge', status: 'closed',
  request: { method: 'get', url }, response: { status: 401, error: { code: 'unauthorized', message: 'Invalid or missing credentials.' } },
  ack_by: '', resolve_by: '', queue_position: 0, created_at: new Date().toISOString(),
});

async function prove(repo: MemoryRepository, f: Failure, extra: Record<string, unknown> = {}) {
  await repo.createFailure(f);
  await repo.createAttempt({ id: `at-${f.id}`, failure_id: f.id, diff: '', proof_replay: true, proof_vendor_tests: true, proof_fresh_agent: true, log_url: '' });
  await repo.appendToolEvent({ id: `e-${f.id}`, ticket_id: f.id, stage: 'fix_drafted', tool: 'resolver', action: 'resolver.draft', t_ms: 0, d_ms: 0, result: 'ok', at: new Date().toISOString(),
    payload: { attempt: 1, path: 'docs/quickstart.md', content: 'fixed', original_sha256: 'abc', fix_steps: ['use bearer'], snippet: '', model: 'm', anthropic_request_id: null, usage: null, ...extra } });
}

test('signature ignores ids and numbers in the path', () => {
  assert.equal(normalizePath('https://x.test/v1/entries/123/lines/9f8e7d6c5b4a39281716'), '/v1/entries/:id/lines/:id');
  assert.equal(signatureOf(mk('c1', 'https://api.ledgerly.test/v1/entries')).key, signatureOf(mk('c2', 'https://api.ledgerly.test/v1/entries?x=1')).key);
  assert.notEqual(signatureOf(mk('c1')).key, signatureOf(mk('c3', 'https://api.ledgerly.test/v1/accounts')).key);
});

test('a proven fix is found for the same failure and document, and not for a different one', async () => {
  const repo = new MemoryRepository();
  await prove(repo, mk('c1'));
  const hit = await findMemoryDraft(repo, mk('c2'), 'docs/quickstart.md', 'abc');
  assert.equal(hit?.source_case, 'c1');
  assert.equal(await findMemoryDraft(repo, mk('c2'), 'docs/quickstart.md', 'different-original'), null);
  assert.equal(await findMemoryDraft(repo, mk('c2', 'https://api.ledgerly.test/v1/accounts'), 'docs/quickstart.md', 'abc'), null);
});

test('an unproven or reused draft never becomes memory, and reuse is counted', async () => {
  const repo = new MemoryRepository();
  await prove(repo, mk('c1'));
  await prove(repo, mk('c2'), { from_memory: 'c1' });
  const f = mk('c3');
  await repo.createFailure(f);
  await repo.createAttempt({ id: 'at-c3', failure_id: 'c3', diff: '', proof_replay: true, proof_vendor_tests: false, proof_fresh_agent: true, log_url: '' });
  await repo.appendToolEvent({ id: 'e-c3', ticket_id: 'c3', stage: 'fix_drafted', tool: 'resolver', action: 'resolver.draft', t_ms: 0, d_ms: 0, result: 'ok', at: new Date().toISOString(), payload: { path: 'docs/quickstart.md', content: 'x', original_sha256: 'abc' } });
  await repo.appendToolEvent({ id: 'h1', ticket_id: 'c2', stage: 'fix_drafted', tool: 'resolver', action: 'resolver.memory_hit', t_ms: 0, d_ms: 0, result: 'ok', at: new Date().toISOString(), payload: { source_case: 'c1' } });
  const list = await listMemory(repo);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.source_case, 'c1');
  assert.equal(list[0]?.reuse_count, 1);
});
