#!/usr/bin/env node
// demo/wake.mjs: bring the hosted desk back without a full redeploy.
//   node demo/wake.mjs <desk url>      exit 0 = healthy, exit 3 = still down (caller redeploys)
// It runs /app/ensure.sh inside the existing sandbox, which restarts the desk and edge if they
// are not running, then waits for /v1/status. A sandbox that has been deleted makes this fail
// fast, and desk-control falls back to the full deploy.
// /healthz is answered by Blaxel's preview proxy even when the desk is dead, so it proves nothing:
// /v1/status is served by the desk itself.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const f = join(ROOT, 'demo/.env.live');
if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(l);
  if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!url) { console.log('usage: wake.mjs <desk url>'); process.exit(2); }
const healthy = async () => { try { return (await fetch(`${url}/v1/status`, { cache: 'no-store', signal: AbortSignal.timeout(6000) })).ok; } catch { return false; } };

if (await healthy()) { console.log('desk already healthy'); process.exit(0); }
try {
  const { SandboxInstance } = createRequire(join(ROOT, 'product/package.json'))('@blaxel/core');
  const sb = await SandboxInstance.get(process.env.AHD_DEPLOY_NAME || 'ahd-desk');
  console.log('sandbox status:', sb.status);
  // Start the processes the same way deploy does: named, kept alive and restarted by Blaxel itself.
  // (A process started from the per-minute schedule is killed when that scheduled command ends.)
  const nodeOut = await sb.process.exec({ command: 'node -v', waitForCompletion: true, timeout: 20 });
  const [maj, min] = (/v(\d+)\.(\d+)/.exec(`${nodeOut.stdout ?? nodeOut.logs ?? ''}`) ?? []).slice(1).map(Number);
  const NODE = maj > 22 || (maj === 22 && min >= 6) ? 'node' : 'npx -y node@22';
  // Keep the evidence: the dead process's last log lines and status, before the restart replaces them.
  try {
    for (const p of (await sb.process.list()).filter((x) => ['desk', 'edge'].includes(x.name) && x.status !== 'running')) console.log(`before restart: ${p.name} status=${p.status} exit=${p.exitCode ?? '-'} pid=${p.pid ?? '-'} started=${p.startedAt ?? '-'}`);
  } catch (e) { console.log('process list failed:', e?.message ?? e); }
  for (const name of ['desk', 'edge']) {
    try { console.log(`--- ${name} log before restart (last 30 lines) ---\n${String(await sb.process.logs(name, 'all')).split('\n').slice(-30).join('\n').slice(-3000)}`); } catch { /* no log */ }
  }
  console.log(`at ${new Date().toISOString()}`);
  for (const name of ['desk', 'edge']) { try { await sb.process.kill(name); } catch { /* not running */ } }
  const keep = { waitForCompletion: false, keepAlive: true, restartOnFailure: true, maxRestarts: 20 };
  await sb.process.exec({ name: 'desk', command: `bash -lc 'cd /app && set -a && . ./ahd.env && set +a && exec ${NODE} --experimental-strip-types product/server.ts'`, workingDir: '/app', ...keep });
  await sb.process.exec({ name: 'edge', command: `bash -lc 'cd /app/mcp && set -a && . /app/ahd-edge.env && set +a && exec npx mcp-use start --port 3000'`, workingDir: '/app/mcp', ...keep });
  console.log('desk and edge started');
} catch (err) {
  console.log('could not wake in place:', err?.message ?? err);
  process.exit(3);
}
for (let i = 0; i < 20; i++) {
  if (await healthy()) { console.log('desk healthy again'); process.exit(0); }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('desk still down after restarting it');
process.exit(3);
