// The resolver step: turn a reproduced failure into a candidate change plus the
// harness that reproduces it.
//
// HONESTY NOTE: in the full product this step is a coding agent running inside
// the sandbox that edits the vendor's checkout. This file is the deterministic,
// offline stand-in that the build plan's "Resolver" checkpoint needs: it emits a
// bounded, reviewable diff from the stored case facts. `runLoop` accepts an
// injected `draft` function so the real resolver can replace it without touching
// the state machine.
//
// The fresh-agent proof is given ONLY the original task and the changed file
// names (`DraftFix.changed`), never this reasoning, never the diff, and never
// the resolver's notes — leaking the fix into that prompt is the failure mode the
// build plan calls out.
import type { Failure } from '../shared/types.ts';
import { changeKindOf } from './gate.ts';
import type { ChangeKind } from './gate.ts';
import { asRecord, clip, methodOf, snippetFor, statusOf, titleFor, typeSlug, urlOf } from './inspect.ts';

const MAX_DIFF = 8000;

/** One patched file: its sandbox-relative path and its full post-change content. */
export interface DraftFile {
  path: string;
  content: string;
}

export interface DraftFix {
  kind: ChangeKind;
  attempt: number;
  type_slug: string;
  title: string;
  status: number | null;
  summary: string;
  /** Unified-diff shaped candidate change. Empty for a pure grant. */
  diff: string;
  /** File names changed. This is the ONLY thing the fresh-agent proof receives. */
  changed: string[];
  /** The patched content of each changed file, so the loop can write them into the
   * sandbox. proofs/proofs.ts READS every `changed` path for the fresh-agent check
   * and fails that proof when a path is missing, so a diff alone is not enough.
   * Empty for a pure grant, which changes no file. */
  files: DraftFile[];
  fix_steps: string[];
  snippet: string;
  target_path: string | null;
}

export function targetPathFor(kind: ChangeKind): string | null {
  switch (kind) {
    case 'docs':
      return 'docs/quickstart.md';
    case 'error_text':
      return 'src/errors/messages.ts';
    case 'code':
      return 'src/http/handler.ts';
    case 'config':
      return 'config/scopes.json';
    case 'schema':
      return 'openapi.yaml';
    case 'grant':
      return null;
  }
}

function fieldHint(response: unknown): string {
  const rec = asRecord(response);
  if (!rec) return 'the rejected field';
  for (const key of ['field', 'invalid_field', 'param', 'name']) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= 80) return v;
  }
  const errs = rec['errors'];
  if (Array.isArray(errs)) {
    const first = asRecord(errs[0]);
    if (first) {
      const f = first['field'] ?? first['param'] ?? first['name'];
      if (typeof f === 'string' && f.length > 0 && f.length <= 80) return f;
    }
  }
  return 'the rejected field';
}

function scopeHint(response: unknown): string {
  const rec = asRecord(response);
  if (!rec) return 'entitlements.reissue';
  for (const key of ['scope', 'required_scope', 'missing_scope', 'permission']) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= 80) return v;
  }
  return 'entitlements.reissue';
}

export function fixStepsFor(kind: ChangeKind, f: Failure, status: number | null): string[] {
  const url = urlOf(f.request) ?? 'https://api.vendor.example/v1/resource';
  const method = methodOf(f.request);
  switch (kind) {
    case 'docs':
      return [
        status === 401
          ? `Send 'Authorization: Bearer <key>' on ${method} ${url}`
          : `Re-send ${method} ${url} using the documented request shape`,
        'Remove the header or field the quickstart showed incorrectly',
        'Retry the original call; no production change is required on your side',
      ];
    case 'error_text':
      return [
        `Re-send the request; the ${status ?? 400} response now names the offending field`,
        `Correct the value of "${fieldHint(f.response)}" and retry`,
      ];
    case 'code':
      return [
        `Re-send ${method} ${url}`,
        'The validator now accepts the documented format; retry the original call',
      ];
    case 'config':
      return [`Ask the vendor to attach scope "${scopeHint(f.response)}" to the key, then retry ${method} ${url}`];
    case 'schema':
      return ['Refresh the OpenAPI document you cached', `Retry ${method} ${url} against the corrected schema`];
    case 'grant':
      return [
        'Call the granted verb with the Idempotency-Key from the reply',
        'A replay of the same key returns the original receipt and spends nothing',
        `Then retry the original task before ${f.resolve_by}`,
      ];
  }
}

/** Comment syntax for the target file kind. JSON has none, so a config draft
 * carries no provenance line rather than becoming unparseable. */
function commentFor(kind: ChangeKind, text: string): string {
  switch (kind) {
    case 'docs':
      return `<!-- ${text} -->`;
    case 'schema':
      return `# ${text}`;
    case 'config':
      return '';
    default:
      return `// ${text}`;
  }
}

/** The full post-change content of the one file a draft touches. Deterministic:
 * the same case and attempt always produce byte-identical bytes, so a re-run of
 * the loop is a no-op write rather than a new "change". */
function fileBodyFor(kind: ChangeKind, f: Failure, attempt: number, added: string[]): string {
  const provenance = commentFor(kind, `AgentHelpDesk draft for case ${f.id}, attempt ${attempt}.`);
  const body = provenance === '' ? added : [provenance, '', ...added];
  return `${body.join('\n')}\n`;
}

