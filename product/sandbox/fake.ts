// sandbox/fake.ts — FakeRunner: an in-memory filesystem + process model of a Blaxel
// sandbox, good enough to run the whole AgentHelpDesk loop offline (tests, demos, CI).
// Selected via AHD_SANDBOX_FAKE=1 or automatically when BLAXEL_API_KEY is absent
// (see sandbox/runner.ts getRunner()).
//
// What it models (and what it does NOT):
//   - per-sandbox in-memory files + a seeded "broken" flag, one sandbox per name
//   - exec recognizes a small command set: 'git clone' (seeds from sandbox/fixtures/),
//     test-shaped commands (anything matching test/replay/fresh-agent — they exit 1
//     while the seeded flag is set, 0 once a fix lands), 'echo', 'cat', 'rm -rf', 'sleep'
//   - background exec follows the same contract convention as the real client
//     (stdout = pid token, files at /tmp/ahd-bg-<pid>.{out,err,exit}); a background run
//     finishes after N polls of its exit file (N = background_ticks, fixtures config),
//     which exercises the real poll loop deterministically
//   - snapshot() deep-copies files+flag; fork() restores that copy — so a fork can never
//     inherit writes made after the snapshot (this is what makes the fresh-agent proof's
//     isolation assertable offline)
//   - it does NOT execute real code: no node, no git, no network. Unknown commands exit
//     127 with a loud stderr (they never throw), matching sandbox semantics.
//
// Fixtures (optional): sandbox/fixtures/<repo>/... is copied into the sandbox on
// `git clone <anything>/<repo>[.git]`; a file named BROKEN in the fixture sets the
// seeded failing flag. sandbox/fixtures/config.json may set { "background_ticks": n }.
//
// The "fix" rule (models the resolver editing the vendor's docs/code): writing to a path
// that was seeded at clone time, or any path ending in `.fix`, clears the broken flag;
// writing a file named BROKEN sets it again.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecResult, SandboxHandle, SandboxRunner } from '../shared/types.ts';
import { backgroundPaths, newBackgroundPid } from './client.ts';

export interface FakeExecLogEntry {
  cmd: string;
  background: boolean;
  timeout_ms: number | undefined;
  at: number;
}

export interface FakeSandboxState {
  name: string;
  files: Map<string, string>;
  /** paths that existed at clone/seed time — overwriting one models "the fix". */
  seeded: Set<string>;
  /** seeded flag: test-shaped commands exit 1 while true. */
  broken: boolean;
  pending: Map<string, { cmd: string; ticksLeft: number }>;
  execLog: FakeExecLogEntry[];
}

export interface FakeRunnerOptions {
  /** defaults to sandbox/fixtures next to this file. */
  fixturesDir?: string;
  /** polls of the exit file before a background run completes (overrides fixtures config). */
  backgroundTicks?: number;
}

interface FixtureSet {
  backgroundTicks: number;
  repos: Map<string, Map<string, string>>;
}

const TEST_SHAPED = /(\btest\b|--test|replay|fresh-agent)/;
const BG_FILE_RE = /^\/tmp\/ahd-bg-([A-Za-z0-9-]{1,64})\.(exit|out|err)$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}[A-Za-z0-9]$/;

