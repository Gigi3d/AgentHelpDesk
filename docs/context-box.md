# Context box

An agent does not arrive with a question. It arrives with a goal that broke on one step. The unit of support is **goal + step + failure**, so the desk solves the goal, not just the error. A ticket closes when the goal is met, not when a reply is sent.

The schema is in [`context-box.schema.json`](./context-box.schema.json). It extends `ProblemReport`: `task` stays the one-line goal, `context` carries the rest.

## Fields

| Field | What it holds | Who fills it |
| --- | --- | --- |
| `goal` | The outcome wanted, one sentence | Agent states it; desk infers it from the trace if missing, then asks to confirm |
| `step` | Where in the plan it failed | Agent or trace |
| `attempted` | Tool, request, params | Agent or client-side trace |
| `result` | Status and raw response | Agent or trace |
| `environment` | API or MCP version, framework, model, auth state | Auto-collected |
| `already_tried` | Earlier attempts | Agent or trace |
| `constraints` | What it must not do, budget, deadline | Agent or vendor policy |
| `done_when` | How success is checked | Agent proposes, vendor can override |

`goal_source` records whether the goal was `stated`, `inferred` or `confirmed`. A goal-completion reward is only paid on `stated` or `confirmed` goals.

## Agent example

```json
{
  "agent_id": "alpha",
  "task": "Buy the Q3 report from Ledgerly over x402",
  "channel": "mcp",
  "requester_kind": "agent",
  "context": {
    "goal": "Buy the Q3 report from Ledgerly over x402",
    "goal_source": "stated",
    "step": "second request after paying the 402",
    "attempted": { "tool": "http", "request": { "method": "GET", "url": "https://api.ledgerly.example/reports/q3", "headers": { "X-Payment": "..." } } },
    "result": { "status": 402, "response": { "error": "payment_required" } },
    "environment": { "framework": "custom", "auth_state": "valid" },
    "already_tried": ["paid per the quickstart header"],
    "constraints": { "budget_usd": 5 },
    "done_when": { "check": "http_status", "expect": 200, "target": "https://api.ledgerly.example/reports/q3" }
  }
}
```

## Human intake

Humans cannot fill structured fields, so the desk asks three plain questions and extracts the same box. Anything the client already knows (session trace, Armature intent data, URL, browser) fills the rest so nobody repeats themselves.

| Ask | Maps to |
| --- | --- |
| "What were you trying to do?" | `goal`, `step` |
| "What happened instead?" | `result` |
| "What did you expect to see when it worked?" | `done_when` |

Optional follow-ups, only if the trace is thin: "Did you already try anything?" (`already_tried`) and "Anything we must not change?" (`constraints.must_not`).

For humans, `done_when.check` defaults to `human_confirm` unless the vendor side can verify it (a receipt, an order record, a webhook).

## Reply loop

Every answer to the requester ends with the same question: did it work? The reply carries `worked: true|false` and optional proof (receipt id, response body). The desk still runs `done_when` against the vendor side before it counts the goal as met.

```json
{ "case_id": "ahd-123", "worked": true, "proof": { "receipt": "rcpt_..." } }
```

## Contract note

This doc and the schema are proposals. They do not edit `product/shared/types.ts`. The matching contract request is appended to `product/CONTRACT_REQUESTS.md`.
