// demo/local-runner.ts: a REHEARSAL sandbox that runs real commands in a temp directory.
//
// It exists so the whole loop (real vendor tests, real replay, real Claude-driven resolver and
// fresh agent, if pointed at the API) can be rehearsed before the Blaxel key is in hand. It is
// NOT Blaxel: there is no isolation, and absolute `/ahd/...` paths in commands are rewritten to
// live under a per-sandbox directory. Anything recorded for YC must use the Blaxel runner.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { backgroundWrapper, newBackgroundPid } from '../product/sandbox/client.ts';
import type { ExecResult, SandboxHandle, SandboxRunner } from '../product/shared/types.ts';

const RELATIVE_ROOT = 'ahd/work';

export function makeLocalRunner(base: string): SandboxRunner {
  const root = resolve(base);
  const dirOf = (name: string): string => join(root, name);

  const handleFor = (name: string): SandboxHandle => {
    const dir = dirOf(name);
    const abs = (p: string): string => (p.startsWith('/') ? join(dir, p) : join(dir, RELATIVE_ROOT, p));
    const rewrite = (cmd: string): string => cmd.replace(/(^|[\s'"=:(])\/ahd\//g, (_m, pre: string) => `${pre}${dir}/ahd/`);
    return {
      name,
      async exec(cmd, opts): Promise<ExecResult> {
        const timeout = opts?.timeout_ms ?? 60_000;
        // Same background convention as the real handle: start detached, print the pid token.
        const pid = opts?.background === true ? newBackgroundPid() : '';
        const command = opts?.background === true ? backgroundWrapper(rewrite(cmd), pid) : rewrite(cmd);
        return await new Promise<ExecResult>((done) => {
          const child = spawn('bash', ['-c', command], { cwd: dir, env: process.env, detached: opts?.background === true });
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
          child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
          child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
          child.on('close', (code) => {
            clearTimeout(timer);
            done({ stdout, stderr, exit_code: code ?? 137 });
          });
        });
      },
      async write(path, content): Promise<void> {
        const full = abs(path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, 'utf8');
      },
      async read(path): Promise<string> {
        return await readFile(abs(path), 'utf8');
      },
      async snapshot(): Promise<string> {
        return `local:${name}`;
      },
    };
  };

  return {
    async createOrResume(name): Promise<SandboxHandle> {
      await mkdir(dirOf(name), { recursive: true });
      return handleFor(name);
    },
    async fork(snapshotId, newName): Promise<SandboxHandle> {
      const source = snapshotId.replace(/^local:/, '');
      await rm(dirOf(newName), { recursive: true, force: true });
      await cp(dirOf(source), dirOf(newName), { recursive: true });
      return handleFor(newName);
    },
    async destroy(name): Promise<void> {
      await rm(dirOf(name), { recursive: true, force: true });
    },
  };
}
