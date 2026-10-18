import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { agentName, useStore } from '../lib/store';
import { ago, useNow } from '../lib/clock';
import type { Stage } from '../lib/types';
import { Button, Card, ClassChip, Empty, Kbd, PageHeader, ProofIcon, Segmented, StageChip, cx, modeLabel } from '../components/ui';

type View = 'all' | 'needs_me' | 'working' | 'done' | 'problems';
type Cls = 'all' | 'knowledge' | 'code' | 'authority';
const views: { key: View; label: string; match: (s: Stage) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'needs_me', label: 'Needs me', match: (s) => s === 'awaiting_approval' },
  { key: 'working', label: 'In progress', match: (s) => ['opened', 'reproducing', 'fix_drafted', 'proving'].includes(s) },
  { key: 'done', label: 'Answered', match: (s) => ['answered', 'shipped', 'closed'].includes(s) },
  { key: 'problems', label: 'Failed, escalated or rejected', match: (s) => s === 'failed_proof' || s === 'escalated' || s === 'rejected' },
];

export default function Tickets() {
  const { tickets, approve } = useStore();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const at = useNow(5000);
  const view = (params.get('view') as View) || 'all';
  const cls = (params.get('class') as Cls) || 'all';
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'all') next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
    setSel(0);
  };

  const active = views.find((v) => v.key === view) ?? views[0];
  const rows = useMemo(() => {
    const m = active.match;
    const s = q.toLowerCase();
    return [...tickets]
      .filter((t) => m(t.stage) && (cls === 'all' || t.failure_class === cls))
      .filter((t) => !s || [t.id, t.title, t.endpoint, agentName(t.agent_id), t.response.headers['Request-Id']].join(' ').toLowerCase().includes(s))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [tickets, active, q, cls]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea')) return;
      if (e.key === 'j') setSel((s) => Math.min(s + 1, rows.length - 1));
      if (e.key === 'k') setSel((s) => Math.max(s - 1, 0));
      if (e.key === 'Enter' && rows[sel]) nav(`/app/tickets/${rows[sel].id}`);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [rows, sel, nav]);

  const filtered = active.key !== 'all' || cls !== 'all' || q.trim() !== '';
  const lowRiskPicked = picked.filter((id) => { const t = tickets.find((x) => x.id === id); return t?.stage === 'awaiting_approval' && t.risk === 'low'; });

  const exportCsv = () => {
    const head = 'id,stage,class,endpoint,agent,created_at,mode,proofs_passed';
    const body = rows.map((t) => [t.id, t.stage, t.failure_class, t.endpoint, t.agent_id, t.created_at, t.mode, Object.values(t.proofs).filter((p) => p.status === 'passed').length].join(','));
    const url = URL.createObjectURL(new Blob([[head, ...body].join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'tickets.csv'; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader title="Tickets" sub="Every agent failure becomes a case with a committed deadline." right={<Button onClick={exportCsv}>Export CSV</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented options={views.map((v) => ({ key: v.key, label: `${v.label} ${tickets.filter((t) => v.match(t.stage)).length}` }))} value={active.key} onChange={(v) => setParam('view', v)} />
        <select value={cls} onChange={(e) => setParam('class', e.target.value)} className="h-9 rounded-ctl border border-line bg-white px-2 text-[13.5px]">
          <option value="all">Every failure class</option>
          <option value="knowledge">Knowledge</option>
          <option value="code">Code</option>
          <option value="authority">Authority</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by ID, endpoint, agent, request ID" className="h-9 min-w-[220px] flex-1 rounded-ctl border border-line px-3 text-[14px] outline-none focus:border-blue" />
      </div>
      {picked.length > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-ctl border border-line bg-surface px-4 py-2 text-[13.5px]">
          <span>{picked.length} selected</span>
          <Button size="sm" variant="primary" disabled={!lowRiskPicked.length} onClick={() => { lowRiskPicked.forEach((id) => approve(id)); setPicked([]); }}>
            Approve {lowRiskPicked.length} low-risk
          </Button>
          <span className="text-[12px] text-muted">Bulk approve only applies to low-risk fixes. Others need their own review.</span>
          <button className="ml-auto text-muted hover:text-ink" onClick={() => setPicked([])}>Clear</button>
        </div>
      )}
      {rows.length === 0 ? (
        filtered ? (
          <Empty title="Nothing matches these filters" body={`${tickets.length} case${tickets.length === 1 ? '' : 's'} on this console, none in this view.`} action={<Button onClick={() => { setParams({}, { replace: true }); setQ(''); }}>Clear filters</Button>} />
        ) : (
          <Empty title="No agent has asked for help yet" body="Share your help link with an agent to test it, or run the install test ticket." action={<Link to="/install"><Button variant="primary">Run the install test ticket</Button></Link>} />
        )
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-table">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-[12px] text-muted">
                <th className="w-10 px-4 py-2.5" />
                <th className="py-2.5 font-medium">Stage</th>
                <th className="py-2.5 font-medium">Ticket</th>
                <th className="py-2.5 font-medium">Agent</th>
                <th className="py-2.5 font-medium">Proofs</th>
                <th className="py-2.5 font-medium">Mode</th>
                <th className="py-2.5 pr-4 text-right font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => (
                <tr key={t.id} onClick={() => nav(`/app/tickets/${t.id}`)} onMouseEnter={() => setSel(i)} className={cx('cursor-pointer border-b border-line last:border-0', i === sel ? 'bg-blue-tint/60' : 'hover:bg-surface/60')}>
                  <td className="px-4" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${t.id}`} checked={picked.includes(t.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))} className="accent-blue" />
                  </td>
                  <td className="py-3 pr-3"><StageChip stage={t.stage} /></td>
                  <td className="max-w-[420px] py-3 pr-4">
                    <Link to={`/app/tickets/${t.id}`} onClick={(e) => e.stopPropagation()} className="block truncate text-ink hover:underline">{t.title}</Link>
                    <div className="mt-0.5 flex items-center gap-2"><span className="font-mono text-[12px] text-muted">{t.endpoint}</span><ClassChip c={t.failure_class} /></div>
                  </td>
                  <td className="py-3 pr-3 text-muted">{agentName(t.agent_id)}</td>
                  <td className="py-3 pr-3"><span className="flex gap-1">{Object.values(t.proofs).map((p, k) => <ProofIcon key={k} s={p.status} size={16} />)}</span></td>
                  <td className="py-3 pr-3 text-muted">{modeLabel[t.mode]}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-muted">{ago(t.created_at, at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="mt-3 text-[12.5px] text-muted"><Kbd>J</Kbd> <Kbd>K</Kbd> to move, <Kbd>Enter</Kbd> to open.</p>
    </div>
  );
}
