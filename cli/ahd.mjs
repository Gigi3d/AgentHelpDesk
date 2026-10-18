#!/usr/bin/env node
// ahd: run any command; when it fails the way an agent fails against a vendor, file a case.
//
//   ahd run [options] -- <command> [args...]
//   ahd bl  <args...>            same as: ahd run --vendor blaxel -- bl <args...>
//
// It runs the command exactly as given (same exit code, same output), keeps the tail of the output,
// and on a non-zero exit that looks like an error an agent could fix by reading better docs (an HTTP
// 4xx/5xx, bad credentials, an unknown flag or command, a validation error) it:
//   1. files a case with the desk (POST /v1/cases) and prints the committed times,
//   2. starts the loop (POST /v1/cases/run), where the desk reproduces it in a sandbox, drafts a fix,
//      proves it, and either ships it (small, safe changes) or escalates to a person by email,
//   3. with --wait, follows the case and prints the verified answer.
// Nothing is filed for success, for a Ctrl-C, or for an error that looks like a plain typo of yours.
//
// Options (or environment): --desk / AHD_DESK_URL, --token / AHD_DESK_TOKEN, --vendor, --agent,
//   --wait, --always (file any non-zero exit), --quiet, --dry-run (show what would be filed)
// With no URL, a sibling ../demo/.deploy.json (written by demo/live.sh deploy) is used.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAIL = 6000;

export const PATTERNS = [
  { re: /\b(?:HTTP\/[\d.]+\s+|status(?:\s+code)?[:=\s]+|error[:\s]+|returned\s+)(4\d\d|5\d\d)\b/i, why: 'http status' },
  { re: /\b(401|403|404|409|410|422|429|500|502|503)\b.{0,40}\b(unauthori[sz]ed|forbidden|not found|conflict|unprocessable|too many|internal|bad gateway|unavailable)\b/i, why: 'http status' },
  { re: /\b(unauthori[sz]ed|forbidden|invalid (?:api[ _-]?key|token|credentials?|signature)|missing (?:credentials?|header|authorization)|permission denied)\b/i, why: 'credentials' },
  { re: /\b(unknown (?:flag|option|command|field|parameter)|unrecognized (?:argument|option)|unsupported|deprecated|no such (?:flag|command|resource))\b/i, why: 'unknown or removed surface' },
  { re: /\b(validation (?:failed|error)|invalid (?:request|body|parameter|payload|argument)|schema|must be|is required|required field)\b/i, why: 'validation' },
  { re: /\b(rate limit(?:ed)?|quota exceeded)\b/i, why: 'limit' },
];

export function classify(code, stdout, stderr) {
  if (code === 0 || code === null) return null;
  if (code === 130 || code === 143) return null; // interrupted by the person
  const text = `${stderr}\n${stdout}`;
  for (const p of PATTERNS) if (p.re.test(text)) return p.why;
  return null;
}

/** Pull the first HTTP status out of the text, if any, so the desk gets a real response to reason about. */
export function statusOf(text) {
  const m = /\b(?:HTTP\/[\d.]+\s+|status(?:\s+code)?[:=\s]+|returned\s+)?\b(4\d\d|5\d\d)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

export function redact(s) {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]')
    .replace(/(--?(?:token|key|api-key|secret|password|auth)[= ])(\S{4,})/gi, '$1[redacted]')
    .replace(/\b(bl_[A-Za-z0-9]{6})[A-Za-z0-9]+/g, 'bl_[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/(authorization|x-api-key|api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)(?!\[redacted)([^\s"',}]{4,})/gi, '$1$2[redacted]');
}

export function buildReport({ argv, code, stdout, stderr, why, vendor, agent }) {
  const text = `${stderr}\n${stdout}`;
  return {
    agent_id: agent,
    task: `Run: ${redact(argv.join(' '))}`.slice(0, 3900),
    request: { command: redact(argv.join(' ')), cwd_basename: process.cwd().split('/').pop() },
    response: { exit_code: code, http_status: statusOf(text), looks_like: why, stderr_tail: redact(stderr.slice(-1800)), stdout_tail: redact(stdout.slice(-800)) },
    channel: 'webhook',
    ...(vendor ? { vendor_hint: vendor } : {}),
  };
}