function unquote(tok: string): string {
  if (tok.length >= 2 && tok.startsWith(`'`) && tok.endsWith(`'`)) {
    return tok.slice(1, -1).replace(/'\\''/g, `'`);
  }
  return tok;
}

function tokenize(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter((t) => t.length > 0).map(unquote);
}

function basenameOf(p: string): string {
  const parts = p.split('/').filter((s) => s.length > 0);
  return parts.length ? parts[parts.length - 1] : p;
}

export class FakeRunner implements SandboxRunner {
  private sandboxes = new Map<string, FakeSandboxState>(); // instance state, NOT module-global
  private snapshots = new Map<string, { files: Map<string, string>; seeded: Set<string>; broken: boolean; source: string }>();
  private fixtures: FixtureSet | null = null;
  private opts: FakeRunnerOptions;
  private snapCounter = 0;

  constructor(opts?: FakeRunnerOptions) {
    this.opts = opts ?? {};
  }

  // ---- fixture loading (lazy, memoized per instance) ----
  private loadFixtures(): FixtureSet {
    if (this.fixtures) return this.fixtures;
    const dir = this.opts.fixturesDir ?? join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
    let backgroundTicks = 2;
    const repos = new Map<string, Map<string, string>>();
    if (existsSync(dir)) {
      const configPath = join(dir, 'config.json');
      if (existsSync(configPath)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(configPath, 'utf8'));
        } catch (err) {
          throw new Error(`sandbox.fixtures: ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
        const rec = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
        const ticks = rec?.['background_ticks'];
        if (typeof ticks === 'number' && Number.isInteger(ticks) && ticks >= 1) backgroundTicks = ticks;
      }
      for (const entry of readdirSync(dir)) {
        if (entry === 'config.json') continue;
        const repoDir = join(dir, entry);
        if (!statSync(repoDir).isDirectory()) continue;
        const files = new Map<string, string>();
        for (const rel of readdirSync(repoDir, { recursive: true }) as string[]) {
          const abs = join(repoDir, rel);
          if (statSync(abs).isFile()) files.set(rel.split(/[\\/]/).join('/'), readFileSync(abs, 'utf8'));
        }
        repos.set(entry, files);
      }
    }
    this.fixtures = { backgroundTicks, repos };
    return this.fixtures;
  }

  private ticks(): number {
    return this.opts.backgroundTicks ?? this.loadFixtures().backgroundTicks;
  }

  // ---- SandboxRunner contract ----
  async createOrResume(name: string): Promise<SandboxHandle> {
    if (!NAME_RE.test(name)) throw new Error(`sandbox.createOrResume: invalid sandbox name '${name}' (expected ahd-<ticketId> shape)`);
    let st = this.sandboxes.get(name);
    if (!st) {
      st = { name, files: new Map(), seeded: new Set(), broken: false, pending: new Map(), execLog: [] };
      this.sandboxes.set(name, st);
    }
    return new FakeHandle(st, this);
  }

  async fork(snapshotId: string, newName: string): Promise<SandboxHandle> {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) throw new Error(`sandbox.fork: unknown snapshot '${snapshotId}' (fake has ${this.snapshots.size})`);
    if (!NAME_RE.test(newName)) throw new Error(`sandbox.fork: invalid sandbox name '${newName}'`);
    const existing = this.sandboxes.get(newName);
    if (existing) return new FakeHandle(existing, this); // createIfNotExists semantics: resume wins
    const st: FakeSandboxState = {
      name: newName,
      files: new Map(snap.files), // deep copy — later parent writes must NOT leak in
      seeded: new Set(snap.seeded),
      broken: snap.broken,
      pending: new Map(),
      execLog: [],
    };
    this.sandboxes.set(newName, st);
    return new FakeHandle(st, this);
  }

  async destroy(name: string): Promise<void> {
    if (!this.sandboxes.delete(name)) throw new Error(`sandbox.destroy: no fake sandbox named '${name}'`);
  }

  // ---- test/inspection helpers (not part of SandboxRunner) ----
  inspect(name: string): FakeSandboxState | undefined {
    return this.sandboxes.get(name);
  }
  reset(): void {
    this.sandboxes.clear();
    this.snapshots.clear();
  }

  /** snapshot semantics: capture files+flag now; the id restores them on fork. */
  takeSnapshot(st: FakeSandboxState): string {
    const id = `snap-${st.name}-${++this.snapCounter}-${randomUUID().slice(0, 8)}`;
    this.snapshots.set(id, { files: new Map(st.files), seeded: new Set(st.seeded), broken: st.broken, source: st.name });
    return id;
  }

  // ---- the fake "kernel" ----
  private interpret(st: FakeSandboxState, cmd: string): ExecResult {
    const toks = tokenize(cmd);
    const [head, ...rest] = toks;
    if (!head) return { stdout: '', stderr: 'fake-sandbox: empty command', exit_code: 2 };

    if (head === 'git' && rest[0] === 'clone') return this.fakeClone(st, rest.slice(1));
    if (head === 'echo') return { stdout: rest.join(' '), stderr: '', exit_code: 0 };
    if (head === 'cat') return this.fakeCat(st, rest);
    if (head === 'rm') return this.fakeRm(st, rest);
    if (head === 'sleep') return { stdout: '', stderr: '', exit_code: 0 }; // no real sleeping offline
    if (TEST_SHAPED.test(cmd)) {
      // The seeded flag decides pass/fail, mirroring "reproduce via the vendor's test
      // file in the sandbox" (Build Plan → Architecture → Sandbox).
      return st.broken
        ? { stdout: 'FAIL: seeded failure still reproduces (fake)', stderr: 'fake-sandbox: broken flag is set', exit_code: 1 }
        : { stdout: 'PASS: all checks green (fake)', stderr: '', exit_code: 0 };
    }
    return {
      stdout: '',
      stderr: `fake-sandbox: command not supported offline: '${cmd}' (extend sandbox/fake.ts or use a real Blaxel sandbox)`,
      exit_code: 127,
    };
  }

  private fakeClone(st: FakeSandboxState, args: string[]): ExecResult {
    const url = args[0];
    if (!url) return { stdout: '', stderr: 'fatal: You must specify a repository to clone.', exit_code: 128 };
    const dest = args[1] ?? basenameOf(url).replace(/\.git$/, '');
    const fixtures = this.loadFixtures().repos.get(dest);
    if (!fixtures) {
      return {
        stdout: '',
        stderr: `fake-sandbox: no fixture repository '${dest}' under sandbox/fixtures/ — add one or use a real sandbox`,
        exit_code: 128,
      };
    }
    for (const [rel, content] of fixtures) {
      const path = `${dest}/${rel}`;
      st.files.set(path, content);
      st.seeded.add(path);
    }
    if (fixtures.has('BROKEN')) st.broken = true;
    return { stdout: `Cloning into '${dest}'...`, stderr: '', exit_code: 0 };
  }

  private fakeCat(st: FakeSandboxState, args: string[]): ExecResult {
    const path = args[0];
    if (!path || args.length !== 1) return { stdout: '', stderr: 'fake-sandbox: cat takes exactly one path', exit_code: 1 };
    const bg = BG_FILE_RE.exec(path);
    if (bg) {
      const pid = bg[1];
      const kind = bg[2];
      const pending = st.pending.get(pid);
      if (pending && kind === 'exit') {
        pending.ticksLeft -= 1;
        if (pending.ticksLeft > 0) return notFound(path); // still running → poll returns null
        st.pending.delete(pid);
        const done = this.interpret(st, pending.cmd); // finish now, deterministically
        const paths = backgroundPaths(pid);
        st.files.set(paths.out, done.stdout);
        st.files.set(paths.err, done.stderr);
        st.files.set(paths.exit, String(done.exit_code));
        return { stdout: `${done.exit_code}\n`, stderr: '', exit_code: 0 };
      }
      if (pending) return notFound(path); // out/err of a still-running job
    }
    const content = st.files.get(path);
    if (content === undefined) return notFound(path);
    return { stdout: content, stderr: '', exit_code: 0 };
  }

  private fakeRm(st: FakeSandboxState, args: string[]): ExecResult {
    const recursive = args.some((a) => a === '-rf' || a === '-r' || a === '--recursive' || a === '-fr');
    for (const target of args.filter((a) => !a.startsWith('-'))) {
      if (recursive) {
        for (const key of [...st.files.keys()]) {
          if (key === target || key.startsWith(`${target}/`)) st.files.delete(key);
        }
      } else {
        st.files.delete(target);
      }
    }
    return { stdout: '', stderr: '', exit_code: 0 }; // rm -f semantics: missing paths are fine
  }

  /** Called by FakeHandle for background runs. */
  startBackground(st: FakeSandboxState, cmd: string): ExecResult {
    const pid = newBackgroundPid();
    st.pending.set(pid, { cmd, ticksLeft: this.ticks() });
    return { stdout: pid, stderr: '', exit_code: 0 };
  }

  /** Called by FakeHandle.exec for foreground commands. */
  run(st: FakeSandboxState, cmd: string): ExecResult {
    return this.interpret(st, cmd);
  }

  /** Called by FakeHandle.write: applies the seeded-fix flip rule. */
  applyWrite(st: FakeSandboxState, path: string, content: string): void {
    st.files.set(path, content);
    if (basenameOf(path) === 'BROKEN') {
      st.broken = true;
    } else if (st.seeded.has(path) || path.endsWith('.fix')) {
      st.broken = false; // the resolver overwrote a seeded file → the fix landed
    }
  }

  /** Called by FakeHandle.snapshot. */
  snapshotOf(st: FakeSandboxState): string {
    return this.takeSnapshot(st);
  }
}

