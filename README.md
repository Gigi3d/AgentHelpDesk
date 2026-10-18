# AgentHelpDesk

A help desk whose customers are AI agents.

When an agent fails against a vendor API, it has nowhere to go. The vendor's docs are wrong, the error message does not name the field, or the agent lacks a scope it cannot grant itself. There is no phone to call and no human to hand off to, so the agent retries, guesses, or gives up.

AgentHelpDesk takes that failing call, reproduces it, drafts a fix, proves the fix three ways, and only then ships it. The agent gets a verified answer. The vendor gets a pull request. The vendor pays only when the agent actually succeeded afterwards.

Built for the YC "Make Something Agents Want" hackathon, October 17 to 18, 2026.

## The problem, from a real night

On October 16, 2026 Hark ran a free pizza promo in San Francisco and orders failed at checkout. Their own agent could only say:

> "The snag is on our end applying it at checkout, so support@hark.com is the fastest fix."

Asked what API it actually wanted, the failing agent specified most of this product on its own: bounded self-fix actions under an authority envelope, idempotency keys, a case endpoint that commits to a deadline, pushed status, warm handoff with the full transcript, and a receipt a user can see. It also named a failure class agents cannot fix themselves at all, which is anything requiring authority.

That is the gap this desk fills.

## The loop

```
        an agent hits a failing call
                    |
                    v
        +---------------------------+
        | 1. INTAKE                 |   POST /v1/cases
        |    classify the failure   |   returns case_id, ack_by,
        |    commit to a deadline   |   resolve_by, queue_position
        +---------------------------+
                    |
                    v
        +---------------------------+
        | 2. REPRODUCE              |   one sandbox per case
        |    make it fail on purpose|   records every tool call
        +---------------------------+   as it goes
                    |
                    v
        +---------------------------+
        | 3. DRAFT THE FIX          |   docs, error text,
        |                           |   config, or a grant
        +---------------------------+
                    |
                    v
        +---------------------------+
        | 4. PROVE IT, THREE WAYS   |   a. replay the failing call
        |                           |   b. run the vendor's tests
        +---------------------------+   c. hand it to a fresh agent
                    |
            did all three pass?
              /            \
            no              yes
             |               |
             v               v
      +-------------+   +---------------------------+
      | ESCALATE    |   | 5. APPROVAL GATE          |
      | to a human  |   |    auto, approve_first,   |
      | nothing     |   |    or suggest_only        |
      | ships, no   |   +---------------------------+
      | charge      |               |
      +-------------+               v
                        +---------------------------+
                        | 6. SHIP                   |
                        |    reply to the agent     |
                        |    open a PR on the repo  |
                        |    add a regression test  |
                        |    issue a bounded grant  |
                        +---------------------------+
                                    |
                                    v
                        +---------------------------+
                        | 7. BILL                   |
                        |    only if the agent      |
                        |    retried and succeeded  |
                        +---------------------------+
```

Three failure classes drive everything downstream: `knowledge` (the docs or the error text are wrong), `code` (the API behaves unlike its contract), and `authority` (the agent is not allowed to do the thing, and cannot grant itself permission).

## The one rule that decides billing

A case is billable when all of these hold:

```
proof_replay AND proof_vendor_tests AND proof_fresh_agent
AND outcome.agent_retry_ok
AND NOT exempt
```

If the desk cannot prove the fix, nothing ships and nothing is charged. If it ships but the agent never succeeds on a retry, nothing is charged. Privacy requests are exempt by policy and are never metered.

The desk applies that rule in code, not in a database query. The store is a repository over memory today, with Postgres behind the same interface later.

## Two money lanes

| Lane | Who pays | Rail |
|---|---|---|
| B2B | the vendor | Stripe usage meter, one event per verified fix |
| A2A | the calling agent | x402. HTTP 402 with a price, settled in stablecoin, no account and no signup |

A2A matters because an agent cannot fill in a billing form. A 402 with a price it can pay per call is the only rail that works for a machine that has never met you.

## Repository layout

```
product/    the desk. Node, TypeScript, zero runtime dependencies
  shared/     types and the http envelope
  store/      the Repository interface and the in-memory implementation
  desk/       intake, the loop, the approval gate, shipping, grants
  sandbox/    the Blaxel client and the offline fake runner
  proofs/     the three-proof runner
  approvals/  the one-reply approval channel, and the reports
  billing/    Stripe metering, x402, mpp, pricing, invoice preview
  email/      email thread handling (fixture lane only)
  evals/      the Armature install eval
  server.ts   wires the modules together. they never import each other
  demo-seed.ts  opt-in demo data, and the four offline fakes

web/        the provider console. React, Vite, Tailwind
mcp/        the MCP server an agent installs. Superseded by product/,
            kept because it is the agent-facing surface for the MCP track

docs live at the repository root, listed at the bottom of this file
```

Modules never import each other. `server.ts` builds the adapters and injects them, which is what keeps any one of them replaceable.

## Run it

The console runs in two modes. Fixture mode is the default and needs no server at all, so a demo cannot fall over because a process died.

```bash
# the desk, with demo data and the offline fakes on
cd product
AHD_SEED=demo PORT=8787 node --experimental-strip-types server.ts

# the console, reading that desk
cd web
VITE_LIVE=1 VITE_API_URL=http://127.0.0.1:8787 npm run dev

# the console with no server, recorded fixtures only
cd web
npm run dev
```

Tests, from inside `product/`:

