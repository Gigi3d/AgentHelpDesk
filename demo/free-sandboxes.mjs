#!/usr/bin/env node
// demo/free-sandboxes.mjs: delete the oldest per-case sandboxes (ahd-*) to free Blaxel quota. Never touches ahd-desk.
//   node demo/free-sandboxes.mjs 30      delete the 30 oldest case sandboxes
// Cases and their records live on the desk, not in these sandboxes, so the console keeps showing them.
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
process.env.BL_API_KEY ||= process.env.BLAXEL_API_KEY;
process.env.BL_WORKSPACE ||= process.env.BLAXEL_WORKSPACE;
const count = Math.max(0, Math.min(200, Number(process.argv[2] ?? 30) || 0));
const KEEP = new Set([process.env.AHD_DEPLOY_NAME || 'ahd-desk']);

const sdk = createRequire(join(ROOT, 'product/package.json'))('@blaxel/core');
let page;
if (typeof sdk.SandboxInstance?.list === 'function') page = await sdk.SandboxInstance.list({ limit: 100 });
else {
  // Older @blaxel/core: the generated client returns { data: { data: [...] } } or { data: [...] }.
  const res = await sdk.listSandboxes({ throwOnError: true });
  const body = res.data ?? res;
  page = Array.isArray(body) ? body : (body.data ?? []);
}
const all = [];
if (typeof page[Symbol.asyncIterator] === 'function') for await (const sb of page) all.push(sb); else for (const sb of page) all.push(sb);
const rows = all
  .map((s) => ({ name: s.metadata?.name ?? s.name ?? '', at: Date.parse(s.metadata?.createdAt ?? '') || 0, status: s.status ?? '' }))
  .filter((s) => s.name.startsWith('ahd-') && !KEEP.has(s.name))
  .sort((a, b) => a.at - b.at);
console.log(`${all.length} sandboxes in the workspace, ${rows.length} are ahd-* case sandboxes; deleting the oldest ${Math.min(count, rows.length)}`);
let removed = 0;
for (const s of rows.slice(0, count)) {
  try { await sdk.SandboxInstance.delete(s.name); removed += 1; console.log(`deleted ${s.name} (${s.status})`); }
  catch (e) { console.log(`could not delete ${s.name}: ${e?.message ?? JSON.stringify(e)}`); }
}
console.log(`\nDeleted ${removed}. ${rows.length - removed} case sandboxes remain, plus ${[...KEEP].join(', ')}.`);
