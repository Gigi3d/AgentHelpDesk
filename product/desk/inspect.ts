// Pure helpers that turn an UNTRUSTED inbound payload (an agent's request and a
// vendor's response, arriving over MCP / email / webhook) into the small set of
// facts the desk is allowed to act on.
//
// Two rules drive this file:
//  1. Payload text is data, never instructions. We extract bounded numbers,
//     bounded strings and a classification hint — nothing else. A payload can
//     never widen a permission, change an envelope, or edit an instruction.
//  2. No secrets are persisted or echoed. Anything that looks like a credential
//     is redacted before it reaches the store, a sandbox file, or an AgentReply.
//
// This module has no imports from other desk/ modules, so it can never take part
// in an import cycle.
import { badRequest } from '../shared/http.ts';
import type { FailureClass } from '../shared/types.ts';

/** Hard cap on any single string we keep from an inbound payload. */
export const MAX_TEXT = 4000;
/** Hard cap on the serialised size of a stored request/response payload. */
export const MAX_PAYLOAD_CHARS = 32_000;
/** Depth/width caps so a hostile nested body cannot blow up the store. */
const MAX_DEPTH = 6;
const MAX_ENTRIES = 50;

const SECRET_KEY =
  /(authorization|auth|token|secret|passw|credential|cookie|session|bearer|signature|api[-_]?key|access[-_]?key|private[-_]?key|x402|payment[-_]?header)/i;

export function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

export function clip(v: unknown, max = MAX_TEXT): string {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

/** Deep-redact + bound an inbound payload so it is safe to store and to write
 * into a sandbox file. Returns JSON-safe data (objects, arrays, string, number,
 * boolean, null). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated:depth]';
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') return clip(value);
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'boolean') return value;
  if (t !== 'object') return null; // undefined, function, symbol, bigint -> dropped
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, MAX_ENTRIES)) out.push(redact(item, depth + 1));
    if (value.length > MAX_ENTRIES) out.push('[truncated:length]');
    return out;
  }
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key of Object.keys(rec)) {
    if (n >= MAX_ENTRIES) {
      out['[truncated]'] = true;
      break;
    }
    n += 1;
    out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(rec[key], depth + 1);
  }
  return out;
}

/** Redact, then enforce the serialised-size cap. */
export function capPayload(value: unknown): unknown {
  const safe = redact(value);
  let text = '';
  try {
    text = JSON.stringify(safe) ?? 'null';
  } catch (err) {
    throw badRequest('desk.intake', `payload is not serialisable: ${(err as Error).message}`);
  }
  if (text.length <= MAX_PAYLOAD_CHARS) return safe;
  return { '[truncated]': true, chars: text.length, preview: text.slice(0, 2000) };
}

/** Keys an inbound report is never allowed to carry, because something downstream
 * would EXECUTE them. proofs/proofs.ts reads `request.replay_cmd` as the exact
 * replay command; desk deliberately reproduces with the operator-configured
 * `AHD_REPRO_COMMAND` instead, so the key is stripped at the boundary. Untrusted
 * agent data may describe a failure — it may never supply a command line.
 *
 * Only the replay-command family is stripped. Generic keys like `cmd` or `shell`
 * are left alone on purpose: a vendor request body may legitimately contain them,
 * they are evidence the resolver needs, and nothing in the pipeline executes them. */
export const EXECUTABLE_REQUEST_KEYS: readonly string[] = ['replay_cmd', 'replay_command', 'replay_shell'];

/** Removes executable keys from a payload's top level (the only place they are read
 * from). Returns the value untouched when nothing was stripped, plus the list of
 * removed key names so the intake event can say what the desk refused. */
export function stripExecutableKeys(value: unknown): { value: unknown; stripped: string[] } {
  const rec = asRecord(value);
  if (rec === null) return { value, stripped: [] };
  const stripped: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(rec)) {
    if (EXECUTABLE_REQUEST_KEYS.includes(key.toLowerCase())) {
      stripped.push(key);
      continue;
    }
    kept[key] = rec[key];
  }
  return { value: stripped.length === 0 ? value : kept, stripped };
}

/** The HTTP status of the vendor's failing response, if the payload states one. */
export function statusOf(response: unknown): number | null {
  const rec = asRecord(response);
  if (!rec) return null;
  for (const key of ['status', 'status_code', 'statusCode', 'http_status', 'code']) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  }
  return null;
}

/** Bounded, lowercase text drawn from the response for classification only.
 * `redact` caps depth and drops non-JSON values, so the result is always acyclic
 * and JSON.stringify cannot throw here. */
function evidenceText(response: unknown): string {
  return (JSON.stringify(redact(response)) ?? '').slice(0, 8000).toLowerCase();
}

export const FAILURE_CLASSES: readonly FailureClass[] = ['knowledge', 'code', 'authority'];

/** Classify the failure. An explicit, valid `klass` from the caller is honoured
 * as a HINT only: it can never mint authority by itself, because a grant always
 * passes the approval gate (see gate.ts). Without a hint we derive it from the
 * evidence, and we derive conservatively — the desk never assumes it may grant. */
