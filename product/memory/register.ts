// memory/register.ts: routes for fix memory.
//   GET  /v1/memory          every remembered fix: signature, source case, proofs, how often it was reused
//   POST /v1/memory/resume   wake the sandbox that proved a fix from standby, time it, and check the patched
//                            document is still there byte for byte. Never creates a sandbox, so a deleted or
//                            expired one is reported as gone instead of being quietly rebuilt.
import { sandboxName } from '../desk/loop.ts';
import { recordStage } from '../desk/obs.ts';
import type { HttpResult, Router } from '../shared/http.ts';
import { HttpError } from '../shared/http.ts';
import * as client from '../sandbox/client.ts';
import { fakeRunner } from '../sandbox/runner.ts';
import type { Repository } from '../store/repository.ts';
import { listMemory, memoryDraftOf, sha256Hex } from './memory.ts';

function bodyOf(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export function registerRoutes(router: Router, repo: Repository): void {
  router.add('GET', '/v1/memory', async (): Promise<HttpResult> => {
    const entries = await listMemory(repo);
    const real = !(process.env['AHD_SANDBOX_FAKE'] === '1' || !process.env['BLAXEL_API_KEY']);
    return {
      status: 200,
      body: {
        sandboxes: real ? 'blaxel' : 'simulated',
        total_reuses: entries.reduce((n, e) => n + e.reuse_count, 0),
        entries: entries.map((e) => ({ ...e, sandbox: sandboxName(e.source_case) })),
      },
    };
  });

  router.add('POST', '/v1/memory/resume', async (ctx): Promise<HttpResult> => {
    const caseId = String(bodyOf(ctx.body)['case_id'] ?? '');
    if (!caseId) throw new HttpError(400, 'bad_request', 'case_id is required', 'memory.resume');
    const draft = await memoryDraftOf(repo, caseId);
    if (!draft) throw new HttpError(404, 'not_found', 'no remembered fix for that case', 'memory.resume');
    const name = sandboxName(caseId);
    const expected = sha256Hex(draft.content);
    const real = !(process.env['AHD_SANDBOX_FAKE'] === '1' || !process.env['BLAXEL_API_KEY']);
    const t0 = Date.now();
    let found = false;
    let actual: string | null = null;
    let detail = '';
    try {
      if (real) {
        const sb = await client.blxGet(name); // get() wakes a standby sandbox with its files and processes
        found = true;
        actual = sha256Hex(await client.blxRead(sb, draft.path));
      } else {
        const h = await fakeRunner.createOrResume(name);
        found = true;
        actual = sha256Hex(await h.read(draft.path).catch(() => ''));
      }
    } catch (err) {
      detail = client.messageOf(err).slice(0, 300);
    }
    const resumedMs = Date.now() - t0;
    const preserved = found && actual === expected;
    await recordStage(repo, {
      ticketId: caseId,
      stage: 'memory',
      tool: 'sandbox',
      action: 'memory.resume',
      startedAtMs: t0,
      result: preserved ? 'ok' : 'error',
      payload: { sandbox: name, found, state_preserved: preserved, resumed_ms: resumedMs, path: draft.path, real },
    });
    return {
      status: 200,
      body: {
        case_id: caseId,
        sandbox: name,
        real,
        found,
        resumed_ms: resumedMs,
        state_preserved: preserved,
        path: draft.path,
        expected_sha256: expected,
        actual_sha256: actual,
        note: !found
          ? `The sandbox is gone (${detail || 'not found'}). The fix is still remembered by the desk; only the sandbox state expired.`
          : preserved
            ? 'Woke from standby and the patched document is byte-identical to the proven fix.'
            : 'Woke from standby but the document differs from the proven fix.',
      },
    };
  });
}
