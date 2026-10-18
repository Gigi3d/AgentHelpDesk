# billing — Stripe meter for B2B, x402 for A2A, MPP for vendor-chooses-agent-pays

AgentHelpDesk bills a provider **per verified fix**: all three proofs passed AND the agent's retry
succeeded. That one rule is `Repository.isBillable()`, and everything in this module is downstream of
it. Two lanes, one rule (Build Plan → "Billing: Stripe meter for B2B, x402 for A2A"):

| Lane | Who pays | Rail | Trigger |
| --- | --- | --- | --- |
| `b2b_meter` | vendor (default) | Stripe usage meter, **count** aggregation, one event per verified fix | `Vendor.payer_mode === 'vendor'` |
| `b2b_mpp` | agent, inside B2B | Stripe MPP — HTTP 402, cards via Shared Payment Tokens ($0.50 min) or USDC ($0.01 min) | `Vendor.payer_mode === 'agent'` and `agent_pay_rail` unset or `'mpp'` |
| `a2a_x402` | stranger agent | x402 open HTTP-402 protocol, settled per call in stablecoin | no `Vendor` row, a vendor with no `stripe_customer_id`, or `payer_mode === 'agent'` with `agent_pay_rail: 'x402'` |

Policy-exempt cases (a `billing_exempt` or `suggest_only` vendor — rungs 0-3 are labelled suggestions
only and never bill — or a privacy / deletion request on the vendor-pays lane) return
`billable: false, lane: null` and append a `billing.exempt` ToolEvent **instead of** a meter event.
The privacy match runs against `Failure.task`, which is the reporting caller's own text, so it is only
honored on `b2b_meter` where the vendor pays: on the agent-pays lanes the payer could otherwise zero
its own bill by writing "gdpr" into a report. When a term matched but was not honored, the
`billing.decision` event carries `privacy_term_ignored`.

## Files

| File | What it does |
| --- | --- |
| `stripe-client.ts` | The **only** file that touches the network. `emitMeterEvent({eventName, customerId, value, identifier})`, `cancelMeterEvent(identifier)`, plus `FakeStripeClient`. |
| `billable.ts` | `decide(failureId, repo): Promise<BillableDecision>` — the billable rule + exemption policy + lane choice. |
| `meter.ts` | `onBillable(outcome, lane, repo, client?)` — emits exactly one meter event (identifier = outcome id), sets `outcome.stripe_event_id`, appends `meter_event.created`; hands back the 402 requirement for the two agent-pays lanes. Also `cancelMeterEventForOutcome`. |
| `x402.ts` | `requirement(priceUsd)` builds the 402 payment requirement; `settle(proof, repo)` verifies, records `payer='agent'` + `x402_payment_id`, returns `unlock: true`. Idempotent per payment id. |
| `mpp.ts` | The B2B agent-pays rail: 402 at $0.50 card / $0.01 USDC minimums, `settle` records `mpp_payment_id`. |
| `verify.ts` | `PaymentVerifier` seam + `FakePaymentVerifier` (offline, deterministic, tagged `mode:'test'`). |
| `invoice.ts` | `invoicePreview(vendorId, repo)` — line items counted from repo rows × the price list. No invented numbers. |
| `prices.ts` | Env-configurable price list and the failure-class → price-key mapping. |
| `outcome.ts` | Outcome lookup/persistence around two Repository gaps (see `../CONTRACT_REQUESTS.md`, billing items 1-2). |
| `log.ts` | One ToolEvent builder so every stage is observable with a consistent `billing.*` stage name. |
| `register.ts` | `registerRoutes(router, repo)`. |
| `billing.test.ts` | `node:test` + `assert/strict`; handlers are called directly with a constructed `Ctx`. |

## Routes

```
POST /v1/billing/decide              {failure_id}                       -> BillableDecision
POST /v1/billing/on-billable         {outcome_id, lane[, failure_id]}   -> 200 meter event | 402 requirement | 200 receipt
GET  /v1/billing/prices              (none)                             -> currency, prices, lane_prices, labels (read-only)
GET  /v1/billing/invoice-preview     ?vendor_id=                        -> counts, line_items, total_usd (from the repo)
POST /v1/billing/meter-events/cancel {outcome_id, reason}               -> cancel inside Stripe's 24h window
POST /v1/billing/mpp/settle          {outcome_id, proof, method}        -> {unlock:true, payment_id, payer:'agent'}
POST /v1/a2a/402                     {outcome_id}                       -> the x402 payment requirement (402)
POST /v1/a2a/settle                  {outcome_id, proof}                -> {unlock:true, payment_id, payer:'agent'}
```

