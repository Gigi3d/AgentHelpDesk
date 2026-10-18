import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getMemory, reportProblem, resumeMemory, runCase, type MemoryEntry, type MemoryList, type MemoryResume } from '../lib/api';
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
        <span key={label} className={cx('rounded-full px-2 py-0.5 text-[12px]', ok ? 'bg-success-tint text-success-text' : 'bg-error-tint text-error-text')}>{label}</span>
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
    <li className="rounded-2xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[15px] text-ink">
            {e.signature.method} {e.signature.path} <span className="text-error-text">{e.signature.status ?? ''}</span> <span className="text-muted">{e.signature.error}</span>
          </p>
          <p className="mt-1 text-[14px] text-muted">
            Fixed in <span className="font-mono text-ink">{e.path}</span>, proven by case{' '}
            <Link className="font-mono underline underline-offset-4 hover:text-ink" to={`/app/theater/${e.source_case}`}>{e.source_case.slice(0, 12)}</Link>, {ago(e.remembered_at)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[28px] font-semibold leading-none text-ink">{e.reuse_count}</p>
          <p className="mt-1 text-[13px] text-muted">{e.reuse_count === 1 ? 'reuse' : 'reuses'}, no new model call</p>
        </div>
      </div>

      <ol className="mt-4 list-decimal space-y-1 pl-5 text-[14px] leading-relaxed text-ink">
        {e.fix_steps.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}
      </ol>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Proofs p={e.proofs} />
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={wake} disabled={waking} className="rounded-full border border-line px-3.5 py-1.5 text-[13px] font-medium text-ink transition hover:border-blue hover:text-ink disabled:opacity-50">
            {waking ? 'Waking' : 'Wake the sandbox'}
          </button>
          <button onClick={onRun} disabled={busy} className="rounded-full bg-pink px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-pink-hover disabled:opacity-50">
            {busy ? 'Starting' : 'Hit this failure again'}
          </button>
        </div>
      </div>

      {err && <p className="mt-3 text-[13px] text-error-text">{err}</p>}
      {res && (
        <div className={cx('mt-4 rounded-xl border px-4 py-3 text-[14px]', res.state_preserved ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning-tint')}>
          <p className="font-medium text-ink">
            {res.found ? `Woke in ${res.resumed_ms} ms. ${res.state_preserved ? 'The fixed document is exactly as it was left.' : 'The document has changed.'}` : 'That sandbox is gone. The fix is still remembered.'}
          </p>
          <p className="mt-1 font-mono text-[12px] text-muted">
            {res.sandbox} · {res.real ? 'Blaxel' : 'simulated'} · {res.path}
            {res.actual_sha256 && ` · sha256 ${res.actual_sha256.slice(0, 12)}`}
          </p>
          <p className="mt-1 text-[13px] text-ink">{res.note}</p>
        </div>
      )}
      {e.reused_by.length > 0 && (
        <p className="mt-3 text-[13px] text-muted">
          Reused by{' '}
          {e.reused_by.slice(-4).map((c, i) => (
            <span key={c}>{i > 0 && ', '}<Link className="font-mono underline underline-offset-4 hover:text-ink" to={`/app/theater/${c}`}>{c.slice(0, 12)}</Link></span>
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
      nav(`/app/theater/${r.case_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const entries = data?.entries ?? [];
  return (
    <div>
        <h1 className="text-title font-semibold text-ink">Proven fixes the desk remembers</h1>
        <p className="mt-3 max-w-[60ch] text-[15px] leading-relaxed text-muted">
          A repeat failure reuses the proven fix with no model call, and all three proofs run again. The sandbox that proved it stays in standby on Blaxel.
        </p>
        {data && (
          <p className="mt-5 text-[14px] text-ink">
            {entries.length} remembered {entries.length === 1 ? 'fix' : 'fixes'}, {data.total_reuses} {data.total_reuses === 1 ? 'reuse' : 'reuses'}.
            {data.sandboxes === 'simulated' && <span className="ml-2 text-warning">Sandboxes are simulated in this run.</span>}
          </p>
        )}
        {error && <p className="mt-4 text-[14px] text-error-text">{error}</p>}
        {data && entries.length === 0 && (
          <div className="mt-8 rounded-2xl border border-dashed border-line p-8 text-center">
            <p className="text-[15px] text-ink">Nothing remembered yet. A fix is remembered once all three proofs pass.</p>
            <button onClick={hitAgain} disabled={busy} className="mt-4 rounded-full bg-pink px-4 py-2 text-[14px] font-semibold text-white transition hover:bg-pink-hover disabled:opacity-50">
              {busy ? 'Starting' : 'Run the Ledgerly case'}
            </button>
          </div>
        )}
        <ul className="mt-6 space-y-4">
          {entries.map((e) => <Entry key={`${e.signature.key}-${e.path}`} e={e} onRun={hitAgain} busy={busy} />)}
        </ul>
    </div>
  );
}
