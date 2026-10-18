// The ONE file that talks to Armature. Nothing else in product/ may reference
// the sponsor directly, so a swapped or removed integration touches one module.
//
// Sponsor facts this file relies on (nothing beyond these is assumed):
//   * "Armature ... Tests whether coding agents pick a product; MCP analytics,
//     evals, agent.reviews" — AgentHelpDesk Research Dossier.md, competitor table.
//     Site: https://armature.tech ; YC: https://ycombinator.com/companies/armature
//   * "Armature | Optional channel and benchmark: its analytics can raise the
//     failure, and its evals can check the fix | Nothing in the weekend build
//     breaks" — AgentHelpDesk Build Plan.md, sponsor table. Strength: "Partner
//     conversation, not a dependency".
//   * "Armature | Tests whether agents pick and install the desk unprompted |
//     Result of a fresh-agent install eval on the install page | Pass or fail,
//     steps taken, time to first ticket | 'A fresh agent installs it from the
//     docs alone'" — AgentHelpDesk Frontend and Product Surface Plan.md, sponsor
//     visuals table.
//
// HONESTY / NO INVENTED SDK:
//   There is no Armature SDK installed in this repo and no Armature API reference
//   in the docs package, so no SDK method is invented here. `HttpArmature` speaks
//   plain JSON over HTTPS to a base URL from env, and the two paths it uses
//   (`POST {base}/v1/evals/runs`, `GET {base}/v1/products/{product}/pick-rate`)
//   are UNCONFIRMED PLACEHOLDERS: they are shaped from the sponsor facts above and
//   must be replaced with the real endpoints once Armature shares a doc page at the
//   event. That is why the real client is opt-in (ARMATURE_KEY + ARMATURE_BASE_URL)
//   and why every result it cannot obtain comes back as `null`, never as a guess.
//   Offline, or without a key, `FakeArmature` answers and labels itself faked.
//
// The numbers the desk reports are computed from our own ToolEvents (see
// ./pick-rate.ts). Armature is a cross-check, never the source of a number.

/** Which implementation answered. Surfaced on every receipt and every event. */
export type ArmatureMode = 'armature' | 'fake';

/** One eval run handed to Armature. Field names mirror what the sponsor table asks to show. */
export interface ArmatureEvalRunInput {
  /** Product being measured, e.g. "agenthelpdesk". */
  product: string;
  run_id: string;
  kind: 'install' | 'pick';
  /** null for aggregate submissions where a single pass/fail makes no sense. */
  pass: boolean | null;
  steps: number;
  time_ms: number;
  /** Always true today: the fresh agent is simulated. See ./install-eval.ts. */
  simulated: boolean;
  /** Extra context; must contain no secrets and no other customer's data. */
  payload: Record<string, unknown>;
}

export interface ArmatureReceipt {
  mode: ArmatureMode;
  /** false whenever nothing actually reached Armature. Never faked to true. */
  submitted: boolean;
  run_ref: string | null;
  status: number | null;
  /** Transport/HTTP failure text, or why the Fake answered. Safe to display. */
  error: string | null;
  faked: boolean;
}

export interface ArmaturePickRateReply {
  mode: ArmatureMode;
  available: boolean;
  /** null when Armature has no answer. We never substitute a computed or invented rate here. */
  pick_rate: number | null;
  sample: number | null;
  source: string;
  error: string | null;
  faked: boolean;
}

export interface ArmatureClient {
  submitEvalRun(input: ArmatureEvalRunInput): Promise<ArmatureReceipt>;
  readPickRate(product: string): Promise<ArmaturePickRateReply>;
}

/** Structural slice of the Node 22 undici Response we use. Keeps tests injectable. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<HttpResponseLike>;

const defaultFetch: FetchFn = (url, init) => globalThis.fetch(url, init);

export const DEFAULT_ARMATURE_TIMEOUT_MS = 8_000;
const MAX_ARMATURE_TIMEOUT_MS = 30_000;
const MAX_ERROR_TEXT = 240;
const MAX_RESPONSE_BYTES = 256_000;

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_ARMATURE_TIMEOUT_MS;
  return Math.min(Math.round(ms), MAX_ARMATURE_TIMEOUT_MS);
}

/** Truncate sponsor error text so a huge body cannot bloat a ToolEvent row. */
function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_ERROR_TEXT ? `${oneLine.slice(0, MAX_ERROR_TEXT)}…` : oneLine;
}

export interface FakeArmatureConfig {
  /** Why the Fake was chosen; recorded on every receipt so nothing looks real. */
  reason?: string;
}

/**
 * Offline implementation. Performs no I/O and reports no numbers: a Fake that
 * invented a pick rate would poison the one metric this module exists to measure.
 */
export class FakeArmature implements ArmatureClient {
  private readonly reason: string;

  constructor(cfg: FakeArmatureConfig = {}) {
    this.reason = cfg.reason ?? 'AHD_EVALS_FAKE=1';
  }

  async submitEvalRun(input: ArmatureEvalRunInput): Promise<ArmatureReceipt> {
    return {
      mode: 'fake',
      submitted: false,
      run_ref: null,
      status: null,
      error: `fake armature client (${this.reason}); run ${input.run_id} not sent anywhere`,
      faked: true,
    };
  }

  async readPickRate(product: string): Promise<ArmaturePickRateReply> {
    return {
      mode: 'fake',
      available: false,
      pick_rate: null,
      sample: null,
      source: `fake:${product}`,
      error: `fake armature client (${this.reason}); no external pick rate is available offline`,
      faked: true,
    };
  }
}

export interface HttpArmatureConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: FetchFn;
}

