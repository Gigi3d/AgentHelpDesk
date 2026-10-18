// sandbox/client.ts — the ONLY file that talks to Blaxel (all network lives here).
//
// Sponsor doc facts this file relies on (Blaxel docs, docs.blaxel.ai — "Sandboxes"
// section; mirrored in "AgentHelpDesk Build Plan.md" → "Check before promising"):
//   - sandboxes are created with `SandboxInstance.createIfNotExists({ name, image, ... })`
//   - sandboxes are resumed with `SandboxInstance.get(name)` — standby resume restores
//     the filesystem AND running processes in ~ms, so a case is a resume, not a rebuild
//   - commands run with `sandbox.process.exec`, files are written with `sandbox.fs.write`
//   - ONE command may wait at most 60 seconds, so anything longer must be started
//     backgrounded and polled — that cap is handled here (`runCapped`, `poll`).
//   - snapshots can be forked (used for the fresh-agent proof).
//
// Honesty rules (product/AGENTS.md "Sponsor SDK honesty"):
//   - product/ has ZERO runtime dependencies, so `@blaxel/core` is loaded lazily via a
//     non-literal dynamic import and used through the minimal structural types below.
//     Nothing is invented: every call we are not 100% sure of is an optional probe that
//     fails loud with a stage name and points at AHD_SANDBOX_FAKE=1 as the offline path.
//   - OPEN items (also flagged in sandbox/README.md): exact SDK shapes for snapshot,
//     fork and destroy; the sandbox image name (AHD_SANDBOX_IMAGE is required, we refuse
//     to guess one); concurrent-sandbox quota; standby storage cost.
import { randomUUID } from 'node:crypto';
import type { ExecResult, SandboxHandle } from '../shared/types.ts';

/** Docs: one command may wait at most 60 seconds. Anything longer goes background+poll. */
export const BLAXEL_EXEC_WAIT_CAP_MS = 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** pid tokens we hand out for background runs; also a shell-safety guard for `poll`. */
const PID_RE = /^[A-Za-z0-9-]{1,64}$/;

// ---- minimal structural view of the SDK (probed, never assumed) ----
export interface BlaxelSandboxLike {
  name?: unknown;
  process?: { exec?: (cmd: string) => Promise<unknown> };
  fs?: { write?: (path: string, content: string) => Promise<unknown> };
  // The three calls below are NOT in the doc facts we were given; they are optional
  // probes so we never invent a method that is not there at runtime (fail loud instead).
  snapshot?: (...args: unknown[]) => Promise<unknown>;
  kill?: (...args: unknown[]) => Promise<unknown>;
  delete?: (...args: unknown[]) => Promise<unknown>;
}
interface BlaxelSdkLike {
  SandboxInstance?: {
    // Documented (build plan "Check before promising"): createIfNotExists + get.
    createIfNotExists?: (opts: Record<string, unknown>) => Promise<unknown>;
    get?: (name: string) => Promise<unknown>;
    // OPEN: fork/destroy statics are unconfirmed; probed, not assumed.
    fork?: (...args: unknown[]) => Promise<unknown>;
    delete?: (...args: unknown[]) => Promise<unknown>;
    kill?: (...args: unknown[]) => Promise<unknown>;
  };
}

const SDK_MODULE = '@blaxel/core'; // package name per Blaxel quickstart; NOT bundled (zero-dep rule)
let sdkPromise: Promise<BlaxelSdkLike> | null = null; // SDK handle cache — not case state

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** POSIX single-quote escaping; used for every path/command we interpolate into a shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function tailText(s: string, max = 280): string {
  const t = s.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

export function loadSdk(): Promise<BlaxelSdkLike> {
  if (!process.env.BLAXEL_API_KEY) {
    return Promise.reject(
      new Error('sandbox.client: BLAXEL_API_KEY is not set — refusing to call Blaxel; set the key or run with AHD_SANDBOX_FAKE=1'),
    );
  }
  if (!sdkPromise) {
    const specifier: string = SDK_MODULE; // non-literal specifier: keeps typecheck + offline import working without the dep installed
    sdkPromise = import(specifier).then(
      (mod: unknown) => (asRecord(mod) ?? {}) as BlaxelSdkLike,
      (err: unknown) => {
        sdkPromise = null;
        throw new Error(
          `sandbox.client: could not load ${SDK_MODULE} (${messageOf(err)}). The SDK is not bundled (product/ has zero runtime deps); install it next to the orchestrator or run with AHD_SANDBOX_FAKE=1.`,
        );
      },
    );
  }
  return sdkPromise;
}

function pickString(body: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string') return v;
    if (v !== undefined && v !== null) return String(v);
  }
  return null;
}

