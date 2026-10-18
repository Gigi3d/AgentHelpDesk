import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, getCase, listCases, reportProblem, replyApproval, runCase, type CaseView } from '../lib/api';
import { Stage } from '../theater/Stage';
import { deriveSteps, isTerminal, type Ev, type StepKey, type StepState } from '../theater/steps';
import { cx } from '../components/ui';

const DOT: Record<StepState, string> = {
  pending: 'border-line bg-transparent',
  active: 'border-blue bg-blue animate-pulse',
  done: 'border-success bg-success',
  failed: 'border-error bg-error',
  skipped: 'border-line bg-line',
};

const msText = (ms: number | null) => (ms === null || ms <= 0 ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** First removed and added line of a unified diff, for the draft scene. */
function diffLines(diff: string): { file: string; removed: string; added: string } {
  const lines = diff.split('\n');
  const file = (lines.find((l) => l.startsWith('+++ '))?.replace(/^\+\+\+ b?\//, '') ?? 'docs/quickstart.md').trim();
  const clip = (s: string) => (s.length > 34 ? `${s.slice(0, 33)}…` : s);
  const removed = lines.find((l) => l.startsWith('-') && !l.startsWith('---') && l.trim().length > 1)?.slice(1) ?? '';
  const added = lines.find((l) => l.startsWith('+') && !l.startsWith('+++') && l.trim().length > 1)?.slice(1) ?? '';
  return { file, removed: clip(removed), added: clip(added) };
}

const SAMPLE_REPORT = {
  agent_id: 'agent-theater',
  task: 'List my ledger entries',
  request: { method: 'GET', url: 'https://api.ledgerly.test/v1/entries', headers: { 'x-api-key': 'redacted' } },
  response: { status: 401, error: { code: 'unauthorized', message: 'Invalid or missing credentials.' } },
  channel: 'mcp' as const,
};

export default function Theater() {
  const { id } = useParams();
  const nav = useNavigate();
  const [view, setView] = useState<CaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [picked, setPicked] = useState<StepKey>('create');
  const [busy, setBusy] = useState(false);
  const playTimer = useRef<number | null>(null);

  // No id in the URL: open the newest case, if there is one.
  useEffect(() => {
    if (id) return;
    let stop = false;
    listCases(50)
      .then((l) => {
        if (stop || l.cases.length === 0) return;
        const newest = [...l.cases].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!;
        nav(`/app/theater/${newest.id}`, { replace: true });
      })
      .catch((e) => !stop && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      stop = true;
    };
  }, [id, nav]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setView(await getCase(id));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        window.dispatchEvent(new Event('ahd-unauthorized'));
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), view && isTerminal(view.status) ? 8000 : 1800);
    return () => window.clearInterval(t);
  }, [load, view?.status]);

  const steps = useMemo(
    () => (view ? deriveSteps({ status: view.status, events: view.events as Ev[], outcome: view.outcome, approval: view.approval }) : []),
    [view],
  );
  const live = steps.find((s) => s.state === 'active') ?? [...steps].reverse().find((s) => s.state === 'done' || s.state === 'failed');
  const focusKey: StepKey = follow ? (live?.key ?? 'create') : picked;
  const focus = steps.find((s) => s.key === focusKey);

  const stopPlay = () => {
    if (playTimer.current !== null) window.clearInterval(playTimer.current);
    playTimer.current = null;
  };
  useEffect(() => stopPlay, []);
  const playBack = () => {
    stopPlay();
    const order = steps.filter((s) => s.state === 'done' || s.state === 'failed').map((s) => s.key);
    if (order.length === 0) return;
    let i = 0;
    setFollow(false);
    setPicked(order[0]!);
    playTimer.current = window.setInterval(() => {
      i += 1;
      if (i >= order.length) {
        stopPlay();
        setFollow(true);
        return;
      }
      setPicked(order[i]!);
    }, 2600);
  };

  const startDemo = async () => {
    setBusy(true);
    try {
      const receipt = await reportProblem({ ...SAMPLE_REPORT, idempotency_key: `theater-${Date.now()}` });
      await runCase(receipt.case_id);
      nav(`/app/theater/${receipt.case_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: 'yes' | 'no') => {
    if (!view?.approval) return;
    setBusy(true);
    try {
      await replyApproval(view.approval.id, decision, 'theater');
      await runCase(view.case.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sandbox = view ? `ahd-c-${view.case.id.replace(/^c-/, '').slice(0, 8)}` : 'ahd-c-…';
  const dl = diffLines(view?.attempt?.diff ?? '');
  const boxState: StepState = !view ? 'pending' : view.status === 'escalated' ? 'failed' : view.status === 'closed' ? 'done' : 'active';
  const testsPayload = steps.find((s) => s.key === 'tests')?.event?.payload as { detail?: string } | undefined;
  const testsCount = (() => {
    const m = /(\d+) tests?/i.exec(testsPayload?.detail ?? '');
    return m ? Number(m[1]) : null;
  })();
  const awaiting = view?.status === 'awaiting_approval' && view.approval && view.approval.decision === null;

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-ink">Case Theater</h1>
        <div className="flex items-center gap-3 text-[13px] text-muted">
          {view && (
            <>
              <span className="font-mono">{view.case.id}</span>
              <span className={cx('rounded-full px-2 py-0.5 text-[12px] font-medium', view.status === 'closed' ? 'bg-success-tint text-success-text' : view.status === 'escalated' ? 'bg-error-tint text-error-text' : 'bg-blue-tint text-blue-text')}>
                {view.status.replace('_', ' ')}
              </span>
              <Link to={`/app/tickets/${view.case.id}`} className="underline underline-offset-4 hover:text-ink">Open ticket</Link>
            </>
          )}
          <button onClick={startDemo} disabled={busy} className="rounded-full bg-pink px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-pink-hover disabled:opacity-50">
            {busy ? 'Starting' : 'Run the Ledgerly case'}
          </button>
        </div>
      </header>

      {!view && (
        <main className="mx-auto max-w-[640px] py-16 text-center">
          <h1 className="text-[28px] font-semibold tracking-tight">Watch a case run inside its sandbox</h1>
          <p className="mx-auto mt-3 max-w-[48ch] text-[15px] leading-relaxed text-muted">
            Every step you see is read from the desk’s own record of the case. Run the Ledgerly case to see a real one, or open any ticket from the console.
          </p>
          {error && <p className="mt-6 text-[14px] text-error-text">{error}</p>}
        </main>
      )}

      {view && focus && (
        <main className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-live="polite">
            <div className="overflow-hidden rounded-2xl border border-line bg-[#0B1020] shadow-pop">
              <div className="aspect-[800/440] w-full">
                <Stage
                  focus={focusKey}
                  steps={steps}
                  sandbox={sandbox}
                  vendor={view.vendor?.name ?? 'vendor'}
                  file={dl.file}
                  removed={dl.removed || 'old line'}
                  added={dl.added || 'new line'}
                  code={{ before: String((view.case.response as { status?: number } | null)?.status ?? 401), after: '200' }}
                  testsCount={testsCount}
                  price={null}
                  boxState={boxState}
                />
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-[60ch]">
                <h2 className="text-[20px] font-semibold leading-7 text-ink">{focus.title}</h2>
                <p className="mt-1 text-[15px] leading-relaxed text-muted">{focus.note ?? focus.caption}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {awaiting && (
                  <>
                    <button onClick={() => void decide('yes')} disabled={busy} className="rounded-full bg-success px-4 py-2 text-[14px] font-semibold text-white hover:brightness-110 disabled:opacity-50">Approve the change</button>
                    <button onClick={() => void decide('no')} disabled={busy} className="rounded-full border border-line px-4 py-2 text-[14px] font-semibold hover:bg-surface disabled:opacity-50">Reject</button>
                  </>
                )}
                <button onClick={playBack} className="rounded-full border border-line px-3.5 py-2 text-[13px] font-medium hover:bg-surface">Play back</button>
                {!follow && <button onClick={() => { stopPlay(); setFollow(true); }} className="rounded-full border border-line px-3.5 py-2 text-[13px] font-medium hover:bg-surface">Follow live</button>}
              </div>
            </div>
            {error && <p className="mt-4 text-[13px] text-error-text">{error}</p>}

            <div className="mt-6 rounded-xl border border-line bg-white p-4">
              <div className="flex items-baseline justify-between text-[13px] text-muted">
                <span>What the desk recorded for this step</span>
                <span className="font-mono">{focus.event ? `${focus.event.tool} · ${focus.event.action} · ${focus.event.result}${focus.ms !== null ? ` · ${msText(focus.ms)}` : ''}` : 'nothing yet'}</span>
              </div>
              <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-ink">
                {focus.event ? JSON.stringify(focus.event.payload, null, 2).slice(0, 1400) : 'This step has not happened yet. This page checks every two seconds.'}
              </pre>
            </div>
          </section>

          <aside>
            <ol className="relative space-y-1 rounded-2xl border border-line bg-white p-3">
              {steps.map((s) => (
                <li key={s.key}>
                  <button
                    onClick={() => { stopPlay(); setFollow(false); setPicked(s.key); }}
                    aria-current={s.key === focusKey ? 'step' : undefined}
                    className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors', s.key === focusKey ? 'bg-blue-tint' : 'hover:bg-surface')}
                  >
                    <span aria-hidden className={cx('h-3 w-3 shrink-0 rounded-full border-2', DOT[s.state])} />
                    <span className={cx('flex-1 text-[14px] leading-5', s.state === 'pending' ? 'text-muted' : 'text-ink')}>{s.title}</span>
                    <span className="font-mono text-[12px] text-muted">{msText(s.ms)}</span>
                    <span className="sr-only">{s.state}</span>
                  </button>
                </li>
              ))}
            </ol>
            <dl className="mt-4 space-y-2 rounded-2xl border border-line bg-white p-4 text-[13px]">
              <div className="flex justify-between gap-4"><dt className="text-muted">Agent’s task</dt><dd className="text-right">{view.case.task}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Acknowledge by</dt><dd className="font-mono">{new Date(view.ack_by).toLocaleTimeString()}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Resolve by</dt><dd className="font-mono">{new Date(view.resolve_by).toLocaleTimeString()}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Vendor mode</dt><dd>{view.vendor?.risk_policy?.replace('_', ' ') ?? 'unknown'}</dd></div>
            </dl>
          </aside>
        </main>
      )}
    </div>
  );
}
