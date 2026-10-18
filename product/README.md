# product/ — AgentHelpDesk backend

Zero runtime dependencies: Node built-ins only (`node:http`, `node:crypto`, `node:test`).
Runs as plain `.ts` under Node type-stripping (Node >= 22.6; 23/24 recommended), so there is
no build step. Stateless by design — all state lives behind `store/repository.ts`, so N copies
of the process can sit behind a load balancer. `server.ts` is the only orchestrator: modules
register their own routes and never import each other; the cross-module wiring (desk → approvals,
desk → billing) is injected there.

Read `AGENTS.md` before changing anything in this directory.

## Run it

```bash
cd product
node --experimental-strip-types server.ts          # or: npm start
```

Listens on `127.0.0.1:${PORT:-8787}`. `GET /healthz` is unauthenticated; every other route is
registered by a module (`desk/`, `billing/`, `approvals/`, `evals/`, `email/`).

```bash
node ../web/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # or: npm run typecheck
node --test --experimental-strip-types --test-concurrency=1 "**/*.test.ts"   # or: npm test
```

A normal boot starts with an **empty repository**. There is no HTTP route that creates a
`Vendor` row, so `desk/intake.ts` synthesizes one with an empty `stripe_customer_id`, and
`billing/billable.ts chooseLane()` reads that as "no vendor relationship" and puts every
verified answer behind the stranger-agent lane `a2a_x402` (a paid 402). That is correct
behaviour and a poor first-run demo — which is what the seed below is for.

The missing route is deliberate, not forgotten. The vendor row decides the risk policy, the pay
lane and `billing_exempt`, so an unauthenticated `POST /v1/vendors` would let any caller flip
itself to `suggest_only` or `billing_exempt` and never pay — the same self-service free ride the
lane-scoped exemption in `billing/billable.ts` exists to prevent. What has to land first is
operator authentication at the HTTP boundary, which this service does not have yet: `x-agent-id`
is informational, and `POST /v1/approvals/reply` is exposed the same way (anyone who can reach the
port can approve a change). Until that boundary exists, vendor rows are written out of band by the
operator — or by `AHD_SEED=demo` for the demo — and everything an agent can reach is scoped to a
case it already owns.

## Boot a seeded demo server

```bash
cd product
AHD_SEED=demo node --experimental-strip-types server.ts
```

`demo-seed.ts` runs at boot, before `server.listen`, only when `AHD_SEED=demo`. It writes the
one vendor row no route can create, then opens four cases through the **real** code paths —
`desk/intake.ts` (validate, redact, commit SLA times), `desk/loop.ts runLoop()` (reproduce in the
sandbox, draft a fix, prove it three ways, gate), `approvals/approvals.ts applyReply()` (the same
function `POST /v1/approvals/reply` calls) and the real `postRetry` handler (which is what fires
the injected billing notifier). Nothing is hand-written state: every attempt, proof, ToolEvent,
outcome, grant, approval and meter row in the demo was produced by production code.

It logs one line per case plus one summary line, then the normal startup line:

```
agenthelpdesk demo seed: case c-… awaiting_approval (ledgerly, docs) - the quickstart shows x-api-key, …; held for a human reply
agenthelpdesk demo seed: vendor ledgerly (approve_first, lane b2b_meter), 4 case(s), 1 meter event(s), 1 awaiting approval
agenthelpdesk desk api listening on 127.0.0.1:8787
```

### What ends up in which state, and why

The demo vendor is `approve_first`, so `desk/gate.ts` holds **every** proven change for a
one-reply human approval. That hold is the beat the console exists to show; the four stories
differ only in what happens next.

| # | Story | Ends at | Why |
| --- | --- | --- | --- |
| 1 | Quickstart shows `x-api-key`, the API wants `Authorization: Bearer` (401) | `awaiting_approval` | `knowledge` → `docs`. Nobody replies, so the approval row stays undecided and the case is genuinely parked. This is the live demo: `POST /v1/approvals/reply` then `POST /v1/cases/run` resumes it. |
| 2 | A 422 that never names the field it rejected | `closed`, **billable** | `code` → `error_text`. The approver replies `yes`, the loop re-runs and ships, then the agent reports a successful retry: all three proofs AND the retry, so exactly one `b2b_meter` meter event lands (identifier = outcome id). |
| 3 | A valid one-per-person credit only the vendor can reissue (403) | `shipped` as a bounded `grant`, not billable | `authority` → `grant`. Approved and issued behind an authority envelope. No retry is reported, so the meter stays silent: it counts verified fixes the agent actually used. |
| 4 | An intermittent 500 on webhook replay | `escalated` (`not_reproduced`) | Run under the production reproduction rule (`reproExpect: 'nonzero'`: the repro test must FAIL because the failure is real). The offline fake sandbox holds no vendor checkout, so the generated harness exits 0 and the desk refuses to guess — it escalates to a human with the evidence. |

