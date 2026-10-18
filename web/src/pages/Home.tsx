import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import config from '../data/agenthelpdesk.json';
import { agentName, agents, HERO_ID, useStore } from '../lib/store';
import { ago, dur, ptHour, until, useNow } from '../lib/clock';
import type { FailureClass, Ticket } from '../lib/types';
import { AgentHelpedIcon, AgentWonIcon, AwaitingIcon, IconTile, ShippedIcon } from '../components/icons';
import { Button, Card, CardHead, Chip, ClassChip, PageHeader, StageChip, Stat, ToolChip } from '../components/ui';

const isResolved = (t: Ticket) => t.stage === 'shipped' || t.stage === 'answered' || t.stage === 'closed';
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;

export default function Home() {
  const { tickets, events, eventsFor, approve, startReplay, replay, live } = useStore();
  const nav = useNavigate();
  const at = useNow();

  const waiting = tickets.filter((t) => t.stage === 'awaiting_approval');
  const resolved = tickets.filter(isResolved);
  /**
   * The desk API has no agent directory route, so live mode cannot read agents.json without
   * inventing numbers under the LIVE badge. Both tiles come off the cases instead: who called,
   * and whose call ended with the agent retrying successfully.
   */
  const distinct = (list: string[]) => new Set(list.filter(Boolean)).size;
  const won = live.on
    ? distinct(tickets.filter((t) => t.outcome?.agent_retry_ok).map((t) => t.agent_id))
    : agents.filter((a) => a.status === 'won').length;
  const helped = live.on ? distinct(tickets.map((t) => t.agent_id)) : agents.filter((a) => a.status !== 'lost').length;
  const identified = agents.filter((a) => a.identified).length;

  /** Cases opened per Pacific hour, from created_at. The demo day is 2:30p–8:12p. */
  const hours = useMemo(() => {
    if (!tickets.length) return [];
    const hs = tickets.map((t) => ptHour(t.created_at));
    const out: { h: number; n: number }[] = [];
    for (let h = Math.min(...hs); h <= Math.max(...hs); h++) out.push({ h, n: hs.filter((x) => x === h).length });
    return out;
  }, [tickets]);

  const classes = useMemo(() => {
    const m = new Map<FailureClass, number>();
    for (const t of tickets) m.set(t.failure_class, (m.get(t.failure_class) ?? 0) + 1);
    return (['authority', 'code', 'knowledge'] as FailureClass[]).map((c) => [c, m.get(c) ?? 0] as const);
  }, [tickets]);

  /** Median open → last recorded event, in milliseconds, over tickets that reached an outcome. */
  const median = useMemo(() => {
    const spans = tickets
      .filter(isResolved)
      .map((t) => Math.max(0, ...events.filter((e) => e.ticket_id === t.id).map((e) => e.t_ms)))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    return spans.length ? dur(spans[Math.floor(spans.length / 2)]) : null;
  }, [tickets, events]);

  const peak = Math.max(1, ...hours.map((x) => x.n));

  /** The first case that cleared all three proofs, so the install checklist states a real duration. */
  const firstProofed = useMemo(() => {
    const done = tickets
      .filter((t) => t.resolved_at && Object.values(t.proofs).every((p) => p.status === 'passed'))
      .sort((a, b) => (a.resolved_at ?? '').localeCompare(b.resolved_at ?? ''))[0];
    return done ? { id: done.id, span: Date.parse(done.resolved_at ?? done.created_at) - Date.parse(done.created_at) } : null;
  }, [tickets]);

  const h = ptHour(at);
  const greeting = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';

  return (
    <div>
      <PageHeader
        title={`Good ${greeting}, Gideon`}
        sub="Here is what needs you now, then what the desk did on its own."
        right={
          live.on ? undefined : (
            <Button onClick={() => { startReplay(); nav(`/app/tickets/${HERO_ID}`); }} disabled={replay.phase === 'running'}>
              ↻ Replay the Hark-shaped failure
            </Button>
          )
        }
      />

      {waiting.length > 0 && (
        <Card className="mb-6 overflow-hidden border-pink/40">
          <div className="flex items-center justify-between bg-pink-tint px-5 py-3">
            <h2 className="text-[15px] font-semibold text-ink">{waiting.length} fix{waiting.length > 1 ? 'es are' : ' is'} waiting for you</h2>
            <span className="text-[12.5px] text-pink-text">Also sent to your phone by text</span>
          </div>
          <ul className="divide-y divide-line">
            {waiting.map((t) => (
              <li key={t.id} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center">
                <Link to={`/app/tickets/${t.id}`} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12.5px] text-ink">{t.endpoint}</span>
                    <ClassChip c={t.failure_class} />
                    <Chip tone={t.risk === 'high' ? 'red' : t.risk === 'medium' ? 'amber' : 'gray'}>Risk {t.risk}</Chip>
                    <span className="text-[12.5px] text-muted">resolve {until(t.resolve_by, at)}</span>
                  </div>
                  <p className="mt-1 truncate text-[14px] text-ink hover:underline">{t.fix.summary}</p>
                  <p className="text-[12.5px] text-muted">
                    {Object.values(t.proofs).filter((p) => p.status === 'passed').length} of 3 proofs passed · {t.affected_agents} agent{t.affected_agents === 1 ? '' : 's'} affected
                  </p>
                </Link>
                <div className="flex shrink-0 gap-2">
                  <Button variant="primary" onClick={() => approve(t.id)}>Approve</Button>
                  <Link to={`/app/tickets/${t.id}`}><Button>Review</Button></Link>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          icon={<IconTile tone="green"><ShippedIcon /></IconTile>}
          label="Fixes shipped"
          value={resolved.length}
          sub={median ? `Median ${median} from failure to answer` : 'Proven before anything ships'}
          color="#0F8A5F"
        />
        <Stat
          icon={<IconTile tone="pink" pulse={waiting.length > 0}><AwaitingIcon /></IconTile>}
          label="Waiting for approval"
          value={waiting.length}
          sub={waiting.length ? 'Oldest opened ' + ago(waiting[waiting.length - 1].created_at, at) : 'Nothing waiting on you'}
        />
        <Stat
          icon={<IconTile tone="blue"><AgentHelpedIcon /></IconTile>}
          label="Agents helped"
          value={helped}
          sub={live.on ? `Distinct agent IDs on the ${tickets.length} case${tickets.length === 1 ? '' : 's'} the desk has` : `${identified} of ${agents.length} send ${config.agent_identifier_header}`}
        />
        <Stat
          icon={<IconTile tone="green"><AgentWonIcon /></IconTile>}
          label="Agents won"
          value={won}
          sub="Succeeded on a later call"
          color="#0F8A5F"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHead title="Ticket feed" sub="Most recent first. Chips show the tools that worked each ticket." right={<Link to="/app/tickets" className="text-[13px] text-blue hover:underline">All tickets</Link>} />
          <ul className="divide-y divide-line">
            {[...tickets].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map((t) => {
              const tools = [...new Set(eventsFor(t.id).map((e) => e.tool))];
              return (
                <li key={t.id}>
                  <Link to={`/app/tickets/${t.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-surface/60">
                    <div className="w-[132px] shrink-0 pt-0.5"><StageChip stage={t.stage} /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] text-ink">{t.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="mr-1 text-[12px] text-muted">{agentName(t.agent_id)} · {ago(t.created_at, at)}</span>
                        {tools.map((x) => <ToolChip key={x} tool={x} />)}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[14px] font-semibold">Cases opened today</h3>
              <span className="text-[12px] text-muted">Pacific time</span>
            </div>
            <div className="mt-4 flex h-24 items-end gap-1.5">
              {hours.map(({ h, n }) => (
                <div key={h} className="flex flex-1 flex-col items-center gap-1.5" title={`${hourLabel(h)} · ${n} case${n === 1 ? '' : 's'}`}>
                  <span className="text-[11px] tabular-nums text-muted">{n || ''}</span>
                  <div className="w-full rounded-t bg-blue/80 transition-[height]" style={{ height: `${Math.max(3, (n / peak) * 68)}px` }} />
                  <span className="text-[10.5px] text-muted">{hourLabel(h)}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2 border-t border-line pt-3">
              {classes.map(([c, n]) => (
                <Link key={c} to={`/app/tickets?class=${c}`} className="flex items-center gap-2 text-[13px] hover:underline">
                  <ClassChip c={c} />
                  <div className="h-1.5 flex-1 rounded-full bg-surface"><div className="h-1.5 rounded-full bg-ink/70" style={{ width: `${(n / Math.max(1, tickets.length)) * 100}%` }} /></div>
                  <span className="w-4 text-right tabular-nums text-muted">{n}</span>
                </Link>
              ))}
            </div>
            <p className="mt-3 text-[12.5px] text-muted">
              Authority failures are the ones an agent cannot fix alone. <Link to="/app/endpoints" className="text-blue hover:underline">See them by endpoint</Link>.
            </p>
          </Card>
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold">Install and test mode</h3>
              <Link to="/install" className="text-[12.5px] text-blue hover:underline">Redo</Link>
            </div>
            <ul className="mt-3 space-y-2 text-[13.5px]">
              {[
                [`GitHub App on ${config.provider.repo.split('/')[1]}`, true],
                [`${config.endpoints.length} endpoints read from ${config.provider.openapi}`, true],
                [firstProofed ? `First test case passed · ${firstProofed.id} (${dur(firstProofed.span)})` : 'First test case', Boolean(firstProofed)],
                ['Live payment method', false],
              ].map(([k, ok]) => (
                <li key={String(k)} className="flex items-center gap-2">
                  <span className={ok ? 'text-success-text' : 'text-muted'}>{ok ? '✓' : '○'}</span>
                  <span className={ok ? 'text-ink' : 'text-muted'}>{k}</span>
                </li>
              ))}
            </ul>
            <Link to="/app/billing" className="mt-3 inline-block text-[13px] text-blue hover:underline">Add a payment method to leave test mode</Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