`proof` on `/v1/a2a/settle` is either the bare `X-Payment` string or `{x_payment, scheme, network}`.
`failure_id` is accepted everywhere as a shortcut that skips the outcome-id scan (CONTRACT_REQUESTS
billing-1). `HttpResult` cannot set response headers, so the base64 `x-payment-required` value is
returned in the body as `x_payment_required_b64` / `payment_requirement_b64` (CONTRACT_REQUESTS
billing-3).

`GET /v1/billing/invoice-preview` is **not a pure read**. It walks every case for the vendor through
`decide()`, and `decide()` appends a `billing.exempt` audit row for each exempt case it finds — so a
client that polls it just to render a price grows the audit trail on every call. Use
`GET /v1/billing/prices` for that: it reads the same `priceBook()` and touches no repository. The
provider console does.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | *(unset)* | Secret key. Read from env only, never committed. `sk_test_*` ⇒ `mode:'test'`. |
| `AHD_BILLING_FAKE` | *(unset)* | `1` forces `FakeStripeClient` (in-memory, `mode:'test'`). Also forced when the key is missing. |
| `AHD_STRIPE_METER_EVENT_NAME` | `ahd_verified_fix` | Must match a meter created with **count** aggregation in Stripe. |
| `AHD_STRIPE_TIMEOUT_MS` | `10000` | Cap on every Stripe call (max 30000). |
| `AHD_STRIPE_API_VERSION` | `2025-03-31.basil` | Pinned so a Stripe rollout cannot change payloads mid-demo. |
| `AHD_PRICE_DOCS_USD` | `0.50` | Docs / error-text fix. |
| `AHD_PRICE_CODE_USD` | `1` | Code / config fix. |
| `AHD_PRICE_MIGRATION_USD` | `25` | Migration / authority fix (the class a human approved). |
| `AHD_PRICE_PLATFORM_USD` | `0` | Platform line — **$0 in test**; set `49` for live. |
| `AHD_X402_PRICE_USD` | `0.50` | A2A per-call price. |
| `AHD_X402_NETWORK` | `base-sepolia` | Network named in the payment requirement; proofs on another network are rejected. |
| `AHD_X402_PAY_TO` | zero address | Recipient. The zero placeholder means nothing can be paid by accident offline. |
| `AHD_X402_ASSET` | `USDC` | The spec wants the token contract address; set it before live use. |
| `AHD_X402_RESOURCE`, `AHD_X402_TIMEOUT_SECONDS` | `/v1/a2a/answer`, `60` | Requirement fields. |
| `AHD_MPP_PRICE_USD` | `0.50` | MPP per-call price (fits the $0.50 card minimum exactly). |
| `AHD_MPP_API_VERSION` | `2026-07-29.preview` | The preview version the MPP business profile + Tempo deposit address use. |
| `AHD_MPP_NETWORK`, `AHD_MPP_ASSET`, `AHD_MPP_DEPOSIT_ADDRESS` | `tempo`, `USDC`, zero address | USDC method fields. |
| `AHD_MPP_RESOURCE` | `/v1/billing/verified-answer` | What the 402 is selling. |
| `AHD_BILLING_EXEMPT_TERMS` | privacy request, data deletion, delete my data, right to be forgotten, dsar, gdpr, ccpa, subject access request | Comma-separated; matched case-insensitively against `Failure.task`. |
| `AHD_BILLING_OUTCOME_SCAN_CAP` | `2000` | Guard on the outcome-id scan (CONTRACT_REQUESTS billing-1). |

No secrets live in code or fixtures: every key and address is read from `process.env`, and the
placeholders in tests are obvious fakes (`cus_demo_ledgerly`, `spt_demo_token_1`, `xpay_demo_blob_1`).

## Sponsor docs cited (no invented APIs)

- **Create a billing meter event** — `stripe.billing.meter_events.create({event_name, payload:{stripe_customer_id, value}, identifier})`; REST `POST /v1/billing/meter_events`.
  https://docs.stripe.com/api/billing/meter-event/create
- **The Meter Event object / Meter object** — `identifier` is the idempotency key; meters use **count** aggregation.
  https://docs.stripe.com/api/billing/meter-event/object · https://docs.stripe.com/api/billing/meter/object
