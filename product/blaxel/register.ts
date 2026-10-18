// blaxel/register.ts: what the desk is doing in Blaxel, for the console's Blaxel page.
//   GET  /v1/blaxel/sandboxes   every ahd-* sandbox in the workspace, with its role and quota use
//   POST /v1/blaxel/delete      delete one case sandbox (never the desk's own)
//   GET  /v1/blaxel/activity    the last Blaxel calls the desk made and how long each took
// Everything on the list comes from Blaxel's API. Nothing is estimated, except the quota limit, which
// Blaxel shows only in its console: set AHD_BLAXEL_STANDBY_LIMIT to your tier (Tier 0 is 10, Tier 1 is 50).
import type { HttpResult, Router } from '../shared/http.ts';
import { HttpError } from '../shared/http.ts';
import * as client from '../sandbox/client.ts';
import type { Repository } from '../store/repository.ts';

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const isReal = (): boolean => !(process.env['AHD_SANDBOX_FAKE'] === '1' || !process.env['BLAXEL_API_KEY']);
const DESK = (): string => process.env['AHD_DEPLOY_NAME'] ?? 'ahd-desk';

export type SandboxRole = 'desk' | 'case' | 'fresh' | 'other';

export function roleOf(name: string): SandboxRole {
  if (name === DESK()) return 'desk';
  if (/^ahd-.+-fresh$/.test(name)) return 'fresh';
  if (name.startsWith('ahd-')) return 'case';
  return 'other';
}

interface SandboxRow {
  name: string;
  role: SandboxRole;
  case_id: string | null;
  status: string;
  created_at: string | null;
  memory_mb: number | null;
  region: string | null;
}

export async function listSandboxes(): Promise<SandboxRow[]> {
  const sdk = (await client.loadSdk()) as unknown as Record<string, unknown>;
  const si = rec(sdk['SandboxInstance']);
  let page: unknown;
  if (typeof si['list'] === 'function') {
    page = await (si['list'] as (q?: unknown) => Promise<unknown>).call(si, { limit: 100 });
  } else if (typeof sdk['listSandboxes'] === 'function') {
    // @blaxel/core 0.3.x has no SandboxInstance.list; the generated client function returns { data: [...] }.
    page = await (sdk['listSandboxes'] as (o?: unknown) => Promise<unknown>)({ throwOnError: true });
  } else {
    throw new Error('the installed @blaxel/core has neither SandboxInstance.list nor listSandboxes');
  }
  const rows: SandboxRow[] = [];
  const take = (item: unknown): void => {
    const o = rec(item);
    const meta = rec(o['metadata']);
    const spec = rec(o['spec']);
    const name = str(meta['name']) ?? str(o['name']);
    if (!name || !name.startsWith('ahd-')) return;
    const role = roleOf(name);
    rows.push({
      name,
      role,
      case_id: role === 'case' ? name.slice(4) : null,
      status: str(o['status']) ?? str(rec(o['status'])['status']) ?? 'unknown',
      created_at: str(meta['createdAt']) ?? null,
      memory_mb: typeof rec(spec['runtime'])['memory'] === 'number' ? (rec(spec['runtime'])['memory'] as number) : typeof spec['memory'] === 'number' ? (spec['memory'] as number) : null,
      region: str(spec['region']),
    });
  };
  const iter = (page as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[Symbol.asyncIterator];
  if (typeof iter === 'function') {
    for await (const item of page as AsyncIterable<unknown>) take(item);
  } else {
    const data = (page as { data?: unknown[] }).data ?? (Array.isArray(page) ? (page as unknown[]) : []);
    for (const item of data) take(item);
  }
  return rows.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

/** Delete one ahd-* case sandbox (never the desk's own) and record it. Throws HttpError. */
export async function deleteSandboxByName(repo: Repository, name: string, by: string): Promise<void> {
  if (!name.startsWith('ahd-')) throw new HttpError(400, 'bad_request', 'only ahd-* sandboxes can be deleted here', 'blaxel.delete');
  if (name === DESK()) throw new HttpError(400, 'bad_request', 'the desk sandbox cannot be deleted from the console', 'blaxel.delete');
  if (!isReal()) throw new HttpError(400, 'bad_request', 'no Blaxel key on this desk', 'blaxel.delete');
  const sdk = (await client.loadSdk()) as unknown as Record<string, unknown>;
  const del = rec(sdk['SandboxInstance'])['delete'];
  if (typeof del !== 'function') throw new HttpError(500, 'blaxel_delete_unavailable', 'SandboxInstance.delete is missing from the SDK', 'blaxel.delete');
  const t0 = Date.now();
  try {
    await (del as (n: string) => Promise<unknown>).call(rec(sdk['SandboxInstance']), name);
  } catch (err) {
    throw new HttpError(502, 'blaxel_delete_failed', client.messageOf(err).slice(0, 300), 'blaxel.delete');
  }
  await repo.appendToolEvent({
    id: `del-${name}-${t0}`, ticket_id: name.slice(4), stage: 'sandbox.destroy', tool: 'sandbox', action: 'destroy',
    t_ms: t0, d_ms: Date.now() - t0, result: 'ok', payload: { sandbox: name, by }, at: new Date().toISOString(),
  });
}

export function registerRoutes(router: Router, repo: Repository): void {
  router.add('GET', '/v1/blaxel/sandboxes', async (): Promise<HttpResult> => {
    const limit = Number(process.env['AHD_BLAXEL_STANDBY_LIMIT'] ?? 10);
    if (!isReal()) {
      return { status: 200, body: { real: false, limit, used: 0, sandboxes: [], note: 'No Blaxel key on this desk: sandboxes are simulated, so there is nothing to list.' } };
    }
    try {
      const sandboxes = await listSandboxes();
      return { status: 200, body: { real: true, limit, used: sandboxes.length, sandboxes } };
    } catch (err) {
      throw new HttpError(502, 'blaxel_list_failed', client.messageOf(err).slice(0, 300), 'blaxel.list');
    }
  });

  router.add('POST', '/v1/blaxel/delete', async (ctx): Promise<HttpResult> => {
    await deleteSandboxByName(repo, String(rec(ctx.body)['name'] ?? ''), 'console');
    return { status: 200, body: { deleted: String(rec(ctx.body)['name']) } };
  });

  router.add('GET', '/v1/blaxel/activity', async (): Promise<HttpResult> => {
    const events = await repo.toolEvents({ tool: 'sandbox' });
    const recent = events.slice(-60).reverse().map((e) => ({
      at: e.at,
      action: e.action,
      sandbox: String(rec(e.payload)['sandbox'] ?? ''),
      case_id: e.ticket_id,
      ms: e.d_ms,
      ok: e.result !== 'error',
      error: e.result === 'error' ? String(rec(e.payload)['error'] ?? '').slice(0, 160) : null,
    }));
    return { status: 200, body: { real: isReal(), activity: recent } };
  });
}
