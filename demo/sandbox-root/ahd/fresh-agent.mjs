// AgentHelpDesk fresh-agent proof, run INSIDE a fork of the case sandbox.
//
//   node /ahd/fresh-agent.mjs /ahd/fresh/task.md /ahd/fresh/changed.json
//
// A clean-context model is given ONLY the original task and the changed docs. It never sees the
// resolver's reasoning, the diff, the failing response, or the vendor's source. It must produce
// the one HTTP request it would send. We run that request against the vendor's own server code
// and exit 0 only if it succeeds (2xx). Exit 2 means the agent could not run at all (no key, API
// error, unparseable answer); the proof fails closed rather than passing without an agent.
import { readFileSync } from 'node:fs';
import { createLedgerlyServer, DEFAULT_KEY } from './work/server.mjs';

const [taskPath, changedPath] = process.argv.slice(2);
if (!taskPath || !changedPath) {
  process.stderr.write('usage: fresh-agent.mjs <task.md> <changed.json>\n');
  process.exit(2);
}

function fail(message) {
  process.stderr.write(`fresh-agent: ${message}\n`);
  process.exit(2);
}

const task = readFileSync(taskPath, 'utf8').trim();
const changed = JSON.parse(readFileSync(changedPath, 'utf8'));
if (!Array.isArray(changed) || changed.length === 0) fail('changed.json held no documents');

let apiKey = process.env.ANTHROPIC_API_KEY ?? '';
if (!apiKey) {
  try {
    apiKey = readFileSync(new URL('./secrets/anthropic.key', import.meta.url), 'utf8').trim();
  } catch {
    // handled below
  }
}
if (!apiKey) fail('no model key: ANTHROPIC_API_KEY is unset and /ahd/secrets/anthropic.key is missing');

const model = process.env.AHD_FRESH_MODEL ?? 'claude-sonnet-5-5';
const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');

const system = [
  'You are an autonomous API client agent. You act only by emitting HTTP requests.',
  'You know nothing about this API except the documentation you are given.',
  'Reply with ONLY a JSON object: {"method": string, "url": string, "headers": object, "body": object or null}.',
  'Write the literal text $LEDGERLY_KEY wherever your API key belongs; the runtime substitutes it.',
].join(' ');
const docs = changed.map((d) => `<doc path="${d.path}">\n${d.content}\n</doc>`).join('\n');
const user = `Task: ${task}\n\nDocumentation:\n${docs}`;

let res;
try {
  res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(90_000),
  });
} catch (err) {
  fail(`the Messages API call failed: ${err.message}`);
}
const raw = await res.text();
if (!res.ok) fail(`the Messages API answered ${res.status}: ${raw.slice(0, 300)}`);
const text = (JSON.parse(raw).content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
const open = text.indexOf('{');
const close = text.lastIndexOf('}');
if (open < 0 || close < open) fail(`the agent did not return a JSON request: ${text.slice(0, 200)}`);
let req;
try {
  req = JSON.parse(text.slice(open, close + 1));
} catch (err) {
  fail(`the agent's request was not valid JSON: ${err.message}`);
}
if (typeof req.method !== 'string' || typeof req.url !== 'string') fail('the agent request needs a method and a url');

const headers = {};
for (const [k, v] of Object.entries(req.headers ?? {})) headers[String(k).toLowerCase()] = String(v).replaceAll('$LEDGERLY_KEY', DEFAULT_KEY);
let target;
try {
  const u = new URL(req.url);
  const server0 = createLedgerlyServer();
  await new Promise((resolve) => server0.listen(0, '127.0.0.1', resolve));
  target = { server: server0, url: new URL(`${u.pathname}${u.search}`, `http://127.0.0.1:${server0.address().port}`) };
} catch (err) {
  fail(`the agent url was not usable: ${err.message}`);
}

const hasBody = req.body !== null && req.body !== undefined && !['GET', 'HEAD'].includes(req.method.toUpperCase());
if (hasBody && !headers['content-type']) headers['content-type'] = 'application/json';
let status = 0;
let body = '';
try {
  const out = await fetch(target.url, { method: req.method.toUpperCase(), headers, body: hasBody ? JSON.stringify(req.body) : undefined });
  status = out.status;
  body = await out.text();
} finally {
  await new Promise((resolve) => target.server.close(resolve));
}

const shown = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.replace(DEFAULT_KEY, '<key>')]));
process.stdout.write(
  `model ${model} request-id ${res.headers.get('request-id') ?? 'n/a'}\n` +
    `agent request: ${req.method.toUpperCase()} ${req.url} headers=${JSON.stringify(shown)}\n` +
    `status ${status} body ${body.slice(0, 160)}\n`,
);
process.exit(status >= 200 && status < 300 ? 0 : 1);