function pickNumber(body: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  }
  return null;
}

/** Defensive normalizer: the exact SDK exec-result shape is unconfirmed, so accept the plausible ones and fail loud otherwise. */
export function normalizeExec(raw: unknown): ExecResult {
  const root = asRecord(raw);
  if (!root) throw new Error('sandbox.exec: Blaxel exec returned a non-object result — cannot normalize');
  const body = asRecord(root['result']) ?? root; // some SDK shapes nest the result under .result (unconfirmed)
  const exit = pickNumber(body, ['exitCode', 'exit_code', 'code']);
  if (exit === null) {
    throw new Error(
      `sandbox.exec: unrecognized Blaxel exec result (no exitCode/exit_code/code); saw keys [${Object.keys(root).join(', ')}] — confirm the SDK shape against docs.blaxel.ai (Sandboxes → processes)`,
    );
  }
  return { stdout: pickString(body, ['stdout', 'output']) ?? '', stderr: pickString(body, ['stderr', 'error']) ?? '', exit_code: exit };
}

function asSandbox(raw: unknown, stage: string): BlaxelSandboxLike {
  const rec = asRecord(raw);
  if (!rec) throw new Error(`${stage}: Blaxel SDK did not return a sandbox object`);
  return rec as unknown as BlaxelSandboxLike;
}

async function sandboxInstanceStatics(stage: string): Promise<NonNullable<BlaxelSdkLike['SandboxInstance']>> {
  const sdk = await loadSdk();
  if (!sdk.SandboxInstance) {
    throw new Error(`${stage}: ${SDK_MODULE} exports no SandboxInstance — cannot match docs.blaxel.ai (Sandboxes); run with AHD_SANDBOX_FAKE=1 offline`);
  }
  return sdk.SandboxInstance;
}

function sandboxImage(): string {
  const image = process.env.AHD_SANDBOX_IMAGE;
  if (!image) {
    // OPEN: we refuse to guess a default image name. docs.blaxel.ai (Sandboxes → create)
    // shows createIfNotExists({ name, image, ... }); the image catalog is account-specific.
    throw new Error('sandbox.create: AHD_SANDBOX_IMAGE must name the Blaxel sandbox image (createIfNotExists requires it; we do not guess image names)');
  }
  return image;
}

/** Documented: SandboxInstance.createIfNotExists({ name, image, memory, labels, region, ... }) — docs.blaxel.ai, Sandboxes → create. */
export async function blxCreateIfNotExists(name: string): Promise<BlaxelSandboxLike> {
  const si = await sandboxInstanceStatics('sandbox.create');
  if (typeof si.createIfNotExists !== 'function') {
    throw new Error('sandbox.create: SandboxInstance.createIfNotExists is missing from the installed SDK — version mismatch vs docs.blaxel.ai');
  }
  const opts: Record<string, unknown> = {
    name,
    image: sandboxImage(),
    memory: Number(process.env.AHD_SANDBOX_MEMORY_MB ?? 2048),
    labels: { app: 'agenthelpdesk', case: name },
  };
  const region = process.env.BLAXEL_REGION;
  if (region) opts['region'] = region;
  return asSandbox(await si.createIfNotExists(opts), 'sandbox.create');
}

/** Documented: SandboxInstance.get(name) resumes a standby sandbox (fs + processes) in ~ms — docs.blaxel.ai, Sandboxes → resume/standby. */
export async function blxGet(name: string): Promise<BlaxelSandboxLike> {
  const si = await sandboxInstanceStatics('sandbox.resume');
  if (typeof si.get !== 'function') {
    throw new Error('sandbox.resume: SandboxInstance.get is missing from the installed SDK — version mismatch vs docs.blaxel.ai');
  }
  return asSandbox(await si.get(name), 'sandbox.resume');
}

/**
 * Documented: sandbox.process.exec — docs.blaxel.ai, Sandboxes → processes.
 * The docs cap a single waited command at 60s; we clamp the client-side race to that
 * cap (plus 2s grace so the SDK's own handling wins when it can) and fail loud on overrun.
 */
