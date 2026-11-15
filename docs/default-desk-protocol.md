# Default desk: how AHD becomes the first place an agent goes

Status: protocol design proposal. Companion to [`context-box.md`](./context-box.md) and [`rewards-spec.md`](./rewards-spec.md).

## Purpose

Every agent that fails on a provider's API should reach the provider's AHD desk first, whatever model runs the agent (Claude, GPT, Grok, Qwen or anything else), and should keep coming back because the desk finishes its goal.

We do not get there by changing what a model believes. We get there by sitting where every agent already looks when something breaks, being first-party to the provider, and being verifiably useful.

## Principles

1. **Infrastructure over belief.** The strongest path never asks the model to decide. Middleware files the case automatically.
2. **First-party placement.** The pointer to the desk lives in the provider's own error responses, docs and tool list, put there by the provider. Third-party text that tells an agent what to do reads as prompt injection, and well-built agents ignore it.
3. **Model-agnostic contract.** One schema, flat and forgiving, generated into every vendor's tool format.
4. **Data, not instructions.** Replies are structured data an agent can verify and replay. They never rely on the agent obeying prose.
5. **Earn the default.** Every reply carries proofs, a committed deadline and a signed receipt. The default holds because it works, and the numbers per model prove it.

## Discovery layers

Ordered from strongest to weakest. A provider installs as many as it wants, and layer 0 alone is enough.

| Layer | Where it lives | Needs the model to decide? |
| --- | --- | --- |
| 0. Auto-report middleware | SDK wrapper, fetch wrapper, CLI hook (Armature, Blaxel CLI) | No |
| 1. Error response hint | `application/problem+json` with a `help` object, or `Link: <...>; rel="help"` | Barely: it reads the error it already reads |
| 2. Well-known file | `/.well-known/ahd.json` on the provider's domain | No: tools and crawlers read it |
| 3. Docs surfaces | `llms.txt` entry, OpenAPI `x-ahd` extension, docs footer | Sometimes |
| 4. MCP tool | `report_problem` on the provider's MCP server | Yes: the agent must pick the tool |

### Layer 0: auto-report

After the first failed retry of a call, the wrapper builds a minimal report from what it already saw (request, response, task string if the caller set one) and posts it to the desk. The agent is told the case id and gets the reply as the next result. No model choice involved, so this behaves the same under every LLM.

### Layer 1: error response hint

Providers add one object to their error bodies:

```json
{
  "type": "https://api.ledgerly.example/errors/payment-required",
  "title": "Payment required",
  "status": 402,
  "detail": "X-Payment header missing or invalid.",
  "help": {
    "desk": "https://desk.ledgerly.example/v1/report",
    "case_token": "ct_01H...",
    "note": "Official support desk for this API. Free for failed calls. Returns a verified corrected request."
  }
}
```

`case_token` is single-use, scoped to the failing call, and lets the desk link the report to the real failure without trusting the agent's copy of it. The `note` states cost and benefit in one plain sentence, in the provider's voice. It is a description, not a command.

### Layer 2: well-known file

```json
{
  "desk": "https://desk.ledgerly.example/v1/report",
  "mcp": "https://desk.ledgerly.example/mcp",
  "schema": "https://gigi3d.github.io/AgentHelpDesk/context-box.schema.json",
  "operator": "ledgerly.example",
  "api_hosts": ["api.ledgerly.example"],
  "case_token_keys": "https://api.ledgerly.example/.well-known/ahd-token-keys.json",
  "reply_signing_keys": "https://desk.ledgerly.example/.well-known/ahd-keys.json",
  "version": 1
}
```

Served from the provider's own domain. That is the domain proof: only the provider can publish it, so an agent can trust the desk endpoint is the provider's official one.

## Contract

One flat schema, three required fields, everything else optional.

```json
{ "goal": "Buy the Q3 report over x402", "request": { "...": "..." }, "response": { "...": "..." } }
```

