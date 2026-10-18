# AgentHelpDesk: Build Plan

Oct 14, 2026 · @Gmoney · **living source, updated Oct 16, 2026** after the Hark evidence (`evidence/2026-10-16-hark-launch-night/`). `AgentHelpDesk Build Plan.docx` is a frozen export of the Oct 14 text; edit this file, not the docx.

> **The pitch:** every company that sells to humans has a support desk, and every company that sells to agents needs one too, one that answers at 3 a.m. and proves the fix in a sandbox before anything changes. On Oct 16 2026 a real agent in San Francisco knew exactly why a $1M-promo order failed and had nothing to call but a human email address; every provider needs a way to answer failing agents, and our failure library gets more valuable with each provider.
>
> **What it does:** when an agent visits your API and cannot use it, cannot make sense of it, or hits a failure, AgentHelpDesk opens a case, reproduces the failure in a sandbox, tests a fix and returns it to the agent without touching production. The provider chooses whether fixes ship on their own or wait for human approval, and gets a daily report of the desk's work to help win more agents. Nobody can predict how each new model will interact with your API, so the desk is your insurance.

## Tickets, approval modes and the daily report

Three product behaviors shape the build, and each one has to be visible in the demo.

- **Case lifecycle.** Every failure becomes a case with the full request and response, and — new on Oct 16 — a committed `ack_by` and `resolve_by` returned at intake. States: opened, reproducing, fix drafted, proving, awaiting approval, answered, shipped, closed. The agent is pushed `case.acknowledged`, `case.needs_user_input`, `case.resolved` and `case.breached_sla`, and may poll as a fallback until push exists.
- **Approval modes,** set per provider and per change type. Auto ships low-risk changes such as docs and error text once all three proofs pass. Approve first holds code and schema changes and asks a human by text message, while the agent gets a holding reply. Suggest only opens the case and drafts the fix for the provider's team. These defaults are a proposal to test with providers.
- **Safe answer to the agent.** The agent receives the tested fix or workaround without any change to production, so a wrong fix cannot break the provider's product. Where the fix is a grant rather than a change, the agent receives an authority envelope instead (see the new section below).
- **Daily report.** Cases opened, fixed and verified, waiting for approval, agents that finished their task after a fix, and the endpoint behind the most cases. It turns silent agent failures into a list the provider can act on to win more agents.
- **Insurance framing.** No one can test every new model against every API. The desk watches real agent failures as they appear, so each new model is covered from its first call. This is a pitch argument, not a measured result.

Cut order if time runs short: keep the case, the sandbox proof and the answer to the agent, then the approval gate, then the daily report.

## The core loop from first principles

Strip the product to its physics: a failed agent attempt is a failing test, a fix is a change that turns it green without breaking anything else, proof means running it in isolation, and shipping means the proven change reaches both the waiting agent and the vendor's product. Everything else is plumbing.

Five statements the whole build rests on:

- **A failure is a reproducible sequence.** The agent's request, the vendor's response and the outcome the agent wanted. If it can be replayed, it can be tested.
- **A fix is only real if it is proven.** The resolver may be wrong, so nothing ships on its say-so.
- **Three proofs, in order.** (a) The replayed failure now passes. (b) The vendor's existing tests still pass. (c) A fresh agent with no context, given only the changed docs and responses, completes the original task. Proof (c) is what shows the fix works for agents, not just for the maintainer who wrote it.
- **Shipping is two actions.** Send the proven answer to the waiting agent now, and open the proven change against the vendor's repo (docs, error messages, spec descriptions, config). Low-risk changes can merge on green. Anything riskier waits for a one-reply approval from a human.
- **Every resolved failure becomes a permanent regression test.** That library, grown across vendors, is the data moat described in the dossier.

### The third failure class, added Oct 16

The loop above assumes every failure has a fix in the vendor's repo. Hark's launch night showed a class that does not: **authority failures**, where the agent is correct and is blocked by a policy grant only the vendor can give. Verbatim from our own session with Hark's agent: "I can't issue a second card, it's one per person, but yours is still good and now holds until 12:36 AM. The snag is on our end applying it at checkout, so support@hark.com is the fastest fix."

