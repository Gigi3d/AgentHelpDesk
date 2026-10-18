AgentHelpDesk (AHD) package index
Last updated Oct 17, 2026. Start with README.md for the product, then
CHANGELOG-2026-10-16-hark.md for the night that changed the design.

WHAT IS HERE

Code
- product/  the desk itself. A dependency-free node:http API on 127.0.0.1:8787:
            intake, sandbox reproduction, three proofs, the approval gate, ship,
            billing. product/README.md explains the layout and how to run it.
- web/      the provider console, the agent-facing surfaces, the install ladder,
            approval by phone and the staff dashboard. web/README.md explains its
            two data modes.
- mcp/      the thin MCP edge an agent calls: report_problem and
            report_retry_result. mcp/README.md has the contract and the error table.

Docs, all living sources. Edit these, not any export.
- CHANGELOG-2026-10-16-hark.md  the Oct 16 change: the Hark launch-night failure,
            the three failure classes, the authority envelope, two claims that were
            corrected rather than extended, and the open items in priority order.
- AgentHelpDesk Build Plan.md   the pitch, the product behaviors that shape the
            build, the prize tracks, and the fact-check behind each sponsor row.
- AgentHelpDesk Research Dossier.md  the market and competitor research, updated in
            place with the Oct 16 primary evidence.
- AgentHelpDesk Frontend and Product Surface Plan.md  the eight surfaces, the case
            contract, and the bounded self-fix verbs. Updated in place.
- API Reliability AgentHelpDesk plus Self-Maintaining APIs - Addendum 2026-10-16.md
            the addendum that adds the third output, a delegation, to the engine.
- YC Make Something Agents Want Sponsor Briefs - Addendum 2026-10-16.md
            per-sponsor deltas and the closing demo beat.

Two of those filenames use a plain hyphen where the frozen PDF exports use a long
dash. The rename is deliberate, so this package can be indexed without any file
name carrying a character that breaks shells and links.

WHAT IS NOT HERE, AND WHY

- evidence/  the raw screenshots from Hark's launch night. Both sessions are
  Gideon's own and the speaker named "Chris" is his alias, but the images still
  show a Gmail address that has to be redacted before any of them is published.
  The local package keeps them; this repo does not.
- YC Application AgentHelpDesk (Draft).md  a private submission.
- deck-source/  the slide deck. A presentation, not part of the code or the docs.
- The frozen .docx and .pdf exports of the Oct 14-15 versions, and the claude.ai
  artifact copies of the same. All are superseded by the .md files above.

The local working package still holds every one of those. Nothing was deleted,
only left unpublished.

PRIVACY RULE FOR THE EVIDENCE

Everything in the local evidence folder is quotable in text. Before publishing any
raw image, redact the Gmail address visible in the screenshots. When quoting a
transcript externally, label the speaker as an alias rather than by the name used
in the chat.
