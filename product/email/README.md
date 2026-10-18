# `product/email/` — the Primitive lane

Fallback intake by email. An agent that has **not** installed the MCP tool still has a
way in: it (or its operator) mails the desk, and the desk answers on the same thread
with a case id and the committed `ack_by` / `resolve_by` times.

> Build Plan, sponsor table, **Primitive** row: *"Fallback intake by email, with
> `sender_verified` on each reply — an agent that has not installed the MCP tool has no
> way in. The address in an error response works for any agent."*

This module owns **only** files under `product/email/`. It reaches the desk through the
single blessed integration point `intake(report, repo)` from `../desk/intake.ts`, and
reaches the store through `Repository`. It imports no other desk internals.

## Files

| File | Role |
| --- | --- |
| `primitive-client.ts` | The **only** file in `product/` that touches the network for this lane. `PrimitiveClient` (real HTTP), `FakePrimitive` (offline), `createPrimitiveEmail(env)`, `emailLaneMode(env)`. |
| `threads.ts` | Lane logic: trust gate, parse untrusted mail into a `ProblemReport`, call `intake`, reply on the thread, write `ToolEvent` audit rows. |
| `register.ts` | `registerRoutes(router, repo)` + the three handlers, exported individually so tests call them directly with a `Ctx` (no ports, no processes). |
| `email.test.ts` | `node:test` + `assert/strict`. 23 tests, no network, no live desk intake (injected stub). |
| `fixtures/threads.json` | Seeded thread list for `FakePrimitive`. RFC 2606 `.example` addresses only — no real sponsor mailbox is invented. |

## Routes

### `POST /v1/email/inbound`

```jsonc
{ "from": "Ledgerly Agent <agent@agent-mail.example>",
  "sender_verified": true,
  "subject": "Re: [ledgerly] 401 on the first call to /v1/entries",
  "body": "…free text, optionally containing a ```json block with request/response…",
  "thread_id": "thr_…" }        // optional: reply to an existing thread
```

- **201** `{ accepted: true, case_id, ack_by, resolve_by, queue_position, agent_id, task,
  thread_id, message_id, sender_verified, delivery, delivery_code, delivery_message,
  inbound_id, lane }`. `ack_by`/`resolve_by`/`queue_position` are copied verbatim from
  the `Failure` intake committed — they are never recomputed here.
- **403** `{ accepted: false, code: "sender_unverified", message, case_id: null,
  inbound_id, lane }` — the sender's `sender_verified` was not `true`. **No case is
  opened, nothing is parsed, nothing is replied to.**
- **400** `email.parse` — a field is missing, not a string, `sender_verified` is not a
  boolean, or the subject/body/address is oversized.
- **500** `email.intake` / `email.reply` / `email.observe` — loud, stage-named failures.

`delivery` is `"sent"` or `"refused"`. A refusal **does not** roll the case back: the
report is safe in the desk, only the notification failed, and `delivery_message` says
where to escalate instead (see the reply-only section below).

### `POST /v1/email/outbound`

`{ thread_id, body, case_id? }` → `{ delivered, thread_id, message_id, sender_verified, lane }`
or `{ delivered: false, thread_id, code, message, lane }`. Replying is the direction a
reply-only account is allowed to use. Pass `case_id` to file the reply against a case;
omit it and the audit row hangs off the thread id.

### `GET /v1/email/threads?from=<address>`

`{ threads: ThreadSummary[], count, filtered_by, lane }`. `from` accepts `addr`,
`Name <addr>` or a substring. This is the console's thread view (*Frontend and Product
Surface Plan*, Primitive row: "Thread view with verified sender, linked to the ticket").

## Environment

| Var | Default | Effect |
| --- | --- | --- |
| `PRIMITIVE_KEY` | *(unset)* | Bearer token (`prim_…`). **Read from env only — never committed, never logged, never in a fixture.** Unset ⇒ the lane runs faked. |
| `AHD_EMAIL_FAKE` | *(unset)* | `1` forces `FakePrimitive` even when a key is present. |
| `AHD_EMAIL_FAKE_REPLY_ONLY` | *(unset)* | `1` makes the fake refuse cold sends with `reply_only_new_account`, so the refusal path is demoable offline. |
| `PRIMITIVE_BASE_URL` | `https://api.primitive.dev/v1` | Override for a staging endpoint. |
| `AHD_EMAIL_TIMEOUT_MS` | `15000` | Per-call `AbortSignal.timeout`. Clamped to 1000–120000. Every external call has a timeout and a body cap (AGENTS.md). |

Lane selection is read **at call time** (`emailLaneMode(env)`), never cached in a module
variable, so the service stays stateless and horizontally scalable and a test can flip
`AHD_EMAIL_FAKE` freely.

