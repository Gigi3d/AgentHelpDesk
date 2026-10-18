#!/usr/bin/env node
// demo/deploy-blaxel.mjs: host the desk (product/server.ts) inside ONE Blaxel sandbox with a public
// preview URL, gated by a bearer token. Run it from your own machine (it needs to reach Blaxel):
//
//   demo/live.sh deploy            # first deploy, or a redeploy of the code and env
//
// What it does: creates (or reuses) the sandbox `ahd-desk`, uploads product/ and demo/sandbox-root,
// installs @blaxel/core, writes /app/ahd.env (mode 600, secrets from demo/.env.live), starts the desk with
// keepAlive + restartOnFailure, creates a preview on port 8787, and waits for /healthz.
//
// UNVERIFIED against a live account when written: the image's Node version (we fall back to
// `npx node@22`), whether the preview URL needs a token for the platform (we make it public and rely
// on AHD_API_TOKEN), and how long Blaxel keeps an idle sandbox. See mcp/GO-LIVE.md, Path C.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const say = (s = '') => process.stdout.write(`${s}\n`);
const die = (s) => { process.stderr.write(`deploy: ${s}\n`); process.exit(1); };

// Load demo/.env.live without printing it.
const envFile = join(ROOT, 'demo/.env.live');
const env = { ...process.env };
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && m[2] !== '' && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
env.BL_API_KEY ||= env.BLAXEL_API_KEY;
env.BL_WORKSPACE ||= env.BLAXEL_WORKSPACE;
for (const k of ['BL_API_KEY', 'BL_WORKSPACE', 'ANTHROPIC_API_KEY']) if (!env[k]) die(`${k} is not set (demo/.env.live)`);

// The SDK reads these from process.env.
process.env.BL_API_KEY = env.BL_API_KEY;
process.env.BL_WORKSPACE = env.BL_WORKSPACE;
if (env.BL_REGION) process.env.BL_REGION = env.BL_REGION;

let SandboxInstance;
let VolumeInstance;
try {
  const req = createRequire(join(ROOT, 'product/package.json'));
  ({ SandboxInstance, VolumeInstance } = req('@blaxel/core'));
} catch {
  die('@blaxel/core is not installed. Run: cd product && npm i --no-save @blaxel/core');
}

