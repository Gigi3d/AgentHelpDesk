// sandbox/runner.ts — SandboxRunner selection + the real Blaxel-backed runner.
//
// Exports (exactly three, per the module contract):
//   blaxelRunner : SandboxRunner  — real Blaxel via sandbox/client.ts (all network there)
//   fakeRunner   : SandboxRunner  — offline in-memory fake (sandbox/fake.ts)
//   getRunner()  : SandboxRunner  — fakeRunner when AHD_SANDBOX_FAKE==='1' or no
//                                   BLAXEL_API_KEY; otherwise blaxelRunner.
// getRunner(repo?) additionally accepts a Repository (optional parameter) so callers can
// get an observed runner that appends a ToolEvent for every create/resume, fork and
// destroy — "take repo as a parameter where needed" (product/AGENTS.md observability).
// getRunner() with no arguments matches the contract signature exactly.
//
// Naming convention (Build Plan → Architecture → Sandbox): one sandbox per open case,
// named `ahd-<ticketId>`, created once with SandboxInstance.createIfNotExists and
// resumed thereafter with SandboxInstance.get (standby resume restores fs + processes
// in ~ms — docs.blaxel.ai, Sandboxes). fork(snapshotId, newName) backs the fresh-agent
// check: a forked sandbox cannot inherit the resolver's post-snapshot state.
import { randomUUID } from 'node:crypto';
import type { ExecResult, SandboxHandle, SandboxRunner } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import * as client from './client.ts';
import { fakeRunner as fakeRunnerInstance } from './fake.ts';

// ---- real Blaxel runner ----

class BlaxelHandle implements SandboxHandle {
  readonly name: string;
  private sb: client.BlaxelSandboxLike;

  constructor(name: string, sb: client.BlaxelSandboxLike) {
    this.name = name;
    this.sb = sb;
  }

  async exec(cmd: string, opts?: { timeout_ms?: number; background?: boolean }): Promise<ExecResult> {
    if (opts?.background === true) {
      // Docs cap one waited command at 60s, so background semantics are implemented by
      // detaching under a shell and echoing a pid token immediately; client.poll() reads
      // the exit-code file afterwards (see client.ts backgroundWrapper).
      const pid = client.newBackgroundPid();
      const started = await client.blxExec(this.sb, client.backgroundWrapper(cmd, pid), {
        timeout_ms: Math.min(opts?.timeout_ms ?? 15_000, client.BLAXEL_EXEC_WAIT_CAP_MS),
      });
      if (started.exit_code !== 0) {
        throw new Error(`sandbox.exec: background start failed on '${this.name}': ${client.tailText(started.stderr || started.stdout)}`);
      }
      return { stdout: pid, stderr: '', exit_code: 0 };
    }
    const timeoutMs = opts?.timeout_ms;
    return client.blxExec(this.sb, cmd, timeoutMs !== undefined ? { timeout_ms: timeoutMs } : undefined);
  }

  async write(path: string, content: string): Promise<void> {
    await client.blxWrite(this.sb, path, content);
  }

  async read(path: string): Promise<string> {
    return client.blxRead(this.sb, path);
  }

  async snapshot(): Promise<string> {
    return client.blxSnapshot(this.sb, this.name);
  }
}

class BlaxelRunner implements SandboxRunner {
  async createOrResume(name: string): Promise<SandboxHandle> {
    if (typeof name !== 'string' || name.length === 0) throw new Error('sandbox.createOrResume: sandbox name must be a non-empty string');
    try {
      // Resume first: SandboxInstance.get restores a standby sandbox in ~ms (docs).
      return new BlaxelHandle(name, await client.blxGet(name));
    } catch (getErr) {
      // Not resumable (never created / archived) → documented create-if-not-exists path.
      try {
        return new BlaxelHandle(name, await client.blxCreateIfNotExists(name));
      } catch (createErr) {
        throw new Error(
          `sandbox.createOrResume: could not resume ('${client.messageOf(getErr)}') nor create ('${client.messageOf(createErr)}') sandbox '${name}'`,
        );
      }
    }
  }

  async fork(snapshotId: string, newName: string): Promise<SandboxHandle> {
    if (typeof snapshotId !== 'string' || snapshotId.length === 0) throw new Error('sandbox.fork: snapshotId must be a non-empty string');
    if (typeof newName !== 'string' || newName.length === 0) throw new Error('sandbox.fork: newName must be a non-empty string');
    return new BlaxelHandle(newName, await client.blxFork(snapshotId, newName));
  }

  async destroy(name: string): Promise<void> {
    if (typeof name !== 'string' || name.length === 0) throw new Error('sandbox.destroy: name must be a non-empty string');
    await client.blxDestroy(name);
  }
}

export const blaxelRunner: SandboxRunner = new BlaxelRunner();
export const fakeRunner: SandboxRunner = fakeRunnerInstance;

// ---- observability wrapper (ToolEvent per sandbox lifecycle call) ----

function ticketFromSandboxName(name: string): string {
  return name.startsWith('ahd-') ? name.slice(4) : name;
}

async function withToolEvent<T>(
  repo: Repository,
  stage: string,
  action: string,
  sandboxName: string,
  payloadExtra: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  const base = {
    id: randomUUID(),
    ticket_id: ticketFromSandboxName(sandboxName),
    stage,
    tool: 'sandbox',
    action,
    t_ms: t0,
    at: new Date().toISOString(),
  };
  try {
    const value = await fn();
    await repo.appendToolEvent({ ...base, d_ms: Date.now() - t0, result: 'ok', payload: { sandbox: sandboxName, ...payloadExtra } });
    return value;
  } catch (err) {
    // Record the failure, then rethrow — the event must never mask the error.
    await repo.appendToolEvent({
      ...base,
      d_ms: Date.now() - t0,
      result: 'error',
      payload: { sandbox: sandboxName, ...payloadExtra, error: client.messageOf(err) },
    });
    throw err;
  }
}

function observeRunner(inner: SandboxRunner, repo: Repository): SandboxRunner {
  return {
    createOrResume(name) {
      return withToolEvent(repo, 'sandbox.createOrResume', 'create_or_resume', name, {}, () => inner.createOrResume(name));
    },
    fork(snapshotId, newName) {
      return withToolEvent(repo, 'sandbox.fork', 'fork', newName, { snapshot_id: snapshotId }, () => inner.fork(snapshotId, newName));
    },
    destroy(name) {
      return withToolEvent(repo, 'sandbox.destroy', 'destroy', name, {}, () => inner.destroy(name));
    },
  };
}

/**
 * fakeRunner when AHD_SANDBOX_FAKE==='1' or BLAXEL_API_KEY is unset; else blaxelRunner.
 * Pass a Repository to also append ToolEvents for create/resume, fork and destroy.
 */
export function getRunner(repo?: Repository): SandboxRunner {
  const base = process.env.AHD_SANDBOX_FAKE === '1' || !process.env.BLAXEL_API_KEY ? fakeRunner : blaxelRunner;
  return repo ? observeRunner(base, repo) : base;
}