So the loop gains a fourth output. When the cause is a grant, the desk does not edit a file — it publishes a bounded verb behind an authority envelope, commits a deadline, and hands the agent an executable outcome. This also sharpens the old objection that agents can fix their own problems: where a fix needs only public information, the agent may do it alone; where it needs the vendor's repo, config or account state, only a sandbox holding the vendor's code can reproduce it; and where it needs a grant, **no agent can do it alone, provably**, because the grant is the vendor's to give. Hark's agent had the right diagnosis, the right attribution, and no path. That is the wedge.

## What can go wrong

- **The failure cannot be reproduced.** Then the desk replies that it could not confirm the problem and escalates to a human, and does not guess.
- **The resolver finds a fix that passes proofs (a) and (b) but is wrong for other agents.** Proof (c) lowers this risk, and a human gate on riskier changes covers the rest.
- **A malicious inbound message tries to steer the resolver.** Treat every inbound message as untrusted data and never let it change the resolver's instructions or tool permissions.
- **An agent abuses a grant.** New with the envelope: every verb carries a cap, a per-user limit, an idempotency key and a receipt. A replayed call must not spend twice, and the audit block on the ticket page shows every grant to the provider.
- **A rung 0 to 3 suggestion gets read as a proven fix.** New with the install ladder: every answer below rung 4 carries an "unproven suggestion" label and the mode chip, low rungs cannot bill, and only rung 4 can run the three proofs. The risk is ours to carry, not the provider's to notice.

For the hackathon, the shippable scope is documentation, error-message text, OpenAPI descriptions, one configuration change on the demo vendor, and one authority verb. Code fixes to real vendor products wait for pilots.

## Sponsor necessity test

The rule: a sponsor earns a place only if removing it breaks a step of the loop or the demo. Anything else is a logo, and judges can tell. Strength ratings are my judgment from the docs I opened.

| Sponsor | Job in the loop | What breaks without it | Honest alternative | Strength |
| --- | --- | --- | --- | --- |
| Blaxel | Reproduce and prove. A persistent per-vendor sandbox holds the vendor's repo and test instance; every proof runs inside it | There is nowhere safe to run an agent's request or a proposed fix, and every run pays a full cold start | E2B, Modal or plain Docker. Blaxel's edge is that a sandbox resumes from standby in under 25 ms with processes restored, so a vendor's environment can sit idle cheaply and wake on a failure | Strong |
| Manufact | Intake. The report_problem tool is an MCP server built with mcp-use and deployed with `npm run deploy` | Coding agents have no native way to ask the desk for help, and the desk is itself not agent-pickable | A plain HTTP endpoint. MCP is the channel coding agents already use, and Manufact adds an inspector, evals per deploy and distribution to Claude and ChatGPT connectors | Strong, and it targets the "Best MCP Server for agents" prize |
| Primitive | Fallback intake by email, with sender_verified on each reply | An agent that has not installed the MCP tool has no way in. The address in an error response works for any agent | A plain mailbox or an HTTP form. Primitive's edge is threaded two-way agent conversation with verified senders and a single primitive chat call | Medium |
| Inkbox | The ship gate: text the vendor's approver, who replies yes or no. It also gives the desk a persistent identity and carries the daily and weekly reports | Riskier changes have no fast human approval | Slack or email approvals. Inkbox's edge is reaching a person by text or phone with a reply the desk can act on | Medium |
| Armature | Optional channel and benchmark: its analytics can raise the failure, and its evals can check the fix | Nothing in the weekend build breaks | Your own regression tests | Partner conversation, not a dependency |
| Stripe | Billing. A meter event per billable fix invoices the vendor, and an optional MPP 402 lane lets an agent pay for the verified answer itself | The billable rule has nowhere to land, and the demo shows no money moving | Any billing tool for the meter. MPP's edge is that an agent pays on its own with no account, from $0.50 by card or $0.01 in USDC | Medium for the meter. Strong as a demo for MPP only if your account has preview access |

**Dropped Oct 17: InsForge.** It held the demo vendor's backend and the safe place to try a config fix. With it gone, Ledgerly is a plain Node repo on GitHub with a small Postgres or SQLite store in the same repo, and the ship step is a git branch plus a pull request — the same path rung 4 of the install ladder opens. That is one less account and one less unconfirmed merge flow, and the demo now ships through the exact mechanism we sell. If we still want agent-provisioned infrastructure, Stripe Projects (`stripe projects init`, `stripe projects add …`) provisions hosting, database and auth from one CLI and bills every provider through Stripe, so it fills the slot on a sponsor we already use instead of adding a sixth vendor.

The fact checks behind this table:

