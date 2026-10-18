# Addendum to "API Reliability: AgentHelpDesk plus Self-Maintaining APIs"

Oct 16, 2026 · @Gmoney · appended to the frozen PDF export; the PDF itself is unchanged.
Evidence base: `evidence/2026-10-16-hark-launch-night/README.md`.

## What the deep dive got right, and what it missed

The deep dive's core claim is that one engine serves two triggers: an agent failing on an API, and a provider shipping a breaking change. Both reduce to "the provider's repo, config or state must change, and the change must be proven before it ships." That claim survives the Oct 16 evidence intact.

What the deep dive missed is that not every failure has a fix in the provider's repo. Hark's launch night produced a failure whose cause was a **policy grant**: one card per person, no reissue, a verification rejection with no appeal. The vendor's agent diagnosed it correctly and attributed it correctly — "the snag is on our end applying it at checkout" — and still had no action available, because the action was a grant only the vendor could give. The deep dive's engine has no output for that case. Its ship gate emits a reply and a patch. It needs a third output: **a delegation**.

## The engine gains a third output

| Trigger | Old outputs | New output |
| --- | --- | --- |
| Agent fails, cause is knowledge or code | Verified reply; proven patch to the provider's repo | unchanged |
| Agent fails, cause is a policy grant | (none — the loop escalated to a human and waited) | An authority envelope: a bounded verb, a cap, a per-user limit, an idempotency key, a receipt, and a committed `resolve_by` |
| Provider ships a breaking change | Proven migration patches to customer repos | unchanged |

The envelope is not a workaround for the loop; it is the loop's answer when the diff is empty. The three proofs still apply in adapted form: the replayed entitlement application now succeeds, the provider's tests still pass with the envelope config in place, and a fresh clean-context agent completes the order using only the published verb and its docs.

## This unifies the two products more tightly, not less

The deep dive argued Desk and migration are one engine because both move a proven change into a repo the customer does not control. The authority class strengthens that argument: a grant is also a change to state the customer cannot make, mediated by proof and approval. The single invariant becomes: **nothing changes and nothing is granted without a proof, a receipt and a deadline.** That is a cleaner statement of the company than either half alone, and it is the sentence to lead with.

## Contract deltas carried into the engine

- Intake returns `case_id`, `ack_by`, `resolve_by` and queue position immediately. Polling becomes a fallback, not the design.
- Push topics per case: `case.acknowledged`, `case.needs_user_input`, `case.resolved`, `case.breached_sla`.
- Resolution is an executable object — `{action, amount, expires_at}` — not prose.
- `POST /cases/{id}/handoff` and `DELETE /users/{id}/data` with a receipt close the two consumer-side gaps the Hark transcript exposed.
- Every grant and every desk action writes a receipt; the audit log is the reliability story made visible to the end user, not only to the provider's dashboard.

## What this does not change

The migration half is untouched: same sandbox, same proofs, same merge-rate economics. The billable rule is untouched: all three proofs true and the agent's retry succeeded. Grants are not separately billable; a grant that leads to a successful retry is part of the verified fix it enabled.

## Open question the addendum raises

Whether an envelope grant counts as "the desk's fix" for the purposes of the provider's approval gate. The Build Plan's answer for the weekend: yes, envelope changes go through the same approval text as config changes, because a cap is a policy decision and policy decisions belong to a human.
