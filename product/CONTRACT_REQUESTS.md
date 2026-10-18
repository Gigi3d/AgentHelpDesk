# CONTRACT_REQUESTS.md

Append-only log of requested contract changes (shared/types.ts, store/repository.ts,
route shapes). Requesting agents code against a clearly-commented local assumption until
the orchestrator rules. Do not edit shared files directly (product/AGENTS.md).

## From: sandbox + proofs owner (product/sandbox/, product/proofs/) — 2026-10-18

1. **Replay command convention for `Failure.request`** (proofs.replay).
   Ask: bless one of — (a) an optional `replay_cmd: string` field inside
   `Failure.request` that proofs re-runs verbatim in the sandbox, or (b) a required
   harness at `/ahd/replay.mjs <request.json>` that the desk/resolver provisions and
   that replays `Failure.request` against the vendor test instance.
   Local assumption (coded in proofs/proofs.ts): `request.replay_cmd` when present and a
   non-empty string, else `node /ahd/replay.mjs /ahd/cases/<sanitized-id>/request.json`.

2. **Vendor test command discovery** (proofs.vendorTests).
   `ProofRunner.vendorTests(sb)` receives no `Vendor`. Ask: either add the test command
   to `Vendor` (e.g. `test_command: string`) or bless the sandbox-file convention.
   Local assumption: read `/ahd/test-command` inside the sandbox; fallback `npm test`.

3. **`freshAgent(sb, task, changed)` semantics of `changed: string[]`.**
   Ask: confirm `changed` = sandbox-relative paths of changed docs/code (contents are
   read from the forked sandbox and handed to the fresh agent as a bundle).
   Local assumption: exactly that; unreadable or `..`-containing paths fail the proof
   with `pass:false` naming the path (never a throw).

4. **Background-exec / poll convention on `SandboxHandle`.**
   The contract's `exec(cmd, { background: true })` has no documented return convention
   and `SandboxHandle` has no `poll`. Ask: bless the convention (or add
   `poll(pid): Promise<ExecResult | null>` to `SandboxHandle`).
   Local assumption (implemented by both the Blaxel handle and the fake, used by
   `sandbox/client.ts runCapped/poll`): background exec resolves immediately with
   `exit_code 0` and the **pid token in `stdout`**; the run's files live at
   `/tmp/ahd-bg-<pid>.{out,err,exit}`; polling reads the exit-code file via `exec('cat …')`
   and returns `null` while it is absent.

5. **ToolEvent ticket key for sandbox-bound proofs.**
   `vendorTests`/`freshAgent` events have no `Failure` in scope. Local assumption:
   `ticket_id` = sandbox name minus the `ahd-` prefix (which is the ticket id by the
   naming convention); `replay` events use `Failure.id` directly. Flag if the console
   expects one or the other everywhere.

## From: approvals + reports owner (product/approvals/) — 2026-10-18

1. **`Repository.listApprovals(filter?: { failure_id?: string; decided?: boolean })`.**
   Needed so the desk can find the open approval for a case, and so reports can count
   pending approvals without depending on case status.
   Local assumption (coded in `approvals/approvals.ts`): the approval id is deterministic —
   `apv_<sha256(failure_id + "\n" + change_summary)>.slice(0,24)` — so a caller who knows both
   can fetch it with `getApproval(id)`, and an identical re-request is a replay that sends
   nothing. Nobody can currently enumerate a case's approvals without the change summary.

2. **`Repository.listGrants(filter?: { vendor_id?: string })`.**
   The weekly report must state "grants issued under the envelope" (Build Plan). `Grant` rows are
   write-only today (`recordGrant` / `grantByIdempotencyKey`), so the envelope cap, per-user limit
   and `spent` flag cannot be reported.
   Local assumption (coded in `approvals/reports.ts`): `grants_issued` counts `Outcome` rows with
   `shipped_as === 'grant'` for cases opened in the window.