- **Blaxel:** sandboxes are created with `SandboxInstance.createIfNotExists`, resumed with `SandboxInstance.get`, driven with `sandbox.process.exec` and `sandbox.fs.write`; one command may wait at most 60 seconds, so long test runs must start without waiting (docs). Blaxel is now part of Baseten but says the product continues unchanged. The docs I opened show no repository clone call, so plan to run git clone through process.exec and confirm the sandbox can reach GitHub.
- **Manufact:** scaffold with `npx create-mcp-use-app@latest`, define tools with `server.tool(...)` and Zod schemas, deploy with `npm run deploy` (mcp-use README).
- **Primitive:** new agent accounts start reply-only, so a first message to a new recipient can be refused; the desk replies to inbound mail, which fits, but outbound escalation to humans should go through Inkbox (primitive.dev).
- **Inkbox:** `pip install inkbox` or `npm install @inkbox/sdk`, an `INKBOX_API_KEY`, and `identity.send_text` or `sendText` (quickstart). The quickstart does not say whether texts go over SMS or iMessage.

## Architecture

Resolver loop, 2 decisions and 3 outputs. A report is reproduced first, because a failure that cannot be replayed is escalated and never guessed at. The fix is proposed in the sandbox, then must pass all three proofs. A failed proof sends it back for another attempt, and repeated failure goes to a human. Only a proven change reaches the ship gate, which sends the tested reply to the agent, opens the patch against the vendor's repo and saves the failure as a regression test.

Where each piece runs:

- **Intake:** five rungs, least permission first (detailed in the Frontend and Product Surface Plan). Rungs 0 to 3 need no repo access and produce labelled suggestions only; rung 4 connects GitHub and is the only rung that can run the three proofs and bill.
- **Orchestrator:** a small service that owns the loop and the state of each failure. Keep it plain code with the language model called as a function, not an open-ended agent, so each step has a clear input and output.
- **Sandbox:** one Blaxel sandbox per open case, named after the case (`ahd-<ticketId>`) so it is created once and resumed thereafter, holding a checkout of the vendor's repo at the reported commit. Separate environments per case, so one case's flaky test or half-applied patch cannot contaminate another. Reproduction targets the vendor's test file or test command, not a full stack; standing up the vendor's database and queues is later work. Standby keeps the filesystem and running processes, so replaying a case against a candidate fix is a resume rather than a rebuild, and each proof is a command run inside the sandbox.
- **Resolver:** a coding agent inside the sandbox that edits files and runs commands, with no network access beyond the vendor's package sources if the platform allows that limit.
- **Fresh-agent check:** a separate agent run with a clean context, given only the original task and the changed docs and responses, never the resolver's reasoning. It runs in a sandbox forked from the same snapshot, so it cannot inherit the resolver's state. If it succeeds, the change works for agents.
- **State and dashboard:** a backend that stores failures, proofs, outcomes and grants.

## Demo vendor and four seeded failures

The demo needs one vendor whose product we control, so every failure is real, reproducible and fixable on stage. Build a small invented API, call it Ledgerly (a placeholder name, not a real company), with a public docs site, a test suite and an MCP server. Its backend is a plain Node app with a small Postgres or SQLite store in the same repo, and the ship step is a git branch plus a pull request — the same path rung 4 of the install ladder opens — so nothing in the demo depends on a backend platform we do not control. InsForge held this slot in the Oct 14 plan and was dropped on Oct 17; the git path is the one the product actually ships through, so the demo stays true either way.

Seed four failures that cover the three kinds of cause, and make each one something a coding agent would plausibly hit. Failure 4 is the Hark-shaped one and closes the demo.

| # | What the agent sees | Real cause | Fix | Ship path |
| --- | --- | --- | --- | --- |
| 1 | 401 on the first call | Quickstart shows the key in the wrong header, x-api-key instead of Authorization: Bearer | Correct the docs snippet | Docs change, auto-merge on green |
| 2 | 422 with the message "invalid request" | The validator rejects a date format but never names the field | Error text names the field and shows an example | Error text change, auto-merge on green |
| 3 | 403 on a write that the docs say is allowed | The test account's key lacks a scope that only the vendor can grant | Config change to the scope plus a docs note | Risky, waits for approval by text |
| 4 | Entitlement applied at checkout fails after three tries; a green success chip on a failure; "contact support" as the only path | The merchant's own checkout cannot apply a valid one-per-person entitlement, and a verification rejection has no appeal endpoint | Publish `POST /entitlements/{id}/reissue` behind an authority envelope (one reissue per user, idempotency key) plus `POST /verifications/{id}/appeal`, with a committed `resolve_by` | Grant, not a merge: the envelope ships behind the approval text, the agent retries, the order completes |