export async function blxExec(sb: BlaxelSandboxLike, cmd: string, opts?: { timeout_ms?: number }): Promise<ExecResult> {
  const proc = sb.process;
  if (!proc || typeof proc.exec !== 'function') {
    throw new Error('sandbox.exec: sandbox has no process.exec — cannot match docs.blaxel.ai (Sandboxes → processes)');
  }
  const waitMs = Math.min(opts?.timeout_ms ?? BLAXEL_EXEC_WAIT_CAP_MS, BLAXEL_EXEC_WAIT_CAP_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw: unknown = await Promise.race([
      proc.exec.call(proc, cmd),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`sandbox.exec: Blaxel did not return within ${waitMs}ms (docs cap ${BLAXEL_EXEC_WAIT_CAP_MS}ms): ${tailText(cmd, 120)}`)),
          waitMs + 2_000,
        );
      }),
    ]);
    return normalizeExec(raw);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Documented: sandbox.fs.write — docs.blaxel.ai, Sandboxes → filesystem. */
export async function blxWrite(sb: BlaxelSandboxLike, path: string, content: string): Promise<void> {
  const fs = sb.fs;
  if (!fs || typeof fs.write !== 'function') {
    throw new Error('sandbox.write: sandbox has no fs.write — cannot match docs.blaxel.ai (Sandboxes → filesystem)');
  }
  await fs.write.call(fs, path, content);
}

/** fs.read is NOT in our confirmed doc facts, so reads go through documented process.exec + cat. */
export async function blxRead(sb: BlaxelSandboxLike, path: string): Promise<string> {
  const r = await blxExec(sb, `cat ${shellQuote(path)}`);
  if (r.exit_code !== 0) {
    throw new Error(`sandbox.read: cat ${path} failed (exit ${r.exit_code}): ${tailText(r.stderr)}`);
  }
  return r.stdout;
}

/**
 * OPEN/unconfirmed: the doc facts say "snapshots can be forked" but do not name the call.
 * We probe the documented surface instead of inventing one, and fail loud pointing at the
 * fake. Confirm the real method against docs.blaxel.ai (Sandboxes → snapshots) before demo.
 */
