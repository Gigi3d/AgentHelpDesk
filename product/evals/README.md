# `product/evals/` — Armature-sponsored evals: does a fresh agent install the desk from the docs alone?

This module produces the two pieces of objective evidence AgentHelpDesk claims:

1. **Install eval** — a fresh, clean-context agent is given *only* the help page and the
   error body, and we record the steps it takes (read docs → find the desk → install →
   open a first ticket) and whether it got there without a human.
2. **Pick rate** — the pass share of the recorded install evals. This is the number the
   install page shows next to the Armature card ("A fresh agent installs it from the docs
   alone").

Sponsor facts relied on (nothing else is assumed): Armature provides MCP analytics, evals
and agent.reviews, and measures whether coding agents pick a product
(`AgentHelpDesk Research Dossier.md`, competitor table, https://armature.tech); its job in
our loop is the fresh-agent install eval on the install page
(`AgentHelpDesk Frontend and Product Surface Plan.md`, sponsor visuals table); it is a
partner, not a dependency (`AgentHelpDesk Build Plan.md`, sponsor table).

## Persistence: ToolEvents, not a new table

The Repository has no eval table, so this module is stateless like every other one:

| What | ToolEvent |
| --- | --- |
| One install eval run | `tool: 'Armature'`, `action: 'eval.install'`, `stage: 'evals.install'`, `result: 'pass' \| 'fail'`, `d_ms` = measured run time, `payload` = `{ run_id, pass, step_count, steps[], time_ms, rung, simulated, mode, leak, idempotency_key, docs_read, armature, disclaimer }` |
| One pick-rate computation | `tool: 'Armature'`, `action: 'eval.pick'`, `stage: 'evals.pick'`, `result: 'pick_rate=50%'`, `payload` = `{ runs, passed, failed, invalidated_by_leak, pick_rate, pick_rate_pct, median_time_ms, step_pass, rungs, simulated_runs, armature_submitted_runs, skipped_malformed, source }` |

Everything is read back with `repo.toolEvents({ tool: 'Armature' })`, so the console can
render evals from the same table as every other stage. Eval runs are not cases; they share
the synthetic ticket id `ahd-eval` (`EVAL_TICKET`) so they group into one timeline.

## Routes

| Route | Body / query | Returns |
| --- | --- | --- |
| `POST /v1/evals/install` | `{ ticket_id?, run_id?, idempotency_key?, product?, rung?, docs?, error_body?, forbidden? }` — all optional, all validated | `200 { run, pick, simulated, disclaimer, request_id }` |
| `GET /v1/evals/results` | `?ticket_id=&limit=1..200&product=&record=0` | `200 { generated_at, count, returned, skipped_malformed, runs[], pick, armature_pick, simulated, disclaimer }` |

**A failing eval is a `200` with `run.pass === false`, never a `5xx` and never a throw.**
Only invalid input (`400`, stage `evals.validate`) or a store failure is an error. Re-POSTing
the same `idempotency_key` returns the stored run (`replayed: true`) and appends nothing;
re-reading an unchanged pick rate returns the existing `eval.pick` event instead of writing
a duplicate row.

`rung` is the install-ladder rung the agent is attempting. Rungs 0–3 must be reachable with
no repo access; rung 4 additionally requires a document that states the repo install path
(`npx agenthelpdesk init` / one install PR). A bundle that passes at rung 1 can therefore
fail at rung 4, and that difference is the point.

## Env vars

| Var | Default | Effect |
| --- | --- | --- |
| `AHD_EVALS_FAKE` | unset | `1` forces `FakeArmature`: no network, and every receipt is labelled `faked: true`, `submitted: false`. |
| `ARMATURE_KEY` | unset | Bearer token for the real client. **Missing or blank ⇒ Fake**, so the desk never calls a sponsor unauthenticated. Read from `process.env` only; never written to an event, a receipt or an error message. |
| `ARMATURE_BASE_URL` | `https://api.armature.tech` | Base URL for the real client. |
| `ARMATURE_TIMEOUT_MS` | `8000` | Per-call cap, clamped to `30000`. Every Armature call carries `AbortSignal.timeout`. |

## What is faked, and what is real

**Faked / simulated (labelled on every result and every stored row):**

- **The fresh agent itself.** `product/` is Node-built-ins-only, so there is no model
  runtime, and Armature publishes no eval-execution API we can cite. The "agent" is a
  deterministic policy (`STEP_RUNNERS` in `install-eval.ts`) that may use **only** the
  documents it is handed. `simulated: true` and `DISCLAIMER` travel with every result.
- **The Armature submission.** `FakeArmature.submitEvalRun` performs no I/O and reports
  `submitted: false`. `HttpArmature` is opt-in, and its two paths
  (`POST {base}/v1/evals/runs`, `GET {base}/v1/products/{product}/pick-rate`) are
  **UNCONFIRMED PLACEHOLDERS** shaped from the sponsor facts above — no Armature SDK method
  was invented, and the paths must be replaced with the documented ones once Armature
  shares an API reference at the event. All Armature access is isolated in
  `armature-client.ts`.
- **The doc bundle** (`fixtures.ts`) is a hand-mirror of surfaces other modules own:
  `web/src/data/help_page.json`, `web/src/pages/Install.tsx` (rung 1 `llms.txt`, the
  `withHelp()` error body, the rung 4 install files), and the Frontend plan sections
  "The error body gets a help field" / "The agent help page". **Drift risk:** if those
  change, this copy must change too.

**Real (computed, never invented):**

- `pass`, `steps`, `step_count`, `time_ms` come from an actual run of the policy over the
  actual documents.
- `pick_rate`, `pick_rate_pct`, `passed`, `failed`, `median_time_ms`, `step_pass` and
  `rungs` are computed from stored `eval.install` rows. With no rows, `pick_rate` is
  `null` — the console shows "Not run yet" rather than a plausible-looking number.
- `armature_submitted_runs` is `0` offline, so a dashboard can tell a real submission from
  a local run.
- Rows whose payload fails to parse are counted in `skipped_malformed` and surfaced in the
  `GET` response, never silently dropped.

### The honesty note (please do not soften this)

A simulated fresh-agent eval is **evidence about our docs, not proof about real agents**.
A pass means: every affordance an agent needs to install the desk and open a first ticket is
present and reachable in the documents we hand it — a pointer at the docs root, a `help`
field in the error body, a reachable help page with committed ack/resolve times, a callable
channel, and a `request_id` to reference. It does **not** mean a real coding agent chose the
desk unprompted; only a real model run (or a real Armature eval) can show that. Anything the
console or a slide quotes from this module must carry `simulated: true` with it.

### Leak guard

The Build Plan warns that agents "make the fresh-agent proof pass by leaking the fix into
the prompt", and the Architecture section requires the fresh-agent check to get "only the
original task and the changed docs and responses, never the resolver's reasoning". So every
document and the error body are screened before the run for resolver knowledge
(`resolver_reasoning`, `resolver_transcript`, `attempt_diff`, `draft_fix`, `fix_steps`,
`proof_replay`, `proof_vendor_tests`, plus any caller-supplied `forbidden` strings). A hit
invalidates the run: `pass: false`, `leak.detected: true`, every step marked failed, and the
reason stored on the row.

## Files

| File | Job |
| --- | --- |
| `armature-client.ts` | The only file that touches the sponsor: `ArmatureClient` (`submitEvalRun`, `readPickRate`), `HttpArmature`, `FakeArmature`, `armatureClient(env)` selection. |
| `fixtures.ts` | The doc bundle + error body the simulated agent may read, with provenance comments. |
| `install-eval.ts` | `runInstallEval(repo, opts)`, the step policy, the leak guard, and `readInstallRuns(repo)` (the only read path). |
| `pick-rate.ts` | `pickRate(repo, opts)` — computes the pass share from stored runs and records `eval.pick`. |
| `register.ts` | `registerRoutes(router, repo)` plus `installHandler` / `resultsHandler` for direct testing. |
| `evals.test.ts` | `node:test` + `node:assert/strict`; handlers are called directly with a `Ctx` and a `MemoryRepository`. No ports, no processes, no network. |

## Tests

Golden path (passes and is stored), replay/idempotency (same key ⇒ stored run, no second
row), failure paths (docs with nothing for agents ⇒ `pass:false` stored, not thrown; leak
guard; rung-4 gating), input validation (`HttpError` 400 with stage `evals.validate`),
exact pick-rate arithmetic from two seeded events (`0.5`, asserted exactly), unchanged-input
dedupe of `eval.pick`, `null` rate with no runs, malformed-row counting, and both HTTP
handlers.

Run them from `product/` with the repo script (`npm test`) — not by hand on this machine
(see `product/AGENTS.md`: never start a node process here; the orchestrator runs them).
