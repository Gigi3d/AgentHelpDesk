import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getScenarios, runScenarios, type Scenario, type ScenarioRun } from '../lib/api';
import { Button, Chip, StageChip } from '../components/ui';
import { cx } from '../components/ui';
import { TILE } from '../lib/sandboxKinds';

const WORKING = new Set(['opened', 'reproducing', 'fix_drafted', 'proving']);
const DONE = new Set(['shipped', 'answered', 'closed']);
const secs = (ms: number | null) => (ms === null ? '' : `${(ms / 1000).toFixed(1)} s`);

/** The paid call as four hops. The defect sits on the pay hop until a run of this scenario ships. */
function Lane({ run }: { run: ScenarioRun | undefined }) {
  const fixed = run ? DONE.has(run.status) : false;
  const working = run ? WORKING.has(run.status) : false;
  const hops: Array<[string, 'ok' | 'bad' | 'work' | 'idle']> = [
    ['402 terms', 'ok'],
    ['Pay', run ? (fixed ? 'ok' : working ? 'work' : 'bad') : 'bad'],
    ['Retry', fixed ? 'ok' : 'idle'],
    ['200 report', fixed ? 'ok' : 'idle'],
  ];
  const tone = { ok: 'bg-success', bad: 'bg-error', work: 'bg-blue animate-pulse', idle: 'bg-line' } as const;
  return (
    <ol className="flex items-center gap-1.5" aria-label="x402 payment lane">
      {hops.map(([label, s], i) => (
        <li key={label} className="flex items-center gap-1.5">
          <span className={cx('h-2.5 w-2.5 rounded-full', tone[s])} />
          <span className={cx('text-[12px]', s === 'idle' ? 'text-muted' : 'text-ink')}>{label}</span>
          {i < hops.length - 1 && <span className={cx('mx-0.5 h-0.5 w-4 rounded', working && i === 1 ? 'animate-flow bg-[length:8px_2px] bg-[linear-gradient(90deg,#2554F5_50%,transparent_50%)]' : 'bg-line')} />}
        </li>
      ))}
    </ol>
  );
}

function Proofs({ p }: { p: ScenarioRun['proofs'] }) {
  if (!p) return null;
  const items: Array<[string, boolean]> = [['replay', p.replay], ['vendor tests', p.vendor_tests], ['fresh agent', p.fresh_agent]];
  return (
    <span className="flex flex-wrap gap-1">
      {items.map(([l, ok]) => <Chip key={l} tone={ok ? 'green' : 'red'}>{l}</Chip>)}
    </span>
  );
}

function Card({ s }: { s: Scenario }) {
  const latest = s.runs[0];
  return (
    <li className="rounded-card border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">{s.title}{s.featured && <Chip tone="blue" className="ml-2 align-middle">in the 4-run</Chip>}</h3>
          <p className="mt-0.5 text-[13px] text-muted">{s.defect}</p>
          <p className="mt-1 font-mono text-[12px] text-error-text">402 {s.id}</p>
        </div>
        <Lane run={latest} />
      </div>
      {s.runs.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {s.runs.slice(0, 4).map((r) => (
            <li key={r.case_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
              <span className="w-14 font-medium text-ink">{r.agent}</span>
              <Link to="/app/blaxel" title={`${r.sandbox} in Blaxel`} className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-muted hover:text-ink">
                <i className={cx('h-3 w-3 rounded-[3px] border animate-wake', TILE[WORKING.has(r.status) ? 'working' : r.status === 'escalated' ? 'escalated' : r.memory_hit || DONE.has(r.status) ? 'closed' : 'other'])} />
                {r.sandbox.replace('ahd-c-', '').slice(0, 8)}
              </Link>
              <StageChip stage={r.status} />
              {r.memory_hit ? <Chip tone="green">memory hit, no model call</Chip> : <Chip tone="blue">fresh draft</Chip>}
              <Proofs p={r.proofs} />
              <span className="ml-auto flex items-center gap-3 text-muted">
                <span className="font-mono text-[12px]">{secs(r.ms)}</span>
                <Link to={`/app/theater/${r.case_id}`} className="text-blue-text hover:underline">Watch</Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function Scenarios() {
  const [data, setData] = useState<Scenario[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData((await getScenarios()).scenarios);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [load]);

  const run = async (agent: string) => {
    setBusy(true);
    setError(null);
    try {
      await runScenarios(agent);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runs = (data ?? []).flatMap((s) => s.runs);
  const count = (f: (r: ScenarioRun) => boolean) => runs.filter(f).length;
  const stats: Array<[string, number, string]> = [
    ['Fixed and shipped', count((r) => DONE.has(r.status)), 'text-success-text'],
    ['In progress', count((r) => WORKING.has(r.status)), 'text-blue-text'],
    ['Model calls avoided', count((r) => r.memory_hit), 'text-success-text'],
    ['Needed a human', count((r) => r.status === 'awaiting_approval' || r.status === 'escalated'), count((r) => r.status === 'awaiting_approval' || r.status === 'escalated') ? 'text-error-text' : 'text-ink'],
  ];

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[64ch]">
          <h1 className="text-title font-semibold text-ink">x402 scenarios</h1>
          <p className="mt-2 text-body text-muted">
            Seven ways a paid call to Ledgerly goes wrong, all simulated and test mode, nothing is charged. The run button fires the four marked ones, so a round opens four sandboxes. Each runs end to end with nobody approving: the desk reproduces it in a Blaxel sandbox, fixes the docs, proves the fix three ways and ships it. Run them again as a second agent and the desk reuses what it already proved.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void run('alpha')} disabled={busy}>{busy ? 'Starting' : 'Run 4 as agent alpha'}</Button>
          <Button onClick={() => void run('beta')} disabled={busy}>Run again as agent beta</Button>
        </div>
      </header>
      {error && <p role="alert" className="mb-4 text-[14px] text-error-text">{error}</p>}
      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map(([label, n, tone]) => (
          <div key={label} className="rounded-card border border-line bg-white px-4 py-3">
            <div className={cx('text-[26px] font-semibold leading-8', tone)}>{n}</div>
            <div className="text-[13px] text-muted">{label}</div>
          </div>
        ))}
      </section>
      <ul className="space-y-3">{(data ?? []).map((s) => <Card key={s.id} s={s} />)}</ul>
    </div>
  );
}