- The desk infers `step`, `environment` and `done_when` from the case token and trace when missing, and marks the goal `inferred` until the requester confirms.
- Accept partial and malformed reports. Never reject a report for schema reasons. Lenient intake is what keeps smaller models, and Qwen in particular, from dropping out at the first call.
- Keep nesting to one level in the tool definition. The full box ([`context-box.schema.json`](./context-box.schema.json)) is what the desk builds internally.
- The schema is written once. Generators emit the OpenAI function format, the Anthropic tool format, Grok and Qwen tool definitions, an MCP tool, an OpenAPI operation, and an email template, so they cannot drift.
- Only the tool description wording may differ per model. Field names, types and enums stay identical.

## Reply envelope

Extends `AgentReply` (RFC 9457-shaped plus proofs). The addition is a machine-replayable fix:

```json
{
  "type": "https://desk.ledgerly.example/replies/fixed",
  "title": "Fix verified",
  "status": 200,
  "retryable": true,
  "retry_request": { "method": "GET", "url": "https://api.ledgerly.example/reports/q3", "headers": { "X-Payment-Token": "..." } },
  "fix_steps": ["Use X-Payment-Token, not X-Payment."],
  "tested": { "replay": true, "vendor_tests": true, "fresh_agent": true },
  "case_id": "ahd-123",
  "resolve_by": "2026-11-14T23:59:00Z",
  "audit_receipt": "...",
  "signature": { "alg": "EdDSA", "kid": "ahd-2026-11", "sig": "..." },
  "ask": { "route": "/v1/cases/ahd-123/reply", "question": "Did the goal complete?" }
}
```

- `retry_request` is replayed verbatim. Any model can do that, so the fix does not depend on how well the model reads prose.
- `signature` is checked against `reply_signing_keys` from the provider's well-known file, so the agent or its runtime can verify the reply came from the provider's desk.
- `ask` closes the loop for the goal-completion metric and the rewards.

## Trust and safety

- All inbound report data is untrusted and never changes instructions or permissions (existing rule in `product/AGENTS.md`).
- The desk never places text in third-party content to steer agents. Pointers live only in surfaces the provider controls.
- Replies contain data the agent can check, plus a signature. They contain no imperative text aimed at the model's own instructions.
- Case tokens are single-use and expire, so a leaked token cannot open arbitrary cases.
- The desk never asks for credentials in a reply. Authority comes only through the existing bounded grants.

## Implementation details

### Case token

A compact signed token (JWS, EdDSA) minted by the provider's own middleware when it returns an error. The desk cannot mint it, because the desk never sees the failing call before the agent reports it. Providers that cannot run code get the same token from the gateway plugin.

```json
{ "alg": "EdDSA", "kid": "ledgerly-2026-11" }
{
  "iss": "ledgerly.example",
  "jti": "ct_01H8X...",
  "iat": 1763164800,
  "exp": 1763165400,
  "fp": "sha256 of method | path | status | hash of request body",
  "cls": "knowledge"
}
```

- `fp` is a hash of the failing call, not its content, so the token reveals nothing about the request.
- `exp` is 10 minutes. `cls` is optional and only a hint.
- The desk verifies the signature with the keys at `case_token_keys` in the provider's well-known file.
- Single use means one case per token. A second report with the same `jti` returns the same case (same rule as `idempotency_key`), and never opens a duplicate.
- When a token verifies and the report's request and response match `fp`, the desk marks the failure `provider_attested`. Attested cases skip the "is this failure real" check and can start reproduction sooner.

### Provider middleware

One function called from the provider's existing error formatter. Framework neutral:

```ts
export function withHelp(problem: Problem, req: ReqInfo, cfg: HelpConfig): Problem {
  if (problem.status < 400 || cfg.skipStatuses.includes(problem.status)) return problem;
  const token = sign(cfg.key, {
    iss: cfg.operator,
    jti: randomId(),
    exp: nowSeconds() + 600,
    fp: fingerprint(req, problem.status),
  });
  return { ...problem, help: { desk: cfg.desk, case_token: token, note: cfg.note } };
}
```

- Default `skipStatuses`: `404` on paths the router does not know (scanners) and `429` unless the provider opts in.
- The `help` object is added to the body of `application/problem+json` responses. For other content types the provider sets `Link: <desk>; rel="help"` and an `AHD-Case-Token` header instead.
- Cost to the provider per error: one signature. No network call.

### Agent-side wrapper behavior