Why these four: failure 1 needs only a docs edit, failure 2 needs a code change in the vendor's repo, failure 3 needs authority that the agent does not have, and failure 4 is what failure 3 looks like to a real customer on a real launch night — the shape Hark lived on Oct 16. Run them in that order and end on 4; anyone in the room who saw the post will recognise it in one sentence.

Honesty rule for the demo: say plainly that Ledgerly is a built-for-the-demo vendor with seeded failures, and that failure 4 mirrors a real incident at another company rather than claiming it is that incident. Judges will respect that, and will punish a staged failure presented as real. Then run the same loop against one real public API's docs to show it is not only a toy, even if that run ends in escalation.

## The authority envelope (new Oct 16)

The mechanism the failing Hark agent asked for by name, and the part of the build with the least margin for error.

- **Bounded verbs.** `POST /verifications/{id}/appeal`, `POST /entitlements/{id}/reissue`, `GET /orders/{id}/state`, `POST /refunds`. For the weekend, ship `entitlements.reissue` only; the others are in the schema and the docs, marked as coming.
- **Envelope.** Per provider and per verb: what may be granted, the cap per case, the cap per agent per day, the per-user limit. Defaults to the tightest option; widening it is a Settings change that lands in the audit log.
- **Idempotency.** Every call takes an idempotency key; a replay returns the original receipt and spends nothing.
- **Receipts and audit.** Every grant writes a receipt row; the ticket page shows a grants-and-audit block built from `tool_events`, so the provider sees every action an agent took under its envelope. This is the audit log from item 6 of the Hark spec, and it costs us nothing because the table already exists.
- **Committed times.** `POST /cases` returns `case_id`, `ack_by`, `resolve_by` and queue position immediately. As the agent put it: "Without committed times, it's just a ticket inbox."
- **Push.** `case.acknowledged`, `case.needs_user_input`, `case.resolved`, `case.breached_sla` as signed webhooks; polling is the fallback.
- **Handoff.** `POST /cases/{id}/handoff` brings a human into the same thread with the full transcript.
- **Deletion.** `DELETE /users/{id}/data` with a confirmation receipt, because the Hark transcript's worst moment was an agent telling a user to email support to delete their own account.

## Data model and formats

Keep the store small. Five tables are enough for the demo and for the billing story.

| Table | Key fields | Purpose |
| --- | --- | --- |
| vendors | id, name, repo_url, sandbox_name, risk_policy, stripe_customer_id, payer_mode, report_contacts | One row per vendor, and the policy for what auto-merges |
| failures | id, vendor_id, agent_id, task, request, response, status, ack_by, resolve_by, queue_position, created_at | The raw report and where it is in the loop |
| attempts | id, failure_id, diff, proof_replay, proof_vendor_tests, proof_fresh_agent, log_url | Every try, with the result of each of the three proofs |
| grants | id, failure_id, verb, envelope, idempotency_key, receipt, spent, created_at | Every action taken under an authority envelope; feeds the audit block |
| outcomes | id, failure_id, shipped_as, approved_by, agent_retry_ok, billable, payer, stripe_event_id, mpp_payment_id | The auditable billing event: verified fix plus a successful retry |

A failure becomes billable only when proof_* are all true and agent_retry_ok is true. That one rule is the pricing model, so build it as a single query and show it on the dashboard.

### What the agent gets back

Return structured data, not prose, so the agent can act without reading a paragraph.

```json
{
  "type": "problem/wrong-auth-header",
  "title": "Use a Bearer token, not x-api-key",
  "status": 401,
  "retryable": true,
  "fix_steps": ["Send Authorization: Bearer <key>", "Remove the x-api-key header"],
  "snippet": "curl -H 'Authorization: Bearer $LEDGERLY_KEY' https://api.ledgerly.example/v1/entries",
  "tested": { "replay": true, "vendor_tests": true, "fresh_agent": true },
  "regression_test_id": "rt_0001",
  "case_id": "ahd_01J...",
  "ack_by": "2026-10-17T03:12:00Z",
  "resolve_by": "2026-10-17T04:07:00Z",
  "queue_position": 3,
  "outcome": { "action": "reissued", "amount": 3000, "currency": "usd", "expires_at": "2026-10-17T05:36:00Z" },
  "authority": { "verbs": ["entitlements.reissue"], "cap_usd": 30, "per_user": 1 },
  "events": ["case.acknowledged", "case.resolved"],
  "audit_receipt": "ahd_aud_01J..."
}
```