- **Usage-based billing / meters guide** — a meter event can be **cancelled within 24 hours**, which is how a retry that later failed gets refunded (`POST /v1/billing/meter-events/cancel`, implemented over `stripe.billing.meter_events.deactivate`; confirm the path against your pinned API version before live mode).
  https://docs.stripe.com/billing/subscriptions/usage-based
- **Stripe MPP quickstart** — HTTP 402 with a payment requirement; cards via **Shared Payment Tokens, $0.50 minimum**; **USDC $0.01 minimum**; the server is a short `mppx` + `stripe` handler tested with `npx mppx@latest validate` (**not run here** — AGENTS.md forbids node/npm/npx on this machine); the setup uses the `2026-07-29.preview` API version for the business profile and the Tempo deposit address.
  https://docs.stripe.com (Machine Payments Protocol quickstart) · Stripe's hackathon primer, shipbysundown.dev
- **x402** — open HTTP-402 protocol: server returns 402 with a payment requirement (network + amount + recipient), client pays in stablecoin and retries with `X-Payment`, server verifies (via a facilitator) then serves.
  https://docs.x402.org · https://docs.x402.org/schemes/exact · https://github.com/x402-foundation/x402
- Build Plan: "Billing: Stripe meter for B2B, x402 for A2A", "Data model" (outcomes table), "Daily and weekly reports" (invoice preview).

## What is faked (and why)

| Piece | Real in production | Here |
| --- | --- | --- |
| Stripe meter events | `stripe.billing.meter_events.create` over HTTPS | `LiveStripeClient` (fetch, pinned API version, timeout, fails loud on non-2xx). `FakeStripeClient` when `AHD_BILLING_FAKE=1` or no key: records to memory, tags `mode:'test'`, dedupes by `identifier` like the real API. |
| Meter event cancellation | within 24h, by identifier | `cancelMeterEvent(identifier)`; the fake 404s on an unknown identifier. The local receipt row is **kept** on cancel, so a cancelled outcome can never be re-metered. |
| x402 verification | a facilitator `verify` call on the payment payload | `FakePaymentVerifier` — deterministic `x402_fake_<sha256[:24]>`, offline, `mode:'test'`; rejects proofs containing `invalid` / `reject` / `insufficient` / `bad_signature` so the failure path is testable. |
| MPP verification | `mppx` + `stripe`, validated with `npx mppx@latest validate` | Same `FakePaymentVerifier` (`mpp_fake_<sha256[:24]>`). Minimums are enforced by our code, not by the fake. |
| Recipient addresses | real `payTo` / deposit address | zero address by default, so an accidental live payment is impossible until env is set. |

Nothing else is faked: the billable rule, the lane choice, the exemption policy, the idempotency and
every number in the invoice preview are computed from `Repository` rows.

## Idempotency (how a retry can never bill twice)

1. `identifier = outcome.id` on every meter event — Stripe dedupes, and `Repository.recordMeterEvent`
   enforces the same uniqueness locally.
2. `onBillable` checks `repo.meterEventByIdentifier(outcome.id)` **first**; a replay returns the
   original receipt, emits nothing, and appends `meter_event.replayed`.
3. If two workers race and the repo returns a different id than we emitted, we log
   `meter_event.race_lost` and keep the winner — we do **not** auto-cancel, because Stripe cancels by
   identifier, which is shared with the winning event. An operator uses the 24h window deliberately.
4. x402/MPP: once the outcome carries `x402_payment_id` / `mpp_payment_id`, a replay returns that id
   and unlocks once. A *different* proof cannot buy the same answer again.
5. `onBillable`, `x402.settle` and `mpp.settle` all re-run `decide()` and refuse (`409 not_billable`,
   `409 lane_mismatch`) if the case is not billable or the lane does not match, so a caller cannot
   pick a cheaper lane or sell an unverified fix.

## Cut order

**Drop the MPP lane before the meter.** The meter is the revenue model; MPP is the "an agent pays by
itself" demo moment (Build Plan, "Cut order"). To cut it: remove the two MPP routes in `register.ts`,
`billing/mpp.ts`, and make `billable.ts chooseLane` return `a2a_x402` for every agent-pays vendor
instead of reading `Vendor.agent_pay_rail`. Nothing else in the module changes — the meter lane and
the invoice preview do not depend on MPP.

## Running

```
AHD_BILLING_FAKE=1 node --test --experimental-strip-types "billing/*.test.ts"   # from product/
```

The orchestrator runs type-check and tests serially; do not start node while another agent is running
(AGENTS.md machine rules).