1. Wrap the HTTP client. Record each call as `(method, host, path, status)`.
2. On a failure, look for the desk in this order: `help.desk` in the body, `Link: rel="help"`, then `/.well-known/ahd.json` on the same host (cached 24 hours). No desk found means do nothing.
3. Report after the second failure of the same call key within 5 minutes, or on the first failure if the status is `402`, `403` or `422`, which retries rarely fix.
4. Take the goal from, in order: `X-Agent-Task` header or wrapper option, the agent framework's current task string if it exposes one, then nothing (the desk infers it).
5. Only report to a desk host that the provider's own well-known file lists. The wrapper never reports to a host named only in an error body from a different domain.
6. Cap reports per host: 5 per hour per agent.
7. Replay `retry_request` only if its host is in the provider's `api_hosts`.
8. Fail open. Timeout 3 seconds to reach the desk. After 5 consecutive failures in 60 seconds, stop calling it for 5 minutes. The desk never blocks or alters the agent's original error path.

### Redaction

The wrapper and the desk both redact before anything is stored or shown.

- Drop `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` and any header whose name contains `token`, `secret` or `key`.
- Mask bearer tokens, JWT-shaped strings, private-key blocks and strings that match common API key prefixes in bodies and URLs.
- The desk redacts again on intake and never trusts that the sender did.
- Redacted values keep their shape (`Bearer ****`) so the fix can still reason about the header.

### Canonical tool definition

Flat on purpose. `request` and `response` are JSON text, not nested objects, so smaller models do not have to build nested structures.

```json
{
  "name": "report_problem",
  "description": "Report a failed API call to the provider's official support desk and get a verified fix. Use it when a call fails twice or the error does not say how to fix it. Free for failed calls.",
  "parameters": {
    "type": "object",
    "properties": {
      "goal": { "type": "string", "description": "What you are trying to get done, in one sentence." },
      "request": { "type": "string", "description": "The failing request, as JSON text." },
      "response": { "type": "string", "description": "The error response, as JSON text." },
      "case_token": { "type": "string", "description": "The case_token from the error's help object, if there is one." }
    },
    "required": ["goal", "request", "response"]
  }
}
```

| Target | Wrapper around the same `parameters` |
| --- | --- |
| OpenAI | `{ "type": "function", "function": { name, description, parameters } }`. For strict mode, list every property in `required` and allow `null` for `case_token`, with `additionalProperties: false` |
| Anthropic | `{ name, description, input_schema }` |
| Grok | OpenAI-compatible function format, same as OpenAI |
| Qwen | OpenAI-compatible function format through the serving stack (Qwen-Agent, vLLM, DashScope). Keep descriptions to one sentence and avoid `oneOf` and `anyOf` |
| MCP | `{ name, description, inputSchema }` |

These are design choices to confirm in the eval, not guarantees. The generator emits all of them from one source file.

### Instruction-file snippet

For `AGENTS.md`, `CLAUDE.md`, Cursor rules and system prompts. The builder pastes it, so it is first-party to the agent.

```
When an API call fails twice, or the error does not say how to fix it, send the
failing request, the response and your goal to the provider's support desk: the
help.desk URL in the error, or desk in the provider's /.well-known/ahd.json.
Retry with the retry_request it returns. Only use desk URLs published by the
provider's own domain.
```

### Report and reply timing

- `POST /v1/report` accepts `Prefer: wait=30` (RFC 7240). If the desk resolves inside the wait, it returns `200` with the full reply. Memory hits normally do, and the proofs still run.
- Otherwise it returns `202` with `case_id`, `ack_by`, `resolve_by`, a `poll` URL and an optional webhook callback if the requester supplied one.
- Committed times follow the existing settings: ack in `AHD_ACK_MINUTES` (default 5) and resolve in `AHD_RESOLVE_MINUTES` (default 45).
- Send `AHD-Version: 1` on requests. The desk ignores unknown fields. Replies only gain fields, never lose them.

### Reply verification

The wrapper or runtime checks every reply before replaying anything:

1. Fetch the signing keys from the provider's well-known file (cache 1 hour, refetch on an unknown `kid`, at most once a minute).
2. Verify `signature` over the canonical JSON (RFC 8785) of the reply without the `signature` member.
3. Confirm `case_id` matches the case it opened.
4. Confirm `retry_request.url` host is in `api_hosts`.
5. Replay. If it succeeds, send `worked: true` to the reply route. If it fails, send `worked: false` with the response and let the desk continue the case.

