import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteBlaxelSandbox, getBlaxelActivity, getBlaxelSandboxes, getMemory, listCases, resumeMemory, type BlaxelActivity, type BlaxelSandbox, type BlaxelSandboxes, type MemoryResume } from '../lib/api';
import { cx } from '../components/ui';
import { TILE, WORD, kindFor, type SandboxKind } from '../lib/sandboxKinds';

type Kind = SandboxKind;

const ACTION: Record<string, string> = { create_or_resume: 'Woke or created', fork: 'Cloned', destroy: 'Deleted', exec: 'Ran a command' };

const ago = (iso: string | null) => {
  if (!iso) return '';
  const s = Math.max(1, Math.round((Date.now() - Date.parse(iso.replace(' ', 'T'))) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

export default function Blaxel() {
  const [sb, setSb] = useState<BlaxelSandboxes | null>(null);
  const [act, setAct] = useState<BlaxelActivity | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [remembered, setRemembered] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [arm, setArm] = useState<string | null>(null);
  const [woke, setWoke] = useState<Record<string, MemoryResume | string>>({});

  const load = useCallback(async () => {
    try {
      const [s, a, c, m] = await Promise.all([getBlaxelSandboxes(), getBlaxelActivity(), listCases(100), getMemory().catch(() => null)]);
      setSb(s);
      setAct(a);
      setStatus(Object.fromEntries(c.cases.map((x) => [x.id, x.status])));
      setRemembered(new Set((m?.entries ?? []).map((e) => e.source_case)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const kindOf = useCallback((s: BlaxelSandbox): Kind => kindFor(s, status, remembered), [remembered, status]);

  const slots = useMemo(() => {
    const list = sb?.sandboxes ?? [];
    const n = Math.max(sb?.limit ?? 10, list.length);
    return Array.from({ length: n }, (_, i) => list[i] ?? null);
  }, [sb]);

  const remove = async (name: string) => {
    if (arm !== name) { setArm(name); return; }
    setArm(null);
    try { await deleteBlaxelSandbox(name); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const wake = async (s: BlaxelSandbox) => {
    if (!s.case_id) return;
    try { setWoke((w) => ({ ...w, [s.name]: '…' })); const r = await resumeMemory(s.case_id); setWoke((w) => ({ ...w, [s.name]: r })); }
    catch (e) { setWoke((w) => ({ ...w, [s.name]: e instanceof Error ? e.message : String(e) })); }
  };

  const full = sb ? sb.used >= sb.limit : false;
  const maxMs = Math.max(1, ...(act?.activity ?? []).map((a) => a.ms));

  return (
    <div>
        <h1 className="text-title font-semibold text-ink">What the desk is doing in Blaxel</h1>
        <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed text-muted">
          Every case gets its own sandbox, and the one that proved a fix stays in standby as the desk’s memory. This is the live list from your Blaxel workspace.
        </p>
        {error && <p className="mt-4 text-[14px] text-error-text">{error}</p>}
        {sb && !sb.real && <p className="mt-4 text-[14px] text-warning">{sb.note}</p>}

        {sb && sb.real && (
          <section className="mt-8 rounded-2xl border border-line bg-white p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[15px] text-ink">
                <span className={cx('text-[28px] font-semibold', full && 'text-error-text')}>{sb.used}</span> of {sb.limit} sandboxes in use
              </p>
              <p className={cx('text-[13px]', full ? 'text-error-text' : 'text-muted')}>
                {full ? 'Full. The next case will escalate until one is deleted.' : `${sb.limit - sb.used} free`}
              </p>
            </div>
            <div className="mt-4 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(44px, 1fr))' }}>
              {slots.map((s, i) => (
                <div key={s?.name ?? `empty-${i}`} title={s ? `${s.name}\n${WORD[kindOf(s)]}` : 'free slot'}
                  className={cx('h-11 rounded-lg border', s ? `${TILE[kindOf(s)]} animate-wake` : 'border-dashed border-line')} style={s ? { animationDelay: `${i * 70}ms` } : undefined} />
              ))}
            </div>
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
              {(['desk', 'remembered', 'closed', 'working', 'escalated'] as Kind[]).map((k) => (
                <span key={k} className="inline-flex items-center gap-1.5"><i className={cx('inline-block h-2.5 w-2.5 rounded-sm border', TILE[k])} />{WORD[k]}</span>
              ))}
            </p>
          </section>
        )}

        {sb && sb.real && (
          <section className="mt-6">
            <h2 className="text-[18px] font-semibold">Sandboxes</h2>
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
              {sb.sandboxes.map((s) => {
                const k = kindOf(s);
                const w = woke[s.name];
                return (
                  <li key={s.name} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-mono text-[13px] text-ink">
                        <i className={cx('inline-block h-2.5 w-2.5 rounded-sm border', TILE[k])} />
                        {s.case_id ? <Link className="underline underline-offset-4 hover:text-blue-text" to={`/app/theater/${s.case_id}`}>{s.name.length > 26 ? `${s.name.slice(0, 26)}…` : s.name}</Link> : s.name}
                      </p>
                      <p className="mt-0.5 text-[12px] text-muted">
                        {WORD[k]} · {s.status} · {s.memory_mb ?? '?'} MB · {s.region ?? 'region ?'} · created {ago(s.created_at)}
                      </p>
                      {typeof w === 'object' && <p className={cx('mt-1 text-[12px]', w.state_preserved ? 'text-success-text' : 'text-warning')}>Woke in {w.resumed_ms} ms. {w.note}</p>}
                      {typeof w === 'string' && <p className="mt-1 text-[12px] text-muted">{w}</p>}
                    </div>
                    {s.role === 'case' && (
                      <div className="flex gap-2">
                        {remembered.has(s.case_id ?? '') && <button onClick={() => wake(s)} className="rounded-full border border-line px-3 py-1 text-[12px] text-ink hover:border-blue">Wake</button>}
                        <button onClick={() => remove(s.name)} className={cx('rounded-full border px-3 py-1 text-[12px]', arm === s.name ? 'border-error bg-error text-white' : 'border-line text-ink hover:border-error')}>
                          {arm === s.name ? 'Click again to delete' : 'Delete'}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {act && act.activity.length > 0 && (
          <section className="mt-8">
            <h2 className="text-[18px] font-semibold">Recent Blaxel calls</h2>
            <p className="mt-1 text-[13px] text-muted">What the desk asked Blaxel to do, and how long each call took.</p>
            <ul className="mt-3 space-y-1.5">
              {act.activity.slice(0, 24).map((a, i) => (
                <li key={`${a.at}-${i}`} className="grid grid-cols-[130px_minmax(0,1fr)_70px] items-center gap-3 text-[13px]">
                  <span className={a.ok ? 'text-ink' : 'text-error-text'}>{ACTION[a.action] ?? a.action}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[12px] text-muted">{a.sandbox || a.case_id}{a.error ? ` · ${a.error}` : ''}</span>
                    <span className="mt-1 block h-1.5 rounded-full bg-surface">
                      <span className={cx('block h-1.5 rounded-full', a.ok ? 'bg-blue' : 'bg-error')} style={{ width: `${Math.max(3, (a.ms / maxMs) * 100)}%` }} />
                    </span>
                  </span>
                  <span className="text-right font-mono text-[12px] text-muted">{a.ms < 1000 ? `${a.ms} ms` : `${(a.ms / 1000).toFixed(1)} s`}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
    </div>
  );
}
