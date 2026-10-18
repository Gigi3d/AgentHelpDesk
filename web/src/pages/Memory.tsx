import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getMemory, reportProblem, resumeMemory, runCase, type MemoryEntry, type MemoryList, type MemoryResume } from '../lib/api';
import { Logo } from '../components/Shell';
import { cx } from '../components/ui';

const REPORT = {
  agent_id: 'agent-memory-demo',
  task: 'List my ledger entries',
  request: { method: 'GET', url: 'https://api.ledgerly.test/v1/entries', headers: { 'x-api-key': 'redacted' } },
  response: { status: 401, error: { code: 'unauthorized', message: 'Invalid or missing credentials.' } },
  channel: 'mcp' as const,
};

const ago = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

function Proofs({ p }: { p: MemoryEntry['proofs'] }) {
  const items: Array<[string, boolean]> = [['replay', p.replay], ['vendor tests', p.vendor_tests], ['fresh agent', p.fresh_agent]];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(([label, ok]) => (
        <span key={label} className={cx('rounded-full px-2 py-0.5 text-[12px]', ok ? 'bg-[#34D399]/15 text-[#34D399]' : 'bg-[#F87171]/15 text-[#F87171]')}>{label}</span>
      ))}
    </div>
  );
}

function Entry({ e, onRun, busy }: { e: MemoryEntry; onRun: () => void; busy: boolean }) {
  const [res, setRes] = useState<MemoryResume | null>(null);
  const [waking, setWaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const wake = async () => {
    setWaking(true);
    setErr(null);
    try {
      setRes(await resumeMemory(e.source_case));
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setWaking(false);
    }
  };

  return (
    <li className="rounded-2xl border border-[#26335C] bg-[#121A33] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[15px] text-white">
            {e.signature.method} {e.signature.path} <span className="text-[#F87171]">{e.signature.status ?? ''}</span> <span className="text-[#8C97B2]">{e.signature.error}</span>
          </p>
          <p className="mt-1 text-[14px] text-[#8C97B2]">
            Fixed in <span className="font-mono text-[#C9D2EA]">{e.path}</span>, proven by case{' '}
            <Link className="font-mono underline underline-offset-4 hover:text-white" to={`/theater/${e.source_case}`}>{e.source_case.slice(0, 12)}</Link>, {ago(e.remembered_at)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[28px] font-semibold leading-none text-white">{e.reuse_count}</p>
          <p className="mt-1 text-[13px] text-[#8C97B2]">{e.reuse_count === 1 ? 'reuse' : 'reuses'}, no new model call</p>
        </div>
      </div>

      <ol className="mt-4 list-decimal space-y-1 pl-5 text-[14px] leading-relaxed text-[#C9D2EA]">
        {e.fix_steps.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}
      </ol>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Proofs p={e.proofs} />
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={wake} disabled={waking} className="rounded-full border border-[#26335C] px-3.5 py-1.5 text-[13px] font-medium text-[#C9D2EA] transition hover:border-[#6C8CFF] hover:text-white disabled:opacity-50">
            {waking ? 'Waking' : 'Wake the sandbox'}
          </button>
          <button onClick={onRun} disabled={busy} className="rounded-full bg-[#E6007A] px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[#FF2D87] disabled:opacity-50">
            {busy ? 'Starting' : 'Hit this failure again'}
          </button>
        </div>
      </div>

      {err && <p className="mt-3 text-[13px] text-[#F87171]">{err}</p>}
      {res && (
        <div className={cx('mt-4 rounded-xl border px-4 py-3 text-[14px]', res.state_preserved ? 'border-[#34D399]/40 bg-[#34D399]/10' : 'border-[#FBBF24]/40 bg-[#FBBF24]/10')}>
          <p className="font-medium text-white">
            {res.found ? `Woke in ${res.resumed_ms} ms. ${res.state_preserved ? 'The fixed document is exactly as it was left.' : 'The document has changed.'}` : 'That sandbox is gone. The fix is still remembered.'}
          </p>
          <p className="mt-1 font-mono text-[12px] text-[#8C97B2]">
            {res.sandbox} · {res.real ? 'Blaxel' : 'simulated'} · {res.path}
            {res.actual_sha256 && ` · sha256 ${res.actual_sha256.slice(0, 12)}`}
          </p>
          <p className="mt-1 text-[13px] text-[#C9D2EA]">{res.note}</p>
        </div>
      )}
      {e.reused_by.length > 0 && (
        <p className="mt-3 text-[13px] text-[#8C97B2]">
          Reused by{' '}
          {e.reused_by.slice(-4).map((c, i) => (
            <span key={c}>{i > 0 && ', '}<Link className="font-mono underline underline-offset-4 hover:text-white" to={`/theater/${c}`}>{c.slice(0, 12)}</Link></span>
          ))}
        </p>
      )}
    </li>
  );
}

export default function Memory() {
  const nav = useNavigate();
  const [data, setData] = useState<MemoryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getMemory().then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 6000);
    return () => window.clearInterval(t);
  }, [load]);

  const hitAgain = async () => {
    setBusy(true);
    try {
      const r = await reportProblem({ ...REPORT, idempotency_key: `memory-${Date.now()}` });
      await runCase(r.case_id);
      nav(`/theater/${r.case_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const entries = data?.entries ?? [];
  return (
    <div className="min-h-screen bg-[#0B1020] text-[#E8ECF6]">
      <header className="mx-auto flex max-w-[860px] flex-wrap items-center justify-between gap-3 px-4 py-4">
        <Link to="/app" className="inline-flex items-center"><Logo dark /></Link>
        <Link to="/theater" className="text-[13px] text-[#8C97B2] underline underline-offset-4 hover:text-white">Case Theater</Link>
      </header>
      <main className="mx-auto max-w-[860px] px-4 pb-20">
        <h1 className="mt-8 text-[30px] font-semibold tracking-tight">Every fix the desk has proven, it keeps</h1>
        <p className="mt-3 max-w-[60ch] text-[15px] leading-relaxed text-[#8C97B2]">
          When another agent fails the same way, the desk reuses the proven fix instead of asking the model again, then proves it again anyway. The sandbox that proved each fix stays in standby on Blaxel, with its files intact, until you wake it.
        </p>
        {data && (
          <p className="mt-5 text-[14px] text-[#C9D2EA]">
            {entries.length} remembered {entries.length === 1 ? 'fix' : 'fixes'}, {data.total_reuses} {data.total_reuses === 1 ? 'reuse' : 'reuses'}.
            {data.sandboxes === 'simulated' && <span className="ml-2 text-[#FBBF24]">Sandboxes are simulated in this run.</span>}
          </p>
        )}
        {error && <p className="mt-4 text-[14px] text-[#F87171]">{error}</p>}
        {data && entries.length === 0 && (
          <div className="mt-8 rounded-2xl border border-dashed border-[#26335C] p-8 text-center">
            <p className="text-[15px] text-[#C9D2EA]">Nothing remembered yet. A fix is remembered once all three proofs pass.</p>
            <button onClick={hitAgain} disabled={busy} className="mt-4 rounded-full bg-[#E6007A] px-4 py-2 text-[14px] font-semibold text-white transition hover:bg-[#FF2D87] disabled:opacity-50">
              {busy ? 'Starting' : 'Run the Ledgerly case'}
            </button>
          </div>
        )}
        <ul className="mt-6 space-y-4">
          {entries.map((e) => <Entry key={`${e.signature.key}-${e.path}`} e={e} onRun={hitAgain} busy={busy} />)}
        </ul>
      </main>
    </div>
  );
}
