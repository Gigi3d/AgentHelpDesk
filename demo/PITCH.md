# Pitch

## One minute: how it works

When an agent calls an API and fails, it has no one to ask. The docs are wrong, the error names no field, or it was never granted access. Today it retries, guesses or gives up.

AgentHelpDesk is the support desk for that agent. The agent sends the failing call. The desk opens a case with a committed deadline and spins up a private Blaxel sandbox for it. It replays the exact call and watches it fail again. Claude reads the vendor's real files and drafts a fix.

Then the fix has to earn its way out. Three proofs: the original call now passes, the vendor's own tests pass, and a fresh agent that sees only the fixed docs succeeds. If all three are green, the fix ships on its own. No human approves anything. The agent retries and gets through.

The vendor pays only when the agent actually succeeded, one Stripe meter event per verified fix. And the desk remembers: the next agent that hits the same failure gets the proven fix with no model call, and the proofs run again anyway.

## Two minutes: demo story

**0:00, the problem.** An agent tries to buy a paid report from Ledgerly over x402. It gets a 402, pays the way the quickstart says, and gets a 402 again. It is stuck. The quickstart names the wrong header.

**0:20, the desk.** Open the console. The sidebar shows the Blaxel rack: the desk sandbox as one blue tile, the rest free. On x402 scenarios, click Run 4 as agent alpha. Four failures land at once: wrong header, wrong network, short amount, stale quote.

**0:40, Blaxel.** Four tiles wake in the sidebar, one sandbox per case. Open Case Theater on one. Watch it reproduce the 402, Claude draft the fix, then the three proofs tick green in a clean sandbox copy. Point out there is no approval step: three green proofs, it ships.

**1:10, the agent wins.** The agent retries, gets 200 and a receipt. One Stripe test meter event appears under Billing, only because the retry worked.

**1:25, memory.** Back on x402 scenarios, click Run again as agent beta. Same four failures, a different agent. Every row says "memory hit, no model call", and the proofs still run. Open Fix memory: four proven fixes, each with its reuse count. Hit Wake on one: the sandbox comes out of standby in milliseconds with the fixed document intact.

**1:45, state and sources.** Open Blaxel: live sandboxes against the plan limit, call timings, delete buttons. Open Armature: its open issues become cases the same way. Say that the desk's state survives a restart and a standby, and that a deleted sandbox restores from backup.

**1:55, close.** Agents do not need a nicer error page. They need a desk that fixes the problem, proves it, and only gets paid when it worked.
