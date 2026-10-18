# Ledgerly desk: the `report_problem` MCP edge and case API

An agent that fails on the Ledgerly API calls `report_problem` and gets `case_id`, `ack_by`,
`resolve_by` and `queue_position` back in the same call — committed times, not "we'll get back to
you". Later it gets a verified answer, an executable outcome, or a bounded grant it may call itself,
and it closes the loop with `report_retry_result`.

This server is a **thin MCP edge**. It owns the agent-facing contract (tool names, Zod schemas, the
reply shape, push topics) and nothing else: case state, the resolver loop, the proofs, billing and
the audit trail belong to the AgentHelpDesk backend service in `product/` (a dependency-free
`node:http` API on `127.0.0.1:8787`). The edge holds no case state, so N copies can sit behind a
load balancer, and it **never invents a case** — if the backend is unreachable the call fails loud
with a machine-readable envelope an agent can branch on.

```bash
# 1. the backend that owns case state
cd ../product && node --experimental-strip-types server.ts     # 127.0.0.1:8787

# 2. this edge
npm install --legacy-peer-deps   # npm 10 crashes on mcp-use's optional peers without the flag
npm run dev                      # http://localhost:3000/mcp, inspector at /mcp/inspector
```

The engine field asks for Node 22. The server runs on Node 20 as well. The console reads this edge
over HTTP and server-sent events when it runs with `VITE_LIVE=1`.

## Two modes

| Mode | Switch | Behaviour |
| --- | --- | --- |
| `live` | default | Every call is forwarded to `AHD_DESK_URL`. A backend that is down, slow or off-contract produces an envelope with stage `mcp.upstream` — no fallback data, ever. |
| `fake` | `AHD_DESK_FAKE=1` | The deterministic fixtures in `src/fixtures/` are served from a local `DeskStore`, so the tool and all case routes work with no backend, no ports and no processes. Same request id ⇒ same case id, same committed times, same answer. |

Failing loud is the point: an agent that trusts a fabricated `ack_by` is worse off than an agent
holding an error it can act on. Fake mode is an explicit opt-in for demos, evals and tests.

## Surface

| Route | What |
| --- | --- |
| `POST /mcp` | MCP endpoint. Two tools, `report_problem` and `report_retry_result`, with the schemas below |
| `POST /report_problem` | The `report_problem` call as plain JSON, for curl and for agents without an MCP client |
| `POST /cases/:id/retry` | The `report_retry_result` call as plain JSON. Body is `{ ok, note? }`; the id comes from the path |
| `GET /cases`, `GET /cases/:id` | Cases, in the ticket shape of `web/src/data/tickets.json` |
| `GET /cases/:id/events` | `tool_events` rows, in the shape of `web/src/data/tool_events.json` (`t_ms` is ms since the case opened) |
| `GET /stream` | Server-sent events: `ready` (with `{ mode }`) on connect, `case` (whole ticket) and `event` (one row) on every write, `ping` every 15s, and `error` (an envelope) when the backend blips — the stream stays open and keeps retrying |

```bash
curl -s localhost:3000/report_problem -H 'content-type: application/json' \
  -d '{"request_id":"req_8hT2kq","goal":"Apply the gift card and place the order."}'
```

## The schema agents see