function notFound(path: string): ExecResult {
  return { stdout: '', stderr: `cat: ${path}: No such file or directory`, exit_code: 1 };
}

class FakeHandle implements SandboxHandle {
  readonly name: string;
  private st: FakeSandboxState;
  private runner: FakeRunner;

  constructor(st: FakeSandboxState, runner: FakeRunner) {
    this.st = st;
    this.runner = runner;
    this.name = st.name;
  }

  async exec(cmd: string, opts?: { timeout_ms?: number; background?: boolean }): Promise<ExecResult> {
    this.st.execLog.push({ cmd, background: opts?.background === true, timeout_ms: opts?.timeout_ms, at: Date.now() });
    if (opts?.background === true) return this.runner.startBackground(this.st, cmd);
    return this.runner.run(this.st, cmd);
  }

  async write(path: string, content: string): Promise<void> {
    if (typeof path !== 'string' || path.length === 0) throw new Error(`sandbox.write: empty path in fake sandbox '${this.name}'`);
    this.runner.applyWrite(this.st, path, content);
  }

  async read(path: string): Promise<string> {
    const content = this.st.files.get(path);
    if (content === undefined) throw new Error(`sandbox.read: ${path} not found in fake sandbox '${this.name}'`);
    return content;
  }

  async snapshot(): Promise<string> {
    return this.runner.snapshotOf(this.st);
  }
}

/** Shared offline instance (re-exported by sandbox/runner.ts as `fakeRunner`). */
export const fakeRunner = new FakeRunner();
