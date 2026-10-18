# Live run: Ledgerly case, end to end

One real case: an agent follows Ledgerly's quickstart, gets a 401, and AgentHelpDesk reproduces it in
a Blaxel sandbox, has Claude fix the docs, proves the fix three ways, asks a human, then bills.

## What is real, and what only your keys can confirm

| Step | Real component | Checked on this machine | Needs your keys to confirm |
|---|---|---|---|
| Vendor | Ledgerly API + its test suite (`demo/sandbox-root/ahd/work`) | Yes, 7 tests | no |
| Reproduction | `node /ahd/replay.mjs` runs the documented call against Ledgerly, exit 1 on the bug | Yes | no |
| Sandbox | Blaxel | Rehearsal sandbox only | Yes: SDK method names, auth, fork, image |
| Resolver | Claude reads `server.mjs` + `quickstart.md`, returns the corrected file | Parsing, diff, reuse against a stand-in API | Yes: model reply quality |
| Vendor tests proof | `node --test` in the sandbox | Yes | Node present in the image |
| Fresh agent proof | Claude call from a forked sandbox, sees only task + docs | Against a stand-in API | Yes |
| Approval | `POST /v1/approvals/reply` (you act as the approver) | Yes | Inkbox only if `INKBOX_API_KEY` set |
| Billing | Stripe meter event | Not run | `STRIPE_SECRET_KEY` (test mode) + `stripe_customer_id` |

x402 payment verification is an offline stub regardless of keys. Do not describe that lane as live.

## Fastest path once the keys are in

```sh
cp demo/live.env.example demo/.env.live   # fill in what you have; the file is gitignored
demo/live.sh check                        # finds the keys, probes Anthropic/Blaxel/Stripe, says what is real
demo/live.sh server                       # terminal 1: desk with every keyed tool switched to real
demo/live.sh run                          # terminal 2: one Ledgerly case end to end
demo/live.sh mcp                          # terminal 3 (optional): MCP edge + public tunnel URL for Claude
```

The manual version of the same setup follows.

## Environment

```sh
export BLAXEL_API_KEY=...          # BL_API_KEY works too; also set BL_WORKSPACE=<workspace>
export AHD_SANDBOX_IMAGE=blaxel/base-image:latest   # must have node >= 18; try blaxel/nextjs:latest if not
export ANTHROPIC_API_KEY=...       # use a restricted throwaway key: it is written into the sandbox
export AHD_RESOLVER=claude
export AHD_PROVISION_DIR=$PWD/demo/sandbox-root
export AHD_FRESH_BASELINE=1
export AHD_REPRO_COMMAND='node /ahd/replay.mjs'
export AHD_REPRO_EXPECT=nonzero
export AHD_APPROVALS_FALLBACK_EMAIL=you@example.com
# risk_policy "autonomous" ships on three green proofs with no human; use "approve_first" to hold changes for one email reply.
export AHD_VENDOR_JSON='{"id":"ledgerly","name":"Ledgerly","risk_policy":"autonomous","report_contacts":["you@example.com"],"test_command":"cd /ahd/work && node --test test/*.test.mjs","stripe_customer_id":"cus_TEST","payer_mode":"vendor"}'
# optional, for real billing / approvals:
# export STRIPE_SECRET_KEY=sk_test_...
# export INKBOX_API_KEY=...
```

Do NOT set `AHD_SEED=demo`, `AHD_SANDBOX_FAKE`, `AHD_PROOFS_FAKE`, `AHD_BILLING_FAKE` or `AHD_APPROVALS_FAKE`.

## Run

```sh
node --experimental-strip-types product/server.ts          # terminal 1: banner must say REAL for sandbox
node demo/run-live.mjs                                      # terminal 2: add --yes to skip the Enter prompt
```

`run-live.mjs` refuses to start unless sandbox, reproduction, resolver, vendor tests and fresh agent are
real. The server prints the same table at boot and serves it at `GET /v1/runtime`; show it on screen.

## Rehearse first (no keys)

```sh
node --experimental-strip-types demo/rehearse.ts
```

## Likely first-run failures (Blaxel details the docs did not settle)

- `sandbox.create`: wrong image name or a missing workspace variable. Set `BL_WORKSPACE`.
- `sandbox.fork.ready`: fork returned before the copy was usable. Raise `AHD_FORK_READY_MS`.
- `destroy`: no confirmed delete call; delete `ahd-*` sandboxes in the Blaxel console afterwards.
- `node: not found` in a proof: pick an image with Node.
- The resolver escalates `unsupported_kind` if the 401 is classified as code. The runner sends
  `klass: "knowledge"`; the built-in classifier reads "Invalid" in a 401 body as a validation error.

## After recording

Delete the `ahd-*` sandboxes and revoke the Anthropic key you used.