const NAME = env.AHD_DEPLOY_NAME || 'ahd-desk';
const IMAGE = env.AHD_DEPLOY_IMAGE || env.AHD_SANDBOX_IMAGE || 'blaxel/base-image:latest';
const PORT = 8787;
const TOKEN_FILE = join(ROOT, 'demo/.deploy.json'); // gitignored; holds the bearer token and URL
let saved = {};
try { saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')); } catch { /* first deploy */ }
const TOKEN = env.AHD_API_TOKEN || saved.token || randomBytes(24).toString('hex');

// 1. Package the code (no node_modules, no env files, no git history).
const dir = mkdtempSync(join(tmpdir(), 'ahd-deploy-'));
const tgz = join(dir, 'ahd.tgz');
execFileSync('tar', ['-czf', tgz, '--exclude=node_modules', '--exclude=.git', '--exclude=.env*', '--exclude=dist', '--exclude=.mcp-use', '-C', ROOT, 'product', 'demo/sandbox-root', 'demo/scenarios', 'mcp'], { stdio: 'inherit' });
say(`1. Packaged code (${(readFileSync(tgz).length / 1024).toFixed(0)} KB)`);

// 1b. The console. Built here (live mode, same origin as the desk) and served by the desk itself,
//     so the whole product is one URL. AHD_SKIP_WEB=1 deploys the API only.
let webTgz = null;
const WEB = join(ROOT, 'web');
if (existsSync(join(WEB, 'package.json')) && env.AHD_SKIP_WEB !== '1') {
  const opts = { cwd: WEB, stdio: 'inherit' };
  if (!existsSync(join(WEB, 'node_modules'))) execFileSync('npm', ['ci', '--silent'], opts);
  execFileSync('npm', ['run', 'build:desk', '--silent'], opts);
  webTgz = join(dir, 'web.tgz');
  execFileSync('tar', ['-czf', webTgz, '-C', ROOT, 'web/dist'], { stdio: 'inherit' });
  say(`   console built (${(readFileSync(webTgz).length / 1024).toFixed(0)} KB)`);
}

// 2. Sandbox.
// Durable storage: a Blaxel persistent volume mounted at /app/data holds cases.json (the desk's whole
// state: cases, events, approvals, outcomes, billing). It outlives restarts, standby and even deletion of
// the sandbox. A volume can only be attached when a sandbox is created, so an older sandbox without
// one is replaced (its on-sandbox disk is lost once; every later deploy keeps the data).
const VOLUME = env.AHD_DEPLOY_VOLUME || 'ahd-data';
const REGION = env.BL_REGION || 'us-pdx-1';
// Some tiers have a volume quota of 0. Then the desk still deploys, with its data on the sandbox disk
// (it survives restarts and standby, not deletion), and `persist wipe` falls back to a file backup.
let volumeOk = true;
try {
  await VolumeInstance.createIfNotExists({ name: VOLUME, size: Number(env.AHD_DEPLOY_VOLUME_MB || 1024), region: REGION, labels: { app: 'agenthelpdesk' } });
  say(`   volume ${VOLUME} ready (${REGION})`);
} catch (err) {
  const text = JSON.stringify(err, Object.getOwnPropertyNames(Object(err)));
  if (!/quota|429/i.test(text)) throw err;
  volumeOk = false;
  say('   NO VOLUME: this Blaxel plan has a volume quota of 0. Deploying without durable storage.');
  say('   Data survives desk restarts and standby but not deleting the sandbox. Ask Blaxel to raise the volume quota (app.blaxel.ai, plan quotas) and redeploy.');
}
let prior = null;
try { prior = await SandboxInstance.get(NAME); } catch { /* first deploy */ }
if (volumeOk && prior && !(prior.spec?.volumes ?? []).some((v) => v.name === VOLUME)) {
  say(`   sandbox ${NAME} has no data volume; replacing it so ${VOLUME} can be mounted`);
  await SandboxInstance.delete(NAME);
  await new Promise((r) => setTimeout(r, 8000));
}
const sb = await SandboxInstance.createIfNotExists({
  name: NAME,
  region: REGION,
  ...(volumeOk ? { volumes: [{ name: VOLUME, mountPath: '/app/data', readOnly: false }] } : {}),
  image: IMAGE,
  memory: Number(env.AHD_DEPLOY_MEMORY_MB || 4096),
  ports: [{ name: 'desk', target: PORT, protocol: 'HTTP' }],
  labels: { app: 'agenthelpdesk', role: 'desk' },
});
say(`2. Sandbox ${NAME} ready (image ${IMAGE}, ${volumeOk ? `data volume ${VOLUME} at /app/data` : 'no data volume'})`);

const sh = async (command, { timeout = 55 } = {}) => {
  const r = await sb.process.exec({ command, waitForCompletion: true, timeout });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.logs ?? ''}`.trim();
  if (r.exitCode && r.exitCode !== 0) die(`command failed (${r.exitCode}): ${command}\n${out}`);
  return out;
};

// 3. Node >= 22.6 (type stripping). Use the image's Node when new enough, else npx node@22.
const nodeV = (await sh('node -v 2>/dev/null || echo none')).split('\n').pop();
const [maj, min] = (/^v(\d+)\.(\d+)/.exec(nodeV) ?? []).slice(1).map(Number);
const NODE = maj > 22 || (maj === 22 && min >= 6) ? 'node' : 'npx -y node@22';
say(`3. Node in sandbox: ${nodeV}; desk will run with: ${NODE}`);

// 4. Upload and unpack. Stop a previous desk first (ignore errors on a first deploy).
try { await sb.process.kill('desk'); } catch { /* not running */ }
await sh('mkdir -p /app');
await sb.fs.writeBinary('/app/ahd.tgz', readFileSync(tgz));
await sh('cd /app && tar -xzf ahd.tgz && rm ahd.tgz');
if (webTgz) {
  await sh('rm -rf /app/web/dist && mkdir -p /app/web');
  await sb.fs.writeBinary('/app/web.tgz', readFileSync(webTgz));
  await sh('cd /app && tar -xzf web.tgz && rm web.tgz');
}
await sh('mkdir -p /app/data');
if (env.AHD_RESTORE_FILE && existsSync(env.AHD_RESTORE_FILE)) {
  await sb.fs.write('/app/data/cases.json', readFileSync(env.AHD_RESTORE_FILE, 'utf8'));
  say('   restored desk data from backup file');
}
say('4. Code uploaded');
const inst = await sb.process.exec({ command: 'cd /app/product && npm i --no-save @blaxel/core', name: 'npm-install', waitForCompletion: true, timeout: 55 });
if (inst.exitCode && inst.exitCode !== 0) die(`npm install failed:\n${inst.logs ?? ''}`);
say('   dependencies installed');

// 5. Environment: secrets stay in /app/ahd.env (mode 600), never in the process list or the image.
//    NOT named .env: the Blaxel SDK reads ./.env from the working directory, ranks it above process.env,
//    and (without the dotenv package) keeps the quotes, which turned a valid key into a 401.
const keep = ['BL_API_KEY', 'BL_WORKSPACE', 'BL_REGION', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_TEST_CUSTOMER_ID', 'INKBOX_API_KEY', 'ARMATURE_KEY', 'AHD_APPROVALS_FALLBACK_EMAIL'];
const contact = env.AHD_APPROVALS_FALLBACK_EMAIL || 'you@example.com';
const vendor = { id: 'ledgerly', name: 'Ledgerly', risk_policy: env.AHD_RISK_POLICY || 'autonomous', report_contacts: [contact], test_command: 'cd /ahd/work && node --test test/*.test.mjs', stripe_customer_id: env.STRIPE_TEST_CUSTOMER_ID || '', payer_mode: 'vendor' };
const lines = keep.filter((k) => env[k]).map((k) => `${k}=${JSON.stringify(env[k])}`);
lines.push(
  `BLAXEL_API_KEY=${JSON.stringify(env.BL_API_KEY)}`,
  `AHD_API_TOKEN=${JSON.stringify(TOKEN)}`,
  `AHD_PUBLIC_URL=${JSON.stringify(saved.url || '')}`,
  `HOST=0.0.0.0`, `PORT=${PORT}`, `AHD_DATA_FILE=/app/data/cases.json`,
  `AHD_SANDBOX_IMAGE=${JSON.stringify(env.AHD_SANDBOX_IMAGE || 'blaxel/base-image:latest')}`,
  `AHD_RESOLVER=claude`, `AHD_PROVISION_DIR=/app/demo/sandbox-root`, `AHD_SCENARIOS_DIR=/app/demo/scenarios`, `AHD_FRESH_BASELINE=1`,
  `AHD_REPRO_COMMAND='node /ahd/replay.mjs'`, `AHD_REPRO_EXPECT=nonzero`,
  `AHD_VENDOR_JSON=${JSON.stringify(JSON.stringify(vendor))}`,
  // Public by default so judges can look and press Run; writes still need the key. AHD_PRIVATE=1 turns it off.
  ...(env.AHD_PRIVATE === '1' ? [] : [`AHD_PUBLIC_READ=1`, `AHD_PUBLIC_DEMO=1`, `AHD_PUBLIC_MAX_PER_HOUR=${env.AHD_PUBLIC_MAX_PER_HOUR || 8}`, `AHD_BLAXEL_STANDBY_LIMIT=${env.AHD_BLAXEL_STANDBY_LIMIT || 10}`]),
);
await sb.fs.write('/app/ahd.env', `${lines.join('\n')}\n`);
await sh('rm -f /app/.env && chmod 600 /app/ahd.env');
say('5. Environment written to /app/ahd.env (mode 600)');

// 6. Start the desk and keep it alive.
await sb.process.exec({
  name: 'desk',
  command: `bash -lc 'cd /app && set -a && . ./ahd.env && set +a && exec ${NODE} --experimental-strip-types product/server.ts'`,
  workingDir: '/app',
  waitForCompletion: false,
  keepAlive: true,
  restartOnFailure: true,
  maxRestarts: 20,
});
say('6. Desk process started');

// 7. Public preview on the desk port. The bearer token is what protects it.
const preview = await sb.previews.createIfNotExists({ metadata: { name: `${NAME}-preview` }, spec: { port: PORT, public: true } });
const url = String(preview.url).replace(/\/+$/, '');
say(`7. Preview URL: ${url}`);

// 7b. The MCP edge (what Claude's custom connector talks to), in the same sandbox on port 3000.
//     Build runs in the background because one exec call is capped at about 60 s.
const EDGE_PORT = 3000;
await sb.fs.write('/app/ahd-edge.env', `AHD_DESK_URL=http://127.0.0.1:${PORT}\nAHD_DESK_TOKEN=${JSON.stringify(TOKEN)}\nPORT=${EDGE_PORT}\nHOST=0.0.0.0\n`);
await sh('chmod 600 /app/ahd-edge.env');
try { await sb.process.kill('edge'); } catch { /* not running */ }
await sb.process.exec({ name: 'edge-build', command: 'cd /app/mcp && npm install --legacy-peer-deps && npm run build', workingDir: '/app/mcp', waitForCompletion: false });
let built = false;
for (let i = 0; i < 100 && !built; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await sb.process.get('edge-build').catch(() => null);
  if (st && st.status && st.status !== 'running') {
    if (st.exitCode && st.exitCode !== 0) die(`edge build failed (exit ${st.exitCode}):\n${String(await sb.process.logs('edge-build').catch(() => '')).slice(-1500)}`);
    built = true;
  }
}
if (!built) die('edge build did not finish in 5 minutes');
say('7b. Edge built');
await sb.process.exec({
  name: 'edge',
  command: `bash -lc 'cd /app/mcp && set -a && . /app/ahd-edge.env && set +a && exec npx mcp-use start --port ${EDGE_PORT}'`,
  workingDir: '/app/mcp',
  waitForCompletion: false,
  keepAlive: true,
  restartOnFailure: true,
  maxRestarts: 20,
});
const edgePreview = await sb.previews.createIfNotExists({ metadata: { name: `${NAME}-edge-preview` }, spec: { port: EDGE_PORT, public: true } });
const edgeUrl = String(edgePreview.url).replace(/\/+$/, '');
let edgeUp = false;
for (let i = 0; i < 30 && !edgeUp; i++) {
  try {
    const r = await fetch(`${edgeUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'deploy', version: '1' } } }), signal: AbortSignal.timeout(5000) });
    edgeUp = r.ok;
  } catch { /* not up yet */ }
  if (!edgeUp) await new Promise((r) => setTimeout(r, 2000));
}
say(edgeUp ? `7c. MCP edge is up: ${edgeUrl}/mcp` : `7c. MCP edge did not answer on ${edgeUrl}/mcp (check the 'edge' process logs in the console)`);

// 7d. Self-heal inside the sandbox. A cold restart of the sandbox does not bring back processes, which is
//     what left the preview showing "could not proxy". A schedule runs this script every minute and starts
//     whichever of the desk or the edge is not answering, so recovery does not depend on GitHub or on us.
const ensure = `#!/bin/bash
S=$(command -v setsid || true)
up() { [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$1")" != "000" ]; }
if ! up http://127.0.0.1:${PORT}/v1/status; then
  cd /app && set -a && . ./ahd.env && set +a
  $S nohup ${NODE} --experimental-strip-types product/server.ts >> /app/data/desk.log 2>&1 < /dev/null &
fi
if ! up http://127.0.0.1:${EDGE_PORT}/; then
  cd /app/mcp && set -a && . /app/ahd-edge.env && set +a
  $S nohup npx mcp-use start --port ${EDGE_PORT} >> /app/data/edge.log 2>&1 < /dev/null &
fi
exit 0
`;
await sb.fs.write('/app/ensure.sh', ensure);
await sh('chmod 700 /app/ensure.sh');
try {
  const page = await sb.schedules.list({ limit: 100 });
  for await (const e of page) if (String(e?.input?.command ?? '').includes('/app/ensure.sh')) await sb.schedules.delete(e.id);
  await sb.schedules.create({ type: 'cron', value: '* * * * *', input: { command: 'bash /app/ensure.sh' } });
  say('7d. Self-heal schedule set (checks the desk and edge every minute)');
} catch (err) {
  say(`7d. Could not set the self-heal schedule (${err?.message ?? err}); the GitHub keep-live check still covers it`);
}

// 8. Wait for health.
let healthy = false;
for (let i = 0; i < 30 && !healthy; i++) {
  try { healthy = (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) })).ok; } catch { /* not up yet */ }
  if (!healthy) await new Promise((r) => setTimeout(r, 2000));
}
writeFileSync(TOKEN_FILE, JSON.stringify({ url, token: TOKEN, sandbox: NAME, volume: volumeOk ? VOLUME : null, edge: `${edgeUrl}/mcp` }, null, 2));
chmodSync(TOKEN_FILE, 0o600);
say(healthy ? '8. /healthz is up' : '8. /healthz did not answer in 60s. Check the process logs: bl or the console, sandbox ' + NAME);
say('');
say(`Console     ${url}/app/theater   (open it, paste the key: it is the token in demo/.deploy.json)`);
say(`Desk URL   ${url}`);
say(`Token      saved in demo/.deploy.json (gitignored); set AHD_DESK_TOKEN to it on the MCP edge`);
say(`Claude connector URL  ${edgeUrl}/mcp   (Settings, Connectors, Add custom connector)`);
say(`Test       curl -s ${url}/healthz`);
say(`Run a case demo/live.sh remote`);
process.exit(healthy && edgeUp ? 0 : 1);
