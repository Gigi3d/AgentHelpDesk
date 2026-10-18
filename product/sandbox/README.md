# sandbox/ — Blaxel sandbox layer

One Blaxel sandbox per open case, named `ahd-<ticketId>` (Build Plan → Architecture →
Sandbox): created once, resumed thereafter (standby resume restores filesystem **and**
processes in ~ms), snapshotted, and forked for the fresh-agent proof. All network lives
in `client.ts`; everything else is selection, observation and the offline fake.

## Files
- `client.ts` — thin Blaxel client: `createIfNotExists` / `get` / `exec` / `write` /
  `snapshot` / `fork` / `destroy`, plus the 60s-cap handling (`runCapped`, `poll`,
  `backgroundWrapper`). The SDK (`@blaxel/core`) is loaded lazily through a non-literal
  dynamic import because `product/` has zero runtime dependencies; it is used through
  minimal structural types and every unconfirmed call is an optional probe that fails
  loud with a stage name.
- `runner.ts` — exports exactly `blaxelRunner`, `fakeRunner`, `getRunner()`.
  `getRunner()` returns `fakeRunner` when `AHD_SANDBOX_FAKE === '1'` or `BLAXEL_API_KEY`
  is unset, else `blaxelRunner`. `getRunner(repo)` (optional `Repository` parameter)
  additionally appends a `ToolEvent` for every create/resume, fork and destroy.
- `fake.ts` — `FakeRunner`: in-memory filesystem + process model. `exec` recognizes
  `git clone` (seeds from `fixtures/`), test-shaped commands (exit 1 while the seeded
  `BROKEN` flag is set, 0 after a seeded file is overwritten — "the fix"), `echo`,
  `cat`, `rm -rf`, `sleep`; anything else exits 127 loudly. Background exec follows the
  pid-token/exit-file convention and finishes after `background_ticks` polls.
- `fixtures/` — optional offline fixtures: `config.json` (`background_ticks`) and
  `ledgerly/` (seeded demo vendor with failure #1: quickstart shows `x-api-key` instead
  of `Authorization: Bearer`, plus a `BROKEN` marker). No secrets in fixtures.
- `runner.test.ts` — node:test coverage (selection, resume, clone+fix, background+poll,
  budget overrun, fork isolation, destroy, ToolEvents).

## Env vars
| Var | Meaning |
| --- | --- |
| `BLAXEL_API_KEY` | Blaxel credentials. Unset → `getRunner()` returns the fake. Never logged. |
| `AHD_SANDBOX_FAKE` | `'1'` forces `fakeRunner` even when a key exists. |
| `AHD_SANDBOX_IMAGE` | REQUIRED in real mode: image name for `createIfNotExists`. We refuse to guess one. |
| `AHD_SANDBOX_MEMORY_MB` | optional, default `2048`. |
| `BLAXEL_REGION` | optional region passed to `createIfNotExists`. |

## Doc pages cited (in code comments)
- docs.blaxel.ai — **Sandboxes**: `SandboxInstance.createIfNotExists({ name, image, ... })`,
  `SandboxInstance.get` (resume), `sandbox.process.exec`, `sandbox.fs.write`; one command
  may wait at most **60 seconds** → longer runs start backgrounded and are polled;
  standby resume in ~ms; snapshots can be forked.
- `AgentHelpDesk Build Plan.md` → "Check before promising" (Blaxel bullet): no documented
  git-clone call → clone runs through `process.exec`; 60s cap → background+poll.

## 60s-cap convention (shared by real + fake handles)
`handle.exec(cmd, { background: true })` returns immediately with a **pid token** in
`stdout`; the run's files live at `/tmp/ahd-bg-<pid>.{out,err,exit}`; `client.poll(handle,
pid)` reads the exit-code file through the plain contract (`exec` + `cat`) and returns
`null` while running. `client.runCapped` picks direct-wait (≤60s) or background+poll
(>60s) and throws `sandbox.exec: ... sandbox.exec.timeout` if the budget is exhausted.

## What is faked
`FakeRunner` executes nothing real: no node, no git, no network, no filesystem. It models
files, a seeded broken flag, a handful of commands, background-run polling and
snapshot/fork deep-copy isolation — enough to run the whole loop and its tests offline.

## OPEN / unconfirmed (flagged, do not promise)
1. **Concurrent-sandbox quota** per Blaxel account/tier is not in the public docs — it
   decides the real fleet size. Ask Blaxel/Baseten before building fleet logic on it.
2. **Standby storage cost** for parked snapshots (~$0.20/GB·month per our research notes)
   is unconfirmed at our sandbox count; use archived mode for cold cases.
3. **snapshot / fork / destroy SDK call shapes** are not in the confirmed doc facts —
   `client.ts` probes for them and fails loud; confirm against docs.blaxel.ai (Sandboxes →
   snapshots/lifecycle) before the demo.
4. **`AHD_SANDBOX_IMAGE` default**: none; the image catalog is account-specific.
5. The background wrapper assumes `process.exec` evaluates command strings via a POSIX
   shell — confirm at integration.
6. Egress: confirm the sandbox can reach GitHub for `git clone` (Build Plan bullet).