The shape borrows from the problem-details idea in RFC 9457, with the three proofs added. The tested block is the part nobody else returns, so keep it. The fields after it are the Oct 16 additions from the Hark agent's spec: committed times, an executable outcome, the envelope, the push topics and the audit receipt.

### What the vendor gets

A pull request whose description reads the same way every time: the failing call, the cause, the diff, the three proof results and the regression test that now guards it. Docs and error-text changes merge on green. Anything that touches config, scopes, permissions, billing or an authority envelope waits for a one-reply approval by text.

## Billing: Stripe meter for B2B, x402 for A2A

Two lanes, one billable rule. B2B — a provider and its customers' agents — bills through the Stripe meter. A2A — another agent calling our desk with no vendor relationship — bills per call over x402. Inside B2B, an agent can also pay through Stripe's MPP when the vendor chooses that.

- **Vendor pays (default):** when an outcome becomes billable, send one meter event for the vendor's Stripe customer, with the outcome id as the identifier so a retry cannot bill twice. Create the meter with a count aggregation and attach a per-fix price. A meter event can be cancelled within 24 hours, so use that if a retry later turns out to have failed.
- **Agent pays (optional):** the desk proves the fix first, then returns the verified answer behind an HTTP 402 at $0.50. Cards through Shared Payment Tokens have a $0.50 minimum and USDC has a $0.01 minimum, so our price guess fits. The server is a short handler built with mppx and stripe, and `npx mppx@latest validate` tests it end to end. Record payer = agent and the payment id on the outcome.
- **A2A lane (x402):** when the caller is an agent rather than a vendor dashboard — a support agent forwarding a failing call at rung 0, or a second desk buying a proven answer — the verified answer is served behind an HTTP 402 with an x402 payment requirement, settled per call in stablecoin. No account, no invoice, no human in the loop. The billable rule is identical to B2B: all three proofs pass and the retry succeeds. Stripe's own hackathon primer (shipbysundown.dev) positions its Machine Payments Protocol at exactly this per-call, agent-to-service case, so x402 (open protocol) and MPP (Stripe-native) are two rails for the same lane; we lead with x402 for agent-to-agent and keep MPP for the vendor-chooses-agent-pays case.
- **Why both:** the meter is the revenue model, and MPP is the moment an agent pays by itself. The vendor chooses who pays, and the vendor is the default because it is the stronger payer.
- **Check first:** the MPP setup uses a 2026-07-29.preview API version for the business profile and the Tempo deposit address, so confirm account access before Saturday. Test card payments with the Link CLI.
- **Cut order:** drop the MPP lane before the meter.

Sources: Stripe MPP quickstart, Stripe meters.

## Daily and weekly reports with Inkbox

The desk reports its own work to the vendor, like a support team's end-of-day note.

- **Daily, by text or email:** failures seen, fixed, escalated and waiting on approval, with anything waiting on the vendor first.
- **Weekly, by email:** the same counts, plus fixes merged, regression tests added, grants issued under the envelope, the top three repeating failures and the expected bill from the Stripe meter. It works as an invoice preview, so the vendor sees the value before they are charged.
- **Honesty rule:** build every number with SQL over the failures, attempts, grants and outcomes tables. The language model writes only the sentences around them, so a report can never invent a count.
- **Demo:** a "send today's report" button, so you show it live instead of waiting for a schedule.
- **Cut order:** drop this before the dashboard polish.
- **Check first:** it is unclear whether Inkbox texts go over SMS or iMessage. Use email for the weekly report and test the text on your own phone.

## Build order, checkpoints and cut lines

Build the thinnest loop that works end to end first, then widen it. Each checkpoint is a thing you can run and watch, not a task you can tick.

