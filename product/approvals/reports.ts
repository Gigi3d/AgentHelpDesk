// approvals/reports.ts — the desk's daily and weekly report of its own work to the vendor.
//
// Build Plan, "Daily and weekly reports with Inkbox":
//   daily  : failures seen, fixed, escalated and waiting on approval, with anything waiting on
//            the vendor first.
//   weekly : the same counts, plus fixes merged, regression tests added, grants issued under the
//            envelope, the top three repeating failures and the expected bill from the Stripe meter
//            (an invoice preview, so the vendor sees the value before they are charged).
//   honesty: "build every number with SQL over the failures, attempts, grants and outcomes tables.
//            The language model writes only the sentences around them, so a report can never
//            invent a count." There is no language model in this file at all: every number below
//            is aggregated from the Repository and every sentence is string concatenation of those
//            numbers.
import type { Failure, Outcome, Vendor } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { HttpError, badRequest } from '../shared/http.ts';
import { toolEvent, maskRecipient } from './events.ts';
import { storeGuard } from './approvals.ts';
import { channelForRecipient, createInkboxClient, type InkboxClient, type SendReceipt } from './inkbox-client.ts';

export type ReportKind = 'daily' | 'weekly';

const STAGE_DAILY = 'approvals.report.daily';
const STAGE_WEEKLY = 'approvals.report.weekly';
const STAGE_SEND = 'approvals.report.send_now';
const STAGE_CONFIG = 'approvals.report.config';

/** A case in one of these states counts as fixed (Build Plan case lifecycle). */
const FIXED_STATUSES: Failure['status'][] = ['answered', 'shipped', 'closed'];
/** How many case ids the report text will list before it says "and N more". */
const MAX_LISTED_IDS = 5;

export interface TopFailure {
  signature: string;
  count: number;
  example_failure_id: string;
}

export interface ReportNumbers {
  cases_opened: number;
  cases_fixed: number;
  cases_escalated: number;
  /** Live snapshot: every case waiting on an approval reply right now, not just this window. */
  awaiting_approval: number;
  agent_retries_ok: number;
  fixes_merged: number;
  regression_tests_added: number;
  grants_issued: number;
  billable_cases: number;
  expected_bill_usd: number;
  top_failures: TopFailure[];
  waiting_on_vendor: string[];
}

export interface Report {
  kind: ReportKind;
  vendor_id: string;
  vendor_name: string;
  generated_at: string;
  window_start: string;
  window_end: string;
  numbers: ReportNumbers;
  /** The report as plain sentences, one per line. Built only from `numbers`. */
  lines: string[];
  text: string;
  /** Everything a reader must not mistake for a measured fact. */
  assumptions: string[];
}

export interface ReportOptions {
  /** Epoch ms "now"; injectable so tests are deterministic. */
  now?: number;
  /** Per verified fix. Defaults to AHD_REPORT_UNIT_PRICE_USD, else 1.00 (see assumptions). */
  unitPriceUsd?: number;
  windowHours?: number;
}

export interface SendReportDeps {
  client?: InkboxClient;
  env?: Record<string, string | undefined>;
  /** Override the vendor's report_contacts (tests, or a demo inbox). */
  recipients?: string[];
}

export interface SendReportResult {
  report: Report;
  delivered: SendReceipt[];
}

function usd(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function unitPrice(opts: ReportOptions, env: Record<string, string | undefined>): number {
  if (opts.unitPriceUsd !== undefined) {
    if (!Number.isFinite(opts.unitPriceUsd) || opts.unitPriceUsd < 0) {
      throw badRequest(STAGE_CONFIG, 'unitPriceUsd must be a finite number >= 0');
    }
    return opts.unitPriceUsd;
  }
  const raw = env['AHD_REPORT_UNIT_PRICE_USD'];
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpError(500, 'bad_config', 'AHD_REPORT_UNIT_PRICE_USD must be a finite number >= 0', STAGE_CONFIG);
  }
  return n;
}

