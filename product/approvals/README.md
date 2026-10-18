# approvals — the human approval gate and the vendor reports (sponsor: Inkbox)

Two jobs, one module:

1. **Approval gate.** A risky change (code, config, schema, a grant) stops here. The desk texts the
   vendor's approver through Inkbox with the case id, the change and the three proof results, so the
   human never approves blind. The approver replies `yes`/`no`; the decision is stored and the desk
   loop reads it back.
2. **Reports.** The desk reports its own work to the vendor: a daily note and a weekly note that also
   works as an invoice preview. Every number is aggregated from the Repository; no language model
   writes any part of a report.

```
approvals/
  inkbox-client.ts   the ONLY file that touches the network (Inkbox send_text + reply polling)
  approvals.ts       requestApproval / applyReply / parseReply / composeApprovalText
  reports.ts         daily() / weekly() / sendReport() — numbers first, sentences second
  register.ts        registerRoutes(router, repo) + one exported handler per route
  events.ts          ToolEvent builder + recipient masking
  approvals.test.ts  node:test, handlers called directly with a Ctx + MemoryRepository
```

## Routes

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| POST | `/v1/approvals` | `{failure_id, change_summary, approver}` | `201` (or `200` on replay) `{approval, replayed, text_sent, body}` |
| POST | `/v1/approvals/reply` | `{id, decision:'yes'\|'no', approver}` — or `{id, text, approver}` with the raw reply | `{approval, replayed}` |
| GET | `/v1/approvals` | `?id=apv_…` | `{approval}` |
| GET | `/v1/reports/daily` | `?vendor_id=…` | `{report}` |
| GET | `/v1/reports/weekly` | `?vendor_id=…` | `{report}` |
| POST | `/v1/reports/send-now` | `{vendor_id, kind:'daily'\|'weekly', recipients?}` | `{report, delivered[]}` and a `report.sent` ToolEvent |

`send-now` is the demo button: it builds the report, delivers it to the vendor's `report_contacts`
and records the ToolEvent, so the room sees a real delivery instead of a schedule.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `INKBOX_API_KEY` | — | Inkbox credential (cited: the quickstart requires an `INKBOX_API_KEY`). Never logged, never stored, read only in `inkbox-client.ts`. |
| `AHD_APPROVALS_FAKE` | unset | `1` forces `FakeInkbox`. Also forced when `INKBOX_API_KEY` is missing, so the loop always runs offline. |
| `AHD_APPROVALS_CHANNEL` | recipient's shape | Force `text` or `email` for approval delivery. Default: a phone number is texted, an email address is emailed. |
| `AHD_APPROVALS_FALLBACK_EMAIL` | — | Where the approval goes if the text channel fails. Without it a text failure is a loud `502`. |
| `AHD_INKBOX_BASE_URL` | `https://api.inkbox.ai/v1` | **Assumption**, see below. |
| `AHD_INKBOX_TIMEOUT_MS` | `8000` (500–30000) | Hard timeout on every Inkbox call (`AbortSignal.timeout`). |
| `AHD_INKBOX_MAX_CHARS` | `1400` (160–4000) | Message cap. The composer trims the change summary, never the case id, the proofs or the reply line. |
| `AHD_REPORT_UNIT_PRICE_USD` | `1` | Price per verified fix used for the weekly *expected bill* only. |

## Sponsor facts cited (not invented)

From `AgentHelpDesk Build Plan.md`, the Inkbox fact-check row and "Daily and weekly reports with Inkbox":

- Install: `pip install inkbox` or `npm install @inkbox/sdk`.
- Auth: an `INKBOX_API_KEY`.
- Send: `identity.send_text` / `sendText` (quickstart).
- Reports: daily by text or email (failures seen, fixed, escalated, waiting on approval, with
  anything waiting on the vendor first); weekly by email adding fixes merged, regression tests added,
  grants issued under the envelope, the top three repeating failures and the expected bill from the
  Stripe meter. Honesty rule quoted from the plan: *"build every number with SQL over the failures,
  attempts, grants and outcomes tables. The language model writes only the sentences around them, so a
  report can never invent a count."* This file goes further: there is no language model in
  `reports.ts` at all, only aggregation and string concatenation.
- Cut order (plan): *"Cut order: drop this before the dashboard polish."*

