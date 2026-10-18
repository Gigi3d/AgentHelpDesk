# `product/desk/` — the orchestrator

The desk owns the case: intake with committed times, the state machine, the
approval gate, and the four outputs of a proven fix. It is the module that turns
"a failing agent attempt" into "a proven change plus an answer the agent can act
on", and it is the only module that decides whether a case is billable-eligible.

Everything is stateless. No module-level case state, no caches, no globals: every
step reads from and writes to the `Repository`, and sandboxes are keyed by case id
(`ahd-<caseId>`), so N replicas can run cases concurrently.

## File map

| File | Responsibility |
| --- | --- |
| `intake.ts` | `intake(report, repo)` → one `Failure` row with committed `ack_by`/`resolve_by` and `queue_position`, plus the `case.acknowledged` ToolEvent. Imported by `email/` and `mcp/`, so it is side-effect-light: it never opens a sandbox or runs the loop. |
| `loop.ts` | The state machine. Reproduces in the sandbox, drafts, proves three ways, gates, ships, or escalates. Talks to `sandbox/` and `proofs/` **through their interfaces only**. |
| `gate.ts` | The approval gate: what auto-ships on green, what waits for a human, what is only ever a suggestion. The approval channel is an injected `askApproval` callback. |
| `ship.ts` | The four outputs: `AgentReply`, `PrDescriptor`, `RegressionTest`, and the authority `Grant`. Also `replyFromStore()` for polling. |
| `grants.ts` | Issue/lookup grants behind the authority envelope. Replay-safe; a caller can narrow an envelope but never widen it. |
| `resolve.ts` | The deterministic resolver stand-in: drafts the candidate diff and generates the repro harness + fixture for the sandbox. |
| `inspect.ts` | Pure helpers that reduce an **untrusted** inbound payload to bounded facts, redact credentials, and validate boundary fields. |
| `obs.ts` | ToolEvent construction/append, receipt hashing, push-topic filtering. |
| `register.ts` | `registerRoutes(router, repo)` and the individually exported handlers. |
| `desk.test.ts` | `node:test` coverage: golden path, escalation paths, gate paths, grant idempotency, the billable rule. |
| `testenv.ts` | Sets the fake selectors before any module under test is imported. |

## The state machine

```
opened ──> reproducing ──> fix_drafted ──> proving ──┬─> awaiting_approval ─┬─> shipped
   │            │                ▲            │      │                      └─> answered
   │            │                └────────────┘      └─────────────────────────> shipped | answered
   │            │              (next attempt, up to AHD_MAX_ATTEMPTS)
   └────────────┴──────────────────────────────────────────────────────────> escalated
```

* `reproducing` writes a redacted fixture (`ahd/repro/<case>.json`) and a
  generated `node:test` harness into the case sandbox, then runs the repro
  command. **Reproduction targets the vendor's test file/command, not a full
  stack** — standing up the vendor's database and queues is later work.
* If the failure does not reproduce, the case goes to `escalated` with
  `reason: not_reproduced` and **nothing is guessed**: no attempt row, no
  outcome, no reply.
* `fix_drafted` → `proving` runs the three proofs **in order** and short-circuits:
  a failed proof marks the rest `skipped` rather than burning sandbox time.
* A failed attempt loops back to `fix_drafted`; after `AHD_MAX_ATTEMPTS`
  (default 3) the case is `escalated` with `reason: proofs_failed`.
* `awaiting_approval` is only entered when the risk policy demands it.
* `answered` means the agent got the tested answer and nothing touched the
  vendor's product. `shipped` means the change also went to the vendor (PR or
  grant). `closed` is set by `POST /v1/cases/retry` when the agent's retry
  succeeded.

Escalation reasons, all recorded as a `case.escalated` ToolEvent with
`result: "error"`: `not_reproduced`, `sandbox_unavailable`,
`sandbox_exec_failed`, `patch_write_failed`, `resolver_failed`, `proofs_failed`,
`budget_exhausted`, `approval_channel_failed`.

Re-entry is idempotent: `runLoop` on a case that is `answered`, `shipped`,
`closed` or `escalated` rebuilds the answer from stored state
(`reason: already_<status>`) instead of re-running anything. `awaiting_approval`
is the exception: it stays parked (also answered from the store) until a human
records a decision on the case's approval row, after which `runLoop` re-runs the
whole loop so the change ships only on proofs that still reproduce.

