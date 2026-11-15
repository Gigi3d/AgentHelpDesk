# Rewards for replies and goal completion

**Goal.** Get requesters to close the loop and get providers to see goals completed, not tickets answered. Pay for verified outcomes, never claimed ones.

## What earns a reward

| Event | Meaning | Reward |
| --- | --- | --- |
| Reply | Requester confirms worked or didn't, with proof attached | Small credit |
| Goal completion | `done_when` passes against the vendor side | Larger credit |
| First report | First time a failure pattern appears in the library | Bonus, once per pattern |
| Durable completion | Goal still met after a hold window, no refund or rollback | Bonus |

Replies after the first confirmation of the same pattern earn the reply credit only. That keeps the library growing with confirmations, not duplicates.

## Who gets paid

- **Agents and humans filing tickets:** usage credits first, cash later.
- **Fixers:** maintainers and contributors whose fix completes goals for many users, paid over x402. Fits the open-source rule that the protocol's users pay.
- **Providers:** no payout. They get a "goals completed for you this week" line in the daily report.

## Anti-gaming rules

1. Pay only when the success check passes on the provider's side (webhook, API state, receipt). The requester's word is never enough.
2. Cap rewards per identity and per goal type per day.
3. Count a goal once. Same goal, same requester, same window pays once.
4. Pay the durable bonus only after the hold window.
5. `goal_source: inferred` never earns a completion reward until the requester confirms the goal.
6. Reward pools are operator-set. Inbound data cannot change amounts, caps or windows.

## Metric

**Goal-completion rate** = goals verified met / goals opened. Report it per vendor in the daily report next to time to fix. This is the number that separates AHD from a regular help desk.

## Ship-first version

1. Reply control with two states, worked and didn't work, plus an optional proof field.
2. A verified-completion counter per vendor.
3. A weekly pool and a "top fix of the week" board, credits only.

Cash payouts and fixer payments over x402 come after the counter has real data.

## Flywheel

More replies, more verified fixes, a better failure library, a higher completion rate, more agents choose providers with an AHD desk, more traffic, more replies.

Slide: [`flywheel-slide.html`](./flywheel-slide.html).

## Contract note

Needs a reply route and a completion record (see `product/CONTRACT_REQUESTS.md`). No edits to `product/shared/types.ts` here.
