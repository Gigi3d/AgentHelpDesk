# AgentHelpDesk: Frontend and Product Surface Plan

Oct 16, 2026 · @Gmoney · revised the same night after the Hark evidence (`evidence/2026-10-16-hark-launch-night/`); the agent-facing surfaces gained four mechanisms

AgentHelpDesk needs eight surfaces, and two of them decide whether anyone adopts it: the one-click install and the ticket page. A provider should be live in under five minutes and see a real fix proof the first time an agent fails. Everything else supports those two moments.

## What we are building

The product has a provider side (the people who run an API) and an agent side (the AI agents that call it). Providers get a web console, messages and a daily email. Agents get a tool, structured errors and a help page. We also need an internal dashboard to run the company.

| # | Surface | Who uses it | Its one job | Hackathon scope |
| --- | --- | --- | --- | --- |
| 1 | Marketing site and docs | Provider engineers and founders | Explain the desk and lead to install | One landing page, one install page |
| 2 | Install ladder | Provider engineer | Give a way in at any permission level, from one forwarded failing call to a merged pull request | Real: five rungs on one page, with rung 4 as the GitHub connect, one command, test ticket |
| 3 | Provider console | Engineer, support lead | See tickets, proofs, approvals, agents | Real: ticket list, ticket page, approval inbox |
| 4 | Approval channel (text, email, Slack) | Whoever approves risky fixes | Approve or reject from a phone in 10 seconds | Real: text message through Inkbox |
| 5 | Daily report | Founder, product lead | Show which agents were helped and won | Real email, sample numbers labelled as sample |
| 6 | Agent-facing surfaces | AI agents | Report a problem, receive a verified answer, and act on bounded grants | Real: report\_problem tool, error fields, and one authority verb in the demo |
| 7 | Billing and settings | Provider admin | Pay per verified fix, set modes and limits | Stripe test mode |
| 8 | Internal dashboard | Our team | Run support, billing and quality across all providers | Minimal: proof outcomes and fix queue |

## What this doc does not cover

