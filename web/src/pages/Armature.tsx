import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getToken, getArmature, getArmatureIssues, listCases, pullArmature, type ArmatureIssue, type ArmatureStatus, type Failure } from '../lib/api';
import { Button, Chip, StageChip } from '../components/ui';

export default function Armature() {
  const [status, setStatus] = useState<ArmatureStatus | null>(null);
  const [issues, setIssues] = useState<ArmatureIssue[]>([]);
  const [cases, setCases] = useState<Failure[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([getArmature(), listCases(100)]);
      setStatus(s);
      getArmatureIssues().then((r) => setIssues(r.issues)).catch(() => undefined);
      setCases(l.cases.filter((c) => c.agent_id.startsWith('armature:')).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [load]);

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      await pullArmature(3);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[62ch]">
          <h1 className="text-title font-semibold text-ink">Armature</h1>
          <p className="mt-2 text-body text-muted">
            Armature reports where people and agents struggle on an MCP server. Each open issue becomes a case.
          </p>
        </div>
        {getToken() ? (
          <Button variant="primary" onClick={pull} disabled={busy}>{busy ? 'Pulling issues' : 'Pull issues and open cases'}</Button>
        ) : (
          <div className="text-right">
            <Link to="/app/scenarios" className="inline-flex items-center rounded-ctl bg-pink px-4 py-2 text-[14px] font-medium text-white hover:bg-pink-hover">Run the full demo</Link>
            <p className="mt-1 text-[12px] text-muted">Opening cases from issues needs the desk key.</p>
          </div>
        )}
      </header>

      {error && <p role="alert" className="mb-4 text-[14px] text-error-text">{error}</p>}

      {status && (
        <section className="mb-6 flex flex-wrap items-center gap-3 rounded-card border border-line bg-white p-4">
          <Chip tone={status.simulated ? 'amber' : 'green'} dot>{status.simulated ? 'Sample issues' : 'Live feed'}</Chip>
          <p className="min-w-0 flex-1 text-[14px] text-muted">{status.note}</p>
        </section>
      )}

      <section className="mb-6 rounded-card border border-line bg-white">
        <h2 className="border-b border-line px-4 py-3 text-[15px] font-semibold text-ink">Open issues</h2>
        {issues.length === 0 ? (
          <p className="px-4 py-8 text-center text-[14px] text-muted">No open issues.</p>
        ) : (
          <ul className="divide-y divide-line">
            {issues.map((i) => (
              <li key={i.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-ink">{i.title}</p>
                  <p className="mt-0.5 text-[13px] text-muted">{i.summary}</p>
                </div>
                <Chip tone="gray">{i.cause}</Chip>
                <span className="w-24 text-right text-[13px] text-muted">{i.sessions} sessions</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-card border border-line bg-white">
        <h2 className="border-b border-line px-4 py-3 text-[15px] font-semibold text-ink">Cases opened from Armature issues</h2>
        {cases.length === 0 ? (
          <p className="px-4 py-10 text-center text-[14px] text-muted">No cases yet. Pull issues to open the first ones.</p>
        ) : (
          <ul className="divide-y divide-line">
            {cases.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link to={`/app/tickets/${c.id}`} className="block truncate text-[14px] font-medium text-ink hover:text-blue-text">{c.task}</Link>
                  <p className="font-mono text-[12px] text-muted">{c.agent_id.replace('armature:', 'cause: ')} · {c.id}</p>
                </div>
                <StageChip stage={c.status} />
                <Link to={`/app/theater/${c.id}`} className="text-[13px] text-blue-text hover:underline">Watch it run</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
