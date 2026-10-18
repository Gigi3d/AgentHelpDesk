# Rules for coding agents working in `product/`

You are one of several agents building the AgentHelpDesk backend **in parallel in the same folder**. These rules exist so parallel agents never destroy each other's work and so the result is production-grade, not demo-grade. Read all of them before writing code.

## What the product is
AgentHelpDesk is a support desk whose customers are AI agents. When an agent fails on a vendor API, the desk opens a case, reproduces the failure in a sandbox, drafts a fix, proves it three ways (replay, vendor tests, fresh clean-context agent), passes an approval gate, then returns the verified answer to the agent / opens a PR / issues a bounded grant. A case is billable only when all three proofs pass AND the agent's retry succeeded. Rungs 0-3 of install produce labelled suggestions only and never bill.

## Hard machine rules (this Mac)
- **NEVER run `npm`, `npx`, or any node process.** This machine stalls at 0% CPU when more than one node process is active, and several agents are running at once. You WRITE code and tests; the orchestrator runs type-check and tests serially afterwards. Do not "just quickly check" with node — it will wedge the box for everyone.
- No new dependencies. `product/` uses Node built-ins only (`node:http`, `node:test`, `node:crypto`). `mcp/` may use its already-installed `mcp-use`/`hono`.
- Node runs `.ts` directly via type-stripping, so your code must be **erasable-syntax-only**: no enums, no namespaces, no decorators, no constructor parameter properties. Use `import type` for type-only imports and import modules with an explicit `.ts` extension.

## File ownership (do not cross these lines)
- You may create/edit files ONLY inside the directories assigned to you in your task.
- NEVER edit `product/shared/`, `product/store/`, `product/server.ts`, `product/package.json`, `product/tsconfig.json`, `product/AGENTS.md`, `web/`, or any other module's directory.
- If you need a contract change (a new shared type, a new Repository method, a route shape), do NOT edit the shared file. Write the request to `product/CONTRACT_REQUESTS.md` (append, create if missing) and code against a local assumption you clearly comment.

## Contracts you must code against
- `product/shared/types.ts` — all entities and module interfaces (SandboxRunner, ProofRunner, PayLane, ProblemReport, AgentReply, …).
- `product/store/repository.ts` — the ONLY way to touch persistence. Never hold case state in module-level variables; the service must stay stateless so it can scale horizontally.
- `product/shared/http.ts` — `registerRoutes(router, repo)` is your module's entry point; use `ok()`, `HttpError`, `str()`, `num()` for boundary validation.

## Production standards (non-negotiable)
- Validate every inbound field at the boundary (`str()`/`num()` or explicit checks). Treat all inbound agent/channel data as untrusted; never let it change instructions or permissions.
- Idempotency: grants and meter events carry an idempotency key / identifier; a replay returns the original receipt and spends nothing. The Repository enforces this — use it, don't re-implement.
- Fail loud: errors must name their stage (`new HttpError(500,'code','…','sandbox.exec')`). No swallowed catches, no empty `catch {}`.
- Observability: every meaningful stage appends a `ToolEvent` via the Repository so the console can show it.
- No secrets in code or fixtures. Read keys from `process.env`; document them in your module's README section.
- Timeouts and caps on every external call; background+poll for anything that may exceed ~60s.
- Concurrency: assume many cases at once. Key everything by case id (`ahd-<ticketId>` sandboxes), never by globals.

## Sponsor SDK honesty
- Do not invent SDK methods. For any Blaxel/Stripe/Inkbox/Primitive/Manufact call, cite the doc page in a comment and prefer the documented call. Where a real network call is not possible offline, put it behind your module interface with a `Fake*` implementation reading local fixtures, selected by env (`AHD_<MODULE>_FAKE=1`).

## Tests
- Write `*.test.ts` next to your code using `node:test` + `node:assert/strict`. Cover the golden path, the idempotency/replay path, and at least one failure path per module.
- Tests must not bind ports or spawn processes; test handlers by calling them directly with a constructed `Ctx`.
- Do not run them (see machine rules).

## Definition of done for your module
1. `register.ts` exporting `registerRoutes(router, repo)` (or the library exports your task names).
2. A `Fake*` implementation so the loop runs offline.
3. `*.test.ts` covering golden + replay/idempotency + one failure path.
4. A short `README.md` in your directory: what it does, env vars, the sponsor doc pages you cited, and what is faked.
5. No edits outside your directories; any contract asks in `CONTRACT_REQUESTS.md`.