## The gate

| vendor `risk_policy` | low-risk change (`docs`, `error_text`) | anything riskier (`code`, `config`, `schema`, `grant`) |
| --- | --- | --- |
| `auto` | ships on green | waits for approval |
| `approve_first` | waits for approval | waits for approval |
| `suggest_only` | answers the agent, records the draft for the provider's team, ships nothing | same |

A denied approval still answers the agent (the safe answer changes nothing in
production) but sets `retryable: false`, issues no grant, and records
`reason: approval_denied`.

The approval channel is **injected**, never imported:

```ts
await runLoop(repo, caseId, { askApproval: inkboxSender });
// or once for every route:
registerRoutes(router, repo, { askApproval: inkboxSender });
```

`AskApproval = (ask: ApprovalAsk, repo: Repository) => Promise<ApprovalDecision>`.
The default is `localApprovalStub`, which records the decision it took from
`AHD_APPROVAL_STUB_DECISION` (operator config, never inbound data) and writes an
`approval.stub_decision` audit event. desk/ therefore never imports `approvals/`
or any sponsor SDK, and the Inkbox agent's real sender can be wired later without
touching this module.

## The four outputs

1. **`AgentReply`** — exactly the shape in `shared/types.ts`: `type`, `title`,
   `status` (the *original failing call's* status), `retryable`, `fix_steps`,
   `snippet`, `tested{replay,vendor_tests,fresh_agent}`, `regression_test_id`,
   `case_id`, `ack_by`, `resolve_by`, `queue_position`, `outcome`, `authority`,
   `events`, `audit_receipt`. `events` is filtered to the four push topics that
   actually occurred on the case. `audit_receipt` is a sha256 over
   `case:attempt:shipped_as`, so re-shipping a case yields the same receipt.
   Credentials are never echoed: intake redacts them before they are stored.
2. **`PrDescriptor`** — the failing call, the cause, the diff, the proof table
   and the regression test id, plus `head_ref`/`base_ref` and a `state` of
   `auto_merge_on_green | opened_for_review | draft_suggestion | skipped`.
   desk/ writes `ahd/pr/<case>.patch` and `ahd/pr/<case>.md` into the case
   sandbox and runs `AHD_PR_COMMAND` there **only if the operator set it**. When
   it is unset the descriptor is recorded as prepared; nothing is claimed as
   merged.
3. **`RegressionTest`** — every resolved failure becomes a permanent test
   (`tests/regression/<case>.test.mjs`). The `Repository` has no regression
   table, so the record is persisted as a ToolEvent (`tool: "regression"`,
   `action: "regression.created"`) carrying the full record.
4. **`Grant`** — for `authority` failures only, via `repo.recordGrant` with
   `envelope {verbs, cap_usd, per_user}`, a deterministic `idempotency_key`
   (`ahd-grant-<case>-<verb>`) and a deterministic `receipt`
   (`ahd_rcpt_<sha256>`). A replay returns the original receipt and spends
   nothing — the Repository enforces that; this module only feeds it a stable key.

## Routes

`registerRoutes(router, repo, deps?)` registers:

| Method + path | Body / query | Behaviour |
| --- | --- | --- |
| `POST /v1/cases` | `ProblemReport` (+ optional `idempotency_key`, `run_loop`, `background`) | Intake. Returns `case_id`, `ack_by`, `resolve_by`, `queue_position` immediately (201). With `run_loop: true` it runs the state machine inline; with `background: true` it returns 202 and you poll. |
| `GET /v1/cases` | `?id=` → one case view; else `?status=&vendor_id=&limit=` → list | The router in `shared/http.ts` matches exact paths and has no path params, so `GET /v1/cases/:id` is `GET /v1/cases?id=…`. The case view carries the attempt, outcome, `billable`, grant, approval, rebuilt reply and the full event trail. |
| `POST /v1/cases/run` | `{id, background?}` | Advance a case through the state machine (202 when backgrounded). |
| `POST /v1/cases/retry` | `{id, ok: boolean}` | Sets `outcome.agent_retry_ok`, re-evaluates `repo.isBillable`, appends the `billing` ToolEvent, and moves the case to `closed` (retry ok) or `escalated` (retry failed). |
| `POST /v1/cases/handoff` | `{id, note?, to?}` | Brings a human into the same thread and returns the full transcript plus a stable handoff receipt. |
| `DELETE /v1/users/data` | `{id}` **or** `?id=` | Erases the user's data through `repo.eraseUserData(id)` and returns a receipt naming what was redacted. Stable per user, so a replay returns the same receipt and reports `already_erased`. The user id never enters the audit trail — the receipt hash is the correlation key. |
| `POST /v1/grants` | `{failure_id, verb, idempotency_key}` | Issues (201) or replays (200) a grant; returns the grant and its receipt. |
| `GET /v1/grants` | `?idempotency_key=` | Looks a grant up without issuing one. |

### The billable rule

desk/ never bills. It maintains the one rule the pricing model is built on —
`all three proofs AND agent_retry_ok` — by writing the attempt and outcome rows
and calling `repo.isBillable(id)`. On a billable flip it appends a ToolEvent
(`stage: "billing"`, `tool: "stripe"`, `action: "billing.billable"`,
`identifier = outcome.id`); emitting the Stripe meter event belongs to
`billing/`. Setting `AHD_DESK_METER=1` makes desk/ also call
`repo.recordMeterEvent` with the outcome id as the identifier — safe to leave on
because the Repository dedupes on `identifier`, so a retry can never bill twice.
A later failed retry re-opens the case and records `billing.not_billable` with
the previous status, which is the signal `billing/` needs to cancel a meter event
inside Stripe's 24h window.

### Erasure (`DELETE /v1/users/data`)

The route calls `repo.eraseUserData(id)` and returns what actually happened:
`cases_erased`, `events_redacted` and the `fields` that were replaced. Erasure
**redacts, it does not drop**. Everything the reporting user supplied —
`agent_id`, `task`, `goal`, `tried`, `contact`, `channel_ref`, `request`,
`response`, and any sandbox `command`/`stdout`/`stderr` — becomes `[erased]` on
the case row and at any depth inside an event payload, as does any string that
*is* the user id under a key the list does not know about (an email row's `from`,
a webhook's `sender`).

What survives is a deliberate boundary, not an oversight: the case row, its audit
trail, the financial record (outcome, grant, meter event) and the engineering
artefacts derived from the report (the draft diff, the regression test, the PR
already sent to the vendor) are the **vendor's** compliance record. Deleting them
would destroy the vendor's proof of what it shipped and what it was billed for.
The receipt names this so nobody reads `200` as "the case is gone".

The user id is never written into an event payload or a ticket id — an erasure
that recorded the id it erased would have to scrub its own proof that it happened.
The receipt hash (`ahd_del_…`, derived from the id) is the correlation key, and
the receipt row is filed under `user:<receipt>`. A replay returns the same
receipt, reports `already_erased: true` and appends nothing. An id the desk has
never seen returns that same empty receipt — deliberately, so the route is not an
oracle for whether a given person ever filed a case.

## Environment variables

No secrets are read here. Behaviour switches only:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AHD_SANDBOX_FAKE` | — | Read by `sandbox/runner.ts` (`getRunner`). desk/ only passes it through. |
| `AHD_PROOFS_FAKE` | — | Read by `proofs/proofs.ts` (`getProofRunner`). |
| `AHD_ACK_MINUTES` | `5` | Committed acknowledgement deadline (1–240). |
| `AHD_RESOLVE_MINUTES` | `45` | Committed resolution deadline; forced above `ack` (1–1440). |
| `AHD_DEFAULT_VENDOR` | `ledgerly` | Vendor used when a report carries no `vendor_hint`. |
| `AHD_DEFAULT_RISK_POLICY` | `auto` | Policy of the fallback vendor row when none is seeded. |
| `AHD_DEFAULT_REPO_URL` | `https://github.com/agenthelpdesk/ledgerly.example` | Repo url of the fallback vendor row. |
| `AHD_REPRO_EXPECT` | `any` | Repro verdict rule: `nonzero` (production: the repro test must fail), `zero`, or `any` (offline: the harness only has to run). Exit code 124 is always a timeout → escalate. |
| `AHD_REPRO_COMMAND` | `node --test {harness}` | Repro command. Placeholders `{case}`, `{harness}`, `{fixture}`, `{sandbox}`. Point it at the vendor's own test command in production. |
| `AHD_SANDBOX_TIMEOUT_MS` | `45000` | Per-command timeout, hard-clamped to 60000: one Blaxel command may wait at most 60s, so anything longer must go background+poll. |
| `AHD_MAX_ATTEMPTS` | `3` | Attempts before `proofs_failed` escalation (1–10). |
| `AHD_LOOP_BUDGET_MS` | `240000` | Whole-loop budget; exceeding it escalates (`budget_exhausted`). |
| `AHD_APPROVAL_STUB_DECISION` | `yes` | Decision returned by `localApprovalStub`. Operator config; an agent cannot approve its own risky change. |
| `AHD_ENVELOPE_CAP_USD` / `AHD_ENVELOPE_PER_USER` | verb default | Envelope overrides. Clamped to the verb's policy, so they can only tighten. |
| `AHD_GRANT_VERB` | `entitlements.reissue` | Verb ship.ts grants for an authority failure (weekend scope). |
| `AHD_PR_COMMAND` | unset | When set, executed inside the case sandbox to open the PR. When unset, desk/ only prepares the patch and the PR body. |
| `AHD_PR_BASE_REF` | `main` | Base ref of the PR descriptor. |
| `AHD_LOG_BASE_URL` | `https://logs.agenthelpdesk.example` | Prefix for `Attempt.log_url`. |
| `AHD_DESK_METER` | `0` | `1` lets desk/ also record the Stripe meter event (deduped by identifier). |
| `AHD_STRIPE_MODE` | `test` | `live` marks meter events live. |

## What is faked, and what is real

* **Real:** every state transition, every ToolEvent, the billable rule, the gate
  policy matrix, grant idempotency and envelope clamping, receipt derivation,
  credential redaction, boundary validation, and all four output shapes.
* **Faked / stand-in:**
  * `resolve.ts` `draftFix()` is a deterministic resolver. The real one is a
    coding agent inside the sandbox; inject it with
    `runLoop(repo, id, { draft })`.
  * `gate.ts` `localApprovalStub()` stands in for the Inkbox text sender; inject
    the real one with `{ askApproval }`.
  * `ship.ts` prepares the PR but does not call GitHub unless `AHD_PR_COMMAND` is
    set. The descriptor's `state` names the intent; nothing is claimed as merged
    that was not merged.
  * Sandbox and proof execution come from `sandbox/` and `proofs/` — faked by
    `AHD_SANDBOX_FAKE=1` / `AHD_PROOFS_FAKE=1` in their modules, not here.
* **Degradation that is logged, not hidden:** if the runner cannot `fork` a clean
  sandbox for the fresh-agent proof, the proof still runs in the case sandbox and
  a `proof.fresh_agent_isolation` event with `result: "error"` records it.

## Sponsor doc pages relied on

* Blaxel — `SandboxInstance.createIfNotExists` / `.get`, `sandbox.process.exec`,
  `sandbox.fs.write`, standby/resume, and the 60-second cap on a single command
  (which is why `AHD_SANDBOX_TIMEOUT_MS` is clamped and long runs go
  background+poll). desk/ reaches all of it through `SandboxRunner`/`SandboxHandle`
  in `shared/types.ts` and never imports the SDK.
* Stripe — meters with a count aggregation and one meter event per billable
  outcome, keyed by the outcome id so a retry cannot bill twice; meter events
  cancellable within 24 hours. desk/ only writes the ToolEvent and (optionally)
  `repo.recordMeterEvent`.
* Inkbox — `identity.send_text` for the one-reply approval. Reached only through
  the injected `askApproval` callback.

## Tests

```
AHD_SANDBOX_FAKE=1 AHD_PROOFS_FAKE=1 node --test --experimental-strip-types "desk/*.test.ts"
```

`desk.test.ts` calls handlers directly with a constructed `Ctx` and a
`MemoryRepository` — no ports, no child processes. Covered: intake (committed
times, redaction, queue position, idempotent replay, validation failures); the
golden path intake → reproduce → three proofs → gate → ship with all four
outputs and the full event trail; loop re-entry idempotency; `not_reproduced`,
`sandbox_unavailable`, timeout and repeated-proof-failure escalations (asserting
nothing was guessed: no attempt, no outcome, no reply); the gate matrix including
approved/denied/suggest-only and an approval-channel failure; grant idempotency
(same receipt, `spent` untouched), envelope clamping, unknown/disabled verbs and
non-authority cases; the billable flip and its reversal; handoff; and erasure over
both the body and the query form (user fields become `[erased]`, the case and the
vendor side survive, the receipt does not re-leak the id, and a replay is a no-op).