/**
 * Real integration: plain HTTPS JSON, one timeout, one response-size cap, and no
 * retry loop. Endpoints are the UNCONFIRMED placeholders documented at the top of
 * this file. The API key is read from env by `armatureClient()`, is sent only as a
 * bearer header, and is never written into a receipt, an event payload or a message.
 */
export class HttpArmature implements ArmatureClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchFn;
  /** Last transport failure. Never contains the API key or any request header. */
  private lastError = 'armature call failed';

  constructor(cfg: HttpArmatureConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.timeoutMs = clampTimeout(cfg.timeoutMs ?? DEFAULT_ARMATURE_TIMEOUT_MS);
    this.fetchImpl = cfg.fetchImpl ?? defaultFetch;
  }

  async submitEvalRun(input: ArmatureEvalRunInput): Promise<ArmatureReceipt> {
    const body = JSON.stringify({
      product: input.product,
      run_id: input.run_id,
      kind: input.kind,
      pass: input.pass,
      steps: input.steps,
      time_ms: input.time_ms,
      simulated: input.simulated,
      payload: input.payload,
    });
    const res = await this.call('POST', '/v1/evals/runs', body);
    if (res === null) {
      return { mode: 'armature', submitted: false, run_ref: null, status: null, error: this.lastError, faked: false };
    }
    const text = await this.readText(res);
    if (!res.ok) {
      return {
        mode: 'armature',
        submitted: false,
        run_ref: null,
        status: res.status,
        error: clip(`armature rejected the run: ${text}`),
        faked: false,
      };
    }
    return {
      mode: 'armature',
      submitted: true,
      run_ref: pickRunRef(text),
      status: res.status,
      error: null,
      faked: false,
    };
  }

  async readPickRate(product: string): Promise<ArmaturePickRateReply> {
    const path = `/v1/products/${encodeURIComponent(product)}/pick-rate`;
    const res = await this.call('GET', path, undefined);
    if (res === null) {
      return {
        mode: 'armature',
        available: false,
        pick_rate: null,
        sample: null,
        source: path,
        error: this.lastError,
        faked: false,
      };
    }
    const text = await this.readText(res);
    if (!res.ok) {
      return {
        mode: 'armature',
        available: false,
        pick_rate: null,
        sample: null,
        source: path,
        error: clip(`armature pick-rate unavailable: ${text}`),
        faked: false,
      };
    }
    return {
      mode: 'armature',
      available: true,
      pick_rate: pickFinite(text, ['pick_rate', 'rate']),
      sample: pickFinite(text, ['sample', 'runs', 'n']),
      source: path,
      error: null,
      faked: false,
    };
  }

  private async call(method: 'GET' | 'POST', path: string, body: string | undefined): Promise<HttpResponseLike | null> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal } = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) init.body = body;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (err) {
      // Loud, but not fatal: Armature is an optional benchmark, so a sponsor outage
      // must never fail an eval run. The reason is carried on the receipt.
      this.lastError = clip(`armature ${method} ${path} failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async readText(res: HttpResponseLike): Promise<string> {
    try {
      const text = await res.text();
      return text.length > MAX_RESPONSE_BYTES ? `${text.slice(0, MAX_RESPONSE_BYTES)}…` : text;
    } catch (err) {
      this.lastError = clip(`armature response body unreadable: ${(err as Error).message}`);
      return '';
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: callers fall back to null rather than inventing a value.
    return null;
  }
}

function pickRunRef(text: string): string | null {
  const v = parseJson(text);
  if (typeof v !== 'object' || v === null) return null;
  const rec = v as Record<string, unknown>;
  for (const key of ['run_ref', 'id', 'run_id']) {
    const cand = rec[key];
    if (typeof cand === 'string' && cand.length > 0) return cand;
  }
  return null;
}

function pickFinite(text: string, keys: string[]): number | null {
  const v = parseJson(text);
  if (typeof v !== 'object' || v === null) return null;
  const rec = v as Record<string, unknown>;
  for (const key of keys) {
    const cand = rec[key];
    if (typeof cand === 'number' && Number.isFinite(cand)) return cand;
  }
  return null;
}

export interface ArmatureEnv {
  ARMATURE_KEY?: string;
  ARMATURE_BASE_URL?: string;
  ARMATURE_TIMEOUT_MS?: string;
  AHD_EVALS_FAKE?: string;
}

/**
 * Selection rule required by product/AGENTS.md: a Fake whenever the loop must run
 * offline. `AHD_EVALS_FAKE=1` forces the Fake; a missing/blank `ARMATURE_KEY`
 * forces it too, so the desk never calls a sponsor with no credentials.
 */
export function armatureClient(env: ArmatureEnv = process.env): ArmatureClient {
  const key = typeof env.ARMATURE_KEY === 'string' ? env.ARMATURE_KEY.trim() : '';
  if (env.AHD_EVALS_FAKE === '1') return new FakeArmature({ reason: 'AHD_EVALS_FAKE=1' });
  if (key.length === 0) return new FakeArmature({ reason: 'ARMATURE_KEY not set' });
  // Armature publishes no install-eval HTTP API (its docs describe an MCP server and SDK). A real base URL
  // has to be named on purpose; the Armature feed (feeds/armature.ts) is the integration that reads real data.
  if (!env.ARMATURE_BASE_URL || env.ARMATURE_BASE_URL.trim().length === 0) {
    return new FakeArmature({ reason: 'ARMATURE_BASE_URL not set: Armature documents no install-eval HTTP API' });
  }
  const rawTimeout = Number(env.ARMATURE_TIMEOUT_MS ?? DEFAULT_ARMATURE_TIMEOUT_MS);
  return new HttpArmature({
    baseUrl: env.ARMATURE_BASE_URL.trim(),
    apiKey: key,
    timeoutMs: clampTimeout(rawTimeout),
  });
}
