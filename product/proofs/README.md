# proofs/ — the three proofs

A drafted fix ships only after all three proofs pass, run IN ORDER (Build Plan →
Architecture; AGENTS.md "What the product is"). A failed proof returns
`{ pass: false, detail }` naming what failed — it **never throws to hide a failure**.
Only infrastructure errors (sandbox unreachable, invalid input) throw, with a stage name
(`proofs.replay`, `proofs.vendorTests`, `proofs.freshAgent`, `sandbox.exec`, ...).

## Files
- `proofs.ts` — exports exactly `proofRunner`, `fakeProofRunner`, `getProofRunner()`.
  `getProofRunner()` returns `fakeProofRunner` when `AHD_PROOFS_FAKE === '1'`, else
  `proofRunner`. `getProofRunner(repo)` (optional `Repository` parameter) appends one
  `ToolEvent` per proof (`tool: 'proofs'`, `result: 'pass' | 'fail' | 'error'`).
- `proofs.test.ts` — node:test coverage: golden path (all three pass), replay-fails →
  `pass:false` without throwing, >60s exec uses background+poll, fork isolation (the
  fresh agent cannot see post-snapshot resolver state), fresh-agent failure paths,
  ToolEvent observability, runner selection.

## The three proofs
1. **replay** — re-runs the failing call from `Failure.request` against the sandbox;
   pass iff it now succeeds (exit 0). The request JSON is written to
   `/ahd/cases/<id>/request.json` and replayed via `request.replay_cmd` when present,
   else via the harness `node /ahd/replay.mjs <request.json>` (OPEN — see
   `product/CONTRACT_REQUESTS.md`). Budget 30s (within Blaxel's 60s wait cap → direct).
2. **vendorTests** — runs the vendor's test command: sandbox file `/ahd/test-command`
   if present, else `npm test`. Budget 300s > the 60s cap, so it starts **backgrounded
   and is polled** via `sandbox/client.ts runCapped` (docs.blaxel.ai — Sandboxes →
   processes: one command may wait at most 60 seconds). Pass iff exit 0.
3. **freshAgent** — runs in a sandbox **forked from the snapshot** (the caller forks via
   `runner.fork` and passes the forked handle). It is given ONLY the original task
   (`/ahd/fresh/task.md`) and the changed docs (`/ahd/fresh/changed.json`), never the
   resolver's reasoning; known resolver-state paths (`/ahd/resolver`, `/tmp/ahd-resolver`)
   are scrubbed first. Harness: `node /ahd/fresh-agent.mjs <task> <changed>`. Pass iff
   exit 0. A changed doc that cannot be read fails the proof with its path in `detail`.

## Env vars
| Var | Meaning |
| --- | --- |
| `AHD_PROOFS_FAKE` | `'1'` → `getProofRunner()` returns `fakeProofRunner` (fast polling, same logic; vendor-test budget stays >60s so background+poll is exercised offline). |
| `AHD_PROOF_REPLAY_BUDGET_MS` | override replay budget (default 30000). |
| `AHD_PROOF_TEST_BUDGET_MS` | override vendor-test budget (default 300000; keep >60000). |
| `AHD_PROOF_FRESH_BUDGET_MS` | override fresh-agent budget (default 300000). |
| `AHD_PROOF_POLL_MS` | override poll interval (default 2000). |

Sandbox selection (`BLAXEL_API_KEY`, `AHD_SANDBOX_FAKE`) lives in `sandbox/README.md`.

## Doc pages cited
- docs.blaxel.ai — Sandboxes → processes: the 60-second wait cap that forces
  background+poll for the vendor test run (via `sandbox/client.ts`).
- `AgentHelpDesk Build Plan.md` → Architecture ("Sandbox", "Fresh-agent check") and
  "Check before promising" (Blaxel bullet).

## What is faked
`fakeProofRunner` is the same proof logic with offline-friendly budgets; it is the
`sandbox/fake.ts` FakeRunner that fakes execution (seeded `BROKEN` flag decides pass/fail
of test-shaped commands; background runs finish after N polls). No real agent, model call,
git or network happens offline. In real mode the harness scripts `/ahd/replay.mjs` and
`/ahd/fresh-agent.mjs` must be provisioned into the sandbox by the desk/resolver layer.

## OPEN / unconfirmed
1. Replay command convention (`request.replay_cmd` vs `/ahd/replay.mjs` harness) — see
   `product/CONTRACT_REQUESTS.md`.
2. Vendor test command discovery (`/ahd/test-command` file) — no `Vendor` field carries it.
3. `freshAgent(changed: string[])` semantics assumed to be sandbox-relative file paths.
4. The real fresh-agent harness (a clean-context coding-agent run) is desk-side work;
   this module only guarantees the isolation contract: forked sandbox + task/docs only.