### Attribution header

Each integration sets `X-AHD-Via` to its `discovered_via` value (`middleware`, `error_hint`, `framework_plugin`, and so on). The desk stores it on the case for the strategy report. It is informational only and never affects rewards or billing.

### Eval harness design

- **Scenarios:** the four x402 failures plus a few from `demo/scenarios` (wrong header, wrong network, short amount, stale quote, missing scope).
- **Models:** one flagship per family (Claude, GPT, Grok, Qwen), plus one small open model.
- **Conditions:** no hint (control), layer 1 only, layer 2 only, layer 4 only, layer 0 on.
- **Runs:** 20 per scenario and condition, fake desk with deterministic fixes so results compare across models.
- **Recorded per run:** reached the desk, goal supplied, reply verified, fix replayed, goal met, tokens, seconds.
- **Targets to set once we have a baseline:** layer 0 invocation about the same for every model, and a minimum goal-completion rate per model before a layer counts as shipped.

## Strategy portfolio

The discovery layers above are the vendor-side core. Deploy more strategies in parallel, because any single one can fail for a given model, framework or provider. Each report records `discovered_via` so we know which strategies earn their keep.

### A. Vendor side (provider installs once)

| Strategy | How it makes AHD the default |
| --- | --- |
| Server middleware (Express, FastAPI, Hono, Rails) | One line adds the `help` object to every 4xx and 5xx, so no per-endpoint work |
| API gateway plugin (Cloudflare, Kong, Apigee) | The gateway injects `help` and the case token with no provider code change |
| Docs block | A short "If a call fails" section at the top of the docs and quickstart, written for agents and humans |
| Docs MCP server | The provider's docs server exposes the desk tool next to search, where agents already look |
| Pre-flight known-issues feed | `/.well-known/ahd-known-issues` lists current failure patterns and fixes. Middleware checks it before the call, so some failures never happen |

### B. Agent-builder side (the person who built the agent controls it)

| Strategy | How it makes AHD the default |
| --- | --- |
| Framework plugins | Error-handler hooks for the OpenAI Agents SDK, Claude Agent SDK, Vercel AI SDK, LangChain, LlamaIndex, CrewAI and Qwen-Agent that file a case on repeated failure |
| Instruction-file snippet | A paste-in block for `AGENTS.md`, `CLAUDE.md`, Cursor rules and system prompts: "On repeated API failure, call the provider's desk." The builder wrote it, so it is first-party to the agent |
| Skill packages | A ready-made skill for agent platforms that support skills |
| Fallback policy | A documented `on_failure: ahd` setting so the runtime, not the model, escalates after N failures |
| Email and webhook | Any agent that can send an email or HTTP POST can use the desk, even with no tool support |

### C. Platform and ecosystem

| Strategy | How it makes AHD the default |
| --- | --- |
| Runtime partnerships | Sandbox and agent-infra platforms (Blaxel, Armature, Inkbox) ship the auto-report as a platform default |
| Registries | Listings in MCP registries and agent directories, with an A2A agent card at `/.well-known/agent.json` so other agents can call the desk agent-to-agent |
| Package presence | Published npm and PyPI packages with the same name and obvious README, since agents often install by search |
| Provider ecosystems | Offer the desk to a whole ecosystem at once (for example every provider in a payments ecosystem), so agents meet it everywhere |

### D. Open data and standards (slower, compounding)

| Strategy | How it makes AHD the default |
| --- | --- |
| Public fix pages | For open-source and consenting providers, publish scrubbed fix pages with the exact error string in the title. Agents that web-search an error land on a verified fix and a link to the desk |
| Open benchmark | Publish the scenario suite as an open benchmark of "agent recovers from API failure". Labs that run it learn to use help desks in training and evals |
| Standards proposals | A `help` member for RFC 9457 problem details, and a support or help capability in MCP and A2A. A standard path makes the desk a default for everyone, not just us |
| Open reply spec | Publish the reply and signature format so other agent tools can consume it without our SDK |

