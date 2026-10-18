import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ticketsJson from '../data/tickets.json';
import eventsJson from '../data/tool_events.json';
import agentsJson from '../data/agents.json';
import type { Agent, Grant, Stage, Ticket, ToolEvent } from './types';
import { now } from './clock';
import {
  API_BASE,
  ApiError,
  affectedAgents,
  caseViewToTicket,
  endpointOf,
  failureToTicket,
  getCase,
  handoffCase,
  listCases,
  priceBookOnce,
  priceUsdFor,
  replyApproval,
  runCase,
  toEvents,
  type CaseView,
  type Failure,
} from './api';

/** An event as it lives in the running app: fixture event plus an absolute time. */
export interface LiveEvent extends ToolEvent {
  at: number;
}

export const HERO_ID = 'ahd_01JBH4RK7Q';

/**
 * VITE_LIVE=1 reads cases and tool_events from the desk API (product/server.ts)
 * instead of the fixtures. That API is request/response only — there is no stream
 * to follow — so live mode polls it. Fixture mode stays the default so the demo
 * never depends on a running server.
 */
export const LIVE = import.meta.env.VITE_LIVE === '1';
const API = API_BASE;
export const agents = agentsJson as Agent[];
export const agentById = (id: string) => agents.find((a) => a.id === id);
/** The recorded directory only covers the fixture ids. A case from the desk API carries an id
 * it has never seen, and a blank name reads like missing data — the id itself is the truth. */
export const agentName = (id: string) => agentById(id)?.name ?? id;

/** Poll interval. Long enough that a page of cases never crowds the API's
 * 20 requests/second bucket, short enough that an approval still feels live. */
const POLL_MS = 4000;
/** Case views read per tick: one request each, and the list itself is another. */
const MAX_VIEWS = 12;
const LIST_LIMIT = 200;
/** Backend statuses nothing further happens to, so their views need no refresh. */
const TERMINAL = new Set(['answered', 'shipped', 'closed']);
/** Console stages whose reply the desk has not sent yet (TicketPage's `editable`). */
const EDITABLE = new Set<Stage>(['awaiting_approval', 'proving', 'fix_drafted']);

/** Mirrors the loop's re-entry rule (product/desk/loop.ts): anything else is
 * already finished or owned by a human, and is answered from the store instead of
 * re-run — so asking for a re-run there would promise something that cannot happen. */
const canRun = (view: CaseView) =>
  ['opened', 'reproducing', 'fix_drafted', 'proving'].includes(view.status) ||
  (view.status === 'awaiting_approval' && view.approval !== null && view.approval.decision !== null);

