// Pick rate: the share of fresh-agent install evals that passed.
//
// Armature's job in our loop is to answer "do coding agents pick this product?"
// (Research Dossier competitor table: Armature "tests whether coding agents pick a
// product"; Frontend plan sponsor row: "Tests whether agents pick and install the desk
// unprompted"). We do not have an Armature eval-execution API to cite, so the number
// shown on the install page is computed here from OUR OWN recorded runs — the
// `eval.install` ToolEvents written by ./install-eval.ts. Every figure is derived from
// stored rows; nothing is estimated, defaulted to a plausible value, or invented.
// When there are no runs the rate is `null`, which the console renders as "Not run yet".
//
// The aggregate itself is stored as a ToolEvent (tool 'Armature', action 'eval.pick')
// so the console reads evals from the same table as everything else, and so a report
// can quote the number with its inputs attached.

import { randomUUID } from 'node:crypto';
import type { ToolEvent } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { ACTION_INSTALL, EVAL_TICKET, EVAL_TOOL, readInstallRuns } from './install-eval.ts';
import type { StoredInstallRun } from './install-eval.ts';

export const ACTION_PICK = 'eval.pick';
export const STAGE_PICK = 'evals.pick';

export interface StepPassRate {
  runs: number;
  ok: number;
  /** null when the step never ran, so a missing step is never shown as 100%. */
  ok_rate: number | null;
}

export interface RungPassRate {
  runs: number;
  passed: number;
}

export interface PickRateResult {
  runs: number;
  passed: number;
  failed: number;
  /** Runs invalidated because resolver knowledge reached the fresh agent. Never counted as passes. */
  invalidated_by_leak: number;
  /** Exact pass share, or null when there is no data. */
  pick_rate: number | null;
  pick_rate_pct: number | null;
  median_time_ms: number | null;
  step_pass: Record<string, StepPassRate>;
  rungs: Record<string, RungPassRate>;
  /** How many stored runs were simulations. Equals `runs` today; kept explicit for honesty. */
  simulated_runs: number;
  /** How many stored runs actually reached Armature. 0 offline. */
  armature_submitted_runs: number;
  skipped_malformed: number;
  source: 'tool_events';
  computed_at: string;
  /** The eval.pick ToolEvent for this computation, or null when nothing was recorded. */
  pick_event_id: string | null;
  pick_event_recorded: boolean;
}

export interface PickRateOptions {
  ticket_id?: string;
  now?: () => number;
  /** Set false for a pure read (no eval.pick event written). Default true. */
  record?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - (sorted.length % 2 === 0 ? 1 : 0)];
  const upper = sorted[mid];
  if (lower === undefined || upper === undefined) return null;
  return Math.round((lower + upper) / 2);
}

/** Fraction (0.5) → percentage with one decimal (50). */
function toPct(v: number): number {
  return Math.round(v * 1000) / 10;
}

function aggregate(runs: readonly StoredInstallRun[]): Omit<PickRateResult, 'source' | 'computed_at' | 'pick_event_id' | 'pick_event_recorded' | 'skipped_malformed'> {
  const total = runs.length;
  const passed = runs.filter((r) => r.pass).length;
  const stepPass: Record<string, StepPassRate> = {};
  const rungs: Record<string, RungPassRate> = {};

  for (const run of runs) {
    const rungKey = `rung_${run.rung}`;
    const rung = rungs[rungKey] ?? { runs: 0, passed: 0 };
    rung.runs += 1;
    if (run.pass) rung.passed += 1;
    rungs[rungKey] = rung;

    for (const step of run.steps) {
      const entry = stepPass[step.name] ?? { runs: 0, ok: 0, ok_rate: null };
      entry.runs += 1;
      if (step.ok) entry.ok += 1;
      entry.ok_rate = entry.runs > 0 ? entry.ok / entry.runs : null;
      stepPass[step.name] = entry;
    }
  }

  const rate = total > 0 ? passed / total : null;
  return {
    runs: total,
    passed,
    failed: total - passed,
    invalidated_by_leak: runs.filter((r) => r.leak_detected).length,
    pick_rate: rate,
    pick_rate_pct: rate === null ? null : toPct(rate),
    median_time_ms: median(runs.map((r) => r.time_ms)),
    step_pass: stepPass,
    rungs,
    simulated_runs: runs.filter((r) => r.simulated).length,
    armature_submitted_runs: runs.filter((r) => r.armature.submitted).length,
  };
}