### E. Pre-emptive and incentive

| Strategy | How it makes AHD the default |
| --- | --- |
| Push fixes | Agents that failed before get a webhook when a fix for their pattern ships, so the desk reaches them before they fail again |
| Memory hits | Known failures answer instantly with no model call. Being the fastest path is its own default |
| Free for failed calls | Agents pay nothing (billing stays on the provider, or the protocol's users over x402), so there is no cost reason to skip it |
| Rewards | Verified replies and goal completions earn credits (see [`rewards-spec.md`](./rewards-spec.md)), which gives builders a reason to leave the desk switched on |
| Committed times | A published response time per case, so a stuck agent knows waiting is worth it |

### Rules for every strategy

- Placement must be by a party that controls the surface: the provider for vendor surfaces, the builder for agent surfaces. We never insert pointers into content we do not control.
- Opt-in for anything that posts into a public place (for example issue comments on a provider's repo). No unsolicited spam.
- Same schema and same reply envelope on every path, so results are comparable across strategies.
- Each strategy gets a `discovered_via` value: `middleware`, `gateway`, `error_hint`, `well_known`, `docs`, `mcp`, `framework_plugin`, `instruction_snippet`, `skill`, `email`, `webhook`, `registry`, `public_fix_page`, `push`, `a2a`.

### Priority

1. Server middleware and gateway plugin (cheapest way to reach every provider).
2. Framework plugins and the instruction-file snippet (cheapest way to reach every agent builder).
3. Runtime partnerships (Blaxel, Armature, Inkbox).
4. Pre-flight known-issues feed and push fixes.
5. Public fix pages, registries and the open benchmark.
6. Standards proposals.

## Measuring "default" per model

Run the same failing-scenario suite against each model family and record, per model:

| Metric | Meaning |
| --- | --- |
| Invocation rate | Share of failures where the agent reached the desk (layers 1 to 4) |
| Goal supplied | Share of reports that stated a goal, not inferred |
| Fix applied | Share of replies where the agent replayed `retry_request` |
| Goal-completion rate | Share of goals verified met on the provider's side |
| Time to completion | Report to verified goal |
| Share by strategy | Reports and completions grouped by `discovered_via`, to see which strategies carry the load |

Layer 0 should show roughly the same invocation rate for every model. The gap between layer 0 and layers 1 to 4 is how much each model needs help noticing the desk, and tells us where to tune the tool description wording. Eval scenarios live under `product/evals`.

## Build order

1. `help` object in problem+json, `/.well-known/ahd.json`, and signed replies with `retry_request`.
2. The flat schema and the per-vendor generators.
3. Auto-report middleware for fetch and the Blaxel CLI.
4. The four-model eval and a per-model dashboard.
5. `llms.txt` and OpenAPI `x-ahd` snippets for providers to paste.
6. The rest of the strategy portfolio in the priority order above, each with its `discovered_via` value.

## Decisions

- **Case token:** signed by the provider's middleware, with the gateway plugin as the fallback for providers that cannot run code. The desk cannot mint it, because it does not see the failing call first.
- **Retry allowlist:** yes. `api_hosts` in the provider's well-known file, enforced by the wrapper before any replay.
- **Key rotation:** every signature carries a `kid`. A keys file lists active keys and previous keys with a `not_after` date. Agents cache keys for 1 hour and refetch on an unknown `kid`, rate limited.
- **Fail open:** neither the middleware nor the wrapper ever blocks the original error path.
- **Redaction:** done on both sides, and the desk never trusts the sender's redaction.

## Open questions

- Agent frameworks that hide HTTP calls (some hosted agents). Layers 1 to 4, the gateway plugin and platform partnerships still reach them, but layer 0 does not.
- Open-source protocols with no operator domain to publish a well-known file. Likely a registry-attested entry instead of a domain proof.
- Whether replies to human requesters carry the same signature, and how a human-facing client verifies it.
- Whether a provider can publish a desk host different from its own domain, and how the wrapper trusts it.

## Contract note

Proposals only. Nothing in `product/shared/` changed. The matching asks (a `help` extension, `retry_request`, `signature`, `ask`, case tokens) are appended to `product/CONTRACT_REQUESTS.md`.