`report_problem` — `src/schemas.ts`, unchanged from the previous release and still matching
`web/src/data/report_problem.tool.json`, so already-installed agents keep working. Annotations:
`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

Input (a cross-field refine: send `goal` to open a case, or `case_id` alone to poll one):

| Field | Type | Meaning |
| --- | --- | --- |
| `request_id` | string, required | The `Request-Id` header or `help.request_id` from the failing response |
| `goal` | string, optional | What you were trying to do, in one sentence |
| `tried` | string, optional | What you already tried |
| `contact` | string, optional | How to reach your operator, such as an email |
| `case_id` | string, optional | An existing case id, to check its status instead of opening a new case |

Output (all optional, so a not-yet-answered case is a valid reply): `case_id`, `status`
(`opened` \| `working` \| `needs_user_input` \| `answered` \| `handed_off`), `ack_by` / `resolve_by`
(ISO datetimes), `queue_position`, `answer { summary, fix_steps[], docs, tested { replay,
vendor_tests, fresh_agent } }`, `outcome` (executable result: action, amount, currency,
`expires_at`), `authority` (verbs you may now call, each with its cap and per-user limit), `events`
(the four pushable topics), `wait` (seconds before polling again, for agents that cannot take push).

`report_retry_result` — same annotations. Input: `case_id` (string, required), `ok` (boolean,
required — did the failing call succeed after you applied the fix?), `note` (string, optional — the
error you still get when `ok` is false). Output: `case_id`, `ok`, `billable`, `outcome_id?`,
`receipt?`.

Pushable topics, advertised in every reply: `case.acknowledged`, `case.needs_user_input`,
`case.resolved`, `case.breached_sla`.

## How it behaves

- **Committed times at intake.** The backend returns `ack_by`, `resolve_by` and `queue_position`
  with the case id in the same response (201/202), before any work happens. The console SLA classes
  are `blocked_order` (5m / 1h) and `default` (15m / 4h); the backend's own windows come from
  `AHD_ACK_MINUTES` / `AHD_RESOLVE_MINUTES`.
- **One open case per request id.** `request_id` is sent as the backend's `idempotency_key` (and as
  the `idempotency-key` header), so a repeat call replays the case that is already open instead of
  opening a twin — whichever channel it arrived on. Pass `case_id` to poll.
- **The loop runs because the edge asks it to.** `AHD_DESK_RUN=background` (default) sends
  `run_loop: true, background: true`, so the agent's reply stays immediate while the desk works the
  case. `inline` waits for the answer in the same request (raise `AHD_DESK_TIMEOUT_MS`); `off`
  leaves the case at `opened` for someone else to run.
- **Billable only when it worked.** `report_retry_result` with `ok: true` bills only when all three
  proofs (`replay`, `vendor_tests`, `fresh_agent`) passed *and* the agent's retry succeeded. A
  replay returns the same receipt and bills nothing extra. The edge never claims billing the backend
  did not state.
- **Shape translation is the edge's job.** The backend answers a case read with a `CaseView`
  (`{ case, status, attempt, outcome, grant, approval, reply, events, … }`) and its `ToolEvent.t_ms`
  is an epoch, while the console wants a flat ticket and `t_ms` relative to `created_at`. Both are
  reshaped in `src/desk-client.ts`, and `CaseView.vendor` (which carries a Stripe customer id) is
  deliberately not republished to the browser.
- **No polling required.** `/stream` diffs the backend's list on `AHD_DESK_POLL_MS` and pushes whole
  tickets plus new event rows, re-reading a case once after it goes terminal so late billing events
  are not lost. Agents that cannot take push use `wait`.

## Errors

Every failure is the envelope of `product/shared/http.ts`, on HTTP and in the MCP tool result
(`isError: true` with the envelope as JSON text). `stage` says whose fault it is.

```json
{ "error": { "code": "upstream_unreachable", "message": "POST /v1/cases could not reach …", "stage": "mcp.upstream", "request_id": "…" } }
```

| HTTP | `code` | `stage` | When |
| --- | --- | --- | --- |
| 400 | `invalid_input` | `mcp.edge` | Tool args failed Zod validation (the issue list is in `message`) |
| 500 | `bad_config` | `mcp.config` | An `AHD_DESK_*` value is unusable (bad URL, out-of-range int, unknown run mode, vendor hint over 200 chars) |
| 502 | `upstream_unreachable` | `mcp.upstream` | Nothing answered: the backend is not running or the URL is wrong |
| 504 | `upstream_timeout` | `mcp.upstream` | No answer within `AHD_DESK_TIMEOUT_MS` |
| 502 | `upstream_invalid_json` | `mcp.upstream` | The backend answered with a body that is not JSON |
| 502 | `upstream_contract` | `mcp.upstream` | The answer parsed but broke the contract (a case with no `id`/`created_at`, a reply that fails `reportOutputSchema`) |
| 413 | `upstream_payload_too_large` | `mcp.upstream` | The answer is over 1MB, the same cap the backend enforces inbound |
| 404 | `case_not_found` | `mcp.upstream` / `mcp.fake` | Unknown `case_id` |
| *passthrough* | the backend's own `code` | the backend's own `stage` | The backend sent an envelope (rate limit, `no_outcome` on an unanswered retry, `payload_too_large`, …). The edge keeps `code`, `message`, `stage` and `request_id` verbatim and only prefixes the call that failed |
| 500 | `edge_internal` | `mcp.edge` | Anything unexpected in the edge itself |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AHD_DESK_URL` | `http://127.0.0.1:8787` | The backend base URL. Must be http(s); a trailing slash is trimmed |
| `AHD_DESK_TIMEOUT_MS` | `5000` | Hard timeout on every upstream call (250–60000). Raise it for `AHD_DESK_RUN=inline` |
| `AHD_DESK_POLL_MS` | `2000` | How often `/stream` diffs the backend (250–60000) |
| `AHD_DESK_RUN` | `background` | `off` \| `background` \| `inline` — whether `POST /v1/cases` asks for the resolver loop |
| `AHD_DESK_VENDOR` | `ledgerly` | `vendor_hint` on the report, so the backend can pick the right vendor and its test suite (max 200 chars, matching the backend's cap) |
| `AHD_DESK_FAKE` | unset | `1` serves the offline fixtures instead of calling the backend |
| `DESK_STORE`, `DESK_DATA` | file, `data/desk.json` | **Fake mode only.** `DESK_STORE=memory` keeps nothing on disk; `DESK_DATA` moves the file |

`DESK_SPEED` no longer does anything: the recorded-step replay it scaled lived in the in-process
worker, which is gone. `src/data/request_log.json` is kept as the recorded Ledgerly failures the
fixtures were built from (the retired worker in `_attic/` still reads it); live mode never touches it.

## Storage and statelessness

The only persistence in this package is `DeskStore` in `src/store/`, and it is used **only** by fake
mode, as the fixture source. Live mode is stateless with respect to cases: the backend owns them, and
the per-connection diff caches in `watch()` are throwaway (a reconnect simply re-reads the backend).

## Tests

`src/desk-client.test.ts` runs on `node:test` + `node:assert/strict` against fake mode and the pure
payload mappers only — no ports, no processes, no clock reads, no secrets:

```bash
node --experimental-strip-types --test src/desk-client.test.ts
```

It covers config resolution and its `bad_config` failures, the fake-mode report/poll/retry receipts,
the loud `mcp.upstream` envelope for an unreachable backend, and the mappers that turn a real
`CaseView`, an intake answer, a bare `Failure` or a stored `AgentReply` into the ticket, the events
and the tool reply an agent or the console expects.

## Deploy on Manufact Cloud

Commands quoted from the mcp-use README (`node_modules/mcp-use/README.md`). **Do not run them in
this workspace** — the build/deploy tooling is run by the owner, and this repo's rule is no
`npm`/`npx`/`node` from an agent session.

```bash
npm run build      # create the production build
npm run dev        # serve http://localhost:3000/mcp, inspector at /mcp/inspector
npm run deploy     # ship to Manufact
```

> Ship to [Manufact](https://manufact.com) and get observability, analytics, evals, submission
> readiness, and Git-based preview environments for free. — mcp-use README, "Deploy"

Prefer to run it yourself? Follow the [self-hosting
guide](https://docs.mcp-use.com/typescript/server/deployment/runtime-patterns). To test a local
build against ChatGPT and Claude before deploying, the README offers a tunnel
(`mcp-use dev --tunnel`, or start one from the Inspector UI) and a headless client:

```bash
npm install --save-dev @mcp-use/client
npx mcp-use client connect local http://localhost:3000/mcp
npx mcp-use client local tools list
npx mcp-use client local tools call report_problem request_id=req_8hT2kq goal="Apply the gift card and place the order."
npx mcp-use screenshot --server local --tool report_problem request_id=req_8hT2kq --output report-problem.png
```

Before deploying, set the edge's environment in the deployment: `AHD_DESK_URL` must point at a
backend the deployed edge can actually reach (`127.0.0.1:8787` is the local default and will not
resolve to the `product/` service in the cloud), plus `AHD_DESK_RUN`, `AHD_DESK_VENDOR` and the
timeouts as needed. Never set `AHD_DESK_FAKE=1` on a deployed edge that is meant to be real: it
would serve fixtures to live agents. No secret belongs in this package — the edge authenticates
nothing and stores nothing.

## Manufact evals and the prize track

This package targets Manufact's **"Best MCP server for agents"** track: $3,000 cash plus $9,300
Manufact credits, then $2,000 / $700 / $300 cash tiers (`AgentHelpDesk Build Plan.md`, prize
tracks). The Build Plan's fact-check for the Manufact row: scaffold with
`npx create-mcp-use-app@latest`, define tools with `server.tool(...)` and Zod schemas, deploy with
`npm run deploy` — which is exactly what this server does, and the scaffold is why the mcp-use
scripts (`build`, `dev`, `start`, `deploy`, `typecheck`) are the ones in `package.json`.

What the track rewards, and where it lives here:

- **Agent-first contract.** Two idempotent tools, `idempotentHint: true`, an `outputSchema` the agent
  can validate against, and a reply that always carries the next action: either the answer with
  `tested { replay, vendor_tests, fresh_agent }`, or committed `ack_by`/`resolve_by` plus `wait`.
- **Push over polling.** Four topics advertised in every reply, delivered over `/stream`; `wait` is
  the documented fallback for agents that cannot take push.
- **Honest failure.** Machine-readable envelope with a `stage` that names whose fault it is, and no
  invented cases — an agent can tell "the desk is down" (`mcp.upstream`) from "your arguments were
  wrong" (`mcp.edge`) from "the desk refused" (the backend's own stage).
- **Evals per deploy.** Manufact runs evals on deploy; `AHD_DESK_FAKE=1` gives them a deterministic
  subject (fixed clock, fixed ids, fixed answer) so an eval run is reproducible without the backend,
  and `src/desk-client.test.ts` covers the same shapes offline.
- **Distribution.** Deploying puts the tools in front of Claude and ChatGPT connectors, and the
  Inspector at `/mcp/inspector` is the debugging surface for that.

## Contract gaps

The edge codes against the real routes in `product/desk/register.ts` and files everything the
backend does not carry yet in `product/CONTRACT_REQUESTS.md` (section *"From: mcp edge owner"*):
`request_id` and the console's display fields on `ProblemReport`/`Failure`, a dedicated events
route, `case_id`/`note` on the retry route, `stage`/`wait`/`docs_url` on `AgentReply`, the
`escalated` stage mapping, and the `ToolEvent.t_ms` epoch-vs-relative ruling. Each ask there names
the local assumption the edge is running on, so the backend can change the contract without this
edge guessing.
