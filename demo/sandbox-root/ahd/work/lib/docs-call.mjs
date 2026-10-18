// Reads the curl examples out of a Markdown doc and runs them against a local instance.
// This is what lets the vendor's own tests (and AgentHelpDesk's replay) check that the
// documentation is true, not just that the server works.

/** Every curl command inside a fenced sh/bash/shell block, with `\`-continued lines joined. */
export function extractCurlCommands(markdown) {
  const commands = [];
  const fence = /```(?:sh|bash|shell)\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(markdown)) !== null) {
    const joined = m[1].replace(/\\\r?\n/g, ' ');
    for (const line of joined.split('\n')) {
      const t = line.trim();
      if (t.startsWith('curl ')) commands.push(t);
    }
  }
  return commands;
}

/** Split a shell-ish line into tokens, honoring single and double quotes. */
export function tokenize(line) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur.length > 0) tokens.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) throw new Error('unterminated quote in curl command');
  if (started || cur.length > 0) tokens.push(cur);
  return tokens;
}

export function substituteEnv(text, env) {
  return text.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_, name) => env[name] ?? '');
}

/** { method, url, headers, body } from one curl command. Unsupported flags throw. */
export function parseCurl(command, env = {}) {
  const tokens = tokenize(command);
  if (tokens[0] !== 'curl') throw new Error('not a curl command');
  let method = null;
  let url = null;
  let body = null;
  const headers = {};
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '-H' || t === '--header') {
      const raw = substituteEnv(tokens[++i] ?? '', env);
      const at = raw.indexOf(':');
      if (at < 1) throw new Error(`malformed header '${raw}'`);
      headers[raw.slice(0, at).trim().toLowerCase()] = raw.slice(at + 1).trim();
    } else if (t === '-X' || t === '--request') {
      method = (tokens[++i] ?? '').toUpperCase();
    } else if (t === '-d' || t === '--data' || t === '--data-raw') {
      body = substituteEnv(tokens[++i] ?? '', env);
    } else if (t.startsWith('-')) {
      throw new Error(`unsupported curl flag '${t}'`);
    } else {
      url = substituteEnv(t, env);
    }
  }
  if (!url) throw new Error('curl command has no URL');
  return { method: method ?? (body === null ? 'GET' : 'POST'), url, headers, body };
}

/** Run one parsed call against a local origin, ignoring the documented host. */
export async function runCall(call, origin) {
  const u = new URL(call.url);
  const target = new URL(`${u.pathname}${u.search}`, origin);
  const res = await fetch(target, { method: call.method, headers: call.headers, body: call.body ?? undefined });
  const text = await res.text();
  return { status: res.status, body: text, target: target.toString() };
}
