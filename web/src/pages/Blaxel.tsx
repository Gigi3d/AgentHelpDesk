import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteBlaxelSandbox, getBlaxelActivity, getBlaxelSandboxes, getMemory, getScenarios, listCases, resumeMemory, type BlaxelActivity, type BlaxelSandbox, type BlaxelSandboxes, type MemoryResume, type ScenarioRun } from '../lib/api';
import { cx } from '../components/ui';
import { TILE, WORD, kindFor, type SandboxKind } from '../lib/sandboxKinds';

type Kind = SandboxKind;

const ACTION: Record<string, string> = { create_or_resume: 'Woke or created', fork: 'Cloned', destroy: 'Deleted', exec: 'Ran a command' };

const ago = (iso: string | null) => {
  if (!iso) return '';
  const s = Math.max(1, Math.round((Date.now() - Date.parse(iso.replace(' ', 'T'))) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};


const WORKING = new Set(['opened', 'reproducing', 'fix_drafted', 'proving']);
const runKind = (r: ScenarioRun): Kind => (WORKING.has(r.status) ? 'working' : r.status === 'escalated' ? 'escalated' : r.memory_hit ? 'remembered' : 'closed');

/** Test runs persist: they are rebuilt from the stored cases, so they stay after the sandboxes are gone. */
function rounds(runs: ScenarioRun[]): ScenarioRun[][] {
  const sorted = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const out: ScenarioRun[][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && prev.agent === r.agent && Date.parse(r.created_at) - Date.parse(prev.created_at) < 180_000) last.push(r);
    else out.push([r]);
  }
  return out.reverse();
}

export default function Blaxel() {
  const [sb, setSb] = useState<BlaxelSandboxes | null>(null);
  const [act, setAct] = useState<BlaxelActivity | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [remembered, setRemembered] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [arm, setArm] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScenarioRun[]>([]);
  const [replay, setReplay] = useState<Record<string, number>>({});
  const [woke, setWoke] = useState<Record<string, MemoryResume | string>>({});

  const load = useCallback(async () => {
    try {
      const [s, a, c, m] = await Promise.all([getBlaxelSandboxes(), getBlaxelActivity(), listCases(100), getMemory().catch(() => null)]);
      setSb(s);
      setAct(a);
      getScenarios().then((r) => setRuns(r.scenarios.flatMap((s) => s.runs))).catch(() => undefined);
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
        <h1 className="text-title font-semibold text-ink">Blaxel sandboxes</h1>
        <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed text-muted">
          One sandbox per case. The ones that proved a fix stay in standby. Live from your Blaxel workspace.
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


        {runs.length > 0 && (
          <section className="mt-8">
            <h2 className="text-[18px] font-semibold">Test runs</h2>
            <p className="mt-1 text-[13px] text-muted">Every round of x402 tests, kept after the sandboxes are deleted. Replay plays the sandboxes opening again.</p>
            <ul className="mt-3 space-y-3">
              {rounds(runs).slice(0, 8).map((round) => {
                const id = round[0]!.case_id;
                const live = new Set((sb?.sandboxes ?? []).map((s) => s.name));
                return (
                  <li key={id} className="rounded-2xl border border-line bg-white p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[14px] text-ink">
                        <span className="font-medium">Agent {round[0]!.agent}</span>
                        <span className="text-muted"> · {round.length} sandboxes · {ago(round[0]!.created_at)}</span>
                      </p>
                      <button onClick={() => setReplay((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 }))} className="rounded-full border border-line px-3 py-1 text-[12px] text-ink hover:border-blue">Replay</button>
                    </div>
                    <div key={replay[id] ?? 0} className="mt-3 flex flex-wrap gap-2">
                      {round.map((r, i) => {
                        const k = runKind(r);
                        const gone = sb?.real === true && !live.has(r.sandbox);
                        return (
                          <Link key={r.case_id} to={`/app/theater/${r.case_id}`} title={`${r.sandbox}\n${WORD[k]}${gone ? ' (sandbox deleted)' : ''}`}
                            className={cx('flex h-14 w-36 flex-col justify-between rounded-lg border px-2 py-1.5 animate-wake', TILE[k], k === 'closed' ? 'text-ink' : 'text-white', gone && 'opacity-60')} style={{ animationDelay: `${i * 140}ms` }}>
                            <span className="truncate font-mono text-[11px]">{r.scenario ?? 'case'}</span>
                            <span className="text-[11px] opacity-90">{r.memory_hit ? 'memory hit' : WORKING.has(r.status) ? 'running' : r.status}{r.ms ? ` · ${Math.round(r.ms / 1000)}s` : ''}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ul>
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