It covers screens and flows, not the sandbox, the fix engine or the proof logic. Those live in the [Build Plan](https://claude.ai/artifact/UoBWAf5Ps5QCkVHAwanUKM). The sandbox runner is Blaxel.

## Lessons from Stripe

Stripe wins developers by making the first working call fast and the dashboard calm. We copy the habits, not the look. The first table is from [Stripe's Dashboard guide](https://docs.stripe.com/dashboard/basics); the last two rows are my own read of Stripe's public pages and are not sourced.

| Stripe habit | What it does for the user | What we do |
| --- | --- | --- |
| Home page of widgets the user can add or remove, with unresolved items surfaced on top | The first screen answers "what needs me now" | Home shows tickets waiting for approval first, then fixes shipped, then agents won |
| Left sidebar with Shortcuts for pinned and recent pages | Fast return to the same few pages | Pin a ticket, an agent or an endpoint; keep the last five visited |
| Search across every object, and a keyboard shortcut list on the question mark key | Power users never touch the mouse | One search for tickets, agents, endpoints and request IDs; question mark opens shortcuts |
| Workbench: every request logged with the original request, the response and related objects | Debugging starts from facts, not guesses | Every ticket shows the failing request and response in full, with the agent's identity |
| Sandboxes that simulate integrations without touching live data | Safe to try before trusting | Test mode on every account; a test ticket during install |
| Team roles, such as letting support staff handle refunds only | Least privilege by default | Roles for admin, engineer and approver |
| Branding settings for logo and colors used on customer-facing emails | Customer-facing messages look like the provider | Provider logo and colors on the daily report and on agent-facing help pages |
| Mobile app with push notifications on business activity | Decisions can happen away from a desk | Approve or reject by text first; a mobile web view of the ticket later |
| Workflows that automate multi-step tasks without code | Customers shape their own rules | Approval modes and rules per endpoint, written in plain language |
| Docs where the code sample is the first thing and is copyable (my read) | Time to first success is minutes | The install page leads with one command and a copy button |
| White space, one primary action per page, plain nouns (my read) | The product feels trustworthy before the user reads anything | One primary pink action per screen; blue for links and trust marks; no jargon |

## What we leave out

Stripe's dashboard serves many products, so its navigation is wide. Ours serves one job. The sidebar stays at six items: Home, Tickets, Agents, Reports, Billing, Settings. A provider should never wonder where something is.

## Visual system

The look is a white page with ink-dark text, blue for trust and information, and hot pink for the one thing a person should do next. Pink means "your decision" and blue means "the system is working". That one rule keeps screens calm and makes approvals impossible to miss.

| Token | Hex | Use | Contrast on white |
| --- | --- | --- | --- |
| Page | #FFFFFF | Every page background | n/a |
| Surface | #F7F8FA | Table headers, side panels, code blocks | n/a |
| Border | #E6E8EE | Dividers and card edges | n/a |
| Ink | #111827 | Headings and body text | 17.7 |
| Muted | #5B6475 | Labels, timestamps, help text | 6.0 |
| Blue | #2554F5 | Links, info chips, focus rings, system-working states | 5.7 |
| Blue tint | #EAF0FF | Info banners, selected rows | text on it 5.9 with #1D4ED8 |
| Hot pink | #E6007A | Primary buttons, approval needed, the one action per screen | 4.5, white text on it passes |
| Bright pink | #FF2D87 | Illustration, charts, large decorative marks only | 3.5, never for small text |
| Pink tint | #FFE8F3 | Approval banners and highlight rows | text on it 5.7 with #B8005F |
| Success | #0F8A5F | Shipped, proof passed | 4.4, use for icons and large text; darken for small text |
| Warning | #B45309 | Waiting too long, a proof flaky | 5.0 |
| Error | #D92D20 | A proof failed, a fix rejected | 4.8 |

Contrast numbers are calculated from the hex values. Run a real check in the browser before launch.

## Type, space and shape

- **Type:** Inter for the interface and JetBrains Mono for requests, responses, diffs and IDs. Body 15 px, tables 14 px, labels 12 px with small letter spacing, page titles 28 px.
- **Spacing:** a 4 px scale, with 16 and 24 as the working gaps. Pages have a 1120 px content column and a fixed 232 px sidebar.
- **Shape:** 8 px corners on buttons and inputs, 12 px on cards, 1 px borders, no heavy shadows. Only menus and dialogs get a soft shadow.
- **Motion:** 120 to 160 ms fades and a pulse on a live ticket. No scroll animation.
- **Voice:** plain sentences, second person, no jargon. "Your agent could not finish this call. Here is the fix we proved."

## Ticket stage colors

| Stage | Color | Meaning |
| --- | --- | --- |
| Opened, reproducing, fix drafted, proving | Blue | The desk is working; no one needs to act |
| Awaiting approval | Pink | A person must decide |
| Answered, shipped | Green | The agent got a working answer |
| Failed proof, rejected | Red | The desk could not prove a fix |
| Closed | Muted gray | Nothing left to do |

## Core components

Button (primary pink, secondary white with border, link blue), status chip, stage timeline, request and response viewer with copy and diff, proof card, approval card, empty state with a single next step, data table with filters and saved views, toast, command search, and a test-mode banner across the top of every page in test mode.

## Install ladder

Install is a ladder of five rungs, least permission first. A provider can start with nothing but a failing call and climb only as far as the value justifies. Rungs 0 to 3 need no GitHub and no repo access; rung 4 is the GitHub flow, and it is the only rung that can prove a fix.

| Rung | What the provider does | What they get | Permission ask | What the desk may do |
| --- | --- | --- | --- | --- |
| 0 | Shares the help link; an agent operator forwards its own failing call | A classified case with a suggested answer | None | Suggest only, unproven, never billed |
| 1 | Adds one help field to error bodies, or one line to llms.txt | Failing agents find the desk at the moment they fail | One line of code, merged by them | Suggest only, unproven, never billed |
| 2 | Pastes an OpenAPI spec URL or drops the file | Knowledge and authority answers, plus bounded grant drafts | Read-only spec, no repo | Suggest only, unproven, never billed |
| 3 | Points the desk at Slack, Linear, email or a webhook | Cases arrive where the team already works | One outbound connection | Suggest only, unproven, never billed |
| 4 | Connects GitHub and merges one install PR | Proven fixes, opened PRs, regression tests | Read repository contents; write PRs and comments | Proven first; the only rung that can bill |

Rung 2 is the recommended front door: two minutes, no GitHub, and it covers the two failure classes that do not need code. Rung 4 is an earned upgrade, prompted at the moment a failure actually needs a merged code change. Each rung stands alone, and every rung screen offers a way back to the ladder and a way straight to rung 4.

### The honesty rule for rungs 0 to 3

Everything below rung 4 produces suggestions, and the interface says so on every screen: an amber note reading "Unproven suggestions — never billed", the mode chip on each answer, and no billing surface at all. Rungs 0 to 3 are free. A billable fix requires all three proofs, and only rung 4 can run them, because proving a code fix needs the provider's tests and CI. This is what keeps "Proven first" true: the promise is about what we bill for and what we claim a fix does, not about whether we are allowed to suggest.

### The consent line

Rung 0 is an agent sending its own failing request. That is fine. Bulk-ingesting a provider's traffic without the provider's consent is not offered at any rung, because those requests carry end-user data. Every rung states what it reads and what it never touches, next to the button that turns it on.

### Rung 4: the GitHub flow

A provider installs by connecting GitHub and merging one pull request that we open. Nothing in their running API changes until they merge, and the target is a first test ticket within five minutes of sign-in.

&#91;embedded content: install ladder with 5 rungs, then the rung 4 flow with 6 steps and 1 merge\]

The merge in step 4 is the only change to their code. Everything before it only reads, and everything after it is a ticket.

### What the install pull request changes

| File or change | What it adds | Why |
| --- | --- | --- |
| agenthelpdesk.json | Endpoints in scope, approval mode, approver, daily report recipients | One place to review and edit every setting |
| Error response helper | A help field in error bodies with the ticket URL and the report\_problem tool name | A failing agent learns where to go at the moment it fails |
| llms.txt and docs footer | One line telling agents how to ask for help | Agents read these files first |
| CI check | Runs the desk's regression tests on every pull request | A later change cannot silently undo a fix |

### Three ways to open the rung 4 pull request

| Option | For whom | How it works |
| --- | --- | --- |
| GitHub App and install PR (default) | Most providers | The flow above |
| Command line: `npx agenthelpdesk init` (proposed name) | Engineers who prefer a terminal | Opens the same install PR from the terminal |
| Agent install | Providers who let a coding agent do chores | One pasted prompt and docs written for agents; their agent follows the steps and opens the PR |
| No GitHub at all | Providers who will not connect a repo yet | Rungs 0 to 3 above. A gateway or middleware rule that adds the help field without a repo is later work |

### What the consent screen says

- **We read:** repository contents, the OpenAPI spec, docs and CI results.
- **We write:** pull requests and comments, never direct commits.
- **We never:** merge, read secrets or environment variables, or touch production.
- **You can revoke** the GitHub App at any time and the desk drops to suggest-only.

### When install goes wrong

| What happens | What the screen says and does |
| --- | --- |
| Rung 2 spec URL will not load | Asks for a file upload instead, and shows exactly what it could read |
| A rung 0 to 3 case turns out to need a code fix | Says so plainly: code fixes need rung 4, and shows the diff the desk would open before asking for GitHub |
| No OpenAPI spec found | Asks for a spec file or a docs URL, and shows a sample of what we found |
| No tests found | Starts in docs and error text only; code fixes stay off until tests exist |
| No CI in the repo | Proofs run only in our sandbox; shown as a gap with a fix link |
| Organization needs an admin to approve the App | Gives a copy-ready message to send the admin and keeps the progress saved |
| Install PR is closed unmerged | Nothing changes; the desk stays in suggest-only mode and asks why |
| Test ticket fails a proof | Shows which proof failed and opens a ticket to us, not to the provider |

We measure time from sign-in to first passing test ticket on every install and show it on the internal dashboard, alongside the rung each provider stops at and how long until they climb to the next one.

## Provider console

The console has six sidebar items and one question on every page: what needs me now. The top of Home answers it, and every other page is a way to look closer.

| Page | What it shows | What the provider can do | Empty state |
| --- | --- | --- | --- |
| Home | Approval banner on top, then four tiles (fixes shipped, waiting for approval, agents helped, agents won), a ticket feed, and a weekly trend | Approve or reject from the banner, open any ticket, pin pages | A single card: "Run your test ticket" with a pink button |
| Tickets | A table with stage, endpoint, agent, age, proof status and mode; filters and saved views; a live badge for tickets in progress | Filter, search, bulk approve low-risk fixes, export | "No agent has asked for help yet. Share your help link with an agent to test it." |
| Ticket page | The full story of one ticket (next section) | Approve, reject, edit the reply, retry a proof, hand to a human | Not applicable |
| Agents | Every agent that called the API, with its name or client string, calls, failures, tickets and a status of helped, won or lost | Open an agent's history, mute a noisy agent, mark an agent as a known partner | "Agents appear here after their first call with a help field." |
| Endpoints | Each endpoint with failure rate, open tickets and last fix | Turn the desk on or off per endpoint, set the approval mode per endpoint | List of endpoints from the spec with the desk off by default for risky ones |
| Reports | The daily report archive and a weekly view of tickets, fixes, agents helped and agents won | Change recipients and send time, forward a report | A sample report with sample numbers clearly labelled |
| Billing | Usage this period, verified fixes billed, invoice preview, payment method | Update payment method, download invoices, set a spend cap | A test mode notice and zero usage |
| Settings | Install status, approval modes, approvers, team and roles, notifications, branding, API keys, Stack page, danger zone | Edit any of these; revoke the GitHub App | Install checklist with unfinished steps highlighted |

## Home in detail

1. **Approval banner (pink tint).** "2 fixes are waiting for you." Each row shows the endpoint, a one-line summary, the risk level, and Approve and Reject buttons. Hidden when nothing waits.
2. **Four tiles.** Fixes shipped, waiting for approval, agents helped, agents won. Each tile shows the last seven days and a small trend line.
3. **Ticket feed.** The twenty most recent tickets with a stage chip and the sponsor tool chips for that ticket.
4. **Install and test-mode strip.** Visible until install is complete or while in test mode.

An agent is **helped** when it received a verified answer. It is **won** when, after that answer, the same agent made a successful call to the endpoint. "Won" needs the agent's identity on later calls, so the install PR adds an optional agent identifier header; without it the tile shows helped only and says why.

## Roles and access

| Role | Can do |
| --- | --- |
| Admin | Everything, including billing, team and revoking access |
| Engineer | See all tickets, retry proofs, edit settings except billing and team |
| Approver | See tickets and approve or reject; no settings |
| Viewer | Read tickets, agents and reports |

## Keyboard and speed

Command search opens with the slash key and finds tickets, agents, endpoints and request IDs. The question mark key shows shortcuts. J and K move through a ticket list, A approves, R rejects, and pages load with the table first and details after.

## Showing the sponsor tools at work

Every sponsor tool we use should be visible on screen, doing a job, with a number that proves it mattered. We show this in three places, so a judge sees it without being told and a provider sees it as product value, not decoration.

1. **On the ticket page.** Each stage in the timeline carries a small chip naming the tool that did the work, with its duration. Click the chip to see the raw event: the sandbox ID, the Stripe meter event, the message sent.
2. **On a Stack page** at Settings, Stack. One card per tool with its role, a live counter and a before and after line.
3. **On the demo screen.** A single full-width strip under the ticket that fills in as the ticket moves: sandbox started, proof run, text sent, approved, fix shipped, meter event billed.

The chips and cards read from one table, `tool_events`, which every stage writes to: ticket ID, tool, action, start, end, result, cost if known, and a link to the raw payload. If the data is not in that table, it does not appear on screen.

| Tool | Its job in the product | What the screen shows | Impact number to display | Before and after line |
| --- | --- | --- | --- | --- |
| Blaxel | A fresh sandbox per ticket where the fix is tried and proved | Sandbox ID, status, resume or start time, three proof results in one card | Median seconds from failure to first proof | "Without a sandbox, no fix is tried before a human reads the ticket" |
| Stripe | Meters each verified fix and bills the provider; can let an agent pay for a verified answer | Meter event per fix, running invoice preview, test mode banner | Verified fixes billed and amount due this period | "Pay for proven fixes, not for tickets opened" |
| Manufact | Exposes report\_problem as an MCP server any agent client can call | Calls received by client name, last call time, the tool schema agents see | MCP calls per day and share that became tickets | "One endpoint any agent can use, no custom SDK" |
| Inkbox | Gives the desk its own identity and sends approval requests by text or email | Message preview, sent and replied times, approver name | Median minutes from request to approval | "Approve a schema change from your phone" |
| Armature | Tests whether agents pick and install the desk unprompted | Result of a fresh-agent install eval on the install page | Pass or fail, steps taken, time to first ticket | "A fresh agent installs it from the docs alone" |

Sponsor roles above come from the [Sponsor Briefs](https://claude.ai/artifact/R3HRjAqH2ugfSCawU1Ea5o), which record what each sponsor likely wants. Confirm each API and what the sponsor's judges care about with the sponsor at the event.

## Rules for sponsor visuals

- **Only real events.** Counters read from `tool_events`. A demo may replay a recorded ticket, and then the page says "Replay of a recorded ticket" in the header.
- **Sample numbers carry a label.** Anything not measured, such as the example daily report, is tagged "Sample numbers" in the same chip style as test mode.
- **No logo walls.** A tool's name appears only beside the work it did.
- **One tool, one color rule.** Sponsor chips use the muted gray with the tool's name; pink and blue stay reserved for decisions and system state.
- **Sandbox runner is swappable.** The Blaxel chip reads the runner name from the event, so a second runner would show its own name and never the wrong one.
- **Each tool needs a fallback.** If a sponsor service is down during a demo, the chip shows "unavailable" and the ticket continues on the fallback path where one exists.

## The ticket page

This is the screen a provider remembers. It answers four questions in order: what failed, what we did about it, how we know the fix works, and what we need from you. The decision sits beside the proof so no one approves blind.

&#91;embedded content: ticket page wireframe, awaiting approval state\]

The wireframe shows the awaiting-approval state. Other states change only the right column: a shipped ticket swaps the decision card for a green summary and a link to the pull request.

### Blocks, top to bottom

| Block | Content | Notes |
| --- | --- | --- |
| Header | One-sentence title, stage chip, endpoint, agent name, age | The title is written by the desk in plain words, never a raw error code alone |
| Timeline | Seven stages with the tool chip and duration for each | Clicking a chip opens the raw event; the current stage pulses |
| What the agent sent and got | The failing request and response, with secrets masked, and a copy button | Mono type; a toggle shows headers; matches what Stripe's request logs do for debugging |
| The fix | Before and after as a diff, plus the reply the agent will receive | The reply is editable until sent; every change is a pull request |
| Three proofs | Replay passes, provider tests pass, fresh agent succeeds, each expandable | A failed proof turns red and shows the log and a Retry button |
| Grants and audit | Every action the desk or an agent took under an authority envelope, with cap, idempotency key and receipt, read from `tool_events` | The audit log the failing Hark agent asked for, surfaced to the end user instead of buried in ops |
| Your decision | Approve and send, Reject with a reason, Ask the desk to try again | Shows the risk level and which approval mode triggered the wait |
| Activity | Comments, who approved and when, messages sent by text or email | Replies by text show up here |

### States of the page

| State | What changes |
| --- | --- |
| In progress | Timeline pulses; proofs fill in live; no decision card yet |
| Awaiting approval | Pink decision card; the same card goes out by text |
| Answered | Green summary with the reply the agent received; Stripe meter event shown |
| Shipped | Link to the merged pull request and the new regression test |
| Proof failed | Red proof; the card offers retry, hand to a human, or close |
| Closed | Read-only; a one-line outcome at the top |

### Details that build trust

- Secrets and personal data are masked before anything is shown, and the page says so.
- A permanent link per ticket opens for the approver without a full login, scoped to that ticket and signed.
- A "What did the agent see?" tab shows the exact reply, rendered as the agent received it.
- Every number on the page links to the event that produced it.

## Approvals, notifications and the daily report

A provider should be able to approve a risky fix from a phone in about ten seconds without opening a laptop. Approvals travel by text first, because Inkbox gives the desk its own identity for messages, and the same decision is always available on the ticket page.

### Approval modes

| Mode | What ships alone | What waits | Default for |
| --- | --- | --- | --- |
| Auto | Docs and error text changes that pass all three proofs | Anything touching code or schema | Docs and error text only |
| Approve first | Nothing | Code and schema changes, sent as a text message | New accounts and code changes |
| Suggest only | Nothing | Every fix, shown as a draft the provider applies | Endpoints marked sensitive, such as payments |

Whatever the mode, nothing ships without three proofs. The mode is set per endpoint, with one account default.

### The approval text

Short, plain and complete enough to decide without a click-through:

- What failed, in one line, and how many agents it affected.
- What we changed, in one line, and whether it is docs, error text, code or schema.
- Proof status: "3 of 3 proofs passed."
- Two replies: **YES** to approve, **NO** to reject, plus a signed link to the ticket page.
- A reply of anything else opens a thread with the desk, and the ticket page shows it in Activity.

### Notification rules

| Event | Channel | When |
| --- | --- | --- |
| Fix waiting for approval | Text, then email if no reply | Immediately; reminder after the provider's set wait time |
| Proof failed twice | Email and console banner | Immediately; asks for a human |
| Fix shipped | Console feed; email in the daily report | Not individually, to avoid noise |
| Agent won | Daily report only | Once a day |
| Spend cap at 80 percent | Email to admins | Once per period |

Quiet hours apply to everything except a spend cap breach. A provider can add Slack as a channel later.

### The daily report

The daily report is the reason a provider keeps the desk, because it connects fixes to agents won. It goes out as an email in the provider's logo and colors, and each section opens the matching console page.

| Section | Content |
| --- | --- |
| Headline | One sentence: tickets opened, fixed, waiting, and agents that finished their task after a fix |
| Agents you won | A short list of agents that failed, were helped, and then succeeded, with the endpoint |
| Still waiting | Tickets that need an approval, each with a one-tap link |
| Where docs mislead agents | The three endpoints or fields that caused the most tickets, with the suggested docs change |
| What changed | Pull requests opened and merged, and regression tests added |
| Spend | Verified fixes billed today and this period |

Every example in the console and the demo uses clearly labelled sample numbers until a provider has real data. The report states "Sample numbers" in its header until then.

## Agent-facing surfaces

The customer who matters most never sees a screen. An agent that fails needs three things in the same response: a clear reason, a place to ask for help, and an answer it can use without a human. These surfaces are text, not pixels, and they get the same design care as the console.

### 1. The error body gets a help field

The install PR adds one object to every error response. Names below are proposed and can change before launch.

```json
{
  "error": { "code": "unknown_field", "message": "currency_code is not a field" },
  "help": {
    "desk": "https://help.example.com/agents",
    "tool": "report_problem",
    "request_id": "req_123",
    "hint": "If this keeps failing, call report_problem with this request_id."
  }
}
```

### 2. The report\_problem tool

The tool is exposed as an MCP server (hosted on Manufact Cloud in the hackathon plan), so any MCP-capable agent can call it without a custom SDK. It has one job and a small schema.

| Field | Direction | Meaning |
| --- | --- | --- |
| request\_id | In | The failing request, so the desk can read it from logs |
| goal | In | What the agent was trying to do, in a sentence |
| tried | In | What the agent already tried |
| contact | In, optional | How to reach the agent's operator, such as an email |
| ticket\_id | Out | The case opened |
| status | Out | opened, working or answered |
| ack\_by, resolve\_by | Out | Committed times, returned at intake, not after the fact |
| queue\_position | Out | Where the case sits right now |
| answer | Out, when ready | Summary, corrected request, docs link and a verified flag with the three proof results |
| outcome | Out, when ready | An executable object — action, amount, expiry — so the agent can resume instead of parsing prose |
| authority | Out, when granted | The verbs this agent may now call, each with its cap and per-user limit |
| events | Out | The push topics this case will emit |
| wait | Out | Suggested seconds before checking again, a fallback until push exists |

While working, the agent can poll the same tool with the case ID; once push webhooks exist, polling is a fallback rather than the design. A verified answer states plainly what was proved and what was not.

The additions above come straight from the failing Hark agent's own spec of Oct 16 2026, which asked for committed times ("Without committed times, it's just a ticket inbox"), pushed status, warm handoff, structured outcomes and an audit log. `wait` was the old contract; `ack_by` and `resolve_by` plus push is the new one.

### 3. The agent help page

A public page at the provider's help URL, written for agents first and humans second.

- Plain Markdown with a JSON twin at the same path, no scripts and no login.
- Sections: how to ask for help, what the desk can and cannot change, expected wait, and the current known issues the desk has already fixed.
- The provider's logo and colors appear in the human view only.
- A line in llms.txt and the docs footer points here.
- It lists the optional agent identifier header, so an agent can say who it is and be recognized when it returns.

### 4. Optional: the agent pays

When the provider chooses, an agent can pay for a verified answer itself through Stripe's Machine Payments Protocol. The default is that the provider pays and the agent pays nothing, so this stays off unless switched on in Settings.

### 5. Bounded self-fix verbs (the authority envelope)

For authority-class failures the answer is not a document, it is a grant. The desk can publish a small set of verbs an agent may call itself, each scoped by an authority envelope:

| Verb | What it does | Envelope example |
| --- | --- | --- |
| `POST /verifications/{id}/appeal` | Re-check a rejected verification with a second carrier, or fall back to email or ID | Two appeals per case |
| `POST /entitlements/{id}/reissue` | Re-hold an expired offer or card | One reissue per user |
| `GET /orders/{id}/state` | True order status from the merchant, not a guess | Read-only |
| `POST /refunds` | Refund up to a cap | $30 per case, $200 per agent per day |

Every call carries an idempotency key so a retry never double-spends, and every call writes a receipt the provider can read. The envelope is set per provider in Settings and defaults to the tightest option. It is also the demo's centrepiece: Ledgerly's seeded failure #4 is an entitlement that will not apply at checkout, reissued behind this envelope with a committed `resolve_by`.

### 6. Push status and warm handoff

- Push topics per case: `case.acknowledged`, `case.needs_user_input`, `case.resolved`, `case.breached_sla`. Delivered as signed webhooks; polling stays as the fallback for agents that cannot receive them.
- `POST /cases/{id}/handoff` brings a human into the same thread with the full transcript, so the user never repeats themselves. This is the consumer-side half the original plan left unspecified.
- `DELETE /users/{id}/data` with a confirmation receipt, because the Hark session showed an agent deflecting a deletion request to a human inbox — the single worst move in the whole transcript.

### Rules for agent surfaces

- **No data from other customers.** An answer never includes another agent's request or response.
- **Same shape every time.** Fields are stable and versioned, so a model that has never seen the desk can still parse it.
- **Rate limits and abuse checks** on the tool, with a clear error that says what to do next.
- **A human fallback.** The help page always names where a human can be reached, even when the desk is down.
- **Grants are the tightest thing in the product.** No verb ships without a cap, a per-user limit, an idempotency key and a receipt. An envelope the calling agent can widen is a bug, not a feature.
- **Test with a fresh agent.** The install test and the Armature-style check use a clean agent with only the help page and the error body.

## Billing and settings

Providers pay per verified fix, so billing is a product feature, not an afterthought: the invoice is the proof that the desk earned its fee. Stripe handles the money, and we build the screens that make usage clear.

### Which Stripe usage product

Stripe's [usage-based billing page](https://docs.stripe.com/billing/subscriptions/usage-based) now recommends Metronome, which is part of Stripe, for new integrations. The older Meters API stays supported and is the lower-level option. Earlier docs in this set say "Stripe meter"; that still works for the hackathon because it is the simplest path to a visible meter event. For production, decide between the two before building the invoice screens, since the data each exposes differs.

### Billing page

| Block | Content |
| --- | --- |
| Usage this period | Verified fixes billed, by type (docs and error text, code, migration pull request), with a bar by day |
| Invoice preview | Line items for the period so far, platform fee and a total, matching what Stripe will invoice |
| Spend cap | One number; the desk stops opening paid fixes and moves to suggest-only when reached |
| Payment method | Card or bank, updated through a Stripe-hosted form so we never handle card numbers |
| Invoices | A list with PDF download and the tickets behind each line |
| Test mode banner | A pink strip when the account has no live payment method, saying nothing is being charged |

Every invoice line links to its ticket, so a finance person can see why each fix was billed. A fix that fails a proof is never billed, and the page says so.

### Pricing we show, still a hypothesis

Our first guess is $0.50 to $1 per verified fix for the desk, $5 to $25 per merged migration pull request and a monthly platform fee. The page reads prices from Stripe, so changing a price never needs a code change. Until a pilot confirms any number, the public site shows "pay per verified fix" and the rate card appears only inside the console.

### Settings map

| Section | What lives there |
| --- | --- |
| Install | Current rung and what it unlocks, next-rung upgrade prompt, GitHub App status, repo, install PR link, the checklist, revoke access |
| Approval modes | Account default and per-endpoint overrides, risk rules in plain language |
| Approvers | Names, phones and emails, quiet hours, backup approver |
| Team and roles | Invite by email; Admin, Engineer, Approver, Viewer |
| Notifications | Per event and channel, the daily report time and recipients |
| Branding | Logo and colors used on the help page and the daily report |
| Agent settings | Optional agent identifier, mute list, whether agents may pay |
| Stack | The sponsor tool cards described above |
| API keys | For the console API and webhooks; test and live keys kept apart |
| Danger zone | Pause the desk, export all data, delete the account |

### Webhooks and API for providers

Providers can subscribe to events such as ticket.opened, ticket.awaiting\_approval, ticket.answered and fix.shipped. Each webhook delivery shows in a log with the payload and the response, the same habit Stripe's own request logs teach.

## Internal dashboard

The internal dashboard is how three people run a support product for many providers without drowning. It borrows Stripe's structure (home, ledger, customers, reports, logs, roles, automations) and adds what Stripe does not need: fix quality and unit cost. It lives on a separate staff-only domain with its own login.

### What we borrow from Stripe

| Stripe feature | Our version | Why we need it |
| --- | --- | --- |
| Home with widgets and unresolved items | Ops home: tickets that need us, failed proofs, installs stuck, spend caps hit | One screen to start the day |
| Transactions list with filters and export | Fix ledger: every ticket and fix, type, proofs, outcome, price, with filters and CSV export | Source of truth for billing disputes and quality |
| Customers with detail pages | Providers: install status, endpoints, approval mode, tickets, billing, notes, last contact | Support and sales in one place |
| Balances and payouts | Revenue: usage billed, invoiced, collected, past due | Cash view without opening Stripe |
| Reporting and Sigma SQL queries | Saved queries over tool\_events and the fix ledger, shareable by link | Answers we have not predicted |
| Workbench request logs | Desk logs: every inbound agent call, the failing request, the model and sandbox steps, errors | Debugging a bad fix |
| Disputes and refunds | Credits: refund or credit a fix the provider says was wrong, with reason | Trust and clean accounting |
| Radar | Abuse controls: block or throttle noisy or hostile agents and providers | Protects margins and sandboxes |
| Workflows | Ops rules, such as "proof fails twice, page a human" | Fewer manual checks |
| Sandboxes and test mode | A staging provider and a replay mode for recorded tickets | Safe demos and regression runs |
| Team roles and audit log | Staff roles and a permanent log of who viewed or changed what | Required before touching customer data |
| Command search | Search by ticket, request ID, provider, agent, endpoint | Speed |

### What Stripe does not have and we need

| Page | What it shows | Decision it supports |
| --- | --- | --- |
| Quality | Proof pass rate by type, fixes later rolled back, fixes the provider rejected, flaky proofs | Whether to widen Auto mode |
| Unit cost | Cost per ticket: sandbox seconds, model use, messages sent; margin against price | Whether the price per fix holds |
| Human queue | Tickets that need our team, oldest first, with the reason | Who to help next |
| Install funnel | Rung chosen, highest rung reached, climb events from rung to rung, then sign in, connect repo, spec found, PR opened, PR merged, first test ticket, live, with drop-off and median time | Where setup loses people, and which rung holds them |
| Library | Regression tests by provider, change type and language, and how many new tickets a test now prevents | The moat we are building |
| Win rate | Agents helped and won by provider, and return rate after a fix | The number in the daily report |
| Stack health | Status and latency of each sponsor tool and the fallback in use | What to fix before a demo |
| Pilot tracker | Providers in trial, owner, next step, what they asked for | The business, in one list |

### Rules for the internal dashboard

- **Read-only by default.** Impersonating a provider is view-only, logged, and shows a banner.
- **Mask by default.** Request bodies show masked until a staff member opens them with a reason, which is logged.
- **Same design system** as the provider console, so one component library serves both.
- **Every metric has a definition link.** "Won" and "helped" mean the same here as in the daily report.
- **Hackathon scope.** Ops home, fix ledger and the quality page with a few real numbers. The rest are labelled placeholders in the plan and are not drawn.

## Build plan

For the hackathon on Oct 17 and 18, build the ticket page first, then the install flow, then the rest in order of how much each helps a judge understand the desk in two minutes. Everything else is planned here and drawn later.

### Stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Web app | React with TypeScript and a file-based router | One app for the provider console and the staff dashboard, split by route and role |
| Styling | Tailwind with the tokens above, and an accessible component set such as shadcn/ui | Fast to build, easy to hold to the visual rules |
| Data and auth | The desk's own store: a small Postgres or SQLite behind one module, provisioned by Stripe Projects if we want it agent-operable | InsForge dropped Oct 17; one module keeps the store swappable and the demo runnable offline |
| Realtime | Server-sent events or the backend's realtime feature for the live ticket timeline | Pulsing timeline without polling |
| Agent tool | MCP server for report\_problem, deployed on Manufact Cloud | Sponsor tool; any MCP agent can call it |
| Sandboxes | Blaxel, behind a runner interface | Sponsor tool; a second runner stays possible |
| Messages | Inkbox for approval texts and the desk's identity | Sponsor tool; approve from a phone |
| Billing | Stripe meter for B2B in test mode; x402 per call for agent-to-agent | Visible meter without real money; the A2A lane shows the 402 and its settlement |
| Email | Inkbox for the daily report | Use the Inkbox mailbox |

Confirm every sponsor API and its limits at the event. This plan names roles from the Sponsor Briefs and does not assume details the sponsors have not published.

### 48-hour build order

| Order | Build | Done when |
| --- | --- | --- |
| 1 | Design tokens, layout shell, ticket page with a live timeline reading from tool\_events | A recorded ticket replays on the page with chips and proofs |
| 2 | report\_problem MCP tool and the error help field on a demo API, returning `ack_by` and `resolve_by` at intake | A real agent fails, calls the tool and a case appears with a committed deadline |
| 3 | Approval card and approval text by YES or NO reply | A phone reply moves the ticket to answered |
| 4 | Install ladder on a demo repo: the five rungs, with rung 4 as GitHub App, detection, install PR, test ticket | A fresh account reaches a live desk from any rung, with a visible clock |
| 5 | Home and Tickets list, with the approval banner | Home answers "what needs me now" |
| 6 | Stack strip on the ticket page and the Stack settings page | Every sponsor tool shows a real event |
| 7 | Daily report email | An email arrives with sample numbers labelled |
| 8 | Billing page and meter event in test mode | An invoice preview shows per-fix lines |
| 9 | Staff ops home and fix ledger | Quality tile shows the proof pass rate |
| 10 | One authority verb (`entitlements.reissue`) plus the grants-and-audit block on the ticket page | The demo agent retries after a grant and the order completes, with the receipt visible |

Order 10 is the demo that wins: it is Friday's Hark failure, fixed. If it slips, show the grant as a recorded replay and say so.

If order 4 slips, run install through the command line and show the same steps. If order 7 slips, show the email as a rendered preview and say so.

### What we show honestly

- A demo API and a demo repo we own, not a real provider's.
- Replays of recorded tickets marked as replays.
- Sample numbers in the daily report and tiles, marked as sample.
- Stripe in test mode, with the banner on.
- A statement of what ran live and what is a plan, spoken in the demo and shown on the last slide.

### Later

| Stage | Adds |
| --- | --- |
| Pilot | Real providers, SSO, Slack approvals, mobile web ticket view, the full internal dashboard |
| Growth | Gateway or middleware install for providers with no repo at all, public status page, templates per framework, a console API |
| Second act | The provider-triggered migration flow: a migration planner screen, a per-repo pull request tracker and a merge-rate report |

## Open questions and risks

The biggest design risk is trust: a provider lets us open pull requests in their code, so every screen has to show what we touched and why. The biggest build risk is scope, which is why the 48-hour order above cuts hard after the first five items.

- [ ] Does Blaxel offer network egress controls and per-sandbox secrets? The "without breaking anything" claim depends on it.
- [ ] Which sponsors' APIs are confirmed at the event, and do any prizes require using the sponsor's product?
- [ ] Stripe: Meters API for the hackathon, and Metronome for production? Decide before building the invoice screens.
- [ ] How is an agent identified on its return visit so "won" can be measured? The install PR proposes an optional header; test whether real agents send it.
- [ ] Is a text message acceptable for approving a code change, or should the text only link to the ticket page for code and schema changes?
- [ ] Who approves at a small provider with one engineer? The flow assumes an approver exists and a backup.
- [ ] Does the pink #E6007A pass accessibility on small buttons? It meets 4.5 with white text; test on real screens and darken if it fails.
- [ ] Name and tagline on the public site: the ADHD line is memorable, and some visitors may read it as a joke about a medical condition. Test it with a few providers before it goes on the front page.
- [ ] Domain, trademark and help URL pattern for AgentHelpDesk and AHD are not checked.
- [ ] Who sets the authority envelope at a provider with no fraud team? The default caps must be safe enough to ship without one.
- [ ] Can push webhooks reach an agent with no server? If not, polling is the real path for the hackathon and push is a pilot feature.

### Risks

| Risk | What it breaks | Mitigation |
| --- | --- | --- |
| Install PR feels invasive | Adoption | Show the exact diff before the click, never merge, keep suggest-only as the starting mode, and let anyone not ready to connect a repo start on rungs 0 to 3 |
| Sponsor service fails in the demo | The demo | Fallback path per tool and a recorded replay, labelled |
| Real numbers are thin | Credibility | Use sample numbers only when labelled; show one real ticket end to end |
| Too many screens for 48 hours | Quality | Hold to the build order; cut from the bottom |
| Daily report reads like marketing | Retention | Only measured facts, with each line linking to its ticket |
| Secrets leak into tickets | Trust and security | Mask before storage and before display, and test with seeded fake secrets |
| An agent abuses a grant | Money and trust | Tightest defaults, per-user and per-day caps, idempotency keys, a receipt on every grant, and the audit block visible on the ticket page |

### Sources

- [Stripe Dashboard guide](https://docs.stripe.com/dashboard/basics), for the dashboard structure we borrow.
- [Stripe usage-based billing](https://docs.stripe.com/billing/subscriptions/usage-based), for the Meters API and Metronome note.
- [Blaxel](https://blaxel.ai/) and the other sponsors, via the [Sponsor Briefs](https://claude.ai/artifact/R3HRjAqH2ugfSCawU1Ea5o).
- [Build Plan](https://claude.ai/artifact/UoBWAf5Ps5QCkVHAwanUKM) and [API Reliability](https://claude.ai/artifact/A7QMvXTQepER1P5PWdNnuX), for the product behind these screens.
- `evidence/2026-10-16-hark-launch-night/README.md`, for the mechanisms in agent-facing surfaces 5 and 6: the failing Hark agent's own spec, captured Oct 16 2026 from our own sessions.
