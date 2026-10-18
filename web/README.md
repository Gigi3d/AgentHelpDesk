# AgentHelpDesk web

The front end from the Frontend and Product Surface Plan: the provider console, the agent-facing surfaces, the install flow, approval by phone, and the staff dashboard. One React app, two data modes.

```bash
npm install
npm run dev         # fixture mode, http://localhost:5180
npm run typecheck
npm run build       # type-check, then a production build
```

## Two modes

**Fixture mode** is the default. Everything on screen comes from the recorded JSON in `src/data/`, so the demo is identical every time and needs no server running. The clock is pinned to Sat Oct 17, 8:20 p.m. Pacific, which is why the fixture times read naturally.

**Live mode** reads the real desk:

```bash
cd ../product && AHD_SEED=demo node --experimental-strip-types server.ts   # port 8787
VITE_LIVE=1 npm run dev
```

The store polls `http://127.0.0.1:8787` every 4 seconds (override with `VITE_API_URL`). There is no push channel. Until the first poll answers, the console stays empty rather than showing fixtures under a LIVE badge. Two rules keep the badge honest:

- Live mode uses the real clock, because live cases carry real timestamps.
- Any surface the API cannot feed labels itself. `/app/agents` says so outright, because there is no agent directory route, and `/staff` tags the numbers it cannot measure as sample.

Replay is fixture-only. Pressing it in live mode explains that instead of faking events over live cases.

## Routes

| Route | Surface |
| --- | --- |
| `/` | Marketing landing |
| `/install` | The install ladder: rungs 0 to 4, consent, detection, install PR diff, test ticket |
| `/app` | Home: approval banner, four tiles, ticket feed |
| `/app/tickets` | Ticket list: saved views, filters, J/K, bulk approve low-risk, CSV export |
| `/app/tickets/:id` | Ticket page: commitments, timeline with tool chips, proofs, grants and audit, decision |
| `/app/agents`, `/app/endpoints`, `/app/reports`, `/app/billing`, `/app/settings` | The rest of the console (Settings has Authority envelope and Stack sections) |
| `/agents` | What agents see: help page (Markdown and JSON twin), error body, `report_problem` schema, try-it |
| `/approve/:id` | The approval text on a phone, plus the signed one-ticket link |
| `/staff` | Staff ops: human queue, fix ledger, quality and cost, install funnel, pilots |

## The fixture demo

Open `/app/tickets/ahd_01JBH4RK7Q` (pinned in the sidebar) and press **Replay from the failure**. The case opens with committed deadlines, and the timeline fills in from `tool_events.json`. The flow stops at the approval gate. **Approve** (or YES on `/approve/ahd_01JBH4RK7Q`) issues the grant: `entitlements.reissue` under its envelope. The agent retries, the order completes, the PR merges, and a Stripe test meter event is billed.

## Data (`src/data/`)

- `tickets.json`: eight recorded cases, including Ledgerly seeded failures 1 through 4
- `tool_events.json`: every chip, counter and audit row reads from here (`after_gate` events play after approval)
- `agenthelpdesk.json`: the provider config the install PR adds
- `report_problem.tool.json`, `help_page.json`: the agent-facing contract
- `agents.json`, `daily_report.json`, `billing.json`, `staff.json`: console data; anything not measured is labelled "Sample numbers"

All state is in memory (`src/lib/store.tsx`). Reloading resets it.
