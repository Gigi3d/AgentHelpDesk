#!/usr/bin/env node
// demo/inkbox-setup.mjs: tell Inkbox to call the hosted desk when mail or an agent-to-agent task arrives.
//
//   demo/live.sh inkbox
//
// Creates one webhook subscription on the AgentHelpDesk identity (documented:
// POST https://inkbox.ai/api/v1/webhooks/subscriptions, header X-API-Key). Inkbox sends
// `Authorization: Bearer <auth_token>` with every delivery, and we set that token to the desk's own token,
// so the desk's existing bearer check is the only gate. Re-running after a redeploy is safe: the URL is
// remembered in demo/.deploy.json and a second subscription is not created for the same URL.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const envFile = join(ROOT, 'demo/.env.live');
if (existsSync(envFile)) for (const l of readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(l);
  if (m && m[2] && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const deployFile = join(ROOT, 'demo/.deploy.json');
if (!existsSync(deployFile)) { console.error('inkbox-setup: no demo/.deploy.json. Run demo/live.sh deploy first.'); process.exit(1); }
const deploy = JSON.parse(readFileSync(deployFile, 'utf8'));
const KEY = env.INKBOX_API_KEY;
if (!KEY) { console.error('inkbox-setup: INKBOX_API_KEY is not set in demo/.env.live'); process.exit(1); }
const IDENTITY = env.INKBOX_IDENTITY_ID || '06e01e73-a369-4d90-a8db-a46eb3d71122'; // AgentHelpDesk, from inkbox_identity_get
const url = `${deploy.url}/v1/inkbox/webhook`;

if (deploy.inkbox_webhook === url) { console.log(`Already subscribed: ${url}`); process.exit(0); }

const res = await fetch('https://inkbox.ai/api/v1/webhooks/subscriptions', {
  method: 'POST',
  headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ agent_identity_id: IDENTITY, url, event_types: ['message.received', 'a2a.task.created', 'a2a.task.message'], auth_token: deploy.token }),
  signal: AbortSignal.timeout(20000),
});
const text = await res.text();
if (!res.ok) { console.error(`inkbox-setup: ${res.status} ${text.slice(0, 400)}`); process.exit(1); }
let body = {};
try { body = JSON.parse(text); } catch { /* ignore */ }
deploy.inkbox_webhook = url;
writeFileSync(deployFile, JSON.stringify(deploy, null, 2));
console.log(`Subscribed. Inkbox will call ${url} for mail and agent-to-agent tasks.`);
console.log(`Email the desk at agenthelpdesk@inkboxmail.com, or send an A2A task to the handle "agenthelpdesk".`);
if (body.signing_key) console.log('A signing key was issued once; the desk does not use it (the bearer token authenticates deliveries).');
