// HTTP surface for the evals module.
//   POST /v1/evals/install  run one fresh-agent install eval, store it, return it
//   GET  /v1/evals/results  stored eval.install runs + the computed pick rate
//
// Both routes are stateless: everything is read from and written to the Repository
// as ToolEvents (tool 'Armature'). A failing eval is a 200 with `pass:false` — it is a
// measurement, not an error. Only invalid input (400) or a store failure (5xx) throws.

import { badRequest, num, ok, str } from '../shared/http.ts';
import type { Ctx, Handler, HttpResult, Router } from '../shared/http.ts';
import type { Repository } from '../store/repository.ts';
import type { ArmatureClient, ArmaturePickRateReply } from './armature-client.ts';
import { armatureClient } from './armature-client.ts';
import { DISCLAIMER } from './fixtures.ts';
import type { FreshAgentDoc } from './fixtures.ts';
import { VALIDATE_STAGE, readInstallRuns, runInstallEval } from './install-eval.ts';
import type { InstallEvalOptions, StoredInstallRun } from './install-eval.ts';
import { pickRate } from './pick-rate.ts';

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const PRODUCT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_DOCS = 20;
const MAX_DOC_BODY = 200_000;
const MAX_FORBIDDEN = 50;

export interface EvalDeps {
  /** Injected in tests so no route ever reaches the network. */
  client?: ArmatureClient;
  now?: () => number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function requireBodyObject(body: unknown): Record<string, unknown> | null {
  if (body === null || body === undefined) return null;
  const rec = asRecord(body);
  if (!rec) throw badRequest(VALIDATE_STAGE, 'body must be a JSON object or omitted');
  return rec;
}

/** Optional string: absent stays absent, present is validated by the shared helper. */
function optStr(body: unknown, field: string): string | undefined {
  const rec = asRecord(body);
  if (!rec || rec[field] === undefined || rec[field] === null) return undefined;
  return str(body, field, VALIDATE_STAGE);
}

function optNum(body: unknown, field: string): number | undefined {
  const rec = asRecord(body);
  if (!rec || rec[field] === undefined || rec[field] === null) return undefined;
  return num(body, field, VALIDATE_STAGE);
}

function checkedId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!ID_RE.test(value)) throw badRequest(VALIDATE_STAGE, `field "${field}" must match ${ID_RE.source}`);
  return value;
}

function parseDocs(body: unknown): FreshAgentDoc[] | undefined {
  const rec = asRecord(body);
  if (!rec || rec['docs'] === undefined || rec['docs'] === null) return undefined;
  const raw = rec['docs'];
  if (!Array.isArray(raw)) throw badRequest(VALIDATE_STAGE, 'field "docs" must be an array of {name,url,body}');
  if (raw.length === 0) throw badRequest(VALIDATE_STAGE, 'field "docs" must not be empty');
  if (raw.length > MAX_DOCS) throw badRequest(VALIDATE_STAGE, `field "docs" must contain at most ${MAX_DOCS} entries`);
  return raw.map((item, i) => {
    const doc = asRecord(item);
    if (!doc) throw badRequest(VALIDATE_STAGE, `docs[${i}] must be an object`);
    const name = doc['name'];
    const url = doc['url'];
    const docBody = doc['body'];
    if (typeof name !== 'string' || name.length === 0) throw badRequest(VALIDATE_STAGE, `docs[${i}].name must be a non-empty string`);
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw badRequest(VALIDATE_STAGE, `docs[${i}].url must be an http(s) URL`);
    if (typeof docBody !== 'string') throw badRequest(VALIDATE_STAGE, `docs[${i}].body must be a string`);
    if (docBody.length > MAX_DOC_BODY) throw badRequest(VALIDATE_STAGE, `docs[${i}].body must be at most ${MAX_DOC_BODY} characters`);
    return { name, url, body: docBody };
  });
}

function parseForbidden(body: unknown): string[] | undefined {
  const rec = asRecord(body);
  if (!rec || rec['forbidden'] === undefined || rec['forbidden'] === null) return undefined;
  const raw = rec['forbidden'];
  if (!Array.isArray(raw)) throw badRequest(VALIDATE_STAGE, 'field "forbidden" must be an array of strings');
  if (raw.length > MAX_FORBIDDEN) throw badRequest(VALIDATE_STAGE, `field "forbidden" must contain at most ${MAX_FORBIDDEN} entries`);
  return raw.map((item, i) => {
    if (typeof item !== 'string') throw badRequest(VALIDATE_STAGE, `forbidden[${i}] must be a string`);
    return item;
  });
}

function parseErrorBody(body: unknown): Record<string, unknown> | undefined {
  const rec = asRecord(body);
  if (!rec || rec['error_body'] === undefined || rec['error_body'] === null) return undefined;
  const errBody = asRecord(rec['error_body']);
  if (!errBody) throw badRequest(VALIDATE_STAGE, 'field "error_body" must be a JSON object');
  return errBody;
}