Deterministic: no randomness, no wall-clock dependency, no network. Case ids are derived from
fixed idempotency keys, and two separate boots were verified to produce the same four ids in the
same statuses. `MemoryRepository` is in-memory, so a restart begins empty and the seed simply
creates those four cases again; the replay path — `intake` recording `case.duplicate_ignored`,
`runLoop` answering from the store with `already_<status>` — is what makes `seedDemo` safe to call
twice inside one process, and what will make it safe against a persistent store later. Either way
no post-step re-approves, re-ships or double-meters. An existing vendor row is **never**
overwritten, so an operator's edits survive a re-seed. A failure anywhere in the seed throws an
`HttpError` naming its stage and stops the boot — a half-seeded demo is worse than no demo.

### The seed changes how you reach the x402 lane

`AHD_DEFAULT_VENDOR` is `ledgerly`, and on an empty boot no such row exists, so a report with no
`vendor_hint` gets a synthesized fallback vendor with an empty `stripe_customer_id` and lands on the
stranger-agent lane `a2a_x402`. Once the seed has written the real `ledgerly` row, that same
hintless report resolves to a known vendor on `b2b_meter` and stops at the `approve_first` gate
instead of returning a 402. Both paths were verified live. To demo A2A on a seeded boot either
send a `vendor_hint` the store does not know (`intake` substitutes the fallback vendor again, so the
case ships and the retry returns **402** with `x-payment-required`), or boot with
`AHD_DEMO_STRIPE_CUSTOMER=none` to put `ledgerly` itself on the x402 lane.

### Env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `AHD_SEED` | unset | `demo` turns the seed on. Anything else (or unset) is today's empty boot. |
| `AHD_DEMO_VENDOR_ID` | `ledgerly` | Vendor id seeded and hinted by every demo report. `sandbox/fixtures/ledgerly/` matches it. |
| `AHD_DEMO_VENDOR_NAME` | capitalized id | Display name on the vendor row. |
| `AHD_DEMO_RISK_POLICY` | `approve_first` | `auto` \| `approve_first` \| `suggest_only`. Anything else fails the boot. Note `suggest_only` never bills (it is a policy exemption), so the meter lane needs one of the other two. |
| `AHD_DEMO_STRIPE_CUSTOMER` | `cus_demo_ledgerly` | Clearly-fake Stripe customer id; its presence is what makes `chooseLane()` pick `b2b_meter`. Set it to `none` to seed an empty id and demo the `a2a_x402` stranger-agent lane instead. |
| `AHD_DEMO_APPROVER` | `approver@ledgerly.example` | The vendor's approver of record, used as `report_contacts[0]`. Must be an email address or a phone number. |
| `AHD_DEMO_REPO_URL` | `https://git.ledgerly.example/ledgerly/ledgerly-api` | Must be http(s) **and** stay on a reserved documentation domain (`example`, `invalid`, `test`, `localhost`), so a seeded PR descriptor can never name a real repository. |

Setting `AHD_SEED=demo` also turns on the four offline fakes below — but only where the operator
has not already set them, so an explicit value always wins and no credential is ever read or
invented by the seed:

| Var | Effect |
| --- | --- |
| `AHD_SANDBOX_FAKE=1` | `sandbox/fake.ts` in-memory sandbox instead of Blaxel. |
| `AHD_PROOFS_FAKE=1` | Fast-poll proof configuration instead of the real budgets. |
| `AHD_BILLING_FAKE=1` | Fake Stripe client: no real meter event can be emitted. |
| `AHD_APPROVALS_FAKE=1` | Fake Inkbox sender: no real text or email can go out. |

### What is fake in demo mode, and what is not

**Fake:** the Blaxel sandbox, the proof runners' execution, the Stripe meter client and the Inkbox
approval sender — each is its own module's offline implementation, selected by env, and none of
them touches a network or a credential. **Real:** everything that decides anything — intake and
boundary validation, credential redaction, the case state machine, the reproduction verdict, the
three proofs' ordering and short-circuit, the approval gate's policy matrix, the one billable rule,
lane selection, grant and meter idempotency, and the whole `ToolEvent` audit trail the console
renders. The demo data itself carries no real person's address and no secret: every credential
value in a report is a `$PLACEHOLDER`, and `desk/intake.ts` redacts credential-shaped header values
before they are stored anyway.

## Layout

| Path | What it owns |
| --- | --- |
| `server.ts` | Orchestrator: HTTP server, routing table, CORS, rate limit, and the injected cross-module adapters (desk → approvals, desk → billing). |
| `demo-seed.ts` | The opt-in demo dataset above. Orchestrator-level, so it may import modules directly. |
| `shared/` | `types.ts` (every entity and module interface) and `http.ts` (`Ctx`, `Handler`, `Router`, `HttpError`, boundary validators). |
| `store/` | `repository.ts` (the only persistence seam) and `memory.ts` (`MemoryRepository`). |
| `desk/` | Intake, classification, the loop, the resolver draft, the approval gate, grants, shipping, observability, routes. |
| `sandbox/` | Blaxel sandbox layer plus the offline fake and its fixtures. |
| `proofs/` | The three proofs: replay → vendor_tests → fresh_agent. |
| `approvals/` | The one-reply human approval channel (Inkbox text/email). |
| `billing/` | The billable decision, the three pay lanes, and the Stripe meter. |
| `evals/`, `email/` | Evaluation runs and the inbound email channel. |
| `CONTRACT_REQUESTS.md` | Append-only log of contract asks between modules. |

Each module directory has its own `README.md` with its files, env vars, the sponsor doc pages it
cited, and exactly what it fakes.
