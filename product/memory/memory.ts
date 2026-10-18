// memory.ts: the desk remembers every fix it has proven.
//
// A proven fix is filed under the failure's SIGNATURE: the vendor, the call that failed (method and path
// with ids removed) and the error it got. When another agent fails the same way, the resolver reuses the
// stored draft instead of asking the model again. The three proofs still run for the new case, so a
// remembered fix is never trusted, only reused: the document it changes must also be byte-identical to
// the one it was drafted against.
//
// Nothing here is a new table. It reads the tool events the loop already records (resolver.draft) and the
// stored attempt, so memory survives restarts exactly as cases do.
import { createHash } from 'node:crypto';
import type { Failure, ToolEvent } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import type { StoredDraft } from '../desk/resolver-claude.ts';

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The call's path with ids, numbers and hashes replaced, so /v1/entries/123 and /v1/entries/456 match. */
export function normalizePath(url: unknown): string {
  if (typeof url !== 'string') return '';
  let path = url;
  try { path = new URL(url).pathname; } catch { path = url.split('?')[0] ?? url; }
  return path
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')
    .replace(/\/[0-9]+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/g, '/:id');
}

export interface Signature {
  key: string;
  vendor: string;
  method: string;
  path: string;
  status: number | null;
  error: string;
}

export function signatureOf(f: Failure): Signature {
  const req = rec(f.request);
  const res = rec(f.response);
  const err = rec(res['error']);
  const method = String(req['method'] ?? 'GET').toUpperCase();
  const path = normalizePath(req['url'] ?? req['path']);
  const status = typeof res['status'] === 'number' ? res['status'] : null;
  const error = String(err['code'] ?? err['message'] ?? res['error'] ?? '').toLowerCase().replace(/[0-9]+/g, '#').slice(0, 60);
  const key = sha(`${f.vendor_id}|${method}|${path}|${status ?? ''}|${error}`).slice(0, 16);
  return { key, vendor: f.vendor_id, method, path, status, error };
}

export type RememberedDraft = StoredDraft & { from_memory?: string };

interface Source {
  case_id: string;
  draft: RememberedDraft;
  at: string;
  signature: Signature;
  proofs: { replay: boolean; vendor_tests: boolean; fresh_agent: boolean };
}

/** Every case whose own draft passed all three proofs. Drafts that were themselves reused are skipped:
 * the memory points at the case that actually earned the fix. */
async function provenSources(repo: Repository): Promise<Source[]> {
  const events: ToolEvent[] = await repo.toolEvents({ action: 'resolver.draft' });
  const byCase = new Map<string, ToolEvent>();
  for (const e of events) {
    const p = rec(e.payload);
    if (p['from_memory'] || typeof p['content'] !== 'string') continue;
    byCase.set(e.ticket_id, e);
  }
  const out: Source[] = [];
  for (const [caseId, e] of byCase) {
    const failure = await repo.getFailure(caseId);
    if (!failure) continue;
    const attempt = await repo.latestAttempt(caseId);
    if (!attempt || !attempt.proof_replay || !attempt.proof_vendor_tests || !attempt.proof_fresh_agent) continue;
    out.push({
      case_id: caseId,
      draft: e.payload as RememberedDraft,
      at: e.at,
      signature: signatureOf(failure),
      proofs: { replay: attempt.proof_replay, vendor_tests: attempt.proof_vendor_tests, fresh_agent: attempt.proof_fresh_agent },
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** A proven draft for the same failure signature that changes the same document, drafted against the same text. */
export async function findMemoryDraft(
  repo: Repository,
  f: Failure,
  targetPath: string,
  originalSha256: string,
): Promise<{ draft: RememberedDraft; source_case: string; signature: Signature } | null> {
  const want = signatureOf(f);
  for (const s of await provenSources(repo)) {
    if (s.case_id === f.id) continue;
    if (s.signature.key !== want.key) continue;
    if (s.draft.path !== targetPath || s.draft.original_sha256 !== originalSha256) continue;
    return { draft: s.draft, source_case: s.case_id, signature: want };
  }
  return null;
}

export interface MemoryEntry {
  signature: Signature;
  source_case: string;
  path: string;
  model: string;
  remembered_at: string;
  reuse_count: number;
  reused_by: string[];
  proofs: { replay: boolean; vendor_tests: boolean; fresh_agent: boolean };
  fix_steps: string[];
  content_sha256: string;
}

export async function listMemory(repo: Repository): Promise<MemoryEntry[]> {
  const hits = await repo.toolEvents({ action: 'resolver.memory_hit' });
  const usedBy = new Map<string, string[]>();
  for (const h of hits) {
    const src = String(rec(h.payload)['source_case'] ?? '');
    if (src) usedBy.set(src, [...(usedBy.get(src) ?? []), h.ticket_id]);
  }
  const seen = new Set<string>();
  const out: MemoryEntry[] = [];
  for (const s of await provenSources(repo)) {
    // One entry per signature and document: the newest proven draft stands for it.
    const k = `${s.signature.key}|${s.draft.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const reusers = usedBy.get(s.case_id) ?? [];
    out.push({
      signature: s.signature,
      source_case: s.case_id,
      path: s.draft.path,
      model: s.draft.model,
      remembered_at: s.at,
      reuse_count: reusers.length,
      reused_by: reusers,
      proofs: s.proofs,
      fix_steps: s.draft.fix_steps ?? [],
      content_sha256: sha(s.draft.content),
    });
  }
  return out;
}

export async function memoryDraftOf(repo: Repository, caseId: string): Promise<RememberedDraft | null> {
  const events = await repo.toolEvents({ ticket_id: caseId, action: 'resolver.draft' });
  const last = events.filter((e) => typeof rec(e.payload)['content'] === 'string').at(-1);
  return last ? (last.payload as RememberedDraft) : null;
}

export { sha as sha256Hex };
