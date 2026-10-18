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
try {
  const req = createRequire(join(ROOT, 'product/package.json'));
  ({ SandboxInstance } = req('@blaxel/core'));
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
execFileSync('tar', ['-czf', tgz, '--exclude=node_modules', '--exclude=.git', '--exclude=.env*', '-C', ROOT, 'product', 'demo/sandbox-root'], { stdio: 'inherit' });
say(`1. Packaged code (${(readFileSync(tgz).length / 1024).toFixed(0)} KB)`);

// 2. Sandbox.
const sb = await SandboxInstance.createIfNotExists({
  name: NAME,
  image: IMAGE,
  memory: Number(env.AHD_DEPLOY_MEMORY_MB || 4096),
  ports: [{ name: 'desk', target: PORT, protocol: 'HTTP' }],
  labels: { app: 'agenthelpdesk', role: 'desk' },
});
say(`2. Sandbox ${NAME} ready (image ${IMAGE})`);

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
say('4. Code uploaded');
const inst = await sb.process.exec({ command: 'cd /app/product && npm i --no-save @blaxel/core', name: 'npm-install', waitForCompletion: true, timeout: 55 });
if (inst.exitCode && inst.exitCode !== 0) die(`npm install failed:\n${inst.logs ?? ''}`);
say('   dependencies installed');

// 5. Environment: secrets stay in /app/ahd.env (mode 600), never in the process list or the image.
//    NOT named .env: the Blaxel SDK reads ./.env from the working directory, ranks it above process.env,
//    and (without the dotenv package) keeps the quotes, which turned a valid key into a 401.
const keep = ['BL_API_KEY', 'BL_WORKSPACE', 'BL_REGION', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_TEST_CUSTOMER_ID', 'INKBOX_API_KEY', 'PRIMITIVE_KEY', 'ARMATURE_KEY', 'AHD_APPROVALS_FALLBACK_EMAIL'];
const contact = env.AHD_APPROVALS_FALLBACK_EMAIL || 'you@example.com';
const vendor = { id: 'ledgerly', name: 'Ledgerly', risk_policy: 'approve_first', report_contacts: [contact], test_command: 'cd /ahd/work && node --test test/*.test.mjs', stripe_customer_id: env.STRIPE_TEST_CUSTOMER_ID || '', payer_mode: 'vendor' };
const lines = keep.filter((k) => env[k]).map((k) => `${k}=${JSON.stringify(env[k])}`);
lines.push(
  `BLAXEL_API_KEY=${JSON.stringify(env.BL_API_KEY)}`,
  `AHD_API_TOKEN=${JSON.stringify(TOKEN)}`,
  `HOST=0.0.0.0`, `PORT=${PORT}`,
  `AHD_SANDBOX_IMAGE=${JSON.stringify(env.AHD_SANDBOX_IMAGE || 'blaxel/base-image:latest')}`,
  `AHD_RESOLVER=claude`, `AHD_PROVISION_DIR=/app/demo/sandbox-root`, `AHD_FRESH_BASELINE=1`,
  `AHD_REPRO_COMMAND='node /ahd/replay.mjs'`, `AHD_REPRO_EXPECT=nonzero`,
  `AHD_VENDOR_JSON=${JSON.stringify(JSON.stringify(vendor))}`,
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

// 8. Wait for health.
let healthy = false;
for (let i = 0; i < 30 && !healthy; i++) {
  try { healthy = (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) })).ok; } catch { /* not up yet */ }
  if (!healthy) await new Promise((r) => setTimeout(r, 2000));
}
writeFileSync(TOKEN_FILE, JSON.stringify({ url, token: TOKEN, sandbox: NAME }, null, 2));
chmodSync(TOKEN_FILE, 0o600);
say(healthy ? '8. /healthz is up' : '8. /healthz did not answer in 60s. Check the process logs: bl or the console, sandbox ' + NAME);
say('');
say(`Desk URL   ${url}`);
say(`Token      saved in demo/.deploy.json (gitignored); set AHD_DESK_TOKEN to it on the MCP edge`);
say(`Test       curl -s ${url}/healthz`);
say(`Run a case demo/live.sh remote`);
process.exit(healthy ? 0 : 1);