export function classOf(explicit: unknown, response: unknown): FailureClass {
  if (typeof explicit === 'string' && (FAILURE_CLASSES as readonly string[]).includes(explicit)) {
    return explicit as FailureClass;
  }
  const status = statusOf(response);
  const text = evidenceText(response);
  const authoritySignal = /(scope|permission|entitle|forbidden|not allowed|grant|appeal|reissue|one per person|quota)/;
  if ((status === 401 || status === 402 || status === 403) && authoritySignal.test(text)) return 'authority';
  if (status !== null && status >= 400 && status < 500 && /(invalid|validation|unprocessable|malformed|422|400)/.test(text)) {
    return 'code';
  }
  return 'knowledge';
}

/** RFC 9457-shaped `type` for the AgentReply. */
export function typeSlug(status: number | null, klass: FailureClass): string {
  if (klass === 'authority') return 'problem/authority-required';
  switch (status) {
    case 400:
      return 'problem/malformed-request';
    case 401:
      return 'problem/wrong-auth-header';
    case 402:
      return 'problem/payment-required';
    case 403:
      return 'problem/missing-scope';
    case 404:
      return 'problem/unknown-endpoint';
    case 422:
      return 'problem/validation-error';
    case 429:
      return 'problem/rate-limited';
    default:
      return status !== null && status >= 500 ? 'problem/vendor-error' : 'problem/vendor-api-failure';
  }
}

/** One-sentence title for the AgentReply. Deliberately generic: the desk states
 * what it proved, not a story it invented. */
export function titleFor(status: number | null, klass: FailureClass): string {
  if (klass === 'authority') {
    return 'The call is correct but blocked by a policy grant only the vendor can issue';
  }
  switch (status) {
    case 401:
      return 'Send the documented Authorization scheme, not x-api-key';
    case 402:
      return 'Payment required before this call will succeed';
    case 403:
      return 'The credential lacks a scope for this write';
    case 404:
      return 'The endpoint or path in the request does not exist';
    case 422:
      return 'The validator rejected a field but did not name it';
    case 429:
      return 'Rate limited: back off and retry with the documented budget';
    default:
      return status !== null && status >= 500
        ? 'The vendor API failed on a valid request'
        : 'The documented behaviour and the observed behaviour disagree';
  }
}

export function urlOf(request: unknown): string | null {
  const rec = asRecord(request);
  if (!rec) return null;
  for (const key of ['url', 'uri', 'href', 'endpoint', 'path']) {
    const v = rec[key];
    if (typeof v !== 'string' || v.length === 0 || v.length > 2000) continue;
    // Strip any embedded credentials and refuse non-http schemes before echoing.
    const withoutCreds = v.replace(/\/\/[^/@\s]+@/, '//');
    if (/^https?:\/\//i.test(withoutCreds)) return clip(withoutCreds, 2000);
    if (withoutCreds.startsWith('/')) return clip(withoutCreds, 2000);
  }
  return null;
}

const HTTP_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function methodOf(request: unknown): string {
  const rec = asRecord(request);
  const v = rec ? rec['method'] : null;
  if (typeof v === 'string') {
    const up = v.toUpperCase();
    if (HTTP_METHODS.includes(up)) return up;
  }
  return 'GET';
}

/** A corrected call the agent can run. Never contains a credential value. */
export function snippetFor(request: unknown, klass: FailureClass, status: number | null): string {
  const url = urlOf(request) ?? 'https://api.vendor.example/v1/resource';
  const method = methodOf(request);
  if (klass === 'authority') {
    return `curl -X POST -H 'Authorization: Bearer $VENDOR_API_KEY' -H 'Idempotency-Key: '"$(uuidgen)" ${url}`;
  }
  if (status === 401) {
    return `curl -H 'Authorization: Bearer $VENDOR_API_KEY' ${url}`;
  }
  if (method === 'GET') return `curl -H 'Authorization: Bearer $VENDOR_API_KEY' ${url}`;
  return `curl -X ${method} -H 'Authorization: Bearer $VENDOR_API_KEY' -H 'Content-Type: application/json' --data @body.json ${url}`;
}

// ---- boundary validators that extend shared/http.ts's str()/num() ----
// shared/http.ts is owned by the orchestrator; these live here so desk/ can
// validate optional and enumerated fields without editing a shared file.

export function optStr(body: unknown, field: string, stage: string, max: number): string | null {
  const rec = asRecord(body);
  if (!rec) return null;
  const v = rec[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw badRequest(stage, `field "${field}" must be a string`);
  if (v.length === 0) return null;
  if (v.length > max) throw badRequest(stage, `field "${field}" must be at most ${max} characters`);
  return v;
}

export function oneOf<T extends string>(body: unknown, field: string, stage: string, allowed: readonly T[]): T {
  const rec = asRecord(body);
  const v = rec ? rec[field] : undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw badRequest(stage, `field "${field}" must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

export function optOneOf<T extends string>(
  body: unknown,
  field: string,
  stage: string,
  allowed: readonly T[],
): T | null {
  const rec = asRecord(body);
  const v = rec ? rec[field] : undefined;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw badRequest(stage, `field "${field}" must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

export function boolOf(body: unknown, field: string, stage: string, fallback: boolean): boolean {
  const rec = asRecord(body);
  const v = rec ? rec[field] : undefined;
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw badRequest(stage, `field "${field}" must be a boolean`);
  return v;
}

/** Read a positive integer from the environment, falling back loudly-checked defaults. */
export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}