/** Absolute URL -> pathname, so the same endpoint reached by two hosts groups together. */
function normalizePath(raw: string): string {
  if (!/^https?:\/\//i.test(raw)) return raw.split('?')[0];
  try {
    return new URL(raw).pathname;
  } catch {
    // Not an error to swallow: a stored request may hold a malformed URL, and the report must
    // still render. Fall back to the raw value, trimmed of any query string.
    return raw.split('?')[0];
  }
}

function stringField(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * Grouping key for "top three repeating failures". The store has no endpoint column, so the
 * signature is derived from stored fields only: the failure class plus the request's
 * method+path when present, else the normalised task text.
 */
export function failureSignature(f: Failure): string {
  let endpoint: string | null = null;
  if (typeof f.request === 'object' && f.request !== null) {
    const rec = f.request as Record<string, unknown>;
    const method = stringField(rec, ['method', 'verb']);
    const path = stringField(rec, ['path', 'url', 'endpoint', 'route']);
    if (path) endpoint = method ? `${method.toUpperCase()} ${normalizePath(path)}` : normalizePath(path);
  }
  if (endpoint) return `${f.klass} ${endpoint}`;
  const task = f.task.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${f.klass} ${task.length > 80 ? `${task.slice(0, 79)}…` : task}`;
}

interface Aggregation {
  vendor: Vendor;
  numbers: ReportNumbers;
  windowStart: string;
  windowEnd: string;
  unitPriceUsd: number;
  assumptions: string[];
}

/** The one place numbers are computed. Both reports read it, so they can never disagree. */
async function aggregate(
  vendorId: string,
  repo: Repository,
  stage: string,
  windowHours: number,
  opts: ReportOptions,
  env: Record<string, string | undefined>,
): Promise<Aggregation> {
  if (typeof vendorId !== 'string' || vendorId.trim() === '') {
    throw badRequest(stage, 'vendor_id must be a non-empty string');
  }
  const id = vendorId.trim();
  const vendor = await storeGuard(stage, () => repo.getVendor(id));
  if (!vendor) throw new HttpError(404, 'not_found', `vendor ${id} not found`, stage);

  const nowMs = opts.now ?? Date.now();
  const startMs = nowMs - windowHours * 3_600_000;
  const all = await storeGuard(stage, () => repo.listFailures({ vendor_id: id }));

  const assumptions: string[] = [];
  const inWindow: Failure[] = [];
  let unparsable = 0;
  for (const f of all) {
    const t = Date.parse(f.created_at);
    if (Number.isNaN(t)) {
      unparsable += 1;
      continue;
    }
    if (t >= startMs && t <= nowMs) inWindow.push(f);
  }
  if (unparsable > 0) {
    assumptions.push(`${unparsable} case(s) had an unparsable created_at and are excluded from the window counts.`);
  }

  const awaiting = all.filter((f) => f.status === 'awaiting_approval').map((f) => f.id).sort();

  // Regression tests are counted from the trail, not from the outcome. ship.ts writes one for
  // every case it ships and records `regression.created`; `outcome.shipped_as` says which channel
  // the FIX travelled by (answer | pr | grant), so reading it here reported zero forever.
  const regressionCases = new Set(
    (await storeGuard(stage, () => repo.toolEvents({ action: 'regression.created' }))).map((e) => e.ticket_id),
  );

  let fixed = 0;
  let escalated = 0;
  let retriesOk = 0;
  let merged = 0;
  let regressions = 0;
  let grants = 0;
  let billable = 0;
  for (const f of inWindow) {
    if (FIXED_STATUSES.includes(f.status)) fixed += 1;
    if (f.status === 'escalated') escalated += 1;
    const outcome: Outcome | null = await storeGuard(stage, () => repo.getOutcome(f.id));
    if (outcome) {
      if (outcome.agent_retry_ok) retriesOk += 1;
      if (outcome.shipped_as === 'pr') merged += 1;
      if (outcome.shipped_as === 'grant') grants += 1;
    }
    if (regressionCases.has(f.id)) regressions += 1;
    if (await storeGuard(stage, () => repo.isBillable(f.id))) billable += 1;
  }

  const groups = new Map<string, { count: number; example: string }>();
  for (const f of all) {
    const sig = failureSignature(f);
    const g = groups.get(sig);
    if (!g) groups.set(sig, { count: 1, example: f.id });
    else {
      g.count += 1;
      if (f.id < g.example) g.example = f.id;
    }
  }
  const top: TopFailure[] = [...groups.entries()]
    .map(([signature, g]) => ({ signature, count: g.count, example_failure_id: g.example }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.signature < b.signature ? -1 : 1))
    .slice(0, 3);

  const price = unitPrice(opts, env);
  assumptions.push(
    `Expected bill uses ${usd(price)} per verified fix (Build Plan pricing guess: "$0.50 to $1 per resolved task"); the Stripe meter is authoritative.`,
  );
  assumptions.push(
    'Outcomes carry no timestamp, so a fix is attributed to the window through the case it belongs to (created_at).',
  );
  assumptions.push(
    'A regression test counts once per case that has a `regression.created` row in its audit trail, attributed to the window the same way.',
  );
  assumptions.push(
    '"Waiting on approval" is a live snapshot of every open approval for this vendor, not only cases opened in the window.',
  );
  assumptions.push(
    'Top repeating failures are grouped over every case on record for this vendor, not only the ones opened in the window.',
  );

  return {
    vendor,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(nowMs).toISOString(),
    unitPriceUsd: price,
    assumptions,
    numbers: {
      cases_opened: inWindow.length,
      cases_fixed: fixed,
      cases_escalated: escalated,
      awaiting_approval: awaiting.length,
      agent_retries_ok: retriesOk,
      fixes_merged: merged,
      regression_tests_added: regressions,
      grants_issued: grants,
      billable_cases: billable,
      expected_bill_usd: Math.round(billable * price * 100) / 100,
      top_failures: top,
      waiting_on_vendor: awaiting,
    },
  };
}

function listedIds(ids: string[]): string {
  if (ids.length === 0) return 'none';
  if (ids.length <= MAX_LISTED_IDS) return ids.join(', ');
  return `${ids.slice(0, MAX_LISTED_IDS).join(', ')} and ${ids.length - MAX_LISTED_IDS} more`;
}

/** Sentences assembled from computed numbers only. No generated prose anywhere in this file. */
function render(kind: ReportKind, agg: Aggregation): string[] {
  const n = agg.numbers;
  const day = agg.windowEnd.slice(0, 10);
  const lines: string[] = [
    `AgentHelpDesk ${kind} report for ${agg.vendor.name} (${agg.vendor.id}), ${day}.`,
    `Waiting on you first: ${n.awaiting_approval} case(s) need an approval reply (${listedIds(n.waiting_on_vendor)}).`,
    `Cases opened: ${n.cases_opened}. Fixed and verified: ${n.cases_fixed}. Escalated: ${n.cases_escalated}. Awaiting approval: ${n.awaiting_approval}.`,
    `Agents that finished their task after a fix: ${n.agent_retries_ok}.`,
  ];
  if (kind === 'weekly') {
    lines.push(
      `Fixes merged: ${n.fixes_merged}. Regression tests added: ${n.regression_tests_added}. Grants issued under the envelope: ${n.grants_issued}.`,
    );
    if (n.top_failures.length === 0) {
      lines.push('Top repeating failures: none recorded.');
    } else {
      const ranked = n.top_failures
        .map((t, i) => `${i + 1}) ${t.signature} (${t.count} case${t.count === 1 ? '' : 's'}, e.g. ${t.example_failure_id})`)
        .join('; ');
      lines.push(`Top repeating failures: ${ranked}.`);
    }
    lines.push(
      `Expected bill: ${usd(n.expected_bill_usd)} USD for ${n.billable_cases} billable case(s) at ${usd(
        agg.unitPriceUsd,
      )} per verified fix. This is an invoice preview; the Stripe meter is authoritative.`,
    );
  }
  lines.push(
    `Every number above was aggregated from the case store for ${agg.windowStart.slice(0, 10)} to ${agg.windowEnd.slice(
      0,
      10,
    )}; no count in this report was written by a language model.`,
  );
  return lines;
}

function build(kind: ReportKind, agg: Aggregation): Report {
  const lines = render(kind, agg);
  return {
    kind,
    vendor_id: agg.vendor.id,
    vendor_name: agg.vendor.name,
    generated_at: agg.windowEnd,
    window_start: agg.windowStart,
    window_end: agg.windowEnd,
    numbers: agg.numbers,
    lines,
    text: lines.join('\n'),
    assumptions: agg.assumptions,
  };
}

/** Failures seen, fixed, escalated and waiting on approval, with what waits on the vendor first. */
export async function daily(
  vendorId: string,
  repo: Repository,
  opts: ReportOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<Report> {
  const agg = await aggregate(vendorId, repo, STAGE_DAILY, opts.windowHours ?? 24, opts, env);
  return build('daily', agg);
}

/** The daily counts plus merged fixes, regression tests, grants, top failures and the expected bill. */
export async function weekly(
  vendorId: string,
  repo: Repository,
  opts: ReportOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<Report> {
  const agg = await aggregate(vendorId, repo, STAGE_WEEKLY, opts.windowHours ?? 168, opts, env);
  return build('weekly', agg);
}

export async function buildReport(
  kind: ReportKind,
  vendorId: string,
  repo: Repository,
  opts: ReportOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<Report> {
  if (kind === 'daily') return daily(vendorId, repo, opts, env);
  if (kind === 'weekly') return weekly(vendorId, repo, opts, env);
  throw badRequest(STAGE_SEND, `kind must be "daily" or "weekly", got ${String(kind).slice(0, 40)}`);
}

/**
 * Deliver a report to the vendor's contacts over Inkbox and record `report.sent`.
 * Default channel is text; an email address in report_contacts goes by email (the Build Plan
 * suggests email for the weekly report). No contacts is a loud failure, not a silent no-op.
 */
export async function sendReport(
  report: Report,
  repo: Repository,
  deps: SendReportDeps = {},
): Promise<SendReportResult> {
  const started = Date.now();
  const env = deps.env ?? process.env;
  const vendor = await storeGuard(STAGE_SEND, () => repo.getVendor(report.vendor_id));
  if (!vendor) throw new HttpError(404, 'not_found', `vendor ${report.vendor_id} not found`, STAGE_SEND);

  const recipients = (deps.recipients ?? vendor.report_contacts).filter((r) => typeof r === 'string' && r.trim() !== '');
  if (recipients.length === 0) {
    throw new HttpError(
      422,
      'no_report_contacts',
      `vendor ${report.vendor_id} has no report_contacts, so there is nobody to send the ${report.kind} report to`,
      STAGE_SEND,
    );
  }

  const client = deps.client ?? createInkboxClient(env);
  const delivered: SendReceipt[] = [];
  try {
    for (const raw of recipients) {
      const to = raw.trim();
      const channel = channelForRecipient(to, STAGE_SEND);
      const receipt =
        channel === 'text'
          ? await client.sendText(to, report.text)
          : await client.sendEmail(to, `AgentHelpDesk ${report.kind} report`, report.text);
      delivered.push(receipt);
    }
  } catch (err) {
    const failed = toolEvent({
      ticket_id: report.vendor_id,
      stage: STAGE_SEND,
      action: 'report.sent',
      t_ms: started,
      result: 'error',
      payload: {
        kind: report.kind,
        vendor_id: report.vendor_id,
        delivered: delivered.length,
        attempted: recipients.length,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    await storeGuard(STAGE_SEND, () => repo.appendToolEvent(failed));
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'delivery_failed', `report delivery failed: ${err instanceof Error ? err.message : String(err)}`, STAGE_SEND);
  }

  const event = toolEvent({
    ticket_id: report.vendor_id,
    stage: STAGE_SEND,
    action: 'report.sent',
    t_ms: started,
    result: 'ok',
    payload: {
      kind: report.kind,
      vendor_id: report.vendor_id,
      window_start: report.window_start,
      window_end: report.window_end,
      recipients: recipients.map((r) => maskRecipient(r)),
      message_ids: delivered.map((d) => d.message_id),
      channels: delivered.map((d) => d.channel),
      fake: delivered.every((d) => d.fake),
      numbers: report.numbers,
    },
  });
  await storeGuard(STAGE_SEND, () => repo.appendToolEvent(event));
  return { report, delivered };
}