Doc pages / sources cited: the Inkbox quickstart (install, `INKBOX_API_KEY`, `identity.send_text` /
`sendText`) as recorded in `AgentHelpDesk Build Plan.md` (sponsor fact-check list and the Inkbox row of
the sponsor table), [inkbox.ai](https://inkbox.ai) and
[Inkbox on YC](https://www.ycombinator.com/companies/inkbox) as listed in the Research Dossier sources.

### Open question: SMS or iMessage?

**The cited Inkbox quickstart does not say whether texts go over SMS or iMessage.** The Build Plan
flags the same thing ("Check first: it is unclear whether Inkbox texts go over SMS or iMessage. Use
email for the weekly report and test the text on your own phone"). Consequences we coded for:

- The channel defaults to **text**, with **email as the fallback** (`AHD_APPROVALS_FALLBACK_EMAIL`,
  or an email-shaped approver). `ApprovalRequest.channel` records which one was actually used.
- Delivery must be tested on a real phone before the demo; iMessage-only delivery would not reach an
  Android approver, and we cannot tell from the quickstart.
- Because the transport is unconfirmed, all of it sits behind `InkboxClient` in one file.

### Assumption flagged (not a cited fact)

`AHD_INKBOX_BASE_URL` and the REST paths `/identity/send_text` and
`/identity/messages/{id}/replies` are our reading of the cited SDK call `identity.send_text` —
the quickstart names the SDK method, not an HTTP route. `product/` may not add dependencies
(AGENTS.md), so `npm install @inkbox/sdk` is not an option here. Confirm the real endpoint with
Inkbox and change it in `inkbox-client.ts` only; no other file knows about it.

## What is faked

- **`FakeInkbox`** (selected by `AHD_APPROVALS_FAKE=1` or a missing `INKBOX_API_KEY`): records every
  outbound message on the instance, hands back a receipt, and lets a test queue a reply that
  `receiveReply` then returns. `armTextFailure()` / `armEmailFailure()` drive the outage paths.
  No module-level fake, no shared outbound log: each call gets its own client, so the service stays
  stateless and horizontally scalable.
- **Real email delivery is refused, not faked.** The cited quickstart documents `send_text` only, so
  `RealInkboxClient.sendEmail` throws `502 channel_unavailable` (stage `approvals.inkbox.send_email`)
  rather than pretending an email left the building. `FakeInkbox` does "send" email so the fallback
  path is testable offline. Inject an adapter (for example the `product/email` module) once a real
  email transport is confirmed.
- Everything else is real: the Repository, the report arithmetic, the ToolEvents, the routes.

## Behaviour worth knowing

- **Idempotency.** The approval id is `sha256(failure_id + change_summary)`, so an identical
  re-request returns the original row, sends nothing and appends an `approval.requested` event with
  `result: 'replayed'`. A *different* change for the same case gets its own approval.
- **No blind approvals.** `requestApproval` refuses with `409 proofs_missing` when the case has no
  attempt, so there are no proof results to put in the text.
- **A decision cannot be flipped.** Repeating the same decision is a replay; contradicting a stored
  decision returns `409 decision_conflict`.
- **Inbound replies are untrusted.** `parseReply` accepts only an unambiguous yes/no, refuses
  negations ("not approved" is not a yes), and refuses a reply that names a different approval id.
- **Send before store.** A failed send stores no approval row, so a retry can send again; the cost of
  a crash between the two is one duplicate text, which is the cheaper fault.
- **This module never writes case status.** The desk owns the lifecycle: after `requestApproval` it
  should set the case to `awaiting_approval`, and it polls `repo.getApproval(id)` for the decision.
  Nothing here imports `desk/`.
- **PII.** Approvers are personal handles: ToolEvent payloads and HTTP responses carry
  `maskRecipient()` values (`****4567`), never the raw number. No secrets in code or fixtures.

## Report semantics (so a number is never misread)

- Window: daily = the last 24h, weekly = the last 168h, by `Failure.created_at`. `opts.now` is
  injectable; tests pin it.
- `cases_opened` / `cases_fixed` / `cases_escalated` / `agent_retries_ok` / `fixes_merged` /
  `grants_issued` / `billable_cases` count cases **opened inside the window**, in their current state.
- `regression_tests_added` counts the cases in the window whose audit trail has a `regression.created`
  row — `desk/ship.ts` writes one for every case it ships. It is **not** read off
  `outcome.shipped_as`: that field names the channel the *fix* travelled by (`answer` | `pr` |
  `grant`), and `ship.ts` never emits `regression` there, so a counter keyed off it reported zero for
  every real case. A regression test can exist for a case whose fix went out as a plain answer, and
  that is the common shape.
- `awaiting_approval` and `waiting_on_vendor` are a **live snapshot** of every open approval for the
  vendor, window or not — anything waiting on the vendor comes first, per the Build Plan.
- `top_failures` groups **every case on record** for the vendor by a signature derived from stored
  fields (`klass` + request method/path, else `klass` + normalised task); there is no endpoint column.
- `billable_cases` is `Repository.isBillable()` — all three proofs passed **and** the agent's retry
  succeeded. `expected_bill_usd` multiplies it by the unit price and is labelled an invoice preview;
  the Stripe meter is authoritative.
- `Outcome` has no timestamp, so an outcome is attributed to the window through its case.
- Every report carries an `assumptions[]` list stating all of the above, and a closing line saying
  the numbers were aggregated from the case store.

## Stages (all errors name one)

`approvals.request`, `approvals.reply`, `approvals.deliver`, `approvals.store`,
`approvals.inkbox.config|send|send_text|send_email|receive_reply|recipient|fake_inject`,
`approvals.report.daily|weekly|send_now|config`,
`approvals.http.create|reply|read|report|send_now`.

## Tests

`node --test --experimental-strip-types "approvals/*.test.ts"` (run by the orchestrator; AGENTS.md
forbids an editing agent from starting node). Coverage: golden path (request → text sent with the
proofs →
`yes` reply → decision stored), `no` reply, replay/idempotency for both request and decision,
decision-conflict, unknown case, unusable approver, missing proofs, delivery outage with and without
the email fallback, exact daily and weekly counts against a hand-counted six-case seed, empty vendor,
unknown vendor, `send-now` emitting `report.sent`, boundary validation on every route, client
selection, and the real client's refusal of the undocumented email channel. No ports, no processes,
no network.

## Cut order

Drop this module **before the dashboard polish** (Build Plan: "Cut order: drop this before the
dashboard polish"; the overall cut line keeps the case, the sandbox proof and the answer to the agent,
then the approval gate, then the daily report). If time runs short, cut in this order:

1. the weekly report,
2. the daily report and `send-now`,
3. the email fallback and reply-text parsing (`POST /v1/approvals/reply` with an explicit `decision`
   still works),
4. never the approval text itself — failure 3 pausing behind a text and shipping on a `yes` reply is
   in the demo's "never cut" list.
