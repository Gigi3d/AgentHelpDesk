#!/usr/bin/env node
// demo/diag.mjs: why does the hosted desk die? Prints kernel, memory and process evidence from the sandbox.
//   demo/live.sh does not wrap this; desk-control runs it (action: diag). Prints no secrets.
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
console.log('sandbox status:', sb.status, 'memory MB:', sb.spec?.runtime?.memory ?? '?', 'expires:', JSON.stringify(sb.expiresIn ?? sb.spec?.runtime?.ttl ?? null));
const run = async (title, command) => {
  try {
    const r = await sb.process.exec({ command, waitForCompletion: true, timeout: 25 });
    console.log(`\n--- ${title} ---\n${(r.stdout ?? r.logs ?? '').toString().trim()}`);
  } catch (e) { console.log(`\n--- ${title}: failed (${e?.message ?? e})`); }
};
await run('uptime and memory', 'uptime; free -m; cat /proc/pressure/memory 2>/dev/null');
await run('top processes by memory', 'ps aux --sort=-rss | head -8 | cut -c1-160');
await run('kernel messages (OOM, kills)', 'dmesg 2>/dev/null | grep -i -E "oom|killed|out of memory|signal" | tail -20; echo "(dmesg done)"');
await run('desk log tail (schedule-started runs)', 'tail -25 /app/data/desk.log 2>/dev/null | cut -c1-200');
await run('desk data file', 'ls -la /app/data | head -12; du -sh /app/data 2>/dev/null');
try {
  for (const p of (await sb.process.list()).filter((x) => ['desk', 'edge'].includes(x.name))) console.log(`process ${p.name}: status=${p.status} exit=${p.exitCode ?? '-'} pid=${p.pid ?? '-'} started=${p.startedAt ?? '-'}`);
} catch (e) { console.log('process list failed:', e?.message ?? e); }