const errText = (err: unknown): string => {
  if (err instanceof ApiError) {
    // status 0 is the fetch itself failing: the server is down, or the browser
    // refused the call (an origin the API's CORS list does not name).
    return err.status === 0 ? `the browser could not reach it (${err.message})` : `${err.code} · ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
};

type ReplayPhase = 'idle' | 'running' | 'gate' | 'post' | 'done';

interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error' | 'pink';
  text: string;
}

interface Store {
  tickets: Ticket[];
  events: LiveEvent[];
  ticket: (id: string) => Ticket | undefined;
  eventsFor: (id: string) => LiveEvent[];
  replay: { phase: ReplayPhase; ticketId: string };
  startReplay: () => void;
  approve: (id: string, by?: string) => void;
  reject: (id: string, reason: string) => void;
  retryProof: (id: string) => void;
  handoff: (id: string) => void;
  close: (id: string, reason?: string) => void;
  editReply: (id: string, text: string) => void;
  /** Settings are config in the provider's repo: every change is a PR, never a write. */
  propose: (key: string, value?: unknown) => number;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone']) => void;
  testMode: boolean;
  /** Live mode only. The desk API scopes reports and invoices to a vendor, and the case
   * list is the only place a vendor id shows up, so this is the id the last poll saw.
   * Null until the first poll lands, and always null in fixture mode. */
  live: { on: boolean; url: string; state: 'off' | 'connecting' | 'open' | 'error'; vendor: string | null };
}

const Ctx = createContext<Store | null>(null);

const rawTickets = ticketsJson as unknown as Ticket[];
const rawEvents = eventsJson as unknown as ToolEvent[];

function initialEvents(): { live: LiveEvent[]; held: Record<string, ToolEvent[]> } {
  const live: LiveEvent[] = [];
  const held: Record<string, ToolEvent[]> = {};
  for (const e of rawEvents) {
    const t = rawTickets.find((x) => x.id === e.ticket_id);
    if (!t) continue; // an event for a case that is not in this fixture set
    if (e.after_gate) {
      (held[e.ticket_id] ??= []).push(e);
    } else {
      live.push({ ...e, at: Date.parse(t.created_at) + e.t_ms });
    }
  }
  return { live, held };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function StoreProvider({ children }: { children: ReactNode }) {
  const init = useMemo(initialEvents, []);
  const [tickets, setTickets] = useState<Ticket[]>(() => (LIVE ? [] : clone(rawTickets)));
  const [events, setEvents] = useState<LiveEvent[]>(LIVE ? [] : init.live);
  const [phase, setPhase] = useState<ReplayPhase>(LIVE ? 'idle' : 'gate');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [liveState, setLiveState] = useState<'off' | 'connecting' | 'open' | 'error'>(LIVE ? 'connecting' : 'off');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const held = useRef(init.held);
  const run = useRef(0); // bumps on every replay start so stale timers stop

  // Live mode only. `views` is the last case view the desk gave us per case, so a
  // case this tick could not fetch keeps showing real data instead of vanishing.
  const views = useRef(new Map<string, CaseView>());
  const seen = useRef<Set<string> | null>(null); // null until the first poll lands
  const drafts = useRef(new Map<string, string>());
  const draftNote = useRef(false);
  const rot = useRef(0);
  const busy = useRef(false);
  const warned = useRef(false);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const patch = useCallback((id: string, fn: (t: Ticket) => void) => {
    setTickets((all) => all.map((t) => (t.id === id ? (() => { const c = clone(t); fn(c); return c; })() : t)));
  }, []);

  const push = useCallback((e: Omit<LiveEvent, 'id' | 't_ms'> & { id?: string }) => {
    setEvents((all) => [...all, { t_ms: 0, ...e, id: e.id || `ev_rt_${Math.random().toString(36).slice(2, 8)}` }]);
  }, []);

  /** Apply what an event means to the ticket it belongs to. */
  const applyEvent = useCallback(
    (e: ToolEvent) =>
      patch(e.ticket_id, (t) => {
        t.stage = e.stage as Stage;
        const p = t.proofs;
        if (e.stage === 'proving') {
          if (e.action === 'proof.replay') { p.replay.status = 'passed'; p.vendor_tests.status = 'running'; }
          if (e.action === 'proof.vendor_tests') { p.vendor_tests.status = 'passed'; p.fresh_agent.status = 'running'; }
          if (e.action === 'proof.fresh_agent') p.fresh_agent.status = 'passed';
        }
        if (e.stage === 'fix_drafted') p.replay.status = 'running';
        if (e.action === 'grant.issued') {
          t.grants = t.grants.map((g: Grant) => ({ ...g, status: 'issued', spent_usd: Number(e.payload.spent_usd ?? 0), receipt: String(e.payload.receipt) }));
        }
        if (e.action === 'case.resolved' && e.payload.outcome) {
          t.outcome = { action: String((e.payload.outcome as { action: string }).action), agent_retry_ok: true };
          if (t.reply) t.reply = { ...t.reply, outcome: e.payload.outcome, audit_receipt: e.payload.audit_receipt };
          t.resolved_at = new Date(now()).toISOString();
        }
        if (e.action === 'pr.merged' && t.pr) t.pr.merged = true;
        if (e.action === 'meter_event.created') t.billed = true;
      }),
    [patch],
  );

  /**
   * One poll: the case list, then a bounded slice of full case views. Nothing is
   * patched locally — the console renders the store as the desk last reported it,
   * so a failed call cannot leave it showing a state the backend disagrees with.
   */
  const poll = useCallback(async () => {
    if (busy.current) return; // the previous tick is still in flight; the next one catches up
    busy.current = true;
    try {
      const list = await listCases(LIST_LIMIT);
      const cases = list.cases;
      const cached = views.current;
      // Reports and invoices are scoped to a vendor, and the case list is the only place an
      // id shows up. One desk serves one vendor, so the first case with an id is the answer.
      setVendorId(cases.find((c) => c.vendor_id)?.vendor_id ?? null);

      // A case parked on a human first, then anything never read, then the cases
      // still moving — rotated, so with more than MAX_VIEWS of them none starves.
      const rank = (f: Failure) => (f.status === 'awaiting_approval' ? 0 : TERMINAL.has(f.status) ? 2 : 1);
      const fresh = cases.filter((f) => !cached.has(f.id)).sort((a, b) => rank(a) - rank(b));
      const moving = cases.filter((f) => cached.has(f.id) && !TERMINAL.has(f.status));
      const at = moving.length > 0 ? rot.current++ % moving.length : 0;
      const picks = [...fresh, ...moving.slice(at), ...moving.slice(0, at)].slice(0, MAX_VIEWS);

      const settled = await Promise.allSettled(picks.map((f) => getCase(f.id)));
      let failed = 0;
      let firstError: unknown = null;
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') cached.set(picks[i].id, r.value);
        else {
          failed += 1;
          if (firstError === null) firstError = r.reason;
        }
      });
      if (failed > 0 && failed === picks.length) throw firstError;

      // The price book is configuration, not per-vendor data, and the route that
      // publishes it writes nothing. It is still only asked once something is
      // actually billable, so a console full of unproven cases makes no call at all.
      const book = [...cached.values()].some((v) => v.billable) ? await priceBookOnce() : null;

      const endpoints = new Map<string, string>();
      const nextTickets: Ticket[] = [];
      const nextEvents: LiveEvent[] = [];
      for (const f of cases) {
        const endpoint = endpointOf(f.request);
        endpoints.set(f.id, endpoint);
        const view = cached.get(f.id);
        const ctx = {
          affectedAgents: affectedAgents(cases, endpoint, f.agent_id),
          priceUsd: view ? priceUsdFor(view, book) : 0,
        };
        const ticket = view ? caseViewToTicket(view, ctx) : failureToTicket(f, ctx);
        const draft = drafts.current.get(f.id);
        if (draft !== undefined) {
          if (EDITABLE.has(ticket.stage)) ticket.fix = { ...ticket.fix, reply_text: draft };
          else drafts.current.delete(f.id); // sent, so show what the desk actually sent
        }
        nextTickets.push(ticket);
        if (view) nextEvents.push(...toEvents(view));
      }

      const known = seen.current;
      if (known === null) seen.current = new Set(cases.map((c) => c.id));
      else {
        for (const f of cases) {
          if (known.has(f.id)) continue;
          known.add(f.id);
          const where = endpoints.get(f.id) ?? '';
          toast(`New case ${f.id}: an agent reported ${where === '' ? 'a failure' : where}.`, 'pink');
        }
      }

      setTickets(nextTickets);
      setEvents(nextEvents);
      setLiveState('open');
      if (failed === 0) warned.current = false;
      else if (!warned.current) {
        warned.current = true;
        toast(`Live mode: ${failed} case ${failed === 1 ? 'view' : 'views'} failed to load from ${API} (${errText(firstError)}). Those cases keep the last data the desk gave us.`, 'error');
      }
    } catch (err) {
      setLiveState('error');
      // The poll retries forever, so warn once per outage instead of once per tick.
      if (!warned.current) {
        warned.current = true;
        toast(`Live mode cannot reach the desk API at ${API} (${errText(err)}). Until it does, this console shows only what it already loaded.`, 'error');
      }
    } finally {
      busy.current = false;
    }
  }, [toast]);

  useEffect(() => {
    if (!LIVE) return;
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll]);

  /**
   * Record a gate decision, then ask the loop to resume: a parked case only moves
   * once the desk has stored the decision. The re-run is reported separately from
   * the decision, because the decision stays recorded even if the re-run fails.
   */
  const decideLive = useCallback(
    async (id: string, decision: 'yes' | 'no', by: string, reason?: string) => {
      try {
        const view = await getCase(id);
        const approval = view.approval;
        if (approval === null) {
          toast(`Nothing to ${decision === 'yes' ? 'approve' : 'reject'}: case ${id} has no approval request. The desk has it at "${view.status}".`, 'error');
        } else {
          const replied = await replyApproval(approval.id, decision, by);
          try {
            await runCase(id);
            if (decision === 'yes') {
              toast(
                replied.replayed
                  ? `That approval was already decided "yes". The desk replayed the decision and is running the case again.`
                  : `Approved by ${by} and recorded on ${approval.id}. The desk is running the case again to ship what it proved.`,
                'success',
              );
            } else {
              toast(
                `Rejected and recorded on ${approval.id}. The desk answers the agent that a person has the case; nothing ships and nothing is billed.${
                  reason ? ` The API stores the decision only, so "${reason}" is not recorded.` : ''
                }`,
                'error',
              );
            }
          } catch (err) {
            toast(`The ${decision === 'yes' ? 'approval' : 'rejection'} is recorded on ${approval.id}, but re-running the case failed: ${errText(err)}`, 'error');
          }
        }
      } catch (err) {
        toast(`Could not record the decision for ${id}: ${errText(err)}`, 'error');
      }
      await poll();
    },
    [poll, toast],
  );

  const startReplay = useCallback(async () => {
    if (LIVE) {
      toast('Replay runs on the recorded fixtures. Start the console without VITE_LIVE to use it.', 'info');
      return;
    }
    const my = ++run.current;
    const start = now();
    const iso = (o: number) => new Date(start + o).toISOString();
    const orig = rawTickets.find((x) => x.id === HERO_ID);
    if (!orig) {
      toast(`Replay needs ${HERO_ID} in tickets.json, and it is not there.`, 'error');
      return;
    }
    patch(HERO_ID, (t) => {
      Object.assign(t, clone(orig));
      t.stage = 'opened';
      t.created_at = iso(0);
      t.acked_at = undefined;
      t.ack_by = iso(5 * 60e3);
      t.resolve_by = iso(60 * 60e3);
      t.proofs.replay.status = 'pending';
      t.proofs.vendor_tests.status = 'pending';
      t.proofs.fresh_agent.status = 'pending';
    });
    setEvents((all) => all.filter((e) => e.ticket_id !== HERO_ID));
    setPhase('running');
    const pre = rawEvents.filter((e) => e.ticket_id === HERO_ID && !e.after_gate);
    held.current[HERO_ID] = rawEvents.filter((e) => e.ticket_id === HERO_ID && e.after_gate);
    for (const e of pre) {
      await sleep(Math.min(1700, Math.max(550, e.d_ms / 22)));
      if (run.current !== my) return;
      const at = now();
      push({ ...e, at });
      if (e.action === 'case.acknowledged') patch(HERO_ID, (t) => { t.acked_at = new Date(at).toISOString(); });
      applyEvent(e);
    }
    setPhase('gate');
    toast('A fix is waiting for your approval. The same card went out by text.', 'pink');
  }, [applyEvent, patch, push, toast]);

  const approve = useCallback(
    async (id: string, by = 'Gideon (admin)') => {
      if (LIVE) {
        await decideLive(id, 'yes', by);
        return;
      }
      const my = run.current;
      const queue = held.current[id];
      held.current[id] = [];
      if (id === HERO_ID) setPhase('post');
      const steps: ToolEvent[] = queue?.length
        ? queue
        : [
            { id: '', ticket_id: id, stage: 'answered', tool: 'Console', action: 'decision.approved', t_ms: 0, d_ms: 0, result: 'approved', payload: { by } },
            { id: '', ticket_id: id, stage: 'answered', tool: 'AgentHelpDesk', action: 'case.resolved', t_ms: 0, d_ms: 50, result: 'pushed', payload: { topic: 'case.resolved' } },
            { id: '', ticket_id: id, stage: 'shipped', tool: 'GitHub', action: 'pr.merged', t_ms: 0, d_ms: 1100, result: 'merged', payload: {} },
            { id: '', ticket_id: id, stage: 'shipped', tool: 'Stripe', action: 'meter_event.created', t_ms: 0, d_ms: 220, result: 'billed', payload: { identifier: `out_${id}`, value: 1, mode: 'test' } },
          ];
      toast('Approved. Shipping the proven change.', 'success');
      for (const e of steps) {
        if (run.current !== my) return;
        push({ ...e, id: e.id || undefined, at: now() } as LiveEvent);
        applyEvent(e);
        await sleep(900);
      }
      if (id === HERO_ID) setPhase('done');
      toast(id === HERO_ID ? 'Order placed. The agent retried under the grant and the receipt is on the ticket.' : 'Shipped and billed as one verified fix.', 'success');
    },
    [applyEvent, decideLive, push, toast],
  );

  const reject = useCallback(
    (id: string, reason: string) => {
      if (LIVE) {
        void decideLive(id, 'no', 'Gideon (admin)', reason);
        return;
      }
      held.current[id] = [];
      patch(id, (t) => { t.stage = 'rejected'; t.rejected_reason = reason; });
      push({ ticket_id: id, stage: 'rejected', tool: 'Console', action: 'decision.rejected', d_ms: 0, result: 'rejected', payload: { reason }, at: now() });
      if (id === HERO_ID) setPhase('done');
      toast('Rejected. The agent was told a person has the case. Nothing is billed.', 'error');
    },
    [decideLive, patch, push, toast],
  );

  const retryProof = useCallback(
    async (id: string) => {
      if (LIVE) {
        try {
          const view = await getCase(id);
          if (canRun(view)) {
            await runCase(id);
            toast('Asked the desk to run this case again. Whatever it proves lands here on the next poll.', 'info');
          } else {
            toast(`The desk will not re-run case ${id}: it is already "${view.status}", so the loop answers it from the store instead of proving anything again.`, 'error');
          }
        } catch (err) {
          toast(`Retry failed: ${errText(err)}`, 'error');
        }
        await poll();
        return;
      }
      patch(id, (t) => { t.stage = 'proving'; t.proofs.fresh_agent.status = 'running'; });
      push({ ticket_id: id, stage: 'proving', tool: 'Blaxel', action: 'proof.fresh_agent', d_ms: 0, result: 'retrying', payload: { attempt: 2 }, at: now() });
      await sleep(2600);
      patch(id, (t) => { t.stage = 'failed_proof'; t.proofs.fresh_agent.status = 'failed'; });
      push({ ticket_id: id, stage: 'failed_proof', tool: 'Blaxel', action: 'proof.fresh_agent', d_ms: 38000, result: 'failed', payload: { attempt: 2, reason: 'Same ordering mistake.' }, at: now() });
      push({ ticket_id: id, stage: 'failed_proof', tool: 'AgentHelpDesk', action: 'human.paged', d_ms: 0, result: 'paged', payload: { rule: 'proof fails twice, page a human' }, at: now() });
      toast('Proof failed twice. The desk asked a human to look instead of guessing.', 'error');
    },
    [patch, poll, push, toast],
  );

  const handoff = useCallback(
    async (id: string) => {
      if (LIVE) {
        try {
          const res = await handoffCase(id, 'Handed to a human from the operator console.');
          toast(`Handed off (${res.handoff_id}). The desk attached ${res.transcript.length} transcript events and the case is now "${res.status}".`, 'success');
        } catch (err) {
          toast(`Handoff failed: ${errText(err)}`, 'error');
        }
        await poll();
        return;
      }
      push({ ticket_id: id, stage: 'answered', tool: 'AgentHelpDesk', action: 'case.handoff', d_ms: 80, result: 'human joined', payload: { endpoint: `POST /cases/${id}/handoff`, transcript_attached: true }, at: now() });
      toast('A human joined the same thread with the full transcript.', 'info');
    },
    [poll, push, toast],
  );

  const close = useCallback(
    (id: string, reason = 'Closed from the console') => {
      if (LIVE) {
        toast(`Case ${id} was not closed: the desk API has no close route. A case ends when the loop answers or ships it, when a human takes it (Handoff), or when the agent reports its retry to POST /v1/cases/retry. Nothing here was changed.`, 'error');
        return;
      }
      held.current[id] = [];
      patch(id, (t) => { t.stage = 'closed'; t.resolved_at ??= new Date(now()).toISOString(); });
      push({ ticket_id: id, stage: 'closed', tool: 'Console', action: 'ticket.closed', d_ms: 0, result: 'closed', payload: { by: 'Gideon (admin)', reason }, at: now() });
      toast('Closed. No proofs passed and no retry confirmed, so no meter event is sent.', 'info');
    },
    [patch, push, toast],
  );

  const editReply = useCallback(
    (id: string, text: string) => {
      if (LIVE) {
        // The reply the agent gets is the one the desk proved, and no route replaces
        // it. The draft is kept here and the poll re-applies it while the case is
        // still editable, so typing is not clobbered every few seconds.
        drafts.current.set(id, text);
        if (!draftNote.current) {
          draftNote.current = true;
          toast('Live mode: the desk sends the reply it proved and the API has no route to replace it. This edit stays in your browser.', 'info');
        }
      }
      patch(id, (t) => { t.fix.reply_text = text; });
    },
    [patch, toast],
  );

  const prSeq = useRef(49); // the newest PR in the fixtures is #48, so config changes start above it
  const propose = useCallback(
    (key: string, value?: unknown) => {
      if (LIVE) {
        // No config route exists on the desk API, so a "drafted PR #n" here would be
        // a number the backend never produced.
        toast(`Live mode: "${key}" was not changed and no PR was drafted. That config lives in the provider's repo and the desk API has no route for it.`, 'error');
        return 0;
      }
      const n = prSeq.current++;
      const shown = value === undefined ? '' : ` = ${typeof value === 'string' ? value : JSON.stringify(value)}`;
      toast(`Drafted PR #${n} · agenthelpdesk.json → ${key}${shown}. Nothing changes until you merge it.`, 'success');
      return n;
    },
    [toast],
  );

  const ticket = useCallback((id: string) => tickets.find((t) => t.id === id), [tickets]);
  const eventsFor = useCallback((id: string) => events.filter((e) => e.ticket_id === id).sort((a, b) => a.at - b.at), [events]);

  useEffect(() => () => { run.current++; }, []);

  const value: Store = {
    tickets, events, ticket, eventsFor,
    replay: { phase, ticketId: HERO_ID },
    startReplay, approve, reject, retryProof, handoff, close, editReply, propose,
    toasts, toast, testMode: true,
    live: { on: LIVE, url: API || window.location.origin, state: liveState, vendor: vendorId },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}