interface StoredPickEvent {
  id: string;
  runs: number;
  passed: number;
  pick_rate: number | null;
}

function parsePickEvent(e: ToolEvent): StoredPickEvent | null {
  const p = asRecord(e.payload);
  if (!p) return null;
  const runs = p['runs'];
  const passed = p['passed'];
  if (typeof runs !== 'number' || typeof passed !== 'number') return null;
  const rate = p['pick_rate'];
  return { id: e.id, runs, passed, pick_rate: typeof rate === 'number' && Number.isFinite(rate) ? rate : null };
}

async function latestPickEvent(repo: Repository, ticketId: string): Promise<StoredPickEvent | null> {
  const events = await repo.toolEvents({ tool: EVAL_TOOL, ticket_id: ticketId });
  let last: StoredPickEvent | null = null;
  for (const e of events) {
    if (e.action !== ACTION_PICK) continue;
    const parsed = parsePickEvent(e);
    if (parsed) last = parsed;
  }
  return last;
}

/**
 * Compute the pass share of recorded install evals and store the aggregate.
 * Reading is idempotent: when the inputs have not changed since the last
 * computation, the existing eval.pick event is returned and no new row is written.
 */
export async function pickRate(repo: Repository, opts: PickRateOptions = {}): Promise<PickRateResult> {
  const ticketId = opts.ticket_id ?? EVAL_TICKET;
  const now = opts.now ?? (() => Date.now());
  const record = opts.record ?? true;
  const started = now();

  const read = await readInstallRuns(repo, { ticket_id: ticketId });
  const stats = aggregate(read.runs);
  const computedAt = new Date().toISOString();

  const base: PickRateResult = {
    ...stats,
    skipped_malformed: read.skipped_malformed,
    source: 'tool_events',
    computed_at: computedAt,
    pick_event_id: null,
    pick_event_recorded: false,
  };

  if (!record || stats.runs === 0) return base;

  const previous = await latestPickEvent(repo, ticketId);
  if (previous && previous.runs === stats.runs && previous.passed === stats.passed) {
    return { ...base, pick_event_id: previous.id, pick_event_recorded: false };
  }

  const dMs = Math.max(0, now() - started);
  const eventId = `evp_${randomUUID()}`;
  const event: ToolEvent = {
    id: eventId,
    ticket_id: ticketId,
    stage: STAGE_PICK,
    tool: EVAL_TOOL,
    action: ACTION_PICK,
    t_ms: 0,
    d_ms: dMs,
    result: stats.pick_rate === null ? 'no_data' : `pick_rate=${stats.pick_rate_pct}%`,
    payload: {
      runs: stats.runs,
      passed: stats.passed,
      failed: stats.failed,
      invalidated_by_leak: stats.invalidated_by_leak,
      pick_rate: stats.pick_rate,
      pick_rate_pct: stats.pick_rate_pct,
      median_time_ms: stats.median_time_ms,
      step_pass: stats.step_pass,
      rungs: stats.rungs,
      simulated_runs: stats.simulated_runs,
      armature_submitted_runs: stats.armature_submitted_runs,
      skipped_malformed: read.skipped_malformed,
      source: 'tool_events' as const,
      computed_from_action: ACTION_INSTALL,
      computed_at: computedAt,
      note: 'Computed from stored eval.install ToolEvents. Runs are simulated fresh-agent doc checks, not real agent behaviour.',
    },
    at: computedAt,
  };
  await repo.appendToolEvent(event);

  return { ...base, pick_event_id: eventId, pick_event_recorded: true };
}
