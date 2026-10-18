/**
 * Turns one case's recorded events into the ten steps the Case Theater shows.
 * Pure: it reads only what the desk stored (tool events, outcome, approval),
 * so nothing on screen is invented. A step with no matching event is pending.
 */
export type StepKey = 'create' | 'reproduce' | 'draft' | 'replay' | 'tests' | 'fresh' | 'approval' | 'ship' | 'retry' | 'bill';
export type StepState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface Ev {
  id: string;
  stage: string;
  tool: string;
  action: string;
  t_ms: number;
  d_ms: number;
  result: string;
  payload: unknown;
  at: string;
}

export interface CaseLike {
  status: string;
  events: Ev[];
  outcome: { agent_retry_ok?: boolean | null; billable?: boolean } | null;
  approval: { decision: string | null } | null;
}

export interface Step {
  key: StepKey;
  title: string;
  caption: string;
  state: StepState;
  event: Ev | null;
  ms: number | null;
  at: string | null;
  note: string | null;
}

interface Def {
  key: StepKey;
  title: string;
  caption: string;
  actions: string[];
}

export const DEFS: Def[] = [
  { key: 'create', title: 'Open a private sandbox', caption: 'A fresh Blaxel sandbox, named for this case, holds a copy of the vendor repo.', actions: ['sandbox.provisioned'] },
  { key: 'reproduce', title: 'Make the failure happen again', caption: 'The agent’s exact call is replayed. It has to fail the same way before anything changes.', actions: ['case.reproduced'] },
  { key: 'draft', title: 'Claude drafts the fix', caption: 'Claude reads the vendor’s real files and rewrites the doc, error text or config.', actions: ['case.fix_drafted', 'resolver.draft', 'resolver.reused'] },
  { key: 'replay', title: 'Replay the call on the fix', caption: 'The same call, against the fixed files. It must now succeed.', actions: ['proof.replay'] },
  { key: 'tests', title: 'Run the vendor’s own tests', caption: 'The vendor’s test suite runs in the sandbox. A fix that breaks it does not ship.', actions: ['proof.vendor_tests'] },
  { key: 'fresh', title: 'A fresh agent tries from the docs', caption: 'A clean copy of the sandbox and an agent that sees only the task and the fixed docs.', actions: ['proof.fresh_agent'] },
  { key: 'approval', title: 'A person approves', caption: 'Riskier changes wait here for one reply from the vendor’s approver.', actions: ['approval.decided', 'approval.requested', 'gate.auto_green'] },
  { key: 'ship', title: 'Ship the fix', caption: 'The agent gets the verified answer. The vendor gets a PR note and a regression test.', actions: ['ship.emitted', 'case.resolved'] },
  { key: 'retry', title: 'The agent retries', caption: 'The agent runs its original call again with the fix applied. This is the real test.', actions: [] },
  { key: 'bill', title: 'Bill only if it worked', caption: 'One Stripe meter event, only when all three proofs passed and the retry succeeded.', actions: ['meter_event.created', 'mpp.settled', 'billing.not_billable', 'billing.exempt'] },
];

const lastOf = (events: Ev[], actions: string[]): Ev | null => {
  let found: Ev | null = null;
  for (const e of events) if (actions.includes(e.action)) found = e;
  return found;
};

const bad = (r: string) => r === 'error' || r === 'fail' || r === 'failed';

export function deriveSteps(c: CaseLike): Step[] {
  const steps: Step[] = DEFS.map((d) => {
    const ev = lastOf(c.events, d.actions);
    let state: StepState = ev ? 'done' : 'pending';
    let note: string | null = null;
    if (ev && bad(ev.result)) state = 'failed';
    if (ev && ev.result === 'skipped') state = 'skipped';
    if (d.key === 'approval') {
      const dec = c.approval?.decision ?? null;
      if (ev?.action === 'approval.requested' && dec !== 'yes' && dec !== 'no') state = 'active';
      if (dec === 'yes') state = 'done';
      if (dec === 'no') {
        state = 'failed';
        note = 'The approver said no.';
      }
      if (ev?.action === 'gate.auto_green') note = 'Safe change, no approval needed.';
    }
    if (d.key === 'retry') {
      const ok = c.outcome?.agent_retry_ok;
      state = ok === true ? 'done' : ok === false ? 'failed' : 'pending';
      note = ok === true ? 'The retry returned success.' : ok === false ? 'The retry failed again.' : null;
    }
    if (d.key === 'bill' && ev) {
      note = ev.action === 'meter_event.created' ? 'Billed.' : ev.action === 'mpp.settled' ? 'Paid by the agent.' : 'Not billed.';
    }
    return { key: d.key, title: d.title, caption: d.caption, state, event: ev, ms: ev ? ev.d_ms : null, at: ev ? ev.at : null, note };
  });
  if (c.status !== 'closed' && c.status !== 'escalated' && !steps.some((s) => s.state === 'active')) {
    const next = steps.find((s) => s.state === 'pending');
    if (next) next.state = 'active';
  }
  return steps;
}

export const isTerminal = (status: string) => status === 'closed' || status === 'escalated';
