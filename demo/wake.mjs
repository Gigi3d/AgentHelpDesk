#!/usr/bin/env node
// demo/wake.mjs: bring the hosted desk back without a full redeploy.
//   node demo/wake.mjs <desk url>      exit 0 = healthy, exit 3 = still down (caller redeploys)
// It runs /app/ensure.sh inside the existing sandbox, which restarts the desk and edge if they
// are not running, then waits for /healthz. A sandbox that has been deleted makes this fail
// fast, and desk-control falls back to the full deploy.
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
const healthy = async () => { try { return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; } };

if (await healthy()) { console.log('desk already healthy'); process.exit(0); }
try {
  const { SandboxInstance } = createRequire(join(ROOT, 'product/package.json'))('@blaxel/core');
  const sb = await SandboxInstance.get(process.env.AHD_DEPLOY_NAME || 'ahd-desk');
  console.log('sandbox status:', sb.status);
  const r = await sb.process.exec({ command: 'bash /app/ensure.sh', waitForCompletion: true, timeout: 40 });
  console.log('ensure.sh exit:', r.exitCode ?? '-');
} catch (err) {
  console.log('could not wake in place:', err?.message ?? err);
  process.exit(3);
}
for (let i = 0; i < 20; i++) {
  if (await healthy()) { console.log('desk healthy again'); process.exit(0); }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('desk still down after ensure.sh');
process.exit(3);
