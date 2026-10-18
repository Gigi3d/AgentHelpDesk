# Go live: the report_problem MCP in Claude

Checked on this machine (2026-10-17): `npm run build` and `npm run typecheck` pass, 35 offline tests pass,
and a real MCP client flow works against the real backend: `tools/list`, `report_problem` (committed
`ack_by`/`resolve_by`), polling, approval, an `answered` reply with `tested {replay, vendor_tests,
fresh_agent}` all true, then `report_retry_result` returning `billable: true` with a receipt.
That run used the rehearsal sandbox and a stub model API. Blaxel and Claude are the parts only your keys confirm.

## Path A (recommended for the hackathon): local backend + tunnel

Everything runs on your machine, so the edge reaches the backend on `127.0.0.1:8787` and nothing else
needs hosting. Claude reaches the edge through a public tunnel URL.

```sh
# terminal 1: the desk (set the live env from demo/RUNBOOK.md first)
node --experimental-strip-types product/server.ts
# terminal 2: the MCP edge with a public URL
cd mcp && npm install --legacy-peer-deps && npx mcp-use dev --tunnel      # prints https://....../mcp
```

Add it in Claude: Settings, Connectors, Add custom connector, paste the tunnel URL ending in `/mcp`.
Then ask Claude to "report this Ledgerly failure with request id ..." and watch the case move in the console.

## Path B: deploy the edge on Manufact

```sh
cd mcp && npm run build && npm run deploy      # needs your Manufact login
```

The deployed edge cannot see `127.0.0.1`. Host `product/` somewhere with a public or private URL
(a small VM, Fly, Railway; start it with `HOST=0.0.0.0 PORT=8787`) and set `AHD_DESK_URL` in the
Manufact deployment to it. Never set `AHD_DESK_FAKE=1` on a deployment meant to be real.

## Before you share the URL

- **No auth.** The edge and the backend authenticate nothing. Anyone with the URL can open cases, and
  each case spends Blaxel and Anthropic usage. Share the URL only for the demo window, use a spend-limited
  Anthropic key, and take the tunnel down after judging.
- **Backend state is in memory.** Restarting `product/server.ts` loses every case. Do not restart mid-demo.
- **Name.** The server presents itself as "Ledgerly Agent Help Desk" with a Ledgerly-specific tool
  description. Rename `title`/`description` in `mcp/index.ts` if the listing should read "AgentHelpDesk".
- **Directory listing.** A custom connector works immediately for you and anyone you give the URL.
  A listing in Anthropic's public connector directory goes through their review and will not land
  before the hackathon ends; say "available as a custom connector" until it does.
- **Approval gate.** Ledgerly is `approve_first`, so a case parks until someone replies. Without
  `INKBOX_API_KEY`, approve with `POST /v1/approvals/reply`, or via the console.

## Known gaps

- A case parked for approval shows the agent `status: working`, not `needs_user_input`.
- The built-in classifier reads "Invalid" in a 401 body as a code bug. The MCP path is not affected (the edge sends
  no response body, so the case classifies as docs, and the run above resolved it), but a direct `POST /v1/cases`
  with the 401 text needs `klass: "knowledge"`.
