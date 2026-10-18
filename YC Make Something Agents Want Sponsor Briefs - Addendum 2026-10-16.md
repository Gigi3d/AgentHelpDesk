# Addendum to "YC Make Something Agents Want — Sponsor Briefs"

Oct 16, 2026 · @Gmoney · appended to the frozen PDF export; the PDF itself is unchanged.
Evidence base: `evidence/2026-10-16-hark-launch-night/README.md`.

The sponsor necessity test in the Build Plan still holds: a sponsor earns its place only if removing it breaks a step of the loop or the demo. The Hark evidence changes what the demo's closing beat is, which changes which sponsors carry the moment that matters.

## Per-sponsor deltas

**Manufact (intake, Best MCP Server track).** `report_problem` now returns `ack_by`, `resolve_by` and queue position at intake, and the reply carries an executable `outcome` plus the `authority` block. This is a stronger prize story than before: an MCP tool that answers a failing agent with a committed deadline and a bounded grant, not a suggestion. Keep the inspector and per-deploy evals in the demo; the eval that matters on stage is "does the returned JSON contain a resolve_by".

**Blaxel (sandbox, proofs).** The envelope demo runs inside the same per-vendor sandbox: the seeded entitlement failure is reproduced, the envelope config is applied on a branch, and the replay proof shows the order completing. No new dependency; the grant path simply reuses the sandbox. The 60-second exec cap still applies — start the order-completion replay without waiting on it.

**InsForge (dropped Oct 17).** Ledgerly's entitlement store and the envelope config no longer live on InsForge. Ledgerly is a plain Node repo on GitHub; the envelope config ships as a config file in the repo, and the grant path is proven by the three proofs plus a git branch and PR — the same ship path we sell. If we want agent-provisioned infrastructure back later, Stripe Projects is the sponsor-native route.

**Inkbox (approval gate, reports).** The approval text for an envelope grant must state the cap and the per-user limit in the first line, because a human is approving a spend limit, not a diff. Add `case.breached_sla` to the alerts Inkbox carries: a missed deadline is the one event that should page the provider.

**Primitive (fallback intake).** Unchanged. Note that the Hark transcript's worst moment — an agent telling a user to email support to delete their own account — is exactly the failure mode Primitive's verified-sender email lane exists to catch, so keep it in the demo as the "before" state.

**Armature (partner, not dependency).** Its evals are the natural third-party check on the grant path: does a fresh agent use the envelope correctly and stop at the cap? That is a concrete partner ask for the event, and it converts the closest startup competitor into a reviewer.

**Stripe (billing).** Unchanged rule: one meter event per billable outcome, billable = all three proofs true and the agent's retry succeeded. Grants are not separately billable. The MPP lane remains optional and cut-first.

## The demo's closing beat

Old closer: failure 3, the scope grant, paused behind an approval text. New closer: Ledgerly seeded failure 4 — an entitlement that will not apply at checkout, a green success chip on a failure, "contact support" as the only path — resolved by publishing `POST /entitlements/{id}/reissue` behind an envelope with a committed `resolve_by`, after which the demo agent retries and the order completes. Sponsors carried: GitHub (the branch), Blaxel (the replay), Manufact (the tool), Inkbox (the approval), Stripe (the meter event). Every sponsor is on stage in the last ninety seconds, which is the point of the necessity test.

## Honesty note for sponsor conversations

Failure 4 mirrors a real incident at another company on Oct 16 2026. Say that it mirrors one; do not present the seeded failure as the real one, and do not name the other company in a sponsor conversation without checking first — Hark is a design-partner lead, not a reference customer yet.