```bash
node --test --experimental-strip-types "**/*.test.ts"
```

123 tests, all passing.

`AHD_SEED=demo` seeds one vendor row, which no HTTP route can create, plus four cases that ran through the real code paths: one awaiting approval, one closed and metered, one shipped as a grant, and one escalated because it could not be reproduced.

## What is real and what is faked

This is the part worth reading before you trust anything above.

`AHD_SEED=demo` turns on four switches. Every one of them sits behind the same interface as the real client, so swapping in the real thing is an environment variable rather than a rewrite.

| Switch | What is faked | What turns on the real thing |
|---|---|---|
| `AHD_SANDBOX_FAKE` | No Blaxel sandbox starts. The fake runner records the same tool events and returns a canned reproduction | set `BLAXEL_API_KEY` |
| `AHD_PROOFS_FAKE` | The three proofs are simulated. No vendor test file actually ran | set the proof runner env |
| `AHD_BILLING_FAKE` | Meter events go to an in-memory client tagged `mode: test` | set `STRIPE_SECRET_KEY` |
| `AHD_APPROVALS_FAKE` | Approval emails are recorded, not sent | set `INKBOX_API_KEY` |

Two more are fake regardless of the seed:

- x402 payment verification is a deterministic offline stub. No facilitator is ever called.
- The email lane runs on fixtures only; there is no email sponsor key.

What is genuinely real and exercised end to end: intake and classification, the case state machine, the approval gate, secret redaction, idempotency, the billing decision rule, user data erasure, the reports, and the console against the live API. The reports contain no language model. Every number is counted out of the store, every sentence is those numbers written out, and each report carries its own list of assumptions.

## Known gaps

Stated plainly, because a demo that hides these is worse than one that lists them.

- The store is in memory. Restart the process and every case is gone. There is no database.
- There is no operator auth at the HTTP boundary. `POST /v1/approvals/reply` is open to anyone who can reach the port. Acceptable on localhost, not acceptable for one real customer.
- There is no close route and no reject-reason field, so the console's Close and Reject buttons only work in fixture mode.
- No evals are seeded and the console has no evals page.
- One process, one vendor row, a token bucket at roughly 20 requests a second. No queue and no worker, so reproduce and prove run inside the HTTP process.
- The desk publishes no agent directory route and no config route. In live mode the console says so on the affected pages rather than quietly showing recorded numbers under a LIVE badge.

The order I would fix them in for real traffic: Postgres behind the existing Repository interface, a token per vendor on every route, a real Blaxel key running one vendor's actual test file, live Stripe metering, then a worker.

## Design notes worth knowing

**Redact, do not delete.** `DELETE /v1/users/data` blanks what the user supplied and keeps what the vendor needs for its own record. The case row, the outcome, the audit trail and the financial rows survive. Everything the user gave becomes `[erased]`. Calling it twice returns the same receipt with `already_erased: true` and appends nothing, so a repeated deletion request cannot create new log entries about the person who asked to be forgotten.

**The gate holds rather than guesses.** If no approver is reachable, the change is held. The desk never approves its own change, because that is the one thing the gate exists to prevent.

**Idempotency is derived, not stored.** Intake derives the case id from the caller's idempotency key, so a retry replays the same case instead of opening a second one.

**Every number on screen is traceable.** Anything invented carries a "Sample numbers" tag. Anything computed is computed from the cases and events the desk is actually holding.

## Docs

| File | What it is |
|---|---|
| `AgentHelpDesk Build Plan.md` | the living build plan |
| `AgentHelpDesk Research Dossier.md` | the research, including the Hark evidence and the competitor read |
| `AgentHelpDesk Frontend and Product Surface Plan.md` | every console surface and what it shows |
| `API Reliability AgentHelpDesk plus Self-Maintaining APIs - Addendum 2026-10-16.md` | the second act, deliberately not the weekend build |
| `YC Make Something Agents Want Sponsor Briefs - Addendum 2026-10-16.md` | what each sponsor track wants |
| `CHANGELOG-2026-10-16-hark.md` | what changed after the Hark evidence landed |
| `product/AGENTS.md` | the rules the backend modules are written against |
| `product/CONTRACT_REQUESTS.md` | the contract disputes between modules, and how each was ruled on |

The demo vendor is Ledgerly. It is a stand-in, it is not a real company, and every address in the fixtures is on a reserved domain.

## One URL, three ways in

`demo/live.sh deploy` puts the desk and the web console on one Blaxel URL. Open `<url>/theater`, paste the desk key once, and watch a case move through its sandbox steps (create, replay, vendor tests, Claude draft, fresh agent, approval, ship, retry, bill) driven by the case's real events.

Cases come in three ways:

- An agent over MCP, A2A or email (Inkbox). `demo/live.sh inkbox` subscribes the webhook at `/v1/inkbox/webhook`.
- The `ahd` command: `ahd run -- <cmd>` or `ahd bl <args>` runs a command, spots agent-facing errors and files a case, keeping the exit code.
- The Armature feed: `demo/live.sh armature` pulls issues from their MCP server (needs `ARMATURE_KEY`); field mapping is unconfirmed until a real response is seen.

## No human in the loop

The live Ledgerly vendor now runs in `autonomous` mode: when replay, vendor tests and the fresh-agent proof are all green, the fix ships and the agent retries with no approval step. A failed proof still holds the change and nothing is billed. To bring the human gate back, set `AHD_RISK_POLICY=approve_first` before `demo/live.sh deploy`.