| When | Build | Checkpoint you can run | Sponsor proven |
| --- | --- | --- | --- |
| Before Saturday | Accounts and keys for every sponsor, Ledgerly skeleton with seeded failures 1 and 4, repo ready | A curl against Ledgerly returns the seeded 401, and the seeded entitlement fails at checkout | — |
| Sat hours 0-3 | Sandbox: create, clone Ledgerly, run its tests, replay the failing call | One command prints "reproduced" for failure 1 | Blaxel |
| Sat hours 3-6 | Resolver edits the docs file, then the three proofs run | The proof table shows three greens for failure 1 | Blaxel |
| Sat hours 6-9 | Intake as an MCP tool, structured reply with `ack_by`/`resolve_by`, billable query | An agent calls report_problem and gets the JSON back, with a deadline in it | Manufact |
| Sat evening | Ship: open the PR, auto-merge on green for docs | A merged PR appears for failure 1 | GitHub |
| Sun hours 0-3 | Failures 2 and 3, the approval text for failure 3 | Failure 3 pauses, a text arrives, a reply of yes ships it | Inkbox |
| Sun hours 3-5 | Failure 4: the authority envelope, `entitlements.reissue`, push events, the grants-and-audit block | The demo agent retries after the grant and the order completes, with the receipt on screen | Stripe |
| Sun hours 5-6 | Stripe: a meter event on each billable outcome, then the optional MPP lane | A billable outcome shows as a meter event in test mode, and a 402 request can be paid | Stripe |
| Sun hours 6-7 | Reports: daily digest from SQL, weekly email, a send-now button | Pressing the button delivers a correct report to your inbox | Inkbox |
| Sun hours 7-8 | Dashboard: failures, proofs, billable count, regression tests, grants | One screen tells the whole story | — |
| Sun hours 8-10 | Rehearse the demo three times, record a backup video | A clean run with a stopwatch | None |

Cut lines, in the order to drop things:

- Email intake through Primitive. The MCP tool is enough to demo.
- The install ladder screens. Rung 4 alone carries the weekend demo, so rungs 0 to 3 drop to one screen and a slide if time runs short.
- The fresh-agent proof as a separate run. If time is short, run it as one more call with a clean context.
- Failure 2. Failures 1, 3 and 4 still show the easy case, the approval case and the grant case.
- Push webhooks. Polling carries the demo; push is a pilot feature.
- The dashboard polish. A plain table is fine.

Never cut: the sandbox replay, the three proofs for at least one failure, the approval for failure 3, and the envelope for failure 4. Those are the product, and failure 4 is the demo's ending.

Rule for the weekend: at the end of each block, the demo must still run. A half-built feature goes behind a flag, never into the main path.

## Vibe-coding playbook

A coding agent builds well when the structure is fixed before it starts and each task has a check it can run itself. Set up both first.

Repo layout:

```
agent-desk/
  CLAUDE.md          rules for the coding agent (below)
  desk/              orchestrator: intake, loop, ship gate, envelope
  sandbox/           Blaxel wrapper: create, clone, exec, replay
  proofs/            replay.ts, vendor_tests.ts, fresh_agent.ts
  mcp/               Manufact server with report_problem
  ledgerly/          the demo vendor: api, docs, tests, seeded failures
  dashboard/         failures, proofs, billable count, grants
  fixtures/          one JSON file per seeded failure
```

Rules to put in CLAUDE.md:

- Write the proof for a step before the step, and run it after every change.
- Call the language model as a function with typed input and output. No open-ended loops outside the sandbox.
- Every external call (Blaxel, Inkbox, Primitive, Stripe) sits behind one small module so it can be swapped or faked.
- Each module has a fake that reads from fixtures/, so the whole loop runs offline when a sponsor API is down.
- No secrets in the repo. Read keys from environment variables and list them in .env.example.
- Keep the demo runnable at all times. New work goes behind a flag until its checkpoint passes.
- A grant is never issued without a cap, a per-user limit, an idempotency key and a receipt row. No exceptions, not even in fixtures.

Prompts that work, in order:

- Scaffold: "Create the repo layout in CLAUDE.md with empty modules, a fake for each external service, and one test per module that fails. Do not implement anything yet."
- Sandbox: "Implement sandbox/ against the Blaxel SDK: create or resume a sandbox by name, clone a repo with git through exec, run a command, return stdout and exit code. Make the sandbox test pass. If the clone is refused, tell me instead of working around it."
- Replay: "Given a failure fixture, run its failing call against Ledgerly inside the sandbox and return reproduced true or false."
- Resolver: "Given a reproduced failure, edit files in the sandbox to fix it, then run the three proofs. Stop after three attempts and mark the failure escalated."
- Intake: "Add a report_problem tool with Zod input using mcp-use. It stores a failure, runs the loop and returns the JSON reply format from the plan, including ack_by and resolve_by."
- Envelope: "Add grants/ with an envelope config per verb, idempotency keys and receipt rows. Expose entitlements.reissue on Ledgerly behind it, and make a replayed call return the original receipt without spending."
- Ship: "Open a PR with the diff and the proof table. Merge it automatically only when the risk policy says the change is docs or error text."

