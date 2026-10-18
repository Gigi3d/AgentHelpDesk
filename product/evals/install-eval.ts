// The fresh-agent install eval.
//
// What it is: AgentHelpDesk claims "a fresh agent installs it from the docs alone"
// (Frontend and Product Surface Plan.md, Armature row) and the Build Plan's
// Architecture section requires that a fresh-agent check gets "only the original task
// and the changed docs and responses, never the resolver's reasoning". This module
// runs that check as a SIMULATION: a deterministic policy stands in for the agent and
// may use only the documents it is handed.
//
// Why simulated: there is no model runtime in product/ (Node built-ins only) and no
// Armature eval-execution API we can cite, so a real clean-context agent run cannot
// happen offline. Per product/AGENTS.md the un-runnable part is faked and labelled —
// `simulated: true` and `DISCLAIMER` travel with every result and every stored event.
//
// What a pass therefore means, honestly: the docs an agent is given contain every
// affordance it needs (a pointer at the docs root, a help field in the error body, a
// reachable help page, an install path, and enough to open a first ticket). That is
// evidence about OUR DOCS. It is not proof that real agents pick the desk.
//
// Persistence: the Repository has no eval table, so a run is stored as a ToolEvent
// with tool 'Armature' and action 'eval.install' and read back with
// repo.toolEvents({ tool: 'Armature' }). The service keeps no state of its own.

import { randomUUID } from 'node:crypto';
import { HttpError } from '../shared/http.ts';
import type { ToolEvent } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import type { ArmatureClient, ArmatureMode, ArmatureReceipt } from './armature-client.ts';
import { armatureClient } from './armature-client.ts';
import { DEFAULT_ERROR_BODY, DEFAULT_INSTALL_DOCS, DISCLAIMER } from './fixtures.ts';
import type { FreshAgentDoc } from './fixtures.ts';

export const EVAL_TOOL = 'Armature';
export const ACTION_INSTALL = 'eval.install';
export const STAGE_INSTALL = 'evals.install';
/** Eval runs are not cases; they share one synthetic ticket so the console groups them. */
export const EVAL_TICKET = 'ahd-eval';
export const VALIDATE_STAGE = 'evals.validate';

const MAX_DOCS = 20;
const MAX_DOC_BODY = 200_000;
const MAX_FORBIDDEN = 50;
const MAX_FORBIDDEN_LEN = 500;
const MIN_FORBIDDEN_LEN = 8;
const MAX_EVIDENCE = 240;
const MAX_DETAIL = 400;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const PRODUCT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Strings that would invalidate the run: the resolver's own knowledge, in any form. */
const LEAK_MARKERS: readonly string[] = [
  'resolver_reasoning',
  'resolver_transcript',
  'attempt_diff',
  'draft_fix',
  'fix_steps',
  'proof_replay',
  'proof_vendor_tests',
];

export interface InstallEvalStep {
  n: number;
  name: string;
  ok: boolean;
  /** Which document supplied the affordance, or null when nothing did. */
  found_in: string | null;
  /** The literal span the agent used. Empty when the step failed. */
  evidence: string;
  detail: string;
  ms: number;
}

export interface InstallEvalResult {
  run_id: string;
  ticket_id: string;
  pass: boolean;
  steps: InstallEvalStep[];
  step_count: number;
  time_ms: number;
  /** Install-ladder rung the agent was attempting (0-3 suggest-only, 4 GitHub). */
  rung: number;
  /** Always true today. See the module header: this is a simulation, labelled. */
  simulated: boolean;
  mode: ArmatureMode;
  leak: { detected: boolean; reason: string | null };
  docs_read: string[];
  armature: ArmatureReceipt;
  idempotency_key: string | null;
  /** True when this result was returned from a stored run instead of re-executed. */
  replayed: boolean;
  recorded_at: string;
  disclaimer: string;
}

