#!/usr/bin/env node
// demo/cleanup-sandboxes.mjs: list the per-case sandboxes (ahd-*) in your Blaxel workspace and delete them.
//
//   node demo/cleanup-sandboxes.mjs          list only (nothing is deleted)
//   node demo/cleanup-sandboxes.mjs --yes    delete every ahd-* sandbox except the desk (ahd-desk)
//
// Tier 0 allows 10 standby sandboxes. Each case leaves two behind, so a few cases fill the quota and the
// next case escalates. Run this between demo runs. Cases and their records live on the desk, not in these.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
try {
  for (const line of readFileSync(join(ROOT, 'demo/.env.live'), 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && m[2] !== '' && env[m[1]] === undefined) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* env vars may already be set */ }
process.env.BL_API_KEY = env.BL_API_KEY || env.BLAXEL_API_KEY;
process.env.BL_WORKSPACE = env.BL_WORKSPACE || env.BLAXEL_WORKSPACE;
if (env.BL_REGION) process.env.BL_REGION = env.BL_REGION;
if (!process.env.BL_API_KEY || !process.env.BL_WORKSPACE) { console.error('BL_API_KEY and BL_WORKSPACE are needed (demo/.env.live).'); process.exit(1); }

const { SandboxInstance } = createRequire(join(ROOT, 'product/package.json'))('@blaxel/core');
const KEEP = new Set([env.AHD_DEPLOY_NAME || 'ahd-desk']);
const yes = process.argv.includes('--yes');

const all = [];
const page = await SandboxInstance.list({ limit: 100 });
for await (const sb of page) all.push(sb);
const mine = all.filter((s) => (s.metadata?.name ?? s.name ?? '').startsWith('ahd-'));
console.log(`${all.length} sandbox(es) in the workspace, ${mine.length} named ahd-*`);
let removed = 0;
for (const sb of mine) {
  const name = sb.metadata?.name ?? sb.name;
  const keep = KEEP.has(name);
  console.log(`  ${keep ? 'keep  ' : yes ? 'delete' : 'would delete'}  ${name}  ${sb.status ?? ''}`);
  if (!keep && yes) {
    try { await SandboxInstance.delete(name); removed += 1; } catch (err) { console.log(`    could not delete: ${err?.message ?? JSON.stringify(err)}`); }
  }
}
console.log(yes ? `\nDeleted ${removed}.` : '\nNothing deleted. Run with --yes to delete the ones marked "would delete".');