export function draftFix(f: Failure, attempt: number): DraftFix {
  const kind = changeKindOf(f.klass, f.response);
  const status = statusOf(f.response);
  const url = urlOf(f.request) ?? 'https://api.vendor.example/v1/resource';
  const target = targetPathFor(kind);
  const slug = typeSlug(status, f.klass);
  const title = titleFor(status, f.klass);
  const snippet = snippetFor(f.request, f.klass, status);
  const widened = attempt > 1 ? `\n+<!-- ahd: attempt ${attempt} widened the change after a failed proof -->` : '';

  let diff = '';
  if (target !== null) {
    const lines: string[] = [`--- a/${target}`, `+++ b/${target}`, '@@ -1,3 +1,4 @@'];
    switch (kind) {
      case 'docs':
        lines.push(
          `-    curl -H 'x-api-key: $VENDOR_API_KEY' ${url}`,
          `+    curl -H 'Authorization: Bearer $VENDOR_API_KEY' ${url}`,
          '+    <!-- ahd:regression ' + f.id + ' guards this snippet -->',
        );
        break;
      case 'error_text':
        lines.push(
          "-  message: 'invalid request',",
          `+  message: 'invalid request: field "${fieldHint(f.response)}" is not accepted. Example: {"${fieldHint(
            f.response,
          )}":"2026-10-17"}',`,
          `+  // ahd:regression ${f.id}`,
        );
        break;
      case 'code':
        lines.push(
          '-  const parsed = strictParse(body);',
          '+  const parsed = strictParse(body, { reportField: true });',
          `+  // ahd:regression ${f.id}`,
        );
        break;
      case 'config':
        lines.push(
          '-    "scopes": ["read"]',
          `+    "scopes": ["read", "${scopeHint(f.response)}"]`,
          `+    // ahd:regression ${f.id}`,
        );
        break;
      case 'schema':
        lines.push(
          '-      description: Request body',
          `+      description: Request body. Field "${fieldHint(f.response)}" must be an ISO-8601 date.`,
          `+      # ahd:regression ${f.id}`,
        );
        break;
      case 'grant':
        break;
    }
    if (widened.length > 0) lines.push(widened.trimStart());
    diff = clip(lines.join('\n'), MAX_DIFF);
  }

  // The patched file is derived from the diff's own added lines, so the file the
  // fresh-agent proof reads and the diff the vendor sees can never disagree.
  const added = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
  const files: DraftFile[] =
    target !== null && added.length > 0 ? [{ path: target, content: fileBodyFor(kind, f, attempt, added) }] : [];

  const summary =
    kind === 'grant'
      ? `Publish a bounded verb behind an authority envelope for case ${f.id} (no repo change).`
      : `${kind} change in ${target ?? 'the vendor repo'} for case ${f.id}: ${title}.`;

  return {
    kind,
    attempt,
    type_slug: slug,
    title,
    status,
    summary,
    diff,
    changed: target !== null ? [target] : [],
    files,
    fix_steps: fixStepsFor(kind, f, status),
    snippet,
    target_path: target,
  };
}

export interface ReproPaths {
  fixture: string;
  harness: string;
}

/** Where the repro harness lives inside the per-case sandbox. Keyed by case id,
 * never by a global, so two cases cannot contaminate each other. */
export function reproPaths(f: Failure): ReproPaths {
  return {
    fixture: `ahd/repro/${f.id}.json`,
    harness: `ahd/repro/${f.id}.test.mjs`,
  };
}

/** The redacted, bounded fixture the harness replays. Credential-shaped fields
 * are already redacted by intake; the sandbox supplies its own test credentials. */
export function reproFixture(f: Failure): string {
  const payload = {
    case_id: f.id,
    vendor_id: f.vendor_id,
    task: f.task,
    klass: f.klass,
    request: f.request,
    response: f.response,
    expected_status: statusOf(f.response),
    generated_by: 'agenthelpdesk/desk/resolve.ts',
  };
  return JSON.stringify(payload, null, 2);
}

/** A `node:test` file that replays the reported failure against the vendor's
 * test target. Reproduction targets the vendor's test file/command, not a full
 * stack: standing up the vendor's database and queues is later work. */
export function reproHarness(f: Failure): string {
  const paths = reproPaths(f);
  const expected = statusOf(f.response);
  return [
    `// Generated by AgentHelpDesk for case ${f.id}. Do not edit by hand.`,
    `// Replays the reported failure against the vendor test target.`,
    `import test from 'node:test';`,
    `import assert from 'node:assert/strict';`,
    `import { readFileSync } from 'node:fs';`,
    ``,
    `const fixture = JSON.parse(readFileSync(new URL('./${f.id}.json', import.meta.url), 'utf8'));`,
    ``,
    `test('replay ${f.id}', async () => {`,
    `  const observed = await globalThis.__ahdReplay(fixture.request);`,
    `  assert.equal(observed.status, ${expected ?? 'null'}, 'the reported failure did not reproduce');`,
    `});`,
    `// fixture: ${paths.fixture}`,
    ``,
  ].join('\n');
}

export type DraftFn = (f: Failure, attempt: number) => DraftFix;