Habit that saves the weekend: after each prompt, run the checkpoint yourself before asking for the next thing. Do not stack three unverified steps.

Things the agent will get wrong, so check them:

- It will invent SDK methods. Make it cite the doc page for any sponsor call, and test against the real API once.
- It will make the fresh-agent proof pass by leaking the fix into the prompt. Give that proof only the task and the changed docs.
- It will quietly swallow errors. Ask for failures to be loud, with the step name in the message.
- It will let the envelope be widened from the caller side. Review every path that reads an envelope; the only writer is Settings.

## Judge questions and answers

**Can't agents just fix their own problems?** When the cause is public, yes, and the desk steps aside. When the cause sits in the vendor's private repo or config, only a sandbox holding the vendor's code can reproduce it. And when the cause is a policy grant — the third class — no agent can fix it alone, provably, because the grant is the vendor's to give. We watched this happen live on Oct 16: Hark's own agent diagnosed its checkout failure correctly, said "the snag is on our end," and had nothing to call but a human email address. AgentHelpDesk is the delegation layer where a provider hands an agent bounded authority, with proof and a deadline. We still test the self-fix claim: three coding agents against ten real APIs, and if about 80% of knowledge and code failures resolve themselves we shrink to the authority slice — which is still a company, but a smaller one.

**Where did the authority envelope come from?** From the failing agent. Asked what support API it would want, Hark's agent wrote a six-part spec: bounded self-fix verbs with an authority envelope and idempotency keys, a case with committed ack and resolve times, pushed status, warm handoff, structured outcomes, and an audit log. We built to it. The transcript is archived and quotable.

**Why a sandbox? Why not just ask a model?** Because a model's answer is a guess until something runs. The sandbox lets us replay the exact failure, apply the fix and show it passing. That proof is what makes the reply trustworthy and the patch mergeable.

**Why Blaxel?** The desk needs one persistent environment per vendor, with the repo and a test instance already warm, so each replay starts in milliseconds instead of rebuilding. Without it we would run a slow, shared environment and every proof would take minutes. Alternative: any container host, at a cost in speed and setup.

**Why Manufact and MCP for intake?** Agents already speak MCP, so a report_problem tool is the lowest-friction way for an agent to ask for help in the middle of a task. Alternative: a plain HTTP endpoint, which works but needs every agent to be taught about it.

**Why is the demo vendor a plain repo instead of a backend platform?** Because the ship step we sell is a pull request, so the demo runs on the same path a customer will: a branch, three proofs, a PR. A platform-specific branch would prove the platform, not the desk. InsForge held this slot and was dropped on Oct 17 for exactly that reason; if we want agent-provisioned infrastructure later, Stripe Projects is the sponsor-native way.

**Why Inkbox and Primitive?** Inkbox carries the human approval for risky changes, a text to the person who can say yes. Primitive gives agents an email address to report problems from. Both are replaceable, and we say that, because the product is the loop and not the channels. Inkbox also carries the daily and weekly reports.

**Why Stripe, and why both a meter and MPP?** The meter bills the vendor for each verified fix, which is the revenue model. MPP lets an agent pay for a verified answer on its own, which is the "agents want it" moment. The vendor chooses who pays. Alternative for the meter: any billing tool, but it would not show an agent paying.

**Why daily and weekly reports?** A vendor who reads "17 agent failures fixed this week" every Friday keeps the product, and sees exactly what they will be billed for before Stripe charges them. Inkbox carries them, and every number comes from the database, not from the model.

**Who pays, and for what?** The vendor pays per verified fix that the agent then uses successfully, about $0.50 to $1 per resolved task in our first pricing guess. The billing event is recorded in the outcomes table and sent to Stripe as one meter event per billable fix, so it can be audited. An agent can also pay for a verified answer itself through MPP when the vendor chooses that.

**Isn't the envelope a fraud machine?** It is the opposite: today an agent that wants a refund has a human's email address and no limits. An envelope is a limit — a cap, a per-user count, an idempotency key and a receipt on every grant, visible to the provider on the ticket page. The unbounded version already exists; it is called "email support."