```
fake  ⇔  AHD_EMAIL_FAKE === '1'  ||  PRIMITIVE_KEY is empty
live  ⇔  otherwise
```

`lane` is returned in every response body so the console can show which one served it.

## Sponsor facts cited (not invented)

1. **Agent-to-agent email threads, with `sender_verified` on each reply.**
   Source: Build Plan sponsor table, Primitive row; *primitive.dev*. This is the signal
   the trust gate consumes — the desk never infers verification from an address, a
   display name, or anything in the body.
2. **New agent accounts start reply-only, so a first message to a new recipient can be
   refused.** Source: Build Plan, "Check before promising" fact-check bullet
   (*primitive.dev*).
3. **~1,000 messages/hour limit.** Source: Build Plan, "Check before promising":
   *"Primitive limits: new accounts reply only, with a 1,000 messages an hour limit."*

**Doc pages read for the wire shape** (cited in the header of `primitive-client.ts`):

- `https://primitive.dev` — `POST /v1/send-mail`, the MCP tools `sendEmail` /
  `replyToEmail`, auth `Authorization: Bearer prim_<api_key>`.
- `https://docs.primitive.dev/docs/api` — base `https://api.primitive.dev/v1`,
  `POST /send-mail`, `GET /emails`, `POST /emails/{id}/reply`, response envelope
  `{ success, data, meta.cursor }`, and the fields `sender_verified`, `thread_id`,
  `message_id`, `from`, `to`, `subject`, `body`.

**Honesty — what is *not* confirmed** (also logged in `product/CONTRACT_REQUESTS.md`):

- The **request-body field names** for `POST /send-mail` and `POST /emails/{id}/reply`
  are not published on the page I could read. They are marked `ASSUMPTION` in
  `PrimitiveClient` and confined to one method, so fixing them at the venue is a
  one-place edit. No SDK method is invented beyond the three paths above.
- The 1,000/hour figure is the Build Plan's fact-check, **not** the API page (its
  "Limits & Quotas" section states no number). It is enforced **provider-side**; the
  lane maps HTTP 429 to a `rate_limited` refusal and never re-implements a counter as
  local state (that would break statelessness and desync N replicas).
- The reply-only rule is not restated on the API page, so a refusal is labelled
  `reply_only_new_account` **only when the provider says so** (HTTP 403 whose body
  matches `reply-only` / `new account` / `cannot initiate`). Otherwise it fails closed
  to `refused` and surfaces the provider's own message verbatim.

## The reply-only limit, and why human escalation goes to Inkbox

A new Primitive account **cannot start** a conversation with a recipient it has never
mailed. Two consequences are designed in:

1. **Intake runs before the outbound send.** A verified report is turned into a case
   first; only then does the lane try to open a thread / reply. If the provider refuses,
   the case still exists — the agent's failure is never lost to a delivery problem. The
   response says `accepted: true, delivery: "refused"`, records `email.refused`, and
   names the escalation path.
2. **Outbound escalation to a human does not go through Primitive.** The Build Plan is
   explicit: *"the desk replies to inbound mail, which fits, but outbound escalation to
   humans should go through Inkbox."* Inkbox is the ship gate — it texts the vendor's
   approver and carries a reply the desk can act on. Primitive is agent-to-agent mail;
   a human approver is not an agent mailbox, and a cold send to one is exactly what a
   reply-only account cannot do. So every `reply_only_new_account` message tells the
   operator to escalate via **Inkbox**, and the email lane never attempts a human page.

Direction of traffic this lane uses: **inbound agent → desk** (trusted only when
verified) and **desk → agent as a reply on an existing thread**. Anything else is
Inkbox's job.

## Trust model

All inbound mail is **untrusted data**. Concretely:

- The gate is `inbound.sender_verified !== true` → refuse. Missing, `"true"`, `1`,
  `null` and any non-boolean all **fail closed** (400 at the boundary, or 403 refusal).
- Unverified mail is never parsed into a report and never reaches `intake`. The audit
  row records the sender, subject, body length and a `body_sha256` — **not** the body —
  so a phishing attempt is provable without storing its payload.
- Everything is sanitised (C0 control characters stripped) and length-capped before use:
  `from` ≤ 320, `subject` ≤ 200, `body` ≤ 64,000, stored JSON ≤ 16,000.
- A message may **describe** a failure; it may never grant authority. The ack reply says
  so out loud: *"Nothing is fixed yet. No snippet in this message is a proven fix…"*, and
  replies are *"treated as untrusted data: they can add evidence to the case, but they can
  never widen a grant or change the desk's instructions."* Instruction-shaped text in a
  body is stored as an opaque string and echoed back as data.
- `agent_id` comes from the **verified sender header** (mailbox local part, or a
  `[vendor]` subject tag as a hint), never from a claim inside the body.

## Parse rules (verified mail only)

