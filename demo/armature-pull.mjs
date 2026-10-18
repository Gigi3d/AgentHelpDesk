#!/usr/bin/env node
// demo/armature-pull.mjs: read open issues from Armature (needs ARMATURE_KEY on the hosted desk) and open a case for each.
//   demo/live.sh armature
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const f = join(ROOT, 'demo/.deploy.json');
if (!existsSync(f)) { console.error('armature-pull: run demo/live.sh deploy first'); process.exit(1); }
const { url, token } = JSON.parse(readFileSync(f, 'utf8'));
const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const status = await (await fetch(`${url}/v1/feeds/armature`, { headers: h })).json();
console.log(status.simulated ? 'Armature feed: SIMULATED (no ARMATURE_KEY on the desk)' : 'Armature feed: live');
const res = await fetch(`${url}/v1/feeds/armature/pull`, { method: 'POST', headers: h, body: JSON.stringify({ limit: 5 }) });
const body = await res.json();
if (!res.ok) { console.error(JSON.stringify(body)); process.exit(1); }
for (const c of body.cases) console.log(`issue ${c.issue} -> case ${c.case_id}   ${url}/theater/${c.case_id}`);
if (body.cases.length === 0) console.log('No open issues.');
