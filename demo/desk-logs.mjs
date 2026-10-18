#!/usr/bin/env node
// demo/desk-logs.mjs: show the hosted desk and edge process state and the tail of their logs.
//   demo/live.sh logs
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
const { SandboxInstance } = createRequire(join(ROOT, 'product/package.json'))('@blaxel/core');
const sb = await SandboxInstance.get(process.env.AHD_DEPLOY_NAME || 'ahd-desk');
console.log('sandbox status:', sb.status);
let procs = [];
try { procs = await sb.process.list(); } catch (e) { console.log('process list failed:', e?.message ?? e); }
for (const p of procs) console.log(`process ${p.name}: status=${p.status} exit=${p.exitCode ?? '-'} restarts=${p.restartCount ?? '-'} pid=${p.pid ?? '-'}`);
for (const name of ['desk', 'edge']) {
  try {
    const logs = String(await sb.process.logs(name, 'all'));
    console.log(`\n--- ${name} (last 40 lines) ---\n${logs.split('\n').slice(-40).join('\n')}`);
  } catch (e) { console.log(`\n--- ${name}: no logs (${e?.message ?? e})`); }
}
try {
  const r = await sb.process.exec({ command: 'free -m | head -2; uptime', waitForCompletion: true, timeout: 20 });
  console.log(`\n--- memory/uptime ---\n${r.stdout ?? r.logs ?? ''}`);
} catch (e) { console.log('exec failed:', e?.message ?? e); }
