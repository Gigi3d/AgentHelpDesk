#!/usr/bin/env node
// demo/fork-probe.mjs: fork the newest ahd-c-* case sandbox once and print Blaxel's FULL answer.
// Use it when the fresh-agent proof fails with a cut-off fork error. Creates (and removes) 'ahd-fork-probe'.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const f = join(ROOT, 'demo/.env.live');
if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(l);
  if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { SandboxInstance } = createRequire(join(ROOT, 'product/package.json'))('@blaxel/core');
const show = (x) => inspect(x, { depth: 6, breakLength: 100 });

const list = await SandboxInstance.list();
const items = Array.isArray(list) ? list : (list.data ?? list.items ?? []);
const names = items.map((s) => s?.metadata?.name ?? s?.name).filter(Boolean);
console.log('sandboxes:', names.join(', '));
const src = process.argv[2] ?? names.filter((n) => n.startsWith('ahd-c-') && !n.endsWith('-fresh')).pop();
if (!src) { console.log('no ahd-c-* sandbox to fork'); process.exit(1); }
const sb = await SandboxInstance.get(src);
console.log('source:', src, 'status:', show(sb.status), 'spec.runtime:', show(sb.spec?.runtime));
try {
  const r = await sb.fork('ahd-fork-probe');
  console.log('FORK OK:', show(r));
  try { await SandboxInstance.delete('ahd-fork-probe'); console.log('probe fork deleted'); } catch (e) { console.log('delete failed:', show(e)); }
} catch (e) {
  console.log('FORK FAILED:', show(e));
}
