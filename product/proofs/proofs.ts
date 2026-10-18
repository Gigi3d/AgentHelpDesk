// proofs/proofs.ts — the three proofs, in order: replay → vendorTests → freshAgent.
//
// Exports (exactly three, per the module contract):
//   proofRunner     : ProofRunner — real configuration (budgets from env, 2s poll)
//   fakeProofRunner : ProofRunner — offline configuration (fast poll, still >60s test
//                     budget so the background+poll path is exercised even in fakes)
//   getProofRunner(): ProofRunner — fakeProofRunner when AHD_PROOFS_FAKE==='1', else
//                     proofRunner. getProofRunner(repo?) (optional Repository parameter)
//                     returns an observed runner that appends one ToolEvent per proof.
//
// Proof semantics (Build Plan → Architecture; product/AGENTS.md "What the product is"):
//   replay      — re-run the failing call from Failure.request against the sandbox;
//                 pass iff it now succeeds (exit 0).
//   vendorTests — run the vendor's test command; budgets above the Blaxel 60s wait cap
//                 start backgrounded and poll (docs.blaxel.ai, Sandboxes → processes).
//   freshAgent  — runs in a sandbox FORKED from the snapshot (caller forks via
//                 runner.fork and passes the forked handle), given ONLY the original
//                 task + the changed docs, never the resolver's reasoning; we scrub the
//                 known resolver-state paths first so a stale fork cannot leak them.
//
// A failed proof returns { pass: false, detail } naming what failed — it NEVER throws to
// hide a failure. Only infrastructure errors (sandbox unreachable, bad input) throw,
// with a stage name ('proofs.replay', 'sandbox.exec', …).
//
// OPEN contract assumptions (see product/CONTRACT_REQUESTS.md):
//   - replay command: Failure.request may carry { replay_cmd: string }; otherwise we
//     write the request JSON into the sandbox and run a harness at /ahd/replay.mjs
//   - vendor test command: read from sandbox file /ahd/test-command, fallback 'npm test'
//   - freshAgent `changed: string[]` = sandbox-relative file paths of the changed docs
import { randomUUID } from 'node:crypto';
import type { Failure, ProofName, ProofResult, ProofRunner, SandboxHandle } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { messageOf, runCapped, tailText } from '../sandbox/client.ts';

interface ProofOptions {
  /** field on Failure.request that, when a non-empty string, is the exact replay command. */
  requestCommandField?: string;
  replayHarness?: string;
  freshAgentHarness?: string;
  vendorTestCommandFile?: string;
  vendorTestCommandFallback?: string;
  replayBudgetMs?: number;
  vendorTestBudgetMs?: number;
  freshAgentBudgetMs?: number;
  pollIntervalMs?: number;
}

const DEFAULTS: Required<ProofOptions> = {
  requestCommandField: 'replay_cmd',
  replayHarness: 'node /ahd/replay.mjs',
  freshAgentHarness: 'node /ahd/fresh-agent.mjs',
  vendorTestCommandFile: '/ahd/test-command',
  vendorTestCommandFallback: 'npm test',
  replayBudgetMs: 30_000, // within the 60s cap → direct exec
  vendorTestBudgetMs: 300_000, // above the cap → background+poll (docs: 60s max wait)
  freshAgentBudgetMs: 300_000,
  pollIntervalMs: 2_000,
};