3. **A billable/meter summary for a vendor: `listMeterEvents({ vendor_id })` or
   `billableSummary(vendorId, since)`.**
   The weekly expected bill should be the Stripe meter total (the plan calls it an invoice
   preview), not a price guess.
   Local assumption: `expected_bill_usd = billable_cases × AHD_REPORT_UNIT_PRICE_USD` (default 1.00,
   Build Plan's "$0.50 to $1 per resolved task" first pricing guess). `billable_cases` comes from
   `Repository.isBillable()`. The report labels it a preview and names the meter authoritative in
   `assumptions[]`.

4. **`Outcome.created_at`.** Outcomes have no timestamp, so a merge, regression test or grant can
   only be attributed to a report window through its case's `Failure.created_at`. Local assumption:
   exactly that (documented in the report's `assumptions[]`).

5. **Shared `Report` / `ReportNumbers` / `TopFailure` types in `shared/types.ts`.**
   `web/` and `desk/` will want to render `GET /v1/reports/{daily,weekly}` and `POST
   /v1/reports/send-now`. Local assumption: they live in `approvals/reports.ts` and are imported
   from there; promote them if the console should not depend on this module's internals.
   Response shapes: `{ report }` for the two GETs, `{ report, delivered[] }` for send-now,
   `{ approval, replayed, text_sent, body }` for `POST /v1/approvals`.

6. **`Failure.endpoint` (or a blessed signature rule).** "Top three repeating failures" needs a
   grouping key and there is no endpoint column. Local assumption
   (`approvals/reports.ts failureSignature`): `klass` + `request.method` + normalised
   `request.path|url|endpoint|route` (query string dropped, absolute URLs reduced to the pathname);
   when the request carries none of those, `klass` + lowercased whitespace-collapsed `task`.
   Note this reads the same `Failure.request` shape the proofs owner asks about in item 1 above.

7. **Desk contract for the gate (no code ask, an agreement).** `approvals/` never writes case status
   and never imports `desk/`. The desk should: (a) call `requestApproval(failureId, changeSummary,
   approver, repo)` after the three proofs, (b) set the case to `awaiting_approval` — the daily
   report's `awaiting_approval` / `waiting_on_vendor` counts read that status, (c) poll
   `repo.getApproval(id)` for `decision`, and (d) for an envelope grant put the cap and per-user
   limit in the **first line** of `change_summary` (Build Plan addendum: a human is approving a spend
   limit, not a diff) — `composeApprovalText` preserves line 1 when it trims to the message cap.
   `requestApproval` fails loud with `409 approvals.request proofs_missing` if the case has no
   attempt yet, so nobody is asked to approve blind.

8. **An email transport from `product/email/` (Primitive).** The cited Inkbox quickstart documents
   `identity.send_text` / `sendText` only and does **not** say whether texts are SMS or iMessage, so
   the plan's "use email for the weekly report" needs a real email path.
   Local assumption: `InkboxClient.sendEmail(to, subject, body)` is the seam; `RealInkboxClient`
   refuses it with `502 channel_unavailable` (stage `approvals.inkbox.send_email`) rather than
   pretending to deliver, and `FakeInkbox` implements it so the fallback is testable. Ask: export
   `sendEmail(to, subject, body) => Promise<{ message_id: string }>` from `email/` and the
   orchestrator injects it via `RouteDeps.client` / `ApprovalDeps.client`.

9. **ToolEvent ticket key for report events** (same question as item 5 above). A report has no case.
   Local assumption: `ticket_id` = vendor id, `tool` = `inkbox`, `action` = `report.sent`. Approval
   events use the case id (`Failure.id`) as `ticket_id`. Flag if the console needs a separate
   `vendor_id` field instead.

## From: billing owner (product/billing/) — 2026-10-18

1. **`Repository.getOutcomeById(outcomeId)`** (and ideally `listOutcomes({ vendor_id })`).
   The billing routes are specified in terms of `outcome_id`, but the store can only fetch an
   outcome by *failure* id (`getOutcome(failureId)`).
   Local assumption (coded in `billing/outcome.ts resolveOutcome`): resolve an outcome id by
   scanning `listFailures()` and reading each outcome, capped by `AHD_BILLING_OUTCOME_SCAN_CAP`
   (default 2000); over the cap it fails loud with `501 outcome_lookup_unavailable` rather than
   guessing. Callers may pass `failure_id` to skip the scan. This is O(cases) per billing call and
   should not survive into Postgres.

2. **`Repository.updateOutcome(id, patch)`**, or a blessing that `createOutcome` is an upsert.
   Billing must persist `stripe_event_id`, `payer`, `mpp_payment_id`, `x402_payment_id` and
   `billable`, and there is no patch method.
   Local assumption (`billing/outcome.ts saveOutcome` + `refreshOutcome`): `MemoryRepository.createOutcome`
   is an upsert keyed by `failure_id` (`Map.set`), so billing re-reads the stored row and writes the
   whole outcome back. If the Postgres store makes `createOutcome` insert-only, `saveOutcome` is the
   single place that must change.

3. **Response headers on `HttpResult`.** x402 clients read the payment requirement from the
   `x-payment-required` header (base64 JSON) and MPP clients expect their requirement on the 402.
   `HttpResult` carries only `{ status, body }`, so `server.ts` cannot set a header for us.
   Local assumption: the base64 value is returned *in the body* as `x_payment_required_b64` (x402)
   and `payment_requirement_b64` (MPP) for the desk/proxy to put on the wire. Ask: add
   `headers?: Record<string, string>` to `HttpResult`.

4. **A receipt store for agent-pays settlements:**
   `recordReceipt({ id, lane, outcome_id, idempotency_key, amount_usd, mode, at })` +
   `receiptByIdempotencyKey(key)`. `recordMeterEvent` already gives identifier uniqueness for the
   meter lane; the two 402 lanes have no equivalent, so one payment replayed against *two different
   outcomes* cannot be detected.
   Local assumption (`billing/x402.ts`, `billing/mpp.ts`): idempotency lives on the outcome
   (`x402_payment_id` / `mpp_payment_id`), so a replay returns the original receipt and unlocks
   once; the fake verifier's payment id is deterministic in the proof, so the same proof yields the
   same id. We deliberately did **not** stuff receipts into the meter or grant tables.

5. **Which rail a vendor chose for agent-pays: `Vendor.agent_pay_rail?: 'mpp' | 'x402'`.**
   `payer_mode` says *who* pays, not *how*.
   Local assumption (`billing/billable.ts chooseLane`): `payer_mode === 'agent'` → `b2b_mpp` (Build
   Plan: "we lead with x402 for agent-to-agent and keep MPP for the vendor-chooses-agent-pays case").

6. **How a "stranger agent" is identified.** Today the only signal is the absence of a vendor
   relationship.
   Local assumption: no `Vendor` row for `Failure.vendor_id`, or a vendor with an empty
   `stripe_customer_id` → `a2a_x402`. Ask: bless that, or add a registered-agents table so a known
   agent calling on a vendor's behalf is not charged per call.

7. **Where the billing-exempt policy lives.** Local assumption (`billing/billable.ts exemptionFor`):
   case-insensitive substring match of `AHD_BILLING_EXEMPT_TERMS` (default: privacy request, data
   deletion, delete my data, right to be forgotten, dsar, gdpr, ccpa, subject access request) against
   `Failure.task`, plus `Vendor.risk_policy === 'suggest_only'` never bills (rungs 0-3 are labelled
   suggestions only). Ask: promote to `Vendor.billing_exempt` / a policy table so exemption is not
   inferred from free text an agent supplied — an agent could otherwise dodge a bill by writing
   "gdpr" into its task string.

8. **Who provisions the Stripe meter.** Billing only emits events
   (`stripe.billing.meter_events.create`, count aggregation, event name `AHD_STRIPE_METER_EVENT_NAME`,
   default `ahd_verified_fix`); the meter itself and its per-fix price must exist first, or Stripe
   rejects the event.
   Local assumption: provisioned out of band in the dashboard/CLI for the demo, and a missing meter
   surfaces as `502 stripe_error` at stage `billing.stripe.emit`. Ask: bless that, or add
   `POST /v1/billing/meters` (create with count aggregation + price) to this module.

9. **Canonical price list.** `web/src/data/billing.json` shows `migration_pr: 15` and
   `platform_monthly: 49`; the billing brief says $0.50 / $1 / $25 with $0 platform in test.
   Local assumption (`billing/prices.ts`): defaults `docs_error_text 0.50`, `code_config_grant 1`,
   `migration_pr 25`, `platform_monthly 0` (test), all overridable via `AHD_PRICE_*_USD`. Ask: pick
   one and we will match it; the preview is computed from repo rows × this list, so only the env
   values change.

10. **Desk ↔ billing call order (no code ask, an agreement).** `billing/` never writes case status
    and never imports `desk/`. The desk should: (a) call `decide(failureId, repo)` after the approval
    gate / retry result is known, (b) when `billable` call `onBillable(outcome, decision.lane, repo)`
    — or `POST /v1/billing/on-billable {outcome_id, lane}` — and (c) treat a `402` from that call as
    "the answer is priced, serve it only after `/v1/a2a/settle` or `/v1/billing/mpp/settle` returns
    `unlock: true`". A retry that later fails should call
    `POST /v1/billing/meter-events/cancel {outcome_id, reason}` inside Stripe's 24h window.
    ToolEvent keys: `ticket_id` = `Failure.id`, `tool` = `billing`, `stage` ∈ `billing.decide`,
    `billing.meter`, `billing.x402`, `billing.mpp`, `billing.invoice`, `billing.stripe`, `billing.prices`.

11. **Same blocker the evals owner filed: `shared/http.ts` `HttpError` uses constructor parameter
    properties**, which Node's strip-only mode (`--experimental-strip-types`, the `test` script)
    rejects, so importing it throws before any test runs. Billing cannot edit shared/; see the evals
    section for the two fixes. Local assumption: everything under `billing/` is erasable-syntax-only
    (no parameter properties, enums, namespaces or decorators), so it loads as soon as shared/ does.

## From: evals owner (product/evals/) — 2026-10-18

1. **BLOCKER for every module: `shared/http.ts` `HttpError` uses constructor parameter
   properties, which are not erasable syntax.**
   `constructor(public readonly status: number, public readonly code: string, message: string,
   public readonly stage: string)` cannot be run by Node type-stripping: parameter properties
   are on Node's unsupported list (with enums, namespaces and decorators), so `npm start`
   (`node server.ts`) and `npm test` (`node --test --experimental-strip-types …`) will fail at
   load on any file that imports `shared/http.ts` — which is all of them.
   Ask: keep the public shape identical but assign in the constructor body:
   `readonly status: number; readonly code: string; readonly stage: string;` + `this.status = status; …`.
   Local assumption (coded in evals/): we only *use* `HttpError`/`badRequest`/`ok`/`str`/`num`
   and never declare a parameter property ourselves, so no evals change is needed once fixed.

2. **`product/tsconfig.json` sets `"types": ["node"]` but no `@types/node` is resolvable from
   `product/`.** There is no `product/node_modules` and no repo-root `node_modules`; the only copy
   in the tree is `mcp/node_modules.nosync/@types/node` (22.20.5), which module resolution from
   `product/` will not reach. `npm run typecheck` therefore fails with "Cannot find type
   definition file for 'node'" for every module (node:test, node:crypto, node:http, process,
   AbortSignal and fetch all depend on it).
   Ask: install/link `@types/node@22` where `product/` can resolve it (or drop `"types"` and let
   automatic `node_modules/@types` discovery work). No evals change either way.

3. **No eval table: proceeding with ToolEvents as instructed — ask to bless it permanently.**
   Local assumption (coded in evals/): a run is a `ToolEvent` with `tool: 'Armature'`,
   `action: 'eval.install'`, `stage: 'evals.install'`, `id` = the run id, `ticket_id` = the
   synthetic `ahd-eval` (evals are not cases), `d_ms` = measured run time and the whole result in
   `payload`; the aggregate is `action: 'eval.pick'`, `stage: 'evals.pick'`. Reads go through
   `repo.toolEvents({ tool: 'Armature' })`. Consequences we accepted: (a) `appendToolEvent` has no
   uniqueness rule, so idempotency is a read-back by `payload.idempotency_key` (a crash between
   run and append can duplicate a row); (b) the pick rate scans all Armature rows.
   Ask: bless ToolEvents as the permanent store, or add `eval_runs` + an idempotent
   `appendToolEvent(e)` that dedupes on `id`. We will switch to whichever is blessed.

4. **`Repository.toolEvents` filter has no `action` (or `stage`).**
   Ask: widen to `toolEvents(filter?: { ticket_id?: string; tool?: string; action?: string; stage?: string })`.
   Local assumption: we pass `{ tool: 'Armature' }` (plus `ticket_id` when known) and filter
   `action` client-side in `evals/install-eval.ts readInstallRuns` and `evals/pick-rate.ts`.

5. **Shared types for eval rows, so the console does not have to guess `payload: unknown`.**
   Ask: add to `shared/types.ts` (shapes are exactly what evals/ writes today):
   `interface EvalStep { n: number; name: string; ok: boolean; found_in: string | null; evidence: string; detail: string; ms: number }`
   `interface EvalInstallPayload { run_id: string; ticket_id: string; pass: boolean; step_count: number; steps: EvalStep[]; time_ms: number; rung: number; simulated: boolean; mode: 'armature' | 'fake'; leak: { detected: boolean; reason: string | null }; idempotency_key: string | null; docs_read: string[]; armature: { mode: string; submitted: boolean; run_ref: string | null; status: number | null; error: string | null; faked: boolean }; disclaimer: string }`
   `interface EvalPickPayload { runs: number; passed: number; failed: number; invalidated_by_leak: number; pick_rate: number | null; pick_rate_pct: number | null; median_time_ms: number | null; step_pass: Record<string, { runs: number; ok: number; ok_rate: number | null }>; rungs: Record<string, { runs: number; passed: number }>; simulated_runs: number; armature_submitted_runs: number; skipped_malformed: number; source: 'tool_events'; computed_at: string }`
   Local assumption: `evals/install-eval.ts` declares `StoredInstallRun` / `StoredInstallStep`
   locally and re-validates every payload on read (malformed rows are counted in
   `skipped_malformed`, never dropped silently), so a blessed shared type is a rename for us.

6. **Coordination with proofs/ and desk/ on the two different "fresh agent" runs (no code ask).**
   The per-case `ProofRunner.freshAgent(sb, task, changed)` (proof c) and this module's
   product-level install eval are different measurements: the proof asks "does the fix work for a
   clean agent", the eval asks "can a clean agent install the desk and open a first ticket from the
   docs alone". Ask: keep them separate, and when either is invoked from the loop, pass the
   resolver's reasoning / diff / fix steps as `forbidden: string[]` to `runInstallEval` so the leak
   guard can prove nothing leaked. Local assumption: `runInstallEval` is called only from
   `POST /v1/evals/install` (and directly by tests), writes only ToolEvents, and never touches
   `Failure`/`Attempt` state, so it cannot corrupt a case.

## From: email owner (product/email/, Primitive lane) — 2026-10-18

1. **Bless `idempotency_key?: string` on the shared `ProblemReport`.**
   `desk/intake.ts` already reads it (`optStr(rec, 'idempotency_key', stage, 200)`) and derives a
   deterministic case id `c_<shortHash('case:'+key,20)>`, deduping on replay with
   `case.duplicate_ignored`. It is not in `shared/types.ts`, so the lane that needs it most
   (email — providers retry) has to widen the type locally.
   Local assumption (coded in `email/threads.ts`): `interface EmailProblemReport extends
   ProblemReport { idempotency_key?: string }`, value `email:<sha256(from|subject|body).slice(0,40)>`,
   passed to the injected `IntakeFn` typed as `(report: ProblemReport, repo: Repository) => Promise<Failure>`.
   Ask: add the optional field to `shared/types.ts` so the MCP, webhook and forwarded lanes get the
   same replay safety. No email change either way (the local interface is assignable).

2. **Confirm the `intake` contract the email lane is built on (no code ask).**
   Ask: keep `export async function intake(report: ProblemReport, repo: Repository): Promise<Failure>`
   as the only desk entry point for channels, keep the desk as the sole owner of `ack_by`,
   `resolve_by`, `queue_position` and `klass`, and keep `vendor_hint` optional.
   Local assumption: exactly that. `email/threads.ts` imports `intake` and nothing else from
   `desk/`, always sends `channel: 'email'`, sends `vendor_hint` only when the subject carries a
   `[tag]`, never sends `klass`, and copies the committed times from the returned `Failure` into
   both the HTTP response and the reply text verbatim (never recomputed in the lane).

3. **No persistence for email threads/messages.**
   `Repository` has no thread or message store, so `GET /v1/email/threads` can only read the
   provider (`FakePrimitive` reads `email/fixtures/threads.json`), and the thread↔case link exists
   only inside ToolEvent payloads.
   Ask: bless one of — (a) `Repository.createThread(t)` / `listThreads({ from? })` plus a `threads`
   table (`thread_id, from, to, subject, sender_verified, case_id, message_count, created_at`), or
   (b) ToolEvents as the permanent store for the lane (what evals/ asked for in item 3), with the
   console joining on `payload.thread_id`.
   Local assumption (coded in `email/threads.ts`): (b)-lite. `email.received` (written before any
   send, so the case survives a delivery failure) carries `{ inbound_id, from, agent_id, vendor_id,
   task, subject, sender_verified, channel, json_found, body_chars, idempotency_key, case_id,
   ack_by, resolve_by, queue_position }`; the case↔thread link is written by `email.replied`
   (`{ thread_id, message_id, sender_verified, direction, opened_here, chars, case_id, ack_by,
   resolve_by }`) and `email.refused` (`{ code, message, thread_id, case_id, escalate_via }`). Every
   row is `tool: 'primitive'`, so a case can be joined to its thread by reading events. Consequences
   we accepted: the thread list is provider-only (unavailable offline in live mode), there is no
   per-message history — only the desk's own sends and receipts — and a case whose reply was refused
   before a thread id existed has no thread link at all.

4. **`ToolEvent.ticket_id` for pre-case rows — one ruling please (same class as sandbox item 5 and
   evals item 3).**
   An unverified, malformed or intake-failed email has no `Failure`, but must still be auditable.
   Local assumption: `ticket_id` = `eml_<sha256(sanitized from|subject|body).slice(0,20)>`,
   deterministic so a provider retry lands on the same row set; once intake returns, all later rows
   use `Failure.id`.
   Ask: bless non-case ids in `ticket_id` (and say so for the console's ticket filter), or add an
   optional `external_ref` to `ToolEvent` and require `ticket_id` to always be a case. Note the
   unverified audit row deliberately stores `from`, `subject`, `body_chars` and `body_sha256` but
   **not** the body, so a phishing attempt is provable without persisting its payload — flag if the
   console needs the body anyway.

5. **Venue ask: Primitive request-body field names are not published (no code ask).**
   `https://docs.primitive.dev/docs/api` names the paths (`POST /send-mail`, `GET /emails`,
   `POST /emails/{id}/reply`), the envelope `{ success, data, meta.cursor }` and the response fields
   (`sender_verified`, `thread_id`, `message_id`, `from`, `to`, `subject`, `body`), but not the
   request bodies. Also: the ~1,000 messages/hour figure is the Build Plan's fact-check, not the API
   page, and the reply-only rule is not restated there either.
   Local assumption: the request-body names are marked `ASSUMPTION` and confined to one method in
   `email/primitive-client.ts`; the cap is enforced provider-side (HTTP 429 → `rate_limited`
   refusal) and never re-implemented as local state; a cold-send refusal is labelled
   `reply_only_new_account` only when the provider's own 403 body says so, else `refused`.
   Ask: confirm with the sponsor before `PRIMITIVE_KEY` is set anywhere. The fake lane is the demo
   default and needs none of this.

6. **Optional `channel_ref` (or `thread_id`) on `ProblemReport`/`Failure`.**
   So the resolver's tested answer, the approval outcome and the daily report can reach an
   email-originated case **on its thread** without importing `email/` internals (and so the email
   lane is not the only module allowed to reply).
   Ask: add `channel_ref?: string | null` to `Failure` (set by `intake` from the report) and let the
   desk hand it back to whichever channel module owns the prefix.
   Local assumption: the lane does not set it. Today a desk-stage reply to an emailed agent goes
   through `POST /v1/email/outbound { thread_id, body, case_id }`, and the caller must already know
   the `thread_id` (from the inbound response or the `email.received` payload).

7. **+1 on evals items 1 and 2 — both block this module too (no code ask).**
   `email/*.ts` imports `shared/http.ts`, so the `HttpError` constructor-parameter-property problem
   breaks the lane at load under Node type-stripping exactly as described; and with no resolvable
   `@types/node`, `npm run typecheck` cannot type `process.env`, `fetch`, `AbortSignal.timeout`,
   `node:test`, `node:crypto`, `node:fs/promises` or `node:url` for this module. `email/` declares no
   parameter properties of its own (`EmailRefusedError` assigns in the constructor body), so no
   email change is needed once either is fixed.

## Rulings — orchestrator, 2026-10-17

Every grant below is ADDITIVE and already applied: `shared/types.ts`, `shared/http.ts`,
`store/repository.ts` and `store/memory.ts` were edited by the orchestrator only, and no module
has to change to keep compiling. `npm run typecheck` is green across all seven modules.

### Granted, and where it landed

| Ask | Where |
| --- | --- |
| `ProblemReport.idempotency_key` (email 1) | `shared/types.ts`. `desk/register.ts` no longer widens the type locally |
| `ProblemReport.channel_ref` + `Failure.channel_ref` (email 6) | `shared/types.ts`; `desk/intake.ts` validates it at the boundary, stores it on the case and includes it in the `case.acknowledged` payload |
| `Vendor.test_command` (sandbox/proofs 2) | `shared/types.ts`. Precedence: `Vendor.test_command` → `/ahd/test-command` in the sandbox → `npm test`. Operator-set only, never from inbound report data |
| `Vendor.agent_pay_rail` (billing 5) | `shared/types.ts`. `chooseLane` should prefer it over the `payer_mode` default |
| `Vendor.billing_exempt` (billing 7) | `shared/types.ts` — see the open item at the bottom |
| `Outcome.created_at` (approvals 4) | `shared/types.ts`, optional. `desk/register.ts` stamps it on the retry write |
| `HttpResult.headers` (billing 3) | `shared/http.ts`; `server.ts` writes them. The desk now sets `x-payment-required` itself when it withholds an answer, so billing does not have to |
| `getOutcomeById`, `listOutcomes`, `updateOutcome` (billing 1, 2) | `store/repository.ts` + memory. `createOutcome` is also formally blessed as an upsert keyed by `failure_id`. `updateOutcome` is keyed by outcome id and refuses to move an outcome to another case |
| `listGrants`, `markGrantSpent` (approvals 2; desk/grants comment) | `store/repository.ts` + memory. Filter `{failure_id, vendor_id, spent}`; `vendor_id` joins through the case |
| `listMeterEvents` (approvals 3) | `store/repository.ts` + memory. Filter `{vendor_id, outcome_id, since}`; `since` is an ISO-string compare |
| `listApprovals` (approvals 1) | `store/repository.ts` + memory. Filter `{failure_id, decided}` |
| `toolEvents` widened with `action`/`stage` (evals 4) | `store/repository.ts` + memory |
| `appendToolEvent` idempotent by event id (evals 3) | `store/memory.ts` — a retried writer can no longer duplicate the audit trail |
| HttpError parameter properties (evals 1, billing 11, email 7) | FIXED in `shared/http.ts` (erasable form) |
| `@types/node` unresolvable (evals 2, email 7) | FIXED in `product/tsconfig.json` (`typeRoots: ../mcp/node_modules/@types`) |

Also fixed in `store/memory.ts` while granting the above: rows are now copied on the way in and
out (a caller holding a reference could mutate stored state), `recordGrant`/`recordMeterEvent`
indexed the caller's object instead of the stored copy, and **`createApproval` clobbered an
existing row** — a loop re-run rewrote it with `decision: null`, erasing a human's reply. Creates
are now idempotent by id.

### Desk behaviour the rulings required

1. **A gate can be genuinely pending.** `ApprovalDecision.decision` now accepts `'pending'`.
   `runGate` holds the case at `awaiting_approval` — nothing ships, no outcome is written, so an
   unapproved change can never be billed — and `runLoop` returns `status: 'awaiting_approval'`,
   `reply: null` and a `loop.parked` event. `server.ts` wires the real adapter: a decision already
   on the approval row wins (so a re-run resumes instead of re-asking), otherwise `approvals/`
   sends the text and the case parks until `POST /v1/approvals/reply` + `POST /v1/cases/run`.
   Before this, every case was force-decided by `localApprovalStub` — fine for tests, wrong for a
   product whose whole pitch is that a human approves the risky change.
2. **A priced answer is withheld.** `OnBillable` may return `{ lane, unlock, charged,
   payment_required }`. `POST /v1/cases/retry` answers `402` with the requirement (plus the
   `x-payment-required` header) and `reply: null` when billing reports the outcome is not unlocked,
   and records `billing.answer_withheld`. That is billing ask 10(c), implemented on the desk side.
3. **Billing picks the lane.** The server adapter calls `decide()` first and passes billing's lane
   to `onBillable()`; the desk's `payer === 'agent' ? 'a2a_x402' : 'b2b_meter'` is now only a hint,
   and the response reports `billing_lane` as billing saw it. A disagreement between the desk's
   `billing.billable` event and billing's `decide()` fails loud as `billing.notify_failed` instead
   of being smoothed over.

### Blessed as written — your local assumption stands

- **sandbox/proofs 1** (replay command): `request.replay_cmd`, else `/ahd/replay.mjs`. What makes
  (a) safe is a desk invariant: `intake` strips executable keys from inbound request data, so an
  agent can never inject a replay command — only an operator or the vendor row can.
- **sandbox/proofs 3**: `changed` = sandbox-relative paths; unreadable or `..`-containing paths fail
  the proof naming the path, never a throw.
- **sandbox/proofs 4**: background exec returns the pid token in stdout, files at
  `/tmp/ahd-bg-<pid>.{out,err,exit}`. No `poll` on `SandboxHandle` — `sandbox/client.ts poll(handle,
  pid)` works on ANY handle through plain exec+cat, which beats an interface method.
- **ToolEvent `ticket_id`** (sandbox/proofs 5, approvals 9, evals 3, email 4): `ticket_id` is the
  SUBJECT of the event, not necessarily a case. Case events use `Failure.id`; everything else uses a
  scoped id (`user:<id>`, `eml_<hash>`, `ahd-eval`, a vendor id). No new `external_ref` field.
- **approvals 6**: no `Failure.endpoint` column. Your `failureSignature` grouping rule is the single
  implementation; it moves to shared/ only when a second module needs it.
- **approvals 7** (gate contract) and **billing 10** (call order): both stand, with the changes above.
- **approvals 8** (email transport): approvals keeps its own `InkboxClient` seam including
  `sendEmail` and must NOT import `email/`. Primitive is the email lane's transport, Inkbox is the
  approval channel; coupling them would let a Primitive outage break approvals. `RealInkboxClient`
  refusing `sendEmail` with `502 channel_unavailable` is correct — the report falls back to text and
  says so.
- **billing 4**: no separate receipt table. Idempotency stays on the outcome row
  (`x402_payment_id` / `mpp_payment_id`); `listOutcomes` is there if you need to prove a payment id
  was never used on a different outcome, and Postgres gets a unique partial index on both columns.
- **billing 6**: a stranger agent is a missing `Vendor` row or an empty `stripe_customer_id`.
- **billing 8**: the meter is provisioned out of band; a missing meter is `502 stripe_error` at
  `billing.stripe.emit`.
- **billing 9**: `billing/prices.ts` defaults are canonical (`docs_error_text 0.50`,
  `code_config_grant 1`, `migration_pr 25`, `platform_monthly 0` in test, all env-overridable).
  `web/src/data/billing.json` disagrees (`platform_monthly: 49`) and will be corrected to match.
- **evals 3, 5, 6**: ToolEvents are the eval store this weekend; the eval payload types stay in
  `evals/`; the per-case fresh-agent proof and the product-level install eval stay separate.
- **email 2**: `intake` is the only channel entry point and the desk owns `ack_by`/`resolve_by`/
  `queue_position`/`klass`. **email 3**: ToolEvents are the lane's store; no threads table.
  **email 5**: Primitive request-body names stay marked ASSUMPTION until the sponsor confirms, and
  the fake lane remains the demo default.

### Denied or deferred

- **approvals 5** (promote `Report`/`ReportNumbers`/`TopFailure` to shared/): deferred. `web/` reads
  JSON over HTTP and imports nothing from `product/`, so promotion buys no decoupling today — it
  would only create a second place for the shape to drift. Revisit when a second backend module
  renders reports.
- **email 3(a)** (a `threads` table): deferred for the same reason.
- **billing 8** (`POST /v1/billing/meters`): deferred; out-of-band provisioning for the demo.
- **A vendor admin route** (`GET/POST /v1/vendors`): deferred until the boundary has operator auth.
  The row decides `risk_policy`, the pay lane and `billing_exempt`, so an open route is a
  self-service billing exemption — the same hole the lane-scoped exemption closed. Vendor rows are
  written out of band (or by `AHD_SEED=demo`); `product/README.md` records the reasoning.

### Closed after the rulings

- **billing 7, where the exemption lives.** Implemented in `billing/billable.ts`:
  `exemptionFor(failure, vendor, lane)` now exempts on operator-controlled facts only
  (`Vendor.billing_exempt`, `risk_policy === 'suggest_only'`) for every lane, and honors the
  free-text `Failure.task` privacy match **only** on `b2b_meter`, where the vendor pays. On the
  agent-pays lanes the payer writes that text, so honoring it was a self-service free ride.
  `privacyTermHit(failure)` is exported separately, and when a term matched but was not honored the
  `billing.decision` ToolEvent carries `privacy_term_ignored`. `chooseLane` now prefers
  `Vendor.agent_pay_rail` (`'x402'` routes an agent-pays vendor to the A2A lane; anything else stays
  on `b2b_mpp`).
- **A parked case can actually resume.** The pending-gate ruling above was not true as shipped:
  `desk/loop.ts` treated every non-resumable status as terminal, so a case parked at
  `awaiting_approval` was answered from the store forever and a human reply changed nothing.
  `runLoop` now re-enters when the case is parked AND `repo.listApprovals({failure_id, decided:true})`
  is non-empty. It re-runs the whole loop rather than jumping to ship, because the sandbox may be
  gone and nothing should ship on proofs that no longer reproduce. `desk/README.md` updated.
- **Erasure is real, not a receipt.** `DELETE /v1/users/data` used to answer
  `erasure: "pending_repository_delete_support"` and delete nothing, which made the privacy story
  the one claim in the product that was false at the root. The contract gained
  `eraseUserData(userId): Promise<ErasureResult>` (`store/repository.ts`, implemented in
  `store/memory.ts`): it redacts every user-supplied field on the case row and at any depth in an
  event payload, plus any string that *is* the user id, and returns `{cases, events, fields,
  already_erased}` so the receipt is a fact. Rows are redacted rather than dropped — the audit
  trail, the financial record and the fix artefacts are the vendor's compliance record. The route
  now reports what it redacted and never writes the id into the trail. `desk/README.md` documents
  the boundary.
- **The outcome no longer claims a payer nobody chose.** `desk/ship.ts` wrote
  `payer: vendor.payer_mode` at ship time, so a vendor with no Stripe customer showed `payer:
  "vendor"` on a case that billing was about to charge an agent for on the x402 lane. It now writes
  `null` until a settlement records one, and preserves a payer a previous settlement set.
  `billing/meter.ts` still defaults a vendor-pays meter event to `'vendor'`.