export interface InstallEvalOptions {
  ticket_id?: string;
  run_id?: string;
  /** Replay guard: a second POST with the same key returns the stored run and sends nothing. */
  idempotency_key?: string;
  product?: string;
  rung?: number;
  /** The complete world the fresh agent may read. Defaults to the mirrored doc bundle. */
  docs?: readonly FreshAgentDoc[];
  /** The failing response the agent is holding. Defaults to the rung 1 422 + help field. */
  error_body?: unknown;
  /** Resolver reasoning / fix text that must never reach the agent. Screening is fatal to the run. */
  forbidden?: readonly string[];
  now?: () => number;
  client?: ArmatureClient;
}

// ---- stored shape (ToolEvent payload) ----

export interface StoredInstallStep {
  n: number;
  name: string;
  ok: boolean;
  found_in: string | null;
  evidence: string;
  detail: string;
  ms: number;
}

export interface StoredArmatureReceipt {
  mode: string;
  submitted: boolean;
  run_ref: string | null;
  status: number | null;
  error: string | null;
  faked: boolean;
}

export interface StoredInstallRun {
  event_id: string;
  ticket_id: string;
  run_id: string;
  at: string;
  result: string;
  pass: boolean;
  step_count: number;
  time_ms: number;
  rung: number;
  simulated: boolean;
  mode: ArmatureMode;
  leak_detected: boolean;
  leak_reason: string | null;
  idempotency_key: string | null;
  docs_read: string[];
  steps: StoredInstallStep[];
  armature: StoredArmatureReceipt;
  disclaimer: string;
}

export interface InstallRunsRead {
  runs: StoredInstallRun[];
  /** Rows with tool 'Armature' + action 'eval.install' whose payload did not validate. */
  skipped_malformed: number;
}

// ---- small untrusted-data helpers (payload is `unknown` in the contract) ----

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function toMode(v: unknown): ArmatureMode {
  return v === 'armature' ? 'armature' : 'fake';
}

function fail(message: string): never {
  throw new HttpError(400, 'bad_request', message, VALIDATE_STAGE);
}

/** Validated string, or a loud 400 naming stage evals.validate. */
function requireStr(v: unknown, message: string): string {
  return asStr(v) ?? fail(message);
}

/** Validated JSON object, or a loud 400 naming stage evals.validate. */
function requireRecord(v: unknown, message: string): Record<string, unknown> {
  return asRecord(v) ?? fail(message);
}

// ---- option validation: every inbound field is untrusted ----

interface NormalizedOptions {
  ticketId: string;
  runId: string;
  idempotencyKey: string | null;
  product: string;
  rung: number;
  docs: FreshAgentDoc[];
  errorBody: Record<string, unknown>;
  forbidden: string[];
  now: () => number;
  client: ArmatureClient;
}