/** Case ids reach sandbox paths; keep them inert. */
function sanitizeForPath(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

function positiveIntFromEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

class Proofs implements ProofRunner {
  private opts: Required<ProofOptions>;

  constructor(opts?: ProofOptions) {
    this.opts = { ...DEFAULTS, ...stripUndefined(opts ?? {}) };
  }

  async replay(sb: SandboxHandle, f: Failure): Promise<ProofResult> {
    const stage = 'proofs.replay';
    if (!f || typeof f.id !== 'string' || f.id.length === 0) {
      throw new Error(`${stage}: a Failure with a non-empty id is required`);
    }
    const caseDir = `/ahd/cases/${sanitizeForPath(f.id)}`;
    const requestPath = `${caseDir}/request.json`;
    try {
      await sb.write(requestPath, JSON.stringify(f.request ?? null, null, 2));
    } catch (err) {
      throw new Error(`${stage}: sandbox.write(${requestPath}) failed: ${messageOf(err)}`);
    }
    const cmd = this.replayCommandFor(f, requestPath);
    const res = await runCapped(sb, cmd, { timeout_ms: this.opts.replayBudgetMs, poll_interval_ms: this.opts.pollIntervalMs });
    if (res.exit_code === 0) {
      return { proof: 'replay', pass: true, detail: `replay of ${f.id} now succeeds (exit 0): ${tailText(res.stdout)}` };
    }
    return {
      proof: 'replay',
      pass: false,
      detail: `replay of ${f.id} still fails: '${tailText(cmd, 120)}' exited ${res.exit_code}; stderr: ${tailText(res.stderr || res.stdout)}`,
    };
  }

  async vendorTests(sb: SandboxHandle): Promise<ProofResult> {
    const { cmd, note } = await this.vendorTestCommand(sb);
    const res = await runCapped(sb, cmd, { timeout_ms: this.opts.vendorTestBudgetMs, poll_interval_ms: this.opts.pollIntervalMs });
    if (res.exit_code === 0) {
      return { proof: 'vendor_tests', pass: true, detail: `vendor tests passed (exit 0): '${cmd}'${note}: ${tailText(res.stdout)}` };
    }
    return {
      proof: 'vendor_tests',
      pass: false,
      detail: `vendor tests failed: '${cmd}' exited ${res.exit_code}${note}; output: ${tailText(res.stderr || res.stdout)}`,
    };
  }

  async freshAgent(sb: SandboxHandle, task: string, changed: string[]): Promise<ProofResult> {
    const stage = 'proofs.freshAgent';
    if (typeof task !== 'string' || task.trim().length === 0) {
      throw new Error(`${stage}: the original task text is required (the fresh agent gets ONLY task + changed docs)`);
    }
    if (!Array.isArray(changed)) throw new Error(`${stage}: changed must be an array of changed-doc paths`);

    // Scrub known resolver-state paths so nothing but task+docs can reach the fresh run.
    // The fork itself is the real isolation (Build Plan → Architecture → Fresh-agent
    // check); this is belt-and-braces for forks taken late.
    let scrubNote = '';
    const scrub = await sb.exec('rm -rf /ahd/resolver /tmp/ahd-resolver /ahd/fresh', { timeout_ms: 15_000 });
    if (scrub.exit_code !== 0) scrubNote = ` (warning: resolver-state scrub exited ${scrub.exit_code})`;

    const bundle: Array<{ path: string; content: string }> = [];
    for (const p of changed) {
      if (typeof p !== 'string' || p.length === 0 || p.includes('..')) {
        return { proof: 'fresh_agent', pass: false, detail: `fresh-agent check failed: changed-doc path '${String(p)}' is not a safe relative path` };
      }
      let content: string;
      try {
        content = await sb.read(p);
      } catch (err) {
        // A changed doc we cannot read is a FAILED proof (named), not an exception:
        // the fresh agent must be given the changed docs, so missing one fails the check.
        return {
          proof: 'fresh_agent',
          pass: false,
          detail: `fresh-agent check failed: changed doc '${p}' could not be read from sandbox '${sb.name}': ${messageOf(err)}`,
        };
      }
      bundle.push({ path: p, content });
    }

    try {
      await sb.write('/ahd/fresh/task.md', task);
      await sb.write('/ahd/fresh/changed.json', JSON.stringify(bundle, null, 2));
    } catch (err) {
      throw new Error(`${stage}: sandbox.write of the fresh-agent brief failed: ${messageOf(err)}`);
    }

    const cmd = `${this.opts.freshAgentHarness} /ahd/fresh/task.md /ahd/fresh/changed.json`;
    const res = await runCapped(sb, cmd, { timeout_ms: this.opts.freshAgentBudgetMs, poll_interval_ms: this.opts.pollIntervalMs });
    if (res.exit_code === 0) {
      return { proof: 'fresh_agent', pass: true, detail: `fresh clean-context agent succeeded in a clean sandbox copy (${bundle.length} changed doc(s))${scrubNote}: ${tailText(res.stdout)}` };
    }
    return {
      proof: 'fresh_agent',
      pass: false,
      detail: `fresh clean-context agent failed (exit ${res.exit_code}) with only task + ${bundle.length} changed doc(s)${scrubNote}; output: ${tailText(res.stderr || res.stdout)}`,
    };
  }

  private replayCommandFor(f: Failure, requestPath: string): string {
    // Assumption (CONTRACT_REQUESTS.md): request objects may carry an explicit replay_cmd.
    const rec = typeof f.request === 'object' && f.request !== null ? (f.request as Record<string, unknown>) : null;
    const explicit = rec?.[this.opts.requestCommandField];
    if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit;
    return `${this.opts.replayHarness} ${requestPath}`;
  }

  private async vendorTestCommand(sb: SandboxHandle): Promise<{ cmd: string; note: string }> {
    const fallback = this.opts.vendorTestCommandFallback;
    const file = this.opts.vendorTestCommandFile;
    try {
      const fromSandbox = (await sb.read(file)).trim();
      if (fromSandbox.length > 0) return { cmd: fromSandbox, note: '' };
      return { cmd: fallback, note: ` (${file} was empty; used fallback)` };
    } catch (err) {
      // Fallback, not a swallow: the reason is surfaced in the ProofResult detail.
      return { cmd: fallback, note: ` (${file} unreadable: ${messageOf(err)}; used fallback)` };
    }
  }
}

function stripUndefined(opts: ProofOptions): ProofOptions {
  const out: ProofOptions = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Real configuration: budgets/poll overridable by env; vendor test budget stays >60s cap. */
export const proofRunner: ProofRunner = new Proofs({
  replayBudgetMs: positiveIntFromEnv('AHD_PROOF_REPLAY_BUDGET_MS') ?? undefined,
  vendorTestBudgetMs: positiveIntFromEnv('AHD_PROOF_TEST_BUDGET_MS') ?? undefined,
  freshAgentBudgetMs: positiveIntFromEnv('AHD_PROOF_FRESH_BUDGET_MS') ?? undefined,
  pollIntervalMs: positiveIntFromEnv('AHD_PROOF_POLL_MS') ?? undefined,
});

/** Offline configuration: same logic, fast polling; test budget deliberately >60s so the background+poll path runs even in fakes. */
export const fakeProofRunner: ProofRunner = new Proofs({
  replayBudgetMs: 30_000,
  vendorTestBudgetMs: 90_000,
  freshAgentBudgetMs: 90_000,
  pollIntervalMs: 5,
});

// ---- observability wrapper: one ToolEvent per proof ----

const PROOF_STAGE: Record<ProofName, string> = {
  replay: 'proofs.replay',
  vendor_tests: 'proofs.vendor_tests',
  fresh_agent: 'proofs.fresh_agent',
};

function ticketFromSandboxName(name: string): string {
  return name.startsWith('ahd-') ? name.slice(4) : name;
}

function observeProofs(inner: ProofRunner, repo: Repository): ProofRunner {
  const wrap = async (proof: ProofName, ticketId: string, fn: () => Promise<ProofResult>): Promise<ProofResult> => {
    const t0 = Date.now();
    const base = {
      id: randomUUID(),
      ticket_id: ticketId,
      stage: PROOF_STAGE[proof],
      tool: 'proofs',
      action: proof,
      t_ms: t0,
      at: new Date().toISOString(),
    };
    try {
      const result = await fn();
      await repo.appendToolEvent({ ...base, d_ms: Date.now() - t0, result: result.pass ? 'pass' : 'fail', payload: { detail: result.detail } });
      return result;
    } catch (err) {
      // Record the infrastructure failure, then rethrow — never mask it.
      await repo.appendToolEvent({ ...base, d_ms: Date.now() - t0, result: 'error', payload: { error: messageOf(err) } });
      throw err;
    }
  };
  return {
    replay(sb, f) {
      return wrap('replay', typeof f?.id === 'string' && f.id.length > 0 ? f.id : ticketFromSandboxName(sb.name), () => inner.replay(sb, f));
    },
    vendorTests(sb) {
      return wrap('vendor_tests', ticketFromSandboxName(sb.name), () => inner.vendorTests(sb));
    },
    freshAgent(sb, task, changed) {
      return wrap('fresh_agent', ticketFromSandboxName(sb.name), () => inner.freshAgent(sb, task, changed));
    },
  };
}

/**
 * fakeProofRunner when AHD_PROOFS_FAKE==='1', else proofRunner. Pass a Repository to
 * append a ToolEvent per proof (getProofRunner() with no args matches the contract).
 */
export function getProofRunner(repo?: Repository): ProofRunner {
  const base = process.env.AHD_PROOFS_FAKE === '1' ? fakeProofRunner : proofRunner;
  return repo ? observeProofs(base, repo) : base;
}