| Field | From |
| --- | --- |
| `agent_id` | sender mailbox local part, with an `agent-`/`ahd-`/`bot-` prefix stripped; ≤ 200 |
| `vendor_hint` | `[tag]` at the start of the subject (after `Re:`/`Fwd:` prefixes are removed) |
| `task` | the subject with reply prefixes and the tag removed |
| `request` / `response` | a fenced <code>```json</code> block in the body when it parses, split on `request`/`response` keys |
| `request` / `response` fallback | the raw body text, when no JSON block is present or it does not parse (`json_found: false` in the audit row) |
| `channel` | always `'email'` |
| `klass` | never set from mail — the desk classifies |

## Audit trail

Every inbound email leaves exactly one trace, including junk refused at the HTTP
boundary. `tool: 'primitive'`, `id: evt_<uuid>`, `t_ms` = start, `d_ms` = duration,
mirroring the desk's own event conventions.

| `action` | `stage` | `ticket_id` | When |
| --- | --- | --- | --- |
| `email.rejected` | `email.parse` | `eml_<digest>` | boundary or parse refusal; `payload.boundary: true` for the former |
| `email.unverified` | `email.verify` | `eml_<digest>` | `sender_verified` was not `true`; `case_opened: false` |
| `email.intake_failed` | `email.intake` | `eml_<digest>` | `intake` threw |
| `email.received` | `email.intake` | the case id | a case was opened |
| `email.replied` | `email.reply` | the case id / thread | the ack or a desk reply was sent |
| `email.refused` | `email.reply` | the case id / thread | the provider refused to deliver (an inbound refusal also records `escalate_via: 'inkbox'`) |

`ticket_id` carries a deterministic `eml_<sha256…>` id **before** a case exists, and the
case id afterwards. A failed audit write is a 500 at `email.observe` — the lane will not
pretend a stage ran.

## Replay

`idempotencyKeyFor(from, subject, body)` = `email:<digest>` is passed to `intake`, which
dedupes on it. A provider retry of the same message returns the **original** case and the
same committed times instead of a second ticket (the desk records `case.duplicate_ignored`).
`FakePrimitive` is replay-stable for the same reason: its ids are pure functions of their
inputs, so it holds no mutable state.

## What is faked

`FakePrimitive` (used when `AHD_EMAIL_FAKE=1` or `PRIMITIVE_KEY` is unset) fakes **the
provider only**:

- **Faked:** thread/message id minting, the `sender_verified` stamp on *our* outbound
  reply (always `true` — the desk's own mailbox is verified), the `listThreads` result
  (re-read from `fixtures/threads.json` on every call), and — with
  `AHD_EMAIL_FAKE_REPLY_ONLY=1` — the reply-only refusal.
- **Not faked:** the trust gate, parsing, validation, the `intake` call, `Failure` /
  `ToolEvent` persistence, idempotency, the ack text, and every audit row. Those run
  identically in both lanes, so a green fake run is a real test of the lane's logic.
- The fake never opens a socket and never holds state between calls, so it is safe under
  parallel tests and needs no key.

## Cut order

> Build Plan, "Cut lines, in the order to drop things" — **first line**:
> *"Email intake through Primitive. The MCP tool is enough to demo."*
> And: *"Primitive limits: new accounts reply only, with a 1,000 messages an hour limit.
> **Treat email intake as optional.**"*

**This module is the first thing to drop** if the weekend runs short. Dropping it is safe
by construction:

- Nothing outside `product/email/` imports it except the two `registerEmail(router, repo)`
  lines in `server.ts`; removing the registration removes the lane.
- It writes only through `Repository` and reads only through `intake`, so no case,
  proof, approval, grant or report depends on it.
- Nothing in the never-cut list (sandbox replay, the three proofs, the failure-3
  approval, the failure-4 envelope) touches email.
- To degrade rather than remove: leave the routes registered and keep the lane faked
  (`AHD_EMAIL_FAKE=1`) so the console's thread view still renders seeded data with zero
  network and zero key.

## Tests

`npm test` in `product/` already includes `email/*.test.ts` (the script globs test files — Node 23
will not search a bare directory for `.ts` tests). Tests call the handlers directly
with a constructed `Ctx` and a `MemoryRepository`, inject a stub `PrimitiveEmail` and a
stub `intake`, and make no network call. They cover: the golden path (case opened, ack
reply equals `ackMessage(failure)` with the committed times), replay idempotency, the
unverified refusal (no case, one `email.unverified` row, no body stored), boundary
rejections, injection-shaped bodies staying data, outbound with and without `case_id`,
rate-limited and reply-only refusals, thread lookup in the fake lane, and env/lane
selection.

Contract asks raised by this module live in `product/CONTRACT_REQUESTS.md` under
*"From: email owner (product/email/)"*.