function normalizeOptions(opts: InstallEvalOptions): NormalizedOptions {
  const ticketId = opts.ticket_id ?? EVAL_TICKET;
  if (!ID_RE.test(ticketId)) fail(`ticket_id must match ${ID_RE.source}`);

  const runId = opts.run_id ?? `evr_${randomUUID()}`;
  if (!ID_RE.test(runId)) fail(`run_id must match ${ID_RE.source}`);

  const idempotencyKey = opts.idempotency_key ?? null;
  if (idempotencyKey !== null && !KEY_RE.test(idempotencyKey)) fail(`idempotency_key must match ${KEY_RE.source}`);

  const product = opts.product ?? 'agenthelpdesk';
  if (!PRODUCT_RE.test(product)) fail(`product must match ${PRODUCT_RE.source}`);

  const rung = opts.rung ?? 1;
  if (!Number.isInteger(rung) || rung < 0 || rung > 4) fail('rung must be an integer 0..4 (install ladder rung)');

  const docsIn: readonly FreshAgentDoc[] = opts.docs ?? DEFAULT_INSTALL_DOCS;
  if (!Array.isArray(docsIn as unknown)) fail('docs must be an array of {name,url,body}');
  if (docsIn.length === 0) fail('docs must not be empty: a fresh agent with no documents cannot install anything');
  if (docsIn.length > MAX_DOCS) fail(`docs must contain at most ${MAX_DOCS} entries`);
  const docs: FreshAgentDoc[] = docsIn.map((d, i) => {
    const rec = requireRecord(d, `docs[${i}] must be an object`);
    const name = requireStr(rec['name'], `docs[${i}].name must be a non-empty string`);
    if (name.length === 0) fail(`docs[${i}].name must be a non-empty string`);
    const url = requireStr(rec['url'], `docs[${i}].url must be an http(s) URL`);
    if (!/^https?:\/\//i.test(url)) fail(`docs[${i}].url must be an http(s) URL`);
    const body = requireStr(rec['body'], `docs[${i}].body must be a string`);
    if (body.length > MAX_DOC_BODY) fail(`docs[${i}].body exceeds ${MAX_DOC_BODY} characters`);
    return { name, url, body };
  });

  const errorBody = requireRecord(
    opts.error_body ?? DEFAULT_ERROR_BODY,
    'error_body must be a JSON object (the response the failing agent received)',
  );

  const forbiddenIn: readonly string[] = opts.forbidden ?? [];
  if (!Array.isArray(forbiddenIn as unknown)) fail('forbidden must be an array of strings');
  if (forbiddenIn.length > MAX_FORBIDDEN) fail(`forbidden must contain at most ${MAX_FORBIDDEN} entries`);
  const forbidden = forbiddenIn.map((f, i) => {
    const s = requireStr(f, `forbidden[${i}] must be a string`);
    if (s.length < MIN_FORBIDDEN_LEN) fail(`forbidden[${i}] must be at least ${MIN_FORBIDDEN_LEN} characters to be a meaningful screen`);
    if (s.length > MAX_FORBIDDEN_LEN) fail(`forbidden[${i}] must be at most ${MAX_FORBIDDEN_LEN} characters`);
    return s;
  });

  return {
    ticketId,
    runId,
    idempotencyKey,
    product,
    rung,
    docs,
    errorBody,
    forbidden,
    now: opts.now ?? (() => Date.now()),
    client: opts.client ?? armatureClient(),
  };
}

// ---- what the simulated agent can see ----

interface AskChannels {
  mcpServer: string | null;
  mcpTool: string | null;
  http: string | null;
  email: string | null;
}

interface Commitments {
  ackWithin: string | null;
  resolveWithin: string | null;
}

interface HelpPageView {
  doc: FreshAgentDoc | null;
  source: 'json' | 'markdown' | 'none';
  channels: AskChannels;
  commitments: Commitments;
}

const NO_CHANNELS: AskChannels = { mcpServer: null, mcpTool: null, http: null, email: null };
const NO_COMMITMENTS: Commitments = { ackWithin: null, resolveWithin: null };

function firstMatch(body: string, re: RegExp): string | null {
  const m = body.match(re);
  return m && typeof m[0] === 'string' ? m[0].trim() : null;
}

function capture(body: string, re: RegExp): string | null {
  const m = body.match(re);
  const v = m?.[1];
  return typeof v === 'string' && v.length > 0 ? v.trim() : null;
}

/** JSON twin first, Markdown fallback — the help page may be served as either (plan §3). */
function readHelpPage(docs: readonly FreshAgentDoc[], deskUrl: string | null): HelpPageView {
  const doc =
    docs.find((d) => deskUrl !== null && d.url === deskUrl) ??
    docs.find((d) => d.name.toLowerCase().includes('help')) ??
    null;
  if (!doc) return { doc: null, source: 'none', channels: NO_CHANNELS, commitments: NO_COMMITMENTS };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(doc.body) as unknown;
  } catch {
    parsed = null; // Not the JSON twin: fall through to the Markdown reading below.
  }

  const rec = asRecord(parsed);
  if (rec) {
    const howTo = asRecord(rec['how_to_ask']);
    const mcp = asRecord(howTo?.['mcp']);
    const commitmentsRoot = asRecord(rec['commitments']);
    const defaultCommitments = commitmentsRoot ? (asRecord(commitmentsRoot['default']) ?? commitmentsRoot) : null;
    const httpRaw = asStr(howTo?.['http']);
    return {
      doc,
      source: 'json',
      channels: {
        mcpServer: asStr(mcp?.['server']),
        mcpTool: asStr(mcp?.['tool']),
        http: httpRaw ? (firstMatch(httpRaw, /https?:\/\/\S+/i) ?? httpRaw) : null,
        email: asStr(howTo?.['email']),
      },
      commitments: {
        ackWithin: asStr(defaultCommitments?.['ack_within']),
        resolveWithin: asStr(defaultCommitments?.['resolve_within']),
      },
    };
  }

  return {
    doc,
    source: 'markdown',
    channels: {
      mcpServer: capture(doc.body, /(https?:\/\/[^\s)"']*\/mcp)/i),
      mcpTool: capture(doc.body, /\btool:\s*([A-Za-z_][A-Za-z0-9_]{2,40})/i) ?? capture(doc.body, /\bcall\s+([A-Za-z_][A-Za-z0-9_]{2,40})/i),
      http: firstMatch(doc.body, /POST\s+https?:\/\/[^\s)"']+/i),
      email: firstMatch(doc.body, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/),
    },
    commitments: {
      ackWithin: firstMatch(doc.body, /ack(?:_|\s)within[:\s]*\S+/i),
      resolveWithin: firstMatch(doc.body, /resolve(?:_|\s)within[:\s]*\S+/i),
    },
  };
}

interface ErrorHelp {
  desk: string | null;
  tool: string | null;
  requestId: string | null;
  raw: string;
}

function readErrorHelp(errorBody: Record<string, unknown>): ErrorHelp {
  const help = asRecord(errorBody['help']);
  const desk = asStr(help?.['desk']);
  return {
    desk: desk && /^https?:\/\//i.test(desk) ? desk : null,
    tool: asStr(help?.['tool']),
    requestId: asStr(help?.['request_id']),
    raw: help ? clip(JSON.stringify(help), MAX_EVIDENCE) : '',
  };
}

interface AgentView {
  docs: readonly FreshAgentDoc[];
  errorBody: Record<string, unknown>;
  rung: number;
}

interface StepOutcome {
  ok: boolean;
  found_in: string | null;
  evidence: string;
  detail: string;
}

const notFound = (detail: string): StepOutcome => ({ ok: false, found_in: null, evidence: '', detail });
const found = (foundIn: string, evidence: string, detail: string): StepOutcome => ({
  ok: true,
  found_in: foundIn,
  evidence: clip(evidence, MAX_EVIDENCE),
  detail: clip(detail, MAX_DETAIL),
});

function stepReadLlmsTxt(view: AgentView): StepOutcome {
  const doc = view.docs.find((d) => d.name.toLowerCase().includes('llms')) ?? null;
  if (!doc) return notFound('no llms.txt in the bundle: an agent starting at the docs root has no pointer to the desk');
  const line = doc.body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /agent/i.test(l) && /https?:\/\//i.test(l));
  if (!line) return notFound(`llms.txt exists at ${doc.url} but names no help URL for agents`);
  const url = firstMatch(line, /https?:\/\/[^\s)"']+/i);
  if (!url) return notFound(`llms.txt mentions agents but the line carries no URL: ${line}`);
  return found(doc.url, line, `docs root points agents at ${url}`);
}

function stepReadErrorBody(view: AgentView): StepOutcome {
  const help = readErrorHelp(view.errorBody);
  if (!help.desk || !help.tool) {
    return notFound(
      'the failing response carries no usable help field (needs help.desk URL and help.tool); ' +
        'an agent that fails here has no way to find the desk at the moment of failure',
    );
  }
  return found(
    'error body',
    help.raw,
    `error body names tool "${help.tool}" and desk ${help.desk}${help.requestId ? ` for request ${help.requestId}` : ''}`,
  );
}

function stepReadHelpPage(view: AgentView): StepOutcome {
  const help = readErrorHelp(view.errorBody);
  const page = readHelpPage(view.docs, help.desk);
  if (!page.doc) return notFound(`the help URL ${help.desk ?? 'from the error body'} is not in the bundle the agent was given`);
  const c = page.channels;
  if (!c.mcpServer && !c.http && !c.email) {
    return notFound(`help page at ${page.doc.url} (${page.source}) states no way to ask for help`);
  }
  if (!page.commitments.ackWithin || !page.commitments.resolveWithin) {
    return notFound(`help page at ${page.doc.url} states no committed ack/resolve times, so the agent cannot tell what to expect`);
  }
  return found(
    page.doc.url,
    JSON.stringify({ how_to_ask: c, commitments: page.commitments }),
    `help page read as ${page.source}; ack within ${page.commitments.ackWithin}, resolve within ${page.commitments.resolveWithin}`,
  );
}

function stepInstallDesk(view: AgentView): StepOutcome {
  const help = readErrorHelp(view.errorBody);
  const page = readHelpPage(view.docs, help.desk);
  const c = page.channels;
  const toolName = c.mcpTool ?? help.tool;
  const channel = c.mcpServer && toolName ? `MCP ${toolName} at ${c.mcpServer}` : c.http ? `HTTP ${c.http}` : null;
  if (!channel) {
    return notFound('no callable channel: the agent cannot reach the desk without a human (needs an MCP server + tool, or an HTTP endpoint)');
  }
  if (view.rung >= 4) {
    const repoDoc =
      view.docs.find((d) => /npx\s+agenthelpdesk\s+init/i.test(d.body) || /pull request/i.test(d.body)) ?? null;
    if (!repoDoc) {
      return notFound(`rung ${view.rung} needs the repo install path (one command or one install PR) and no document in the bundle states it`);
    }
    const command = firstMatch(repoDoc.body, /npx\s+agenthelpdesk\s+init/i) ?? 'open the install pull request';
    return found(
      `${page.doc?.url ?? 'help page'} + ${repoDoc.url}`,
      `${command} → ${channel}`,
      `rung 4 install path found ("${command}") plus a callable channel; the agent can install without asking a human`,
    );
  }
  return found(
    page.doc?.url ?? 'error body',
    channel,
    `rung ${view.rung} install needs no repo access; the agent can call ${channel} straight from the docs`,
  );
}

function stepFirstTicket(view: AgentView): StepOutcome {
  const help = readErrorHelp(view.errorBody);
  const page = readHelpPage(view.docs, help.desk);
  const c = page.channels;
  const toolName = c.mcpTool ?? help.tool;
  const destination = c.mcpServer && toolName ? `POST ${c.mcpServer}` : c.http ? `POST ${c.http}` : null;
  if (!help.requestId) return notFound('the error body carries no help.request_id, so the agent cannot reference its failing call in the first ticket');
  if (!destination || !toolName) return notFound('no destination to open the first ticket at');
  if (!page.commitments.ackWithin || !page.commitments.resolveWithin) return notFound('no committed times, so the agent cannot decide whether to wait or escalate');
  const call = `${toolName}({request_id:"${help.requestId}", goal:"<what the agent was trying to do>", desk:"${help.desk}"}) → ${destination}`;
  return found(
    page.doc?.url ?? 'help page',
    call,
    `first ticket is openable from the docs alone; expects ack within ${page.commitments.ackWithin}, resolve within ${page.commitments.resolveWithin}`,
  );
}

interface StepRunner {
  name: string;
  run: (view: AgentView) => StepOutcome;
}

const STEP_RUNNERS: readonly StepRunner[] = [
  { name: 'read_docs_root', run: stepReadLlmsTxt },
  { name: 'read_error_body', run: stepReadErrorBody },
  { name: 'read_help_page', run: stepReadHelpPage },
  { name: 'install_desk', run: stepInstallDesk },
  { name: 'first_ticket', run: stepFirstTicket },
];

// ---- leak guard: the fresh agent must never see the resolver's knowledge ----

function screenForLeaks(docs: readonly FreshAgentDoc[], errorBody: unknown, forbidden: readonly string[]): { detected: boolean; reason: string | null } {
  const haystack = `${docs.map((d) => d.body).join('\n')}\n${JSON.stringify(errorBody)}`.toLowerCase();
  const needles = [...LEAK_MARKERS, ...forbidden];
  for (const needle of needles) {
    const n = needle.toLowerCase();
    if (n.length < MIN_FORBIDDEN_LEN) continue;
    if (haystack.includes(n)) {
      return {
        detected: true,
        reason: `the documents handed to the fresh agent contain "${needle}": the resolver's reasoning or fix leaked into the eval input`,
      };
    }
  }
  return { detected: false, reason: null };
}

// ---- read-back ----

function parseSteps(v: unknown): StoredInstallStep[] {
  if (!Array.isArray(v)) return [];
  const out: StoredInstallStep[] = [];
  for (const raw of v) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const name = asStr(rec['name']);
    if (name === null) continue;
    out.push({
      n: asNum(rec['n'], out.length + 1),
      name,
      ok: asBool(rec['ok'], false),
      found_in: asStr(rec['found_in']),
      evidence: clip(asStr(rec['evidence']) ?? '', MAX_EVIDENCE),
      detail: clip(asStr(rec['detail']) ?? '', MAX_DETAIL),
      ms: asNum(rec['ms'], 0),
    });
  }
  return out;
}

function parseReceipt(v: unknown): StoredArmatureReceipt {
  const rec = asRecord(v);
  const rawStatus = rec ? rec['status'] : null;
  return {
    mode: asStr(rec?.['mode']) ?? 'fake',
    submitted: asBool(rec?.['submitted'], false),
    run_ref: asStr(rec?.['run_ref']),
    status: typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : null,
    error: asStr(rec?.['error']),
    faked: asBool(rec?.['faked'], true),
  };
}

function parseInstallRun(e: ToolEvent): StoredInstallRun | null {
  const p = asRecord(e.payload);
  if (!p) return null;
  const runId = asStr(p['run_id']);
  if (runId === null) return null;
  const steps = parseSteps(p['steps']);
  if (steps.length === 0) return null;
  const leak = asRecord(p['leak']);
  return {
    event_id: e.id,
    ticket_id: e.ticket_id,
    run_id: runId,
    at: e.at,
    result: e.result,
    pass: asBool(p['pass'], false),
    step_count: asNum(p['step_count'], steps.length),
    time_ms: asNum(p['time_ms'], e.d_ms),
    rung: asNum(p['rung'], 0),
    simulated: asBool(p['simulated'], true),
    mode: toMode(p['mode']),
    leak_detected: asBool(leak?.['detected'], false),
    leak_reason: asStr(leak?.['reason']),
    idempotency_key: asStr(p['idempotency_key']),
    docs_read: asStrArray(p['docs_read']),
    steps,
    armature: parseReceipt(p['armature']),
    disclaimer: asStr(p['disclaimer']) ?? DISCLAIMER,
  };
}

/** The only read path for eval results: back out of the ToolEvent table. */
export async function readInstallRuns(
  repo: Repository,
  filter: { ticket_id?: string; idempotency_key?: string } = {},
): Promise<InstallRunsRead> {
  const eventFilter: { ticket_id?: string; tool?: string } = { tool: EVAL_TOOL };
  if (filter.ticket_id) eventFilter.ticket_id = filter.ticket_id;
  const events = await repo.toolEvents(eventFilter);
  const runs: StoredInstallRun[] = [];
  let skipped = 0;
  for (const e of events) {
    if (e.action !== ACTION_INSTALL) continue;
    const parsed = parseInstallRun(e);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    if (filter.idempotency_key && parsed.idempotency_key !== filter.idempotency_key) continue;
    runs.push(parsed);
  }
  return { runs, skipped_malformed: skipped };
}

function receiptFromStored(r: StoredArmatureReceipt): ArmatureReceipt {
  return {
    mode: toMode(r.mode),
    submitted: r.submitted,
    run_ref: r.run_ref,
    status: r.status,
    error: r.error,
    faked: r.faked,
  };
}

function resultFromStored(r: StoredInstallRun, replayed: boolean): InstallEvalResult {
  return {
    run_id: r.run_id,
    ticket_id: r.ticket_id,
    pass: r.pass,
    steps: r.steps.map((s) => ({ ...s })),
    step_count: r.step_count,
    time_ms: r.time_ms,
    rung: r.rung,
    simulated: r.simulated,
    mode: r.mode,
    leak: { detected: r.leak_detected, reason: r.leak_reason },
    docs_read: [...r.docs_read],
    armature: receiptFromStored(r.armature),
    idempotency_key: r.idempotency_key,
    replayed,
    recorded_at: r.at,
    disclaimer: r.disclaimer,
  };
}

// ---- the eval ----

/**
 * Run one fresh-agent install eval and store it as a ToolEvent.
 * A failing eval is a RESULT (pass:false), never a throw: only invalid input throws.
 */
export async function runInstallEval(repo: Repository, opts: InstallEvalOptions = {}): Promise<InstallEvalResult> {
  const cfg = normalizeOptions(opts);

  if (cfg.idempotencyKey !== null) {
    const prior = await readInstallRuns(repo, { ticket_id: cfg.ticketId, idempotency_key: cfg.idempotencyKey });
    const hit = prior.runs.find((r) => r.idempotency_key === cfg.idempotencyKey);
    if (hit) return resultFromStored(hit, true); // replay returns the original run and submits nothing
  }

  const started = cfg.now();
  const view: AgentView = { docs: cfg.docs, errorBody: cfg.errorBody, rung: cfg.rung };
  const leak = screenForLeaks(cfg.docs, cfg.errorBody, cfg.forbidden);

  const steps: InstallEvalStep[] = [];
  for (const [i, runner] of STEP_RUNNERS.entries()) {
    const stepStart = cfg.now();
    // A leaked fix invalidates the run: the agent "passes" only because it was told the
    // answer. Every step is marked failed so the row cannot be misread as a real pass.
    const outcome: StepOutcome = leak.detected
      ? notFound(`run invalidated by leak guard: ${leak.reason ?? 'resolver knowledge present in the eval input'}`)
      : runner.run(view);
    steps.push({
      n: i + 1,
      name: runner.name,
      ok: outcome.ok,
      found_in: outcome.found_in,
      evidence: outcome.evidence,
      detail: outcome.detail,
      ms: Math.max(0, cfg.now() - stepStart),
    });
  }

  const timeMs = Math.max(0, cfg.now() - started);
  const pass = !leak.detected && steps.every((s) => s.ok);
  const recordedAt = new Date().toISOString();
  const runId = cfg.runId;

  const receipt = await cfg.client.submitEvalRun({
    product: cfg.product,
    run_id: runId,
    kind: 'install',
    pass,
    steps: steps.length,
    time_ms: timeMs,
    simulated: true,
    payload: {
      rung: cfg.rung,
      ticket_id: cfg.ticketId,
      leak_detected: leak.detected,
      failed_steps: steps.filter((s) => !s.ok).map((s) => s.name),
      docs_read: cfg.docs.map((d) => d.url),
      disclaimer: DISCLAIMER,
    },
  });

  const event: ToolEvent = {
    id: runId,
    ticket_id: cfg.ticketId,
    stage: STAGE_INSTALL,
    tool: EVAL_TOOL,
    action: ACTION_INSTALL,
    t_ms: 0,
    d_ms: timeMs,
    result: pass ? 'pass' : 'fail',
    payload: {
      run_id: runId,
      ticket_id: cfg.ticketId,
      pass,
      step_count: steps.length,
      steps,
      time_ms: timeMs,
      rung: cfg.rung,
      simulated: true,
      mode: receipt.mode,
      leak,
      idempotency_key: cfg.idempotencyKey,
      docs_read: cfg.docs.map((d) => d.url),
      armature: receipt,
      disclaimer: DISCLAIMER,
      recorded_at: recordedAt,
    },
    at: recordedAt,
  };
  await repo.appendToolEvent(event);

  return {
    run_id: runId,
    ticket_id: cfg.ticketId,
    pass,
    steps,
    step_count: steps.length,
    time_ms: timeMs,
    rung: cfg.rung,
    simulated: true,
    mode: receipt.mode,
    leak,
    docs_read: cfg.docs.map((d) => d.url),
    armature: receipt,
    idempotency_key: cfg.idempotencyKey,
    replayed: false,
    recorded_at: recordedAt,
    disclaimer: DISCLAIMER,
  };
}
