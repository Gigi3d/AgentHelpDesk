import { useState } from 'react';
import { Link } from 'react-router-dom';
import staff from '../data/staff.json';
import { useStore } from '../lib/store';
import { ago, usd } from '../lib/clock';
import { Code } from '../components/Json';
import { Logo } from '../components/Shell';
import { CostIcon, HumanQueueIcon, IconTile, InstallStuckIcon, ShieldCheckIcon } from '../components/icons';
import { Card, CardHead, Chip, SampleTag, Stat, StageChip, Tabs, changeLabel } from '../components/ui';

export default function Staff() {
  const { tickets, events } = useStore();
  const [tab, setTab] = useState<'ops' | 'ledger' | 'quality' | 'funnel'>('ops');
  const proofs = tickets.flatMap((t) => Object.values(t.proofs)).filter((p) => p.status === 'passed' || p.status === 'failed');
  const passRate = proofs.filter((p) => p.status === 'passed').length / Math.max(1, proofs.length);
  const cost = events.reduce((a, e) => a + (e.cost_usd ?? 0), 0);
  const needUs = tickets.filter((t) => t.stage === 'failed_proof' || t.stage === 'escalated' || events.some((e) => e.ticket_id === t.id && /handoff|human/.test(e.action)));

  return (
    <div className="min-h-screen bg-white">
      <header className="flex h-14 items-center justify-between bg-ink px-4 text-white md:px-8">
        <div className="flex items-center gap-3"><Logo dark /><span className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide">Staff only</span></div>
        <Link to="/app" className="text-[13px] text-white/70 hover:text-white">Provider console →</Link>
      </header>
      <div className="bg-warning-tint px-4 py-1.5 text-center text-[12.5px] text-warning">Read-only by default. Request bodies stay masked until opened with a reason, which is logged.</div>
      <div className="mx-auto max-w-[1120px] px-4 py-8 md:px-6">
        <h1 className="text-title font-semibold">Ops</h1>
        <p className="mb-6 mt-1 text-muted">How a small team runs support for many providers without drowning.</p>
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'ops', label: 'Ops home' }, { key: 'ledger', label: 'Fix ledger' }, { key: 'quality', label: 'Quality and cost' }, { key: 'funnel', label: 'Install funnel and pilots' }]} />
        <div className="mt-6">
          {tab === 'ops' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Stat icon={<IconTile tone="green"><ShieldCheckIcon /></IconTile>} label="Proof pass rate" value={`${Math.round(passRate * 100)}%`} sub={`${proofs.length} proofs measured`} />
                <Stat icon={<IconTile tone="pink" pulse={needUs.length > 0}><HumanQueueIcon /></IconTile>} label="Need us" value={needUs.length} sub="Failed twice or handed off" />
                <Stat icon={<IconTile tone="amber"><InstallStuckIcon /></IconTile>} label="Installs stuck" value={3} sub="Merged, no live ticket" sample />
                <Stat icon={<IconTile tone="ink"><CostIcon /></IconTile>} label="Model and sandbox cost" value={usd(cost)} sub="From tool_events.cost_usd" />
              </div>
              <Card>
                <CardHead title="Human queue" sub="Oldest first, with the reason" />
                <ul className="divide-y divide-line">
                  {needUs.map((t) => <li key={t.id}><Link to={`/app/tickets/${t.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface"><StageChip stage={t.stage} /><span className="min-w-0 flex-1 truncate text-[14px]">{t.title}</span><span className="text-[12.5px] text-muted">{ago(t.created_at)}</span></Link></li>)}
                </ul>
              </Card>
            </div>
          )}
          {tab === 'ledger' && (
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-table">
                <thead><tr className="border-b border-line bg-surface text-left text-[12px] text-muted"><th className="px-4 py-2.5 font-medium">Ticket</th><th className="font-medium">Provider</th><th className="font-medium">Type</th><th className="font-medium">Proofs</th><th className="font-medium">Outcome</th><th className="font-medium">Billable</th><th className="pr-4 text-right font-medium">Price</th></tr></thead>
                <tbody>
                  {tickets.map((t) => {
                    const ok = Object.values(t.proofs).every((p) => p.status === 'passed');
                    const billable = ok && !!t.outcome?.agent_retry_ok && !t.not_billable_reason;
                    return (
                      <tr key={t.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-2.5"><Link to={`/app/tickets/${t.id}`} className="font-mono text-[12.5px] text-blue hover:underline">{t.id}</Link></td>
                        <td>Ledgerly</td>
                        <td className="text-muted">{changeLabel[t.change_type]}</td>
                        <td>{Object.values(t.proofs).filter((p) => p.status === 'passed').length}/3</td>
                        <td><StageChip stage={t.stage} /></td>
                        <td>{billable ? <Chip tone="green">yes</Chip> : <Chip>{t.not_billable_reason ? 'exempt' : 'no'}</Chip>}</td>
                        <td className="pr-4 text-right tabular-nums">{billable ? usd(t.price_usd) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="border-t border-line p-4"><Code file="the one rule, written as a query">{'-- One rule is the pricing model. The desk applies it in code, not in a database:\n-- the store is a repository over memory today, Postgres later. Same rule either way.\nselect f.id from failures f\njoin attempts a on a.failure_id = f.id\njoin outcomes o on o.failure_id = f.id\nwhere a.proof_replay and a.proof_vendor_tests and a.proof_fresh_agent\n  and o.agent_retry_ok;\n-- Exempt by policy, never metered: privacy requests.'}</Code></div>
            </Card>
          )}
          {tab === 'quality' && (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <Card className="overflow-x-auto">
                <CardHead title="Quality by change type" sub="Decides whether to widen Auto mode" right={<SampleTag />} />
                <table className="w-full text-table"><thead><tr className="border-b border-line text-left text-[12px] text-muted"><th className="px-5 py-2 font-medium">Type</th><th className="font-medium">Proofs</th><th className="font-medium">Pass</th><th className="font-medium">Rolled back</th><th className="font-medium">Rejected</th><th className="pr-5 font-medium">Flaky</th></tr></thead>
                  <tbody>{staff.quality.map((q) => <tr key={q.type} className="border-b border-line last:border-0"><td className="px-5 py-2.5">{q.type}</td><td>{q.proofs}</td><td><div className="flex items-center gap-2"><div className="h-1.5 w-16 rounded-full bg-surface"><div className="h-1.5 rounded-full bg-success" style={{ width: `${q.pass * 100}%` }} /></div>{Math.round(q.pass * 100)}%</div></td><td>{q.rolled_back}</td><td>{q.rejected}</td><td className="pr-5">{q.flaky}</td></tr>)}</tbody>
                </table>
              </Card>
              <Card className="p-5">
                <div className="flex items-center justify-between"><h3 className="text-[14px] font-semibold">Unit cost per ticket</h3><SampleTag /></div>
                <dl className="mt-3 space-y-2 text-[13.5px]">
                  <div className="flex justify-between"><dt className="text-muted">Model</dt><dd>{usd(staff.unit_cost.model_per_ticket_usd)}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted">Messages</dt><dd>{usd(staff.unit_cost.messages_per_ticket_usd)}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted">Sandbox, per second</dt><dd>{usd(staff.unit_cost.sandbox_s)}</dd></div>
                </dl>
                <p className="mt-3 rounded-ctl bg-warning-tint px-3 py-2 text-[12.5px] text-warning">{staff.unit_cost.note}</p>
              </Card>
            </div>
          )}
          {tab === 'funnel' && (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="p-5">
                <div className="mb-4 flex items-center justify-between"><h3 className="text-[14px] font-semibold">Install funnel</h3><SampleTag /></div>
                {staff.install_funnel.map((s) => <div key={s.step} className="mb-2"><div className="flex justify-between text-[13px]"><span>{s.step}</span><span className="tabular-nums text-muted">{s.n}</span></div><div className="mt-1 h-2 rounded-full bg-surface"><div className="h-2 rounded-full bg-blue" style={{ width: `${(s.n / staff.install_funnel[0].n) * 100}%` }} /></div></div>)}
              </Card>
              <Card>
                <CardHead title="Pilot tracker" sub="The business, in one list" />
                <ul className="divide-y divide-line">{staff.providers.map((p) => <li key={p.id} className="px-5 py-3"><div className="flex items-center justify-between"><span className="text-[14px] font-semibold">{p.name}</span><Chip tone={p.stage === 'live' ? 'green' : p.stage === 'outreach' ? 'pink' : 'gray'}>{p.stage}</Chip></div><p className="mt-0.5 text-[13px] text-muted">Next: {p.next} · owner {p.owner}</p></li>)}</ul>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