function parseRung(body: unknown): number | undefined {
  const rung = optNum(body, 'rung');
  if (rung === undefined) return undefined;
  if (!Number.isInteger(rung) || rung < 0 || rung > 4) throw badRequest(VALIDATE_STAGE, 'field "rung" must be an integer 0..4');
  return rung;
}

function parseProduct(body: unknown, fallback: string): string {
  const product = optStr(body, 'product') ?? fallback;
  if (!PRODUCT_RE.test(product)) throw badRequest(VALIDATE_STAGE, `field "product" must match ${PRODUCT_RE.source}`);
  return product;
}

/** Runs the eval, stores it as a ToolEvent, returns it with the recomputed pick rate. */
export function installHandler(repo: Repository, deps: EvalDeps = {}): Handler {
  return async (ctx: Ctx): Promise<HttpResult> => {
    requireBodyObject(ctx.body);
    const ticketId = checkedId(optStr(ctx.body, 'ticket_id'), 'ticket_id');
    const runId = checkedId(optStr(ctx.body, 'run_id'), 'run_id');
    const idempotencyKey = optStr(ctx.body, 'idempotency_key');
    if (idempotencyKey !== undefined && idempotencyKey.length > 200) {
      throw badRequest(VALIDATE_STAGE, 'field "idempotency_key" must be at most 200 characters');
    }
    const product = parseProduct(ctx.body, 'agenthelpdesk');

    const opts: InstallEvalOptions = { product };
    if (ticketId !== undefined) opts.ticket_id = ticketId;
    if (runId !== undefined) opts.run_id = runId;
    if (idempotencyKey !== undefined) opts.idempotency_key = idempotencyKey;
    const rung = parseRung(ctx.body);
    if (rung !== undefined) opts.rung = rung;
    const docs = parseDocs(ctx.body);
    if (docs !== undefined) opts.docs = docs;
    const errorBody = parseErrorBody(ctx.body);
    if (errorBody !== undefined) opts.error_body = errorBody;
    const forbidden = parseForbidden(ctx.body);
    if (forbidden !== undefined) opts.forbidden = forbidden;
    if (deps.client) opts.client = deps.client;
    if (deps.now) opts.now = deps.now;

    const run = await runInstallEval(repo, opts);
    const pickOpts: { ticket_id?: string; now?: () => number } = { ticket_id: run.ticket_id };
    if (deps.now) pickOpts.now = deps.now;
    const pick = await pickRate(repo, pickOpts);

    return ok({
      // 200 even when pass is false: a failed eval is the measurement we came for.
      run,
      pick,
      simulated: run.simulated,
      disclaimer: DISCLAIMER,
      request_id: ctx.requestId,
    });
  };
}

/** Stored eval.install runs (newest first) plus the pick rate computed from them. */
export function resultsHandler(repo: Repository, deps: EvalDeps = {}): Handler {
  return async (ctx: Ctx): Promise<HttpResult> => {
    const ticketId = ctx.query.get('ticket_id');
    if (ticketId !== null && !ID_RE.test(ticketId)) throw badRequest(VALIDATE_STAGE, `query "ticket_id" must match ${ID_RE.source}`);

    const rawLimit = ctx.query.get('limit');
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw badRequest(VALIDATE_STAGE, `query "limit" must be an integer 1..${MAX_LIMIT}`);
      }
      limit = parsed;
    }

    const productParam = ctx.query.get('product');
    const product = productParam ?? 'agenthelpdesk';
    if (!PRODUCT_RE.test(product)) throw badRequest(VALIDATE_STAGE, `query "product" must match ${PRODUCT_RE.source}`);

    const record = ctx.query.get('record') !== '0';

    const read = await readInstallRuns(repo, ticketId ? { ticket_id: ticketId } : {});
    const pickOpts: { ticket_id?: string; record?: boolean; now?: () => number } = { record };
    if (ticketId) pickOpts.ticket_id = ticketId;
    if (deps.now) pickOpts.now = deps.now;
    const pick = await pickRate(repo, pickOpts);

    const client = deps.client ?? armatureClient();
    let armaturePick: ArmaturePickRateReply;
    try {
      armaturePick = await client.readPickRate(product);
    } catch (err) {
      // Surfaced in the body, never swallowed: a sponsor outage must not blank the console.
      armaturePick = {
        mode: 'armature',
        available: false,
        pick_rate: null,
        sample: null,
        source: product,
        error: `armature pick-rate call failed: ${(err as Error).message}`,
        faked: false,
      };
    }

    const runs: StoredInstallRun[] = [...read.runs]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, limit);

    return ok({
      generated_at: new Date().toISOString(),
      count: read.runs.length,
      returned: runs.length,
      skipped_malformed: read.skipped_malformed,
      runs,
      pick,
      armature_pick: armaturePick,
      simulated: pick.simulated_runs === pick.runs && pick.runs > 0,
      disclaimer: DISCLAIMER,
      request_id: ctx.requestId,
    });
  };
}

export function registerRoutes(router: Router, repo: Repository): void {
  router.add('POST', '/v1/evals/install', installHandler(repo));
  router.add('GET', '/v1/evals/results', resultsHandler(repo));
}