export async function blxSnapshot(sb: BlaxelSandboxLike, name: string): Promise<string> {
  if (typeof sb.snapshot === 'function') {
    const raw: unknown = await sb.snapshot();
    if (typeof raw === 'string' && raw.length > 0) return raw;
    const rec = asRecord(raw);
    for (const key of ['id', 'snapshotId', 'snapshot_id', 'name']) {
      const v = rec?.[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    throw new Error(`sandbox.snapshot: snapshot call returned an unrecognized shape for '${name}' — confirm against docs.blaxel.ai (Sandboxes → snapshots)`);
  }
  throw new Error(
    `sandbox.snapshot: no snapshot call found on sandbox '${name}'. The exact SDK method is unconfirmed (docs say snapshots can be forked); run with AHD_SANDBOX_FAKE=1 offline or confirm the call in docs.blaxel.ai (Sandboxes → snapshots).`,
  );
}

/** OPEN/unconfirmed: fork-from-snapshot call shape. Probed, never invented silently; fails loud. */
export async function blxFork(snapshotId: string, newName: string): Promise<BlaxelSandboxLike> {
  const si = await sandboxInstanceStatics('sandbox.fork');
  if (typeof si.fork === 'function') {
    return asSandbox(await si.fork(snapshotId, { name: newName }), 'sandbox.fork');
  }
  if (typeof si.createIfNotExists === 'function') {
    // Best-effort with the ONE documented create call; the `snapshot` option name is
    // UNCONFIRMED — verify against docs.blaxel.ai (Sandboxes → snapshots/fork) before demo.
    return asSandbox(
      await si.createIfNotExists({ name: newName, image: sandboxImage(), snapshot: snapshotId, labels: { app: 'agenthelpdesk', forked_from: snapshotId } }),
      'sandbox.fork',
    );
  }
  throw new Error('sandbox.fork: neither SandboxInstance.fork nor createIfNotExists is available — cannot fork snapshot for the fresh-agent proof');
}

/** OPEN/unconfirmed: teardown call shape (sb.kill / sb.delete / static delete). Probed; fails loud. */
export async function blxDestroy(name: string): Promise<void> {
  const si = await sandboxInstanceStatics('sandbox.destroy');
  try {
    const sb = await blxGet(name);
    if (typeof sb.kill === 'function') return void (await sb.kill());
    if (typeof sb.delete === 'function') return void (await sb.delete());
  } catch (err) {
    // Not resumable — fall through to the static teardown probe; the original error is
    // kept in the final loud failure below rather than swallowed.
    if (typeof si.delete !== 'function' && typeof si.kill !== 'function') {
      throw new Error(`sandbox.destroy: could not resume '${name}' (${messageOf(err)}) and no static delete/kill exists on SandboxInstance`);
    }
  }
  if (typeof si.delete === 'function') return void (await si.delete(name));
  if (typeof si.kill === 'function') return void (await si.kill(name));
  throw new Error(`sandbox.destroy: no documented teardown call found for '${name}' — confirm against docs.blaxel.ai (Sandboxes → lifecycle)`);
}

// ---- 60s-cap handling: background start + poll over exit-code files ----
// Convention (shared by the real handle and the fake, see CONTRACT_REQUESTS.md):
//   handle.exec(cmd, { background: true }) returns immediately with the pid token in
//   stdout; the run's files live at /tmp/ahd-bg-<pid>.{out,err,exit}; poll() below reads
//   the exit-code file through the plain contract (exec+cat), so it works on ANY handle.

export interface BackgroundPaths {
  out: string;
  err: string;
  exit: string;
}

export function backgroundPaths(pid: string): BackgroundPaths {
  if (!PID_RE.test(pid)) throw new Error(`sandbox.poll: malformed background pid '${tailText(pid, 40)}'`);
  return { out: `/tmp/ahd-bg-${pid}.out`, err: `/tmp/ahd-bg-${pid}.err`, exit: `/tmp/ahd-bg-${pid}.exit` };
}

export function newBackgroundPid(): string {
  return `bg-${randomUUID()}`;
}

/**
 * Wraps cmd so it runs detached, captures stdout/stderr/exit-code under /tmp/ahd-bg-<pid>.*,
 * and echoes the pid immediately. Assumes sandbox.process.exec evaluates the string via a
 * POSIX shell (docs show command strings; OPEN: confirm at integration).
 */
export function backgroundWrapper(cmd: string, pid: string): string {
  const p = backgroundPaths(pid);
  const inner = `( ${cmd} ) >${p.out} 2>${p.err}; echo $? >${p.exit}`;
  return `sh -c ${shellQuote(inner)} & echo ${pid}`;
}

/** Reads the exit-code file; returns null while the background run is still going. */
export async function poll(handle: SandboxHandle, pid: string): Promise<ExecResult | null> {
  const p = backgroundPaths(pid); // validates pid shape before it reaches a shell
  const exitRead = await handle.exec(`cat ${shellQuote(p.exit)}`, { timeout_ms: 15_000 });
  if (exitRead.exit_code !== 0) return null; // exit file not written yet → still running
  const code = Number.parseInt(exitRead.stdout.trim(), 10);
  if (!Number.isFinite(code)) return null;
  const out = await handle.exec(`cat ${shellQuote(p.out)}`, { timeout_ms: 15_000 });
  const err = await handle.exec(`cat ${shellQuote(p.err)}`, { timeout_ms: 15_000 });
  return {
    stdout: out.exit_code === 0 ? out.stdout : '',
    stderr: err.exit_code === 0 ? err.stdout : '',
    exit_code: code,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The 60s-cap rule from the docs, as one call: budgets within the cap wait directly;
 * bigger budgets start the command backgrounded and poll the exit-code file. Overrunning
 * the budget fails loud (stage sandbox.exec.timeout) instead of hanging the case.
 * cap_ms exists only so tests can exercise both branches without waiting 60 real
 * seconds; production callers leave it at the documented Blaxel cap.
 */
export async function runCapped(
  handle: SandboxHandle,
  cmd: string,
  opts?: { timeout_ms?: number; poll_interval_ms?: number; cap_ms?: number },
): Promise<ExecResult> {
  const cap = opts?.cap_ms ?? BLAXEL_EXEC_WAIT_CAP_MS;
  const budget = opts?.timeout_ms ?? BLAXEL_EXEC_WAIT_CAP_MS;
  const interval = opts?.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
  if (budget <= cap) {
    return handle.exec(cmd, { timeout_ms: budget });
  }
  const started = await handle.exec(cmd, { background: true, timeout_ms: cap });
  const pid = started.stdout.trim();
  if (started.exit_code !== 0 || !PID_RE.test(pid)) {
    throw new Error(
      `sandbox.exec: background start failed (exit ${started.exit_code}, pid '${tailText(pid, 40)}'): ${tailText(started.stderr || started.stdout)}`,
    );
  }
  const t0 = Date.now();
  for (;;) {
    const done = await poll(handle, pid);
    if (done) return done;
    if (Date.now() - t0 >= budget) {
      throw new Error(`sandbox.exec: command still running after ${budget}ms budget (pid ${pid}, stage sandbox.exec.timeout): ${tailText(cmd, 120)}`);
    }
    await sleep(interval);
  }
}