function deskFromFiles() {
  for (const f of [join(HERE, '..', 'demo', '.deploy.json'), join(process.env.HOME || '', '.ahd.json')]) {
    try {
      if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    } catch { /* ignore a bad file */ }
  }
  return {};
}

async function call(desk, token, method, path, body) {
  const res = await fetch(`${desk}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.error?.message ?? text.slice(0, 200)}`);
  return json;
}

function parseArgs(args) {
  const o = { wait: false, always: false, quiet: false, dry: false, vendor: process.env.AHD_VENDOR || '', agent: process.env.AHD_AGENT_ID || `cli-${process.env.USER || 'agent'}`, desk: process.env.AHD_DESK_URL || '', token: process.env.AHD_DESK_TOKEN || '' };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (a === '--wait') o.wait = true;
    else if (a === '--always') o.always = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--dry-run') o.dry = true;
    else if (['--desk', '--token', '--vendor', '--agent'].includes(a)) o[a.slice(2)] = args[++i] ?? '';
    else break;
  }
  return { opts: o, argv: args.slice(i) };
}

function runChild(argv) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { process.stdout.write(d); out = (out + d).slice(-TAIL); });
    child.stderr.on('data', (d) => { process.stderr.write(d); err = (err + d).slice(-TAIL); });
    child.on('error', (e) => resolve({ code: 127, stdout: out, stderr: `${err}\n${e.message}` }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 143 : 1), stdout: out, stderr: err }));
  });
}

export async function main(rawArgs) {
  let args = rawArgs;
  let sub = args[0];
  if (sub === 'bl') { args = ['run', '--vendor', 'blaxel', '--', 'bl', ...args.slice(1)]; sub = 'run'; }
  if (sub !== 'run') {
    process.stderr.write('usage: ahd run [--wait] [--vendor v] [--desk url] [--token t] -- <command...>\n       ahd bl <args...>\n');
    return 2;
  }
  const { opts, argv } = parseArgs(args.slice(1));
  if (argv.length === 0) { process.stderr.write('ahd: no command given after --\n'); return 2; }

  const { code, stdout, stderr } = await runChild(argv);
  const why = opts.always && code ? 'any non-zero exit' : classify(code, stdout, stderr);
  if (!why) return code;

  const saved = deskFromFiles();
  const desk = (opts.desk || saved.url || '').replace(/\/+$/, '');
  const token = opts.token || saved.token || '';
  const say = (s) => { if (!opts.quiet) process.stderr.write(`\nAgentHelpDesk: ${s}\n`); };
  const report = buildReport({ argv, code, stdout, stderr, why, vendor: opts.vendor, agent: opts.agent });
  if (opts.dry) { say(`would file (${why}):\n${JSON.stringify(report, null, 2)}`); return code; }
  if (!desk) { say('this looks like an error the desk can help with, but no desk is set. Pass --desk or set AHD_DESK_URL.'); return code; }

  try {
    const receipt = await call(desk, token, 'POST', '/v1/cases', { ...report, idempotency_key: `cli:${Buffer.from(report.task + (report.response.http_status ?? '')).toString('base64url').slice(0, 40)}` });
    say(`filed ${receipt.case_id} (${why}). Acknowledged by ${receipt.ack_by}, resolved by ${receipt.resolve_by}.`);
    await call(desk, token, 'POST', '/v1/cases/run', { id: receipt.case_id, background: true });
    say(`working on it in a sandbox. Watch: ${desk}/theater/${receipt.case_id}`);
    if (opts.wait) {
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const view = await call(desk, token, 'GET', `/v1/cases?id=${encodeURIComponent(receipt.case_id)}`);
        if (['answered', 'shipped', 'closed'].includes(view.status)) {
          const steps = view.reply?.answer?.fix_steps ?? view.reply?.fix_steps;
          say(`fixed and verified.${Array.isArray(steps) ? '\n  ' + steps.join('\n  ') : ''}`);
          break;
        }
        if (view.status === 'escalated') { say('a person has this case now; they were emailed.'); break; }
        if (view.status === 'awaiting_approval') { if (i % 5 === 0) say('waiting for the vendor to approve the change.'); }
      }
    }
  } catch (e) {
    say(`could not file the case: ${e instanceof Error ? e.message : String(e)}`);
  }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
