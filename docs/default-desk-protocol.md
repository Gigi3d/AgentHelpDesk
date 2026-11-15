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
  "reply_signing_keys": "https://desk.ledgerly.example/.well-known/ahd-keys.json"
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

## Measuring "default" per model

Run the same failing-scenario suite against each model family and record, per model:

| Metric | Meaning |
| --- | --- |
| Invocation rate | Share of failures where the agent reached the desk (layers 1 to 4) |
| Goal supplied | Share of reports that stated a goal, not inferred |
| Fix applied | Share of replies where the agent replayed `retry_request` |
| Goal-completion rate | Share of goals verified met on the provider's side |
| Time to completion | Report to verified goal |

Layer 0 should show roughly the same invocation rate for every model. The gap between layer 0 and layers 1 to 4 is how much each model needs help noticing the desk, and tells us where to tune the tool description wording. Eval scenarios live under `product/evals`.

## Build order

1. `help` object in problem+json, `/.well-known/ahd.json`, and signed replies with `retry_request`.
2. The flat schema and the per-vendor generators.
3. Auto-report middleware for fetch and the Blaxel CLI.
4. The four-model eval and a per-model dashboard.
5. `llms.txt` and OpenAPI `x-ahd` snippets for providers to paste.

## Open questions

- Case token format: signed by the provider, or issued by the desk when the provider calls it in on error?
- Where the middleware runs when the agent framework hides HTTP calls (some hosted agents).
- Whether `retry_request` needs a per-provider allowlist of hosts so an agent never replays to an unexpected domain.
- Key rotation for reply signing and how agents cache keys.

## Contract note

Proposals only. Nothing in `product/shared/` changed. The matching asks (a `help` extension, `retry_request`, `signature`, `ask`, case tokens) are appended to `product/CONTRACT_REQUESTS.md`.
