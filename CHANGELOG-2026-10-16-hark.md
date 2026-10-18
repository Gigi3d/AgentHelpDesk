# Changelog — Hark evidence propagation, Oct 16 2026

One night of primary evidence (Hark's launch night, captured ~7:33–8:24 p.m. PT) plus the failing agent's own six-part "Support API for Agents" spec was folded into every document in this package. This file lists what changed and why, and what is still open.

## The idea-level change

- **A third failure class: authority.** Knowledge failures and code failures can sometimes be self-fixed by a coding agent. Authority failures — a policy grant the agent does not hold — provably cannot. Hark's agent had the correct diagnosis and the correct attribution ("the snag is on our end") and still had nothing to call but `support@hark.com`.
- **AHD is therefore the delegation layer:** the place where a provider hands an agent bounded authority, with proof and a deadline. The engine gains a third output alongside the verified reply and the proven patch: an authority envelope (bounded verb, cap, per-user limit, idempotency key, receipt).
- **The reply contract grew** to what the failing agent asked for: `case_id`, `ack_by`, `resolve_by`, queue position at intake; pushed `case.acknowledged / case.needs_user_input / case.resolved / case.breached_sla`; an executable `outcome` object; `POST /cases/{id}/handoff`; `DELETE /users/{id}/data` with a receipt; and a user-visible audit log (free, from the Frontend Plan's `tool_events` table).
- **Two claims were corrected, not just extended.** "Agent failures are silent" is wrong: they are loud to the user and silent to the engineering team. And the unverified "agent traffic exceeds human traffic" line was cut from the YC application's Why now and replaced with the citable incident.
- **Privacy position:** both Hark sessions are Gideon's own; "Chris" in the transcript is his alias. Everything in `evidence/2026-10-16-hark-launch-night/` is quotable. When external: label the speaker as an alias and redact the Gmail address visible in the raw screenshots.

## Files created

| File | What it is |
| --- | --- |
| `evidence/2026-10-16-hark-launch-night/README.md` | The evidence record: sources, both sessions verbatim, the six-part spec verbatim, what it proves and does not, consequences, inventory, handling rules |
| `evidence/2026-10-16-hark-launch-night/IMG_6103.jpg … IMG_6111.jpg` | Nine archived screenshots |
| `deck-source/slides/hark.html` | New opening evidence slide (slide 2) |
| `deck-source/slides/spec.html` | New slide: the failing agent's spec (slide 6) |
| `deck-source/base.css` | The host CSS the fragments always assumed: reset, table and list styling, positioned ancestor for the footers, notes overlay, print rules |
| `deck-source/build.py` | Builds `index.html` and `index-notes.html` from `deck.json` order |
| `deck-source/index.html`, `deck-source/index-notes.html` | Self-contained presentable deck (19 slides, keyboard nav, N for notes, F for fullscreen) |
| `AgentHelpDesk Build Plan.md` | Living source for the frozen docx, rebuilt with the deltas |
| `YC Application AgentHelpDesk (Draft).md` | Living source for the frozen PDF, rebuilt with the deltas |
| `API Reliability … — Addendum 2026-10-16.md` | Delta for the frozen deep-dive PDF |
| `YC Make Something Agents Want Sponsor Briefs — Addendum 2026-10-16.md` | Delta for the frozen sponsor-briefs PDF |
| `CHANGELOG-2026-10-16-hark.md` | This file |

## Files edited

**Deck (`deck-source/`)**

- `deck.json` — order is now cover, hark, loop, silence, analogy, spec, insurance, desk, proofs, modes, night, report, reverse, payer, flywheel, rivals, risks, team, ask. `scene` and `now` are dropped from the order (files kept on disk, unbuilt). Section descriptions updated.
- `slides/hark.html` — new; sourcing footer states the sessions are ours and not a composite.
- `slides/spec.html` — new.
- `slides/cover.html` — the ADHD acronym pun moved off the cover into the speaker notes as an explicitly-flagged optional verbal icebreaker; cover now carries the authority line.
- `slides/silence.html` — rewritten to carry the three failure classes with the authority card highlighted.
- `slides/loop.html` — closing line now "the provider finds out on a public post, not in a dashboard"; aside scopes the 401 as the knowledge/code class.
- `slides/insurance.html` — "you learn from churn" corrected to "you learn from the fallout"; aside pre-empts the judge pushback.
- `slides/desk.html` — step 1 returns a case with committed ack/resolve-by; step 5 hands back an executable outcome; aside names the envelope.
- `slides/proofs.html` and `slides/payer.html` — billable condition now includes "and the agent's retry succeeds", consistently in both.
- `slides/night.html` — retitled so the callback is unambiguous; 3:07 row carries the deadline; aside says the live demo runs the Hark-shaped failure instead.
- `slides/report.html` — added a grants-under-envelope row and a matching "what it tells you" line.
- `slides/rivals.html` — replaced the migration-tool table with the desk-competitor table (Zendesk/Salesforce-Fin, Armature, Cloudflare, AWS AgentCore, in-house); Fern/Stainless kept in the aside as exit evidence.
- `slides/risks.html` — risk 1 narrowed: settled for authority, open for knowledge/code; aside states what Friday did and did not prove.

**Living markdown**

- `AgentHelpDesk Research Dossier.md` — update line and new pitch anchor; claim 1 gains the three classes; problem section retitled; new "A live case: Hark, launch night" subsection with the verbatim quote, the three-class table and two honest limits; market table gains the direct-observation row; ecommerce moved from Second to co-first; build list gains items 9 (Delegate) and 10 (Commit and push); reply JSON extended; weekend scope names the Hark-shaped demo; new "envelope abuse" risk row; two new open questions; new primary-evidence source block.
- `AgentHelpDesk Frontend and Product Surface Plan.md` — update line; surface 6 job and scope; ticket page gains a grants-and-audit block; `report_problem` table gains `ack_by`/`resolve_by`, `queue_position`, `outcome`, `authority`, `events` with a note that `wait` is now the fallback; new agent-facing sections 5 (authority envelope verbs table) and 6 (push, handoff, deletion); new rule that grants are the tightest thing in the product; build order 2 and new order 10; two new open questions; new risk row; evidence source.
- `README.txt` — rewritten to point at living sources first and the frozen exports second.

## Verified while doing this

- All 19 built slides fit 1920×1080 with no overflow (measured in a real browser; max content bottom 1016px, which is the absolute footer at `bottom:64px`).
- The deck renders correctly standalone: fonts load, tables align left with real cell padding, absolute footers anchor to their slide.
- Oct 16 2026 is a Friday; Oct 17–18 are Saturday–Sunday, so "Friday night" and "tomorrow" in the posts and slides are consistent.

## Still open, in priority order

1. **Re-capture the public X post screenshot** from the X app and record its URL in the evidence README. The original lived in a macOS temp path that was cleaned. Do not reconstruct it from memory.
2. **Fill `[email]`** in `deck-source/slides/ask.html` and choose the email for the YC form.
3. **Fill the co-founder brackets** in `deck-source/slides/team.html` and the YC application, in writing, only once people have agreed.
4. **Run the self-fix kill test** (3 coding agents × 10 real APIs, sorted by failure class). Hark settled existence and shape, not base rate.
5. **Compute the unit cost of one proof-run** against the $0.50–$1 price. Still uncomputed everywhere.
6. After the hackathon, add the "what ran live vs what was planned" slide the Frontend Plan promises, from the real result.