**What if a big platform builds this?** Then the data is what matters. Every resolved failure is a regression test and a record of how agents break on that vendor, and a platform will not have it for vendors outside its own ecosystem. Our first partner channel is Armature, which would put the desk where vendors already install tools.

**What is real and what is staged?** The vendor and failures are seeded and we say so; failure 4 mirrors a real incident at another company and we say that too. The loop, the sandbox, the proofs and the PR are real. We also run it once against a real public API's docs, and show an honest escalation if it cannot fix it.

## Open threads from the Oct 17 kickoff

Read off the sponsor slides at kickoff and from Stripe's hackathon primer (shipbysundown.dev); confirm amounts at the venue before quoting them.

- **Prize tracks.** Manufact, "Best MCP server for agents": $3,000 cash plus $9,300 Manufact credits, then $2,000 / $700 / $300 cash tiers. Blaxel: $500 credits for every builder, plus $1,000 cash for the track "Build something a human would never want". Stripe: $500 credits and Atlas incorporation discounts for every builder, $3,000 / $2,000 / $1,000 for winners. Inkbox and Armature each run an agent-communication / agents-use track around $2,000 and $1,000. Our build already sits in the Manufact MCP track and the Blaxel sandbox track, and failure 4 — an entitlement no human could reissue at 3 a.m. — is a literal fit for Blaxel's "a human would never want" framing.
- **Inkbox as the event-to-agent channel (open idea, not weekend scope).** Inkbox gives an agent a persistent identity — a phone number and an inbox — so our `case.*` push events could reach a waiting agent as a text or a call, not only a webhook. That turns "the desk answered" into "the agent was told", the half of support most agent stacks miss. Stripe's primer lists the same shape in its partner row (AgentPhone, AgentMail), which is evidence the channel is real and not only a sponsor pitch. Webhooks carry the demo; Inkbox is the pilot upgrade.
- **Manufact's public MCP feedback as a failure firehose (open idea, not weekend scope).** Manufact is collecting feedback on the MCP servers hosted on its cloud. Each public feedback item is a rung-0-style report: an agent saying a tool failed. Ingesting that feed would seed the failure library with real cross-vendor failures on day one, and each item maps onto the existing per-case Blaxel sandbox (`ahd-<ticketId>`) to draft a fix. The honest limits: for repos we have no consent to touch we publish labelled suggestions only (the rung 0 to 3 rule), we bill nothing, and a weekend demo shows a read-only feed plus one sandboxed draft fix, not a running ingestion pipeline. If the feedback is public today, ask Manufact for a sample export at the venue; that sample is the demo.
- **Stripe primer facts worth using.** Stripe Projects provisions hosting, database and auth from one CLI (`stripe projects init`, `stripe projects add …`) and bills every provider through Stripe — the agent-provisioned-backend slot InsForge vacated, on a sponsor we already use. Stripe Directory (`stripe directory search`) is an agent-discovery layer, which is how a stranger agent finds our desk in the A2A lane. Link Agent Wallet's guardrails — scoped credentials, spend limits, merchant controls, human approval on sensitive buys — are the payments-side twin of our authority envelope, and worth citing as precedent when judges ask whether bounded grants are realistic.

## Check before promising, and sources

These four points were not confirmed from the docs I read. Test each one before Saturday, and change the demo if one fails.

- **Blaxel clone and egress:** the docs show no git clone example. Run git clone through process.exec and confirm the sandbox can reach the repo host. Exec calls cap at 60 seconds, so the vendor's test command either finishes inside that or runs backgrounded with its result polled. Because the design is one sandbox per open case, also confirm how many sandboxes one account may hold at once, what standby snapshot storage costs at that count, and which quota tier removes the TTL that would delete a parked case.
- **Inkbox text channel:** it is unclear whether texts go over SMS or iMessage. Send one to your own phone.
- **Primitive limits:** new accounts reply only, with a 1,000 messages an hour limit. Treat email intake as optional.

Sources: the sponsor docs for Blaxel, Manufact (mcp-use), Primitive and Inkbox, read for the sponsor test above, plus Stripe's MPP quickstart and meter docs for billing, plus the Research Dossier for the market, competition and pricing assumptions, plus `evidence/2026-10-16-hark-launch-night/README.md` for the authority envelope, the committed times, push, handoff and the audit receipt. The pricing and unit economics are assumptions to test, not facts.
