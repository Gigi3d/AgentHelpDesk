# AgentHelpDesk: Research Dossier

Oct 14, 2026 · @Gmoney · updated Oct 16, 2026 with live evidence from Hark's launch night (`evidence/2026-10-16-hark-launch-night/`)

> **The pitch:** every company that sells to humans has a support desk, and every company that sells to agents needs one too, one that answers at 3 a.m. and proves the fix in a sandbox before anything changes. On Oct 16 2026 a real agent in San Francisco knew exactly why a $1M-promo order failed and had nothing to call but a human email address. Every provider needs a way to answer failing agents, and our failure library gets more valuable with each provider.
>
> **What it does:** when an agent visits your API and cannot use it, cannot make sense of it, or hits a failure, AgentHelpDesk opens a ticket, reproduces the failure in a sandbox, tests a fix and returns it to the agent without touching production. The provider chooses whether fixes ship on their own or wait for human approval, and gets a daily report of the desk's work to help win more agents. Nobody can predict how each new model will interact with your API, so the desk is your insurance.

## Bottom line

AgentHelpDesk is a support desk whose customers are AI agents: when an agent fails on a vendor's product, the desk replies with a verified, machine-readable fix and gives the vendor a list of what to repair and what revenue it recovered. The recommendation is to build it for the Oct 17-18 YC hackathon, sell first to API and developer-tool companies, and design it so a helpdesk, developer platform or identity vendor would want to buy it.

The bet rests on three claims, each tested in the sections below:

1. **Agents are becoming real users of vendor products,** and they fail in three classes — knowledge, code and authority — of which the third has no channel at all. The vendor usually hears about it last.
2. **No one owns the response.** Helpdesk vendors focus on their own AI answering humans; adjacent tools measure or prevent failures but do not reply to the agent.
3. **Acquirers are paying for agent capability now.** Salesforce is buying Fin for $3.6B, Zendesk bought Forethought, Baseten bought Blaxel.

What is established: the failure patterns, the competitive gaps and the acquisition activity are sourced below. What is not: whether vendors will pay today. Agent ticket volume is small for most vendors, and I found no published price paid for an agent-facing support product. The plan therefore ends with a validation test, not a forecast.

## The problem: no one answers, and the vendor hears about it last

When a human hits a bad error, they search, ask a colleague or file a ticket. An agent has none of those habits, so a failure usually ends the task or produces a wrong guess. The evidence for each failure mode:

| Failure mode | Evidence | Why a desk helps |
| --- | --- | --- |
| Silent error handling | A Columbia study of 15+ apps built with five coding agents found agents prioritize running code over correct code and often suppress errors, leaving users with a stuck screen ([DAPLab](https://daplab.cs.columbia.edu/general/2026/01/08/9-critical-failure-patterns-of-coding-agents.html), as of Nov 2025) | The vendor never sees the failure, so the desk must capture it from the agent's side |
| Invented inputs | Same study: agents may hallucinate API keys or environment variables instead of asking for the real values | The desk can detect placeholder credentials and return the exact setup step |
| Wrong tool picked or tool misread | Microsoft says the most common and most fixable failure is selection, usually a vocabulary mismatch between tool descriptions and what developers say ([AX stack](https://developer.microsoft.com/blog/the-ax-stack-whats-fixed-where-you-can-win/)) | Failure reports reveal the vocabulary agents actually use |
| Errors written for humans | Cloudflare measured an HTML error page at about 14,252 tokens versus about 221 for a structured Markdown one, and moved to RFC 9457 error payloads in March 2026 ([Cloudflare](https://www.blog.cloudflare.com/rfc-9457-agent-error-pages/)) | Shows vendors and platforms already accept that agents need a different reply format |
| Agents can answer but not act | In Alhena's test, all 15 agents could answer questions but only 4 could complete an action ([Alhena](https://alhena.ai/blog/agentic-traffic-customer-support/), vendor study) | Support for agents has to resolve the action, not explain it |
| Queue distortion and identity | One agent can open dozens of parallel tickets, and support teams often cannot tell whether an agent really acts for the customer (Alhena) | The desk must tag, rate-limit and verify agents |

Two caveats. The Columbia study is about apps built by coding agents, not about agents calling a particular vendor, so it shows how agents fail in general, not how often they fail on your product. And most of the figures above come from vendors or researchers describing the problem, not from a count of lost revenue. Measuring that loss is the first thing AgentHelpDesk would produce.

### A live case: Hark, launch night, Oct 16 2026

Everything above is secondary literature. On Oct 16 2026 we captured a primary case, archived with screenshots in `evidence/2026-10-16-hark-launch-night/`. Hark, an agentic assistant, ran a $1M free-pizza promotion in San Francisco; orders failed at checkout. From our own session with Hark's agent, verbatim:

> "I can't issue a second card, it's one per person, but yours is still good and now holds until 12:36 AM. The snag is on our end applying it at checkout, so support@hark.com is the fastest fix. Want me to retry your Margherita in a bit?"

Three things in that sentence settle arguments this dossier had left open. The agent diagnosed correctly and attributed correctly ("the snag is on our end"), so this was not a knowledge gap. It was blocked by a policy grant it did not hold — one card per person, no reissue, a VoIP verification rejection with no appeal — so no doc fix and no code fix could have helped it. And its only recourse was a human email address: no case ID, no deadline, no appeal endpoint, no handoff.

Asked in a second session what support API it would want, the same agent independently specified bounded self-fix verbs with an **authority envelope** and idempotency keys, `POST /cases` returning `case_id`, `ack_by`, `resolve_by` and queue position, pushed status webhooks including `case.breached_sla`, warm handoff with the full transcript, structured outcomes, and an audit log of every agent action. That is a convergent derivation of this product's core mechanism from the customer side. Full text in the evidence README.

This reframes the failure table above into three classes:

| Class | Example from the table | Can the agent self-fix? | What the desk adds |
| --- | --- | --- | --- |
| Knowledge | Wrong tool picked, errors written for humans | Often, by retrying or reading | A verified, tested answer |
| Code | Suppressed errors, invented inputs, a broken endpoint | Sometimes, by routing around | A sandbox-proven fix and a PR |
| Authority | One card per person; a verification rejected with no appeal | **Provably not** — the grant is the vendor's to give | An authority envelope, a committed deadline, a handoff |

Two honest limits. This is one vendor on one night, so it settles existence and shape, not base rate; the self-fix kill test in the risks section still sizes the knowledge and code half. And "thousands of people failed" is a characterization in our own public post, not a measured count — quote the transcript, not the count.

## Market and timing

Agent traffic is real and growing, but most public numbers measure all automated traffic, not agents that need support. The honest reading is that the supply side (tools for agents to call) is large and the demand side (agents that fail and need answers) is early.

| Signal | Figure | Reading |
| --- | --- | --- |
| Automated share of web traffic | Over 53% in 2025, up from 51% ([Imperva 2026 Bad Bot Report](https://securityboulevard.com/2026/04/bad-bot-report-2026-the-internet-is-no-longer-human-and-its-changing-how-business-works/), via a summary) | Includes all bots, mostly not agents. Direction matters more than the level |
| AI-driven US retail traffic | Up 693% year over year in Nov to Dec 2025 (Adobe, cited by [Alhena](https://alhena.ai/blog/agentic-traffic-customer-support/)) | Fast growth from a small base |
| MCP servers | 9,652 latest-version records in the official registry on May 24, 2026; 15,926 GitHub repos tagged `mcp-server` ([Digital Applied](https://digitalapplied.com/blog/mcp-adoption-statistics-2026), secondary source) | Thousands of publishers who each need agent support |
| MCP in production | 41% of about 100 software respondents in limited or broad production (Stacklok survey, via the same page) | Small, self-selected sample |
| Machine customers | Gartner projects 50% of service requests from machine customers by 2030 (cited by Alhena) | A forecast; an earlier Gartner forecast of 20% by 2026 is unverified |
| Agent payments | AWS AgentCore Payments reached general availability on Aug 18, 2026 with x402 and MPP ([AWS](https://aws.amazon.com/about-aws/whats-new/2026/08/bedrock-agentcore-payments-ga/)) | Big platforms are building the plumbing for agents that transact |
| Agent identity | Web Bot Auth, an IETF draft led by Cloudflare, went live at Cloudflare's edge in March 2026 ([Stellagent](https://stellagent.ai/insights/web-bot-auth-cloudflare-ietf), single vendor article) | Verified agent identity is arriving, which lets a desk trust who it is helping |
| Agent-mediated commerce failing live | Hark's $1M pizza promo in SF, Oct 16 2026: checkout failures across one city in one evening with no machine-readable escalation ([our archive](evidence/2026-10-16-hark-launch-night/README.md)) | Direct observation, not a statistic. The demand side is not hypothetical |

Why now rather than two years ago: three prerequisites have just appeared. Publishers exist in the thousands, platforms are standardizing how agents identify themselves and pay, and the big helpdesks are consolidating around their own AI and have left inbound agents unserved.

Why it could still be too early: if agent contact volume stays below a few percent of a vendor's traffic, the customer will not pay for a separate product. Alhena suggests acting once agent contacts reach roughly 5% of volume. The test in the validation section checks whether your design partners are near that line.

## Customers and money

Start with API and developer-tool companies, because their revenue depends on a developer or agent getting from signup to first successful call, and failure there is measurable.

| Segment | Pain | Likely signer | Why they pay | Priority |
| --- | --- | --- | --- | --- |
| API and devtool vendors (payments, auth, data, email, infra) | Agents abandon at signup, key setup or first call | Head of growth, developer relations or platform | Recovered activations, fewer unknown failures | First |
| MCP and tool publishers | Agents misuse tools or pick a rival | Founder or lead engineer | Pick rate and completion rate | First, but small budgets |
| Ecommerce and marketplace merchants | Agent-placed orders produce order-status, entitlement and returns tickets; Hark's launch night was exactly this shape | Head of support | Fewer tickets, safe handling of agent identity, authority grants at checkout | Co-first: the Oct 16 evidence came from this segment |
| Platforms and clouds (AWS-type) | Customer agents fail on partner tools | Product lead for agent platform | Platform completion and partner health | Partner, not first sale |
| Identity and security vendors | Need to separate real agents from abuse | Product or corp dev | Data on legitimate agent behavior | Acquirer type, see exit map |

### How the money works

Three charges, ordered from easiest to sell to most valuable:

1. **Pilot at no charge for 30 days,** in exchange for access to error logs and a named contact.
2. **Per resolved agent ticket,** priced near existing outcome benchmarks. Intercom's Fin charges [$0.99 per outcome](https://www.gleap.ai/blog/intercom-fin-ai-pricing-2026) (a competitor's blog; check Intercom's page), and AI resolution is quoted at roughly $0.50 to $2.37 on [one vendor page](https://lorikeetcx.ai/articles/customer-service-cost-per-ticket) with no source. Human SaaS tickets are quoted at $18 to $35 from a single third-party source, so check before relying on that range.
3. **A monthly fixes feed** that turns clusters of failures into docs, SDK and error-message changes for engineers.

The pitch that moves budget is recovered revenue, not ticket savings. An unsourced developer-portal funnel from [Zuplo](https://zuplo.com/learning-center/your-developer-portal-is-losing-you-customers) shows the shape: half of developers who get an API key never make a first call. Treat those figures as illustrative.

### Illustrative unit economics

Every input below is an assumption to be replaced with a design partner's real logs.

| Line | Assumption | Result |
| --- | --- | --- |
| Agent signup attempts per month | 10,000 |  |
| Share that hit a fixable failure | 30% | 3,000 |
| Share the desk resolves | 60% | 1,800 tickets |
| Of those, share that then complete signup | 25% | 450 recovered signups |
| First-month revenue per activation | $20 | $9,000 recovered |
| Desk fee: $0.75 per resolved ticket plus $1,500 fixes feed |  | $2,850 a month |

On these inputs the vendor gets about 3.2 times its fee back in first-month revenue alone, and the contract is worth about $34,000 a year. If real numbers are an order of magnitude lower, the product is a feature, not a company. That is the number to find out first.

## Competition

I found no company selling a live support desk for agent customers. The space is covered in pieces, and the threat is a vendor assembling those pieces or a big player adding an "agent mode." Threat levels are my judgment.

| Player | What they do | Overlap with AgentHelpDesk | What they leave open | Threat |
| --- | --- | --- | --- | --- |
| [Zendesk](https://techcrunch.com/2026/03/11/zendesk-acquires-agentic-customer-service-startup-forethought), [Salesforce / Fin](https://www.channelinsider.com/channel-business/mergers-and-acquisitions/ma-june-2026-recap/) | AI agents that answer human customers; Zendesk bought Forethought in March 2026, Salesforce agreed to buy Fin for $3.6B | Same buyer budget (support) and same pricing style (per outcome) | Built for humans; inbound agents are "largely unclaimed" per [Alhena](https://alhena.ai/blog/agentic-traffic-customer-support/) | High if they add an agent mode |
| [Armature](https://armature.tech) (hackathon sponsor) | Tests whether coding agents pick a product; MCP analytics, evals, agent.reviews | Failure data and developer-tool buyers | Measures and advises, does not reply to a live failing agent | Medium, and a likely partner |
| [Stainless](https://www.stainless.com/blog/steps-toward-great-agent-experience-every-api-provider-can-take-today/) | Generates SDKs, docs, MCP servers and agent skills from an OpenAPI spec | Same developer-tool buyer, same goal of agent-friendly products | Acts before launch; no response to live failures | Low to medium |
| [Cloudflare](https://www.blog.cloudflare.com/rfc-9457-agent-error-pages/) | Structured error pages for agents (Mar 2026); [Web Bot Auth](https://stellagent.ai/insights/web-bot-auth-cloudflare-ietf) for agent identity | Machine-readable errors; agent identity | Covers network errors, not a vendor's product errors | Medium as an enabler |
| [AWS AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html) | Gateway, Identity, Observability, Evaluations, Registry, Payments | Traces and evals of agent failures inside AWS | Does not answer agents or tell tool publishers what to fix | Medium; partner or acquirer |
| [Alhena](https://alhena.ai/blog/agentic-traffic-customer-support/) | Order management agent for ecommerce; publishes research on agent traffic | Ecommerce segment | Not aimed at API and developer-tool vendors | Low to medium |
| [Sapiom](https://siliconangle.com/2026/02/06/sapiom-reels-15-75m-equip-ai-agents-payment-features/) | Agent spend controls and know-your-agent checks; about $50M raised per a [listing](https://www.trysignalbase.com/news/funding/sapiom-raises-350m-series-a-for-ai-agent-payments) | Agent identity and trust | Buyer-side payments, not support | Low |
| [Inkbox](https://www.ycombinator.com/companies/inkbox), [Primitive](https://primitive.dev) (hackathon sponsors) | Agent inboxes, phone, identity | The inbound channel AgentHelpDesk would use | Infrastructure, not a support product | Low as competitors; useful as suppliers |
| In-house build | A vendor wires an LLM to its own docs and support inbox | The default alternative | Needs a test matrix, cross-vendor data and ongoing upkeep | High for large vendors, low for the long tail |

Likely entrants over the next year: a helpdesk shipping an agent mode, an observability vendor extending traces into replies, and a cloud platform bundling a tool-publisher support service. Armature adding live replies is the nearest threat among startups.

Implication: the product has to be fast to install and strong where each of these is weak, which is verified answers, cross-vendor learning and neutrality across helpdesks.

## Defensibility

The reply model, the prompt and the dashboard can all be copied in a week, so none of them is a moat. A vendor builds its own when the function is core and unique, and buys when it is non-differentiating, shared across the industry and needs ongoing upkeep. Agent support is the second kind for all but the largest platforms. These are the parts that compound, in the order they should be started (this is my analysis, not tested):

| Moat | Why a vendor cannot copy it alone | How to start it this weekend | Strength |
| --- | --- | --- | --- |
| Cross-vendor failure data | One vendor sees only its own failures; you see which failures repeat across hundreds of products | Log every failure in one schema: error type, agent harness and version, step, fix, outcome | Strong, but needs many customers |
| Maintained test matrix | Verified answers must work in Claude Code, Codex, Cursor and each new version; harness behavior is opaque and keeps changing ([Microsoft](https://developer.microsoft.com/blog/the-ax-stack-whats-fixed-where-you-can-win/)) | Run every proposed fix in a sandbox against at least two harnesses before sending | Strong, costly to maintain, which is the point |
| Agent-side habit | If agents learn your address returns working fixes, they route there first; vendors then want to be on it | Put the support address in error headers and MCP tool descriptions | Strong if it works, unproven |
| Neutral position | A helpdesk's tool favors that helpdesk; a neutral one can serve all of them | Ship integrations with at least two helpdesks | Medium |
| Published agent-readiness score | A neutral reference others cite becomes a standard | Publish a leaderboard from the design partners' data, with consent | Medium, slow |
| Outcome pricing | You carry the cost of failure, so a vendor avoids owning a cost center | Charge per resolved ticket, no charge on escalation | Medium |

Not a moat: the interface, the prompts, the docs indexing, and a first-mover label. Do not describe those as defensibility in front of a YC partner.

The honest weakness is that every moat above needs customers first, and customers need the product to work first. The first six weeks are therefore about getting one repeatable failure-to-fix loop working on real agent traffic.

## Exit map

Acquirers in this space are buying capability they cannot build fast enough, plus data and customers. Only one price in the comparable deals is public, so use these as direction, not valuation. Zendesk said the Forethought deal accelerates its roadmap by more than a year.

| Deal | Date | What was bought | Price | Lesson for AgentHelpDesk |
| --- | --- | --- | --- | --- |
| [Zendesk buys Forethought](https://thenextweb.com/news/zendesk-acquires-forethought-agentic-ai) | Mar 2026 | Self-improving agentic customer service AI; $115M raised | Not disclosed | Helpdesks buy agent capability to save roadmap time |
| [Salesforce buys Fin (formerly Intercom)](https://www.channelinsider.com/channel-business/mergers-and-acquisitions/ma-june-2026-recap/) | Jun 2026 | AI customer-service agents | $3.6B | The category is valued highly, but this is for human-facing support at scale |
| [Baseten buys Blaxel](https://www.baseten.co/blog/blaxel-is-joining-baseten-to-build-the-future-of-agentic-cloud/) | Sep 10, 2026 | Agent sandboxes and persistent storage; $7.3M seed ([Axios](https://www.axios.com/pro/enterprise-software-deals/2026/09/10/baseten-agentic-infrastructure-blaxel)) | Not disclosed | A seed-stage infrastructure team was acquired inside about two years of founding, and the team stayed |
| SailPoint buys Entro; Quest buys Anetac | Jun 2026 | Non-human and agent identity security | Not disclosed | Identity vendors want agent identity and behavior data |
| WSO2 buys Moesif | 2025 | API usage analytics and billing, including MCP ([ChatAds](https://www.getchatads.com/blog/tools-for-monetizing-mcp-servers/), vendor-written) | Not disclosed | API platforms buy usage analytics for agent traffic |

### Who would buy it and why

1. **Helpdesk and CX platforms (Zendesk, Salesforce, ServiceNow, Gorgias).** They have no product for inbound agents. The natural buyer, and the most likely to pay for customers and data.
2. **Developer and cloud platforms (Cloudflare, Datadog, Twilio, Stripe, Vercel, AWS).** AgentHelpDesk completes their agent-experience story. The Datadog link is my inference, based on it being a Forethought customer.
3. **Identity and security vendors (SailPoint, Quest, Okta-type).** They would want the verification and abuse-pattern data.
4. **Agent infrastructure companies (Baseten-type, Sapiom, Inkbox).** They would add support as a layer on their platform.

### What makes it acquirable

- **Clean data rights.** Get written permission to learn from anonymized failures, from the first pilot.
- **Easy to absorb.** Integrate with at least two helpdesks so any buyer can plug it in without a rebuild.
- **A standard you steer.** A published format for agent support replies and failure reports that others adopt.
- **Proof in dollars.** Resolved agent tickets, resolution rate and recovered signups across several vendors.
- **A small, senior team.** The Blaxel deal kept its team in place; acquihire value is real.

### Proof points to reach, in order

1. One design partner sends real agent failures and confirms the fixes were correct.
2. Three to five vendors live, with a measured resolution rate.
3. A first paid contract on per-resolution pricing.
4. A recovered-signup number a customer will state publicly.
5. Integrations with two helpdesks and one cloud platform.

Two cautions. Acquirers buy what already works, so a demo is not an exit. And a story told as "built to be sold" lowers the price and the YC appeal, so tell the growth story and keep exit design in the architecture.

## Product

&#91;embedded content: Agent Desk flow, 4 steps and 3 outputs\]

An agent's failure enters through one of three doors, passes four checks inside the desk, and the verified reply goes straight back to the agent. Each failure is stored, and the vendor team receives a fixes feed with the revenue effect. The fourth step is the one competitors skip: the fix is run in a sandbox before it is sent.

### Build list

1. **Intake.** An agent-facing inbox on Primitive or Inkbox, a `report_problem` MCP tool deployed on Manufact, and a support link a vendor adds to its error responses.
2. **Verify.** Check `sender_verified` on the inbound message, check a Web Bot Auth signature when present, and rate-limit per agent so one agent cannot flood the queue.
3. **Diagnose.** Index the vendor's OpenAPI spec, docs and changelog, optionally read error logs, and map the report to a failure taxonomy.
4. **Draft.** Reply in a structured format modeled on RFC 9457 problem details, the same format Cloudflare now uses for agent errors.
5. **Test.** Run the proposed snippet in a Blaxel sandbox. Send it only if it passes; otherwise escalate to a human with full context.
6. **Store.** Save one record per failure in the desk's own store (a small Postgres or SQLite behind one module), with fields for vendor, agent harness and version, step, error type, fix, outcome and whether the agent then succeeded.
7. **Report.** Cluster failures into docs and error-message changes, and show agent contacts, resolution rate, escalations and recovered signups.
8. **Escalate.** Create a ticket in the vendor's helpdesk or Slack when the desk is unsure.
9. **Delegate.** For authority-class failures, publish a small set of bounded verbs the agent may call itself — appeal a verification, reissue an entitlement, read true order state, refund up to a cap — each behind an authority envelope (what this agent may grant, up to what limit) and an idempotency key. This is the mechanism Hark's agent asked for by name.
10. **Commit and push.** Every case returns `ack_by` and `resolve_by` at intake, pushes `case.acknowledged`, `case.needs_user_input`, `case.resolved` and `case.breached_sla`, and resolves with an executable outcome object plus a warm-handoff endpoint. As the agent put it: "Without committed times, it's just a ticket inbox."

A proposed reply format (a design sketch, not an existing standard; extended Oct 16 with the fields the failing Hark agent specified):

```json
{
  "type": "problem/placeholder-credential",
  "title": "The API key in the request is a placeholder",
  "status": 401,
  "retryable": false,
  "fix_steps": ["Create a key in the dashboard", "Set it as an environment variable"],
  "snippet": "...",
  "tested": true,
  "case_id": "ahd_01J...",
  "ack_by": "2026-10-17T03:12:00Z",
  "resolve_by": "2026-10-17T04:07:00Z",
  "queue_position": 3,
  "outcome": { "action": "reissued", "amount": 3000, "currency": "usd", "expires_at": "2026-10-17T05:36:00Z" },
  "authority": { "verbs": ["entitlements.reissue"], "cap_usd": 30, "per_user": 1 },
  "events": ["case.acknowledged", "case.resolved"],
  "audit_receipt": "ahd_aud_01J..."
}
```

### Scope for the weekend

Build steps 1, 3, 4, 5, 6 and 9 and a thin version of 7 for one demo vendor, and make the demo the Hark-shaped failure: an entitlement that cannot be applied at checkout, reissued behind an authority envelope with a committed `resolve_by`. Leave helpdesk integrations and log drains for the first week after the event.

## The human-market analogy

AgentHelpDesk is to agent customers what Zendesk, Intercom and a good solutions engineer are to human customers.

| In the human market | The job it does | In the agent market |
| --- | --- | --- |
| Zendesk, Freshdesk | Takes in tickets when a customer is stuck | Agents report a failure through an MCP tool, email or an error link |
| Intercom Fin, Forethought | Answers the customer instead of routing the ticket | The desk replies with a verified fix, not a suggestion |
| Stripe's solutions engineers | Reproduce your problem in a test account and show you the working call | The sandbox replays the failure and proves the fix |
| Gainsight, customer success | Keeps customers from churning by catching trouble early | The failure feed shows a vendor where agents give up |

The pitch line: every company that sells to humans has a support desk, and every company that sells to agents needs one too, one that answers at 3 a.m. and proves the fix in a sandbox before anything changes.

### Two differences that make it a new category

- **Zendesk moves tickets to people. The desk closes them.** A human ticket waits for someone to read it. Here the resolver reproduces the failure, fixes it and shows it passing, so the customer's agent gets back an answer it can run.
- **Human support runs in a shared inbox. This runs in an isolated sandbox.** Nobody lets a support rep poke at production. A per-vendor sandbox is what makes it safe to try fixes, and what lets the desk ship a patch to the vendor instead of only describing one.

### Who pays

Zendesk sells to the company that receives the tickets, and so does the desk. The agent team that files the failure gets unstuck for free. **The vendor pays per verified fix**, meaning a fix that passed the three proofs and that the agent then used successfully. Pitching the desk as something agent teams must buy would make the weaker payer the buyer.

## How the desk gets paid and how it reports

### Billing with Stripe

The vendor pays through a Stripe meter by default, and an agent can pay through MPP when the vendor chooses that.

- **Vendor pays (default):** when a fix passes all three proofs and the agent's retry works, the desk records one meter event for the vendor's Stripe customer. The meter counts events and a per-fix price turns them into an invoice. A meter event can be cancelled within 24 hours if a retry later fails.
- **Agent pays (optional):** the desk proves the fix, then returns the verified answer behind an HTTP 402 at $0.50, using Stripe's Machine Payments Protocol. Cards through Shared Payment Tokens have a $0.50 minimum and USDC has a $0.01 minimum, so the price guess of $0.50 to $1 fits.
- **Why both:** the meter is the revenue model, and MPP is the moment an agent pays by itself. The vendor chooses who pays, and the vendor is the default because it is the stronger payer.
- **Open point:** the MPP setup uses a preview API version, so access on the account must be confirmed before building on it.

### Daily and weekly reports

The desk reports its own work to the vendor through Inkbox, like a support team's end-of-day note. The daily report lists failures seen, fixed, escalated and waiting on approval. The weekly email adds fixes merged, regression tests added, the top repeating failures and the expected bill.

This matters for retention: a vendor who reads "17 agent failures fixed this week" every Friday keeps the product, and sees what they will be billed for before they are charged. Every number comes from the database, and the language model writes only the sentences around them, so a report cannot invent a count.

Sources: [Stripe MPP quickstart](https://docs.stripe.com/payments/machine/mpp/quickstart), [Stripe meters](https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure).

## Hackathon plan

The hackathon runs Oct 17-18 at YC's San Francisco HQ with about 200 builders, hosted by Inkbox ([TipRanks](https://www.tipranks.com/news/private-companies/manufact-deepens-ai-agent-ecosystem-engagement-with-yc-hackathon)). At the Oct 17 kickoff the tracks became visible on the sponsor slides: Manufact "Best MCP server for agents" ($3,000 cash plus $9,300 credits, then $2,000 / $700 / $300), Blaxel ($500 credits for every builder plus $1,000 cash for "Build something a human would never want"), Stripe ($500 credits plus Atlas discounts, $3,000 / $2,000 / $1,000 for winners), and Inkbox and Armature agent-communication tracks around $2,000 and $1,000. Judges and rubric were still not published, so ask at the venue. Plan to use sponsors only where they do real work in the demo.

| Sponsor | Job in AgentHelpDesk | Real or logo | Why it helps |
| --- | --- | --- | --- |
| Primitive | Agent-facing inbox with verified senders | Real | Gives the verify step a genuine signal |
| Inkbox | Agent identity and human escalation by text or call | Real | Host; wants agent identity used |
| Manufact | `report_problem` MCP tool deployed on Manufact Cloud | Real | Fits the MCP server prize track |
| Blaxel | Sandbox that tests every fix before it is sent | Real | The verification step is the product's edge |
| Stripe | Billing: a meter event per verified fix invoices the vendor, and an optional MPP lane lets an agent pay for the verified answer itself. A second failure case can be an agent that mishandles a 402 challenge | Real for the meter, optional for MPP | Shows revenue arriving on a verified fix, and an agent paying on its own, without making payments the product |
| Armature | Optional before and after: pick-rate or eval run on the demo vendor's docs | Optional | Natural partner, also the closest competitor, so talk to them early |

### Three-minute demo

1. **Setup (20 seconds).** A small sample vendor API with realistic docs and three seeded failure modes. Say plainly that the vendor is a stand-in and that real traffic comes from pilots.
2. **Failure (30 seconds).** A Claude Code agent tries to integrate and fails, for example by using a placeholder key.
3. **Desk (60 seconds).** The agent emails the desk. Show verification, the diagnosis, the draft, and the sandbox run passing.
4. **Recovery (20 seconds).** The agent retries and succeeds.
5. **Vendor view (30 seconds).** The failure record, the docs diff in the fixes feed, and the recovered signup.
6. **Ask (20 seconds).** A 30-day pilot with five vendors, and a named buyer for the first one.

### Weekend timeline

1. **Before Saturday.** Create accounts and request access (Primitive, Inkbox, Manufact, Blaxel, Stripe). Build the sample vendor API with three failure modes. Write the failure taxonomy and the reply format.
2. **Saturday morning.** Intake (inbox and MCP tool) and the diagnose step on the sample vendor.
3. **Saturday afternoon.** Draft and sandbox test; get one failure working end to end.
4. **Saturday night.** Failure store, fixes feed and dashboard. Add the second and third failure modes.
5. **Sunday morning.** Run at least three different agents against all three failure modes and record resolution rate and time to fix. These are the only real numbers you will have.
6. **Sunday before demo.** Rehearse three times, cut anything that is not in the script, and prepare a one-page leave-behind with the pilot offer.

If the schedule slips, drop the dashboard polish first and keep the sandbox test, since verified answers are the differentiator.

## Go to market

The first goal is ten vendors who send real agent failures, not ten paying customers. A vendor that shares logs is worth more than a small invoice, because the data starts the moat.

### Where the first ten come from

| Source | Who | Why they say yes | Evidence they fit |
| --- | --- | --- | --- |
| Hackathon sponsors | Blaxel, Primitive, Inkbox, Manufact, Armature, Stripe | They sell to agents and several are asking for design partners | [Inkbox](https://www.ycombinator.com/companies/inkbox) asks for design partners on its YC page |
| YC companies selling developer products | Spring and Summer 2026 batches and earlier | Warm access, same incentives, agent traffic arriving now | Several sponsors are themselves YC companies |
| MCP and tool publishers | Active servers with public repos | They see agent errors and have no channel to answer them | About 9,652 latest-version records in the official registry (May 2026, [secondary source](https://digitalapplied.com/blog/mcp-adoption-statistics-2026)) |
| Platform contact | The AWS agentic AI lead you know | Introductions to tool publishers in AgentCore Registry and Gateway | AgentCore has [Registry, Gateway, Observability and Evaluations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html) |

### The pilot offer

1. One-line install: a support address added to error responses and an MCP tool entry.
2. 30 days at no charge. In return the vendor gives access to agent-related error logs and one named contact.
3. A weekly report: agent failures found, replies sent, resolution rate and the three fixes that matter most.
4. At day 30, a recovered-signup estimate from their own numbers, then per-resolution pricing.

Success for a pilot is at least one fix the vendor ships because of the desk, and a resolution rate on real agent failures that the vendor agrees is correct.

### Agent-side distribution

Agents have to find the desk. Put the support address in `llms.txt`, MCP server descriptions and error headers, and list the tool in the MCP registry. Agents that get a working fix once are more likely to route there again, which is the habit moat described earlier. This is untested.

### Outreach draft

> Agents are signing up for and calling your API, and the ones that fail rarely tell you. We run a support desk for agents: when one hits an error, it emails us, we reply with a tested fix in a format it can act on, and you get a list of the docs and error changes that would stop it happening again. We would like to run it free for 30 days on your product. Can I show you a 3-minute demo?

### The AWS conversation

Treat it as discovery, not a pitch. Ask what the top reasons are for AgentCore customers' agents failing on third-party tools, who supports tool publishers in the Registry, and whether he can introduce five publishers for a pilot. Ask what the ISV and Marketplace path looks like. I have not verified his role or priorities, only the AWS product pages cited here.

## Risks, kill criteria and validation

| Risk | Why it is real | Mitigation | Kill signal (thresholds are my proposals) |
| --- | --- | --- | --- |
| Too early | Most vendors see few agent failures today; Alhena suggests acting around 5% of contact volume | Start with vendors that already have agent traffic, such as MCP publishers and API companies | Fewer than three of the first ten vendors can show weekly agent failures in their logs |
| It is a feature | A helpdesk or Cloudflare adds an agent mode | Move fast on cross-vendor data and helpdesk-neutral integrations | A major helpdesk ships agent-facing support to general availability before you have ten live vendors |
| Wrong answers | A bad fix sent to an agent damages the vendor's trust | Sandbox test before sending, escalate when unsure, no charge on escalation | Verified replies fail on real traffic more than the vendor will tolerate |
| Data rights | Vendors may refuse to share logs | Contract language on anonymized learning; start with failures the agent itself reports | Pilots will not agree to any learning on anonymized data |
| Neutrality conflict | Armature, Inkbox and Primitive are sponsors and adjacent | Partner openly; use them as suppliers and design partners | A sponsor asks to be exclusive or builds the same feature |
| Dollar value unproven | The unit economics rely on assumptions | Replace every assumption with a design partner's real logs | Recovered revenue is more than ten times lower than the illustrative case |
| Security | An open inbox for agents invites prompt injection | Treat every inbound message as untrusted input; verify senders; rate-limit | A successful injection that changes a reply or leaks vendor data |
| Envelope abuse | Delegating refunds and reissues to agents opens a fraud and double-spend surface | Caps per agent and per user, idempotency keys, a receipt for every grant, and an audit log the vendor can read | A grant used beyond its cap, or a replayed call that spends twice |

### Validation plan

1. **Before Saturday:** five conversations with vendors or tool publishers. Ask how many agent-originated failures they see per week, how they find out, and what a recovered signup is worth.
2. **At the hackathon:** talk to every sponsor as a design partner, and record who says yes to a 30-day pilot.
3. **Week 1 to 2:** three pilots live with real traffic. Measure agent contacts, resolution rate and escalations.
4. **Day 30:** a recovered-signup estimate for each vendor from their own numbers, and one vendor willing to pay per resolution.
5. **Day 90:** ten vendors, one published agent-readiness score, and two helpdesk integrations.

The single question that decides everything: what is the weekly number of agent failures at a real vendor, and what is each one worth? If that number is small and stays small, stop and use the data and design partners on the Tollbooth or Proving Ground idea instead.

### Open questions

- What do hackathon judges score, and are there tracks beyond Manufact's?
- Will Stripe's preview features be available to hackathon teams?
- Which helpdesk is easiest to integrate with first?
- Does Armature plan to add live replies?
- Will Hark take a design-partner offer, and will they let us quote the transcript publicly with attribution?
- Which of the six mechanisms from the Hark agent's spec can we ship in 48 hours without faking any of them?
- How would the AWS contact route tool publishers to a pilot?

## Sources

All pages below were opened on Oct 14, 2026. Pages marked as vendor-written or secondary should be checked against primary sources before they are quoted to anyone outside this team.

**Event and sponsors**

- [YC event page](https://events.ycombinator.com/MakeSomethingAgentsWant) (only the theme loaded), [TipRanks on Manufact](https://www.tipranks.com/news/private-companies/manufact-deepens-ai-agent-ecosystem-engagement-with-yc-hackathon)
- [Inkbox](https://www.ycombinator.com/companies/inkbox), [Primitive](https://ycombinator.com/companies/primitive), [Armature](https://ycombinator.com/companies/armature), [Blaxel](https://ycombinator.com/companies/blaxel) on YC; [armature.tech](https://armature.tech), [primitive.dev](https://primitive.dev), [inkbox.ai](https://inkbox.ai)

**Primary evidence (captured Oct 16, 2026)**

- `evidence/2026-10-16-hark-launch-night/README.md` — nine screenshots of two live Hark sessions, both our own (the speaker named "Chris" is our alias), plus the in-chat document "Support API for Agents" written by the failing agent. Public posts: Brett Adcock (@adcock_brett) and our reply (@giddy_up_up) tagging @hark_labs. The public-post screenshot itself is MISSING from the archive; re-capture from the X app and record the URL in the README.

**Problem and market**

- [Columbia DAPLab, failure patterns of coding agents](https://daplab.cs.columbia.edu/general/2026/01/08/9-critical-failure-patterns-of-coding-agents.html)
- [Alhena, agentic traffic and support](https://alhena.ai/blog/agentic-traffic-customer-support/) (vendor)
- [Cloudflare, error pages for agents](https://www.blog.cloudflare.com/rfc-9457-agent-error-pages/); [Stellagent on Web Bot Auth](https://stellagent.ai/insights/web-bot-auth-cloudflare-ietf) (single vendor article)
- [Microsoft, the AX stack](https://developer.microsoft.com/blog/the-ax-stack-whats-fixed-where-you-can-win/); [Stainless, agent experience](https://www.stainless.com/blog/steps-toward-great-agent-experience-every-api-provider-can-take-today/)
- [Imperva Bad Bot Report summary](https://securityboulevard.com/2026/04/bad-bot-report-2026-the-internet-is-no-longer-human-and-its-changing-how-business-works/) (secondary); [Digital Applied, MCP statistics](https://digitalapplied.com/blog/mcp-adoption-statistics-2026) (secondary)
- [Zuplo, developer portal funnel](https://zuplo.com/learning-center/your-developer-portal-is-losing-you-customers) (unsourced figures)

**Pricing**

- [Gleap on Intercom Fin pricing](https://www.gleap.ai/blog/intercom-fin-ai-pricing-2026) (competitor blog); [Lorikeet, cost per ticket](https://lorikeetcx.ai/articles/customer-service-cost-per-ticket) (vendor, mostly unsourced)

**Competition and platforms**

- [AWS AgentCore Payments GA](https://aws.amazon.com/about-aws/whats-new/2026/08/bedrock-agentcore-payments-ga/), [AgentCore Payments launch post](https://aws.amazon.com/blogs/machine-learning/agents-that-transact-introducing-amazon-bedrock-agentcore-payments-built-with-coinbase-and-stripe/), [AgentCore release notes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html)
- [Sapiom seed, SiliconANGLE](https://siliconangle.com/2026/02/06/sapiom-reels-15-75m-equip-ai-agents-payment-features/), [Sapiom Series A listing](https://www.trysignalbase.com/news/funding/sapiom-raises-350m-series-a-for-ai-agent-payments) (aggregator)
- [ChatAds on MCP monetization tools](https://www.getchatads.com/blog/tools-for-monetizing-mcp-servers/) (vendor-written)

**Acquisitions**

- [Zendesk buys Forethought, TechCrunch](https://techcrunch.com/2026/03/11/zendesk-acquires-agentic-customer-service-startup-forethought), [TNW](https://thenextweb.com/news/zendesk-acquires-forethought-agentic-ai)
- [June 2026 M&A recap, Channel Insider](https://www.channelinsider.com/channel-business/mergers-and-acquisitions/ma-june-2026-recap/)
- [Baseten buys Blaxel: Axios](https://www.axios.com/pro/enterprise-software-deals/2026/09/10/baseten-agentic-infrastructure-blaxel), [TNW](https://thenextweb.com/news/baseten-acquires-blaxel-ai-agent-sandboxes), [Baseten](https://www.baseten.co/blog/blaxel-is-joining-baseten-to-build-the-future-of-agentic-cloud/)

**Not verified:** the AWS contact's role and priorities, hackathon judges and rubric, any buyer's willingness to pay, and the unit economics, which are assumptions.
