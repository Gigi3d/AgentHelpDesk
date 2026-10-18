import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getBlaxelSandboxes, getMemory, listCases, type BlaxelSandboxes } from '../lib/api';
import { LIVE } from '../lib/store';
import { TILE, WORD, kindFor } from '../lib/sandboxKinds';
import { cx } from './ui';

/**
 * The desk's Blaxel sandboxes as a strip of tiles, in the sidebar of every page. Each tile is a
 * real sandbox in the workspace; the tiles wake in one after another when the console loads, a new
 * sandbox pops in when a case opens one, and a case that is still working pulses. Click to open
 * the full Blaxel view. Only drawn against a live desk: the recorded fixtures have no sandboxes.
 */
export function SandboxRail() {
  const [sb, setSb] = useState<BlaxelSandboxes | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [remembered, setRemembered] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!LIVE) return;
    let stop = false;
    const load = async () => {
      try {
        const [s, c, m] = await Promise.all([getBlaxelSandboxes(), listCases(100), getMemory().catch(() => null)]);
        if (stop) return;
        setSb(s);
        setStatus(Object.fromEntries(c.cases.map((x) => [x.id, x.status])));
        setRemembered(new Set((m?.entries ?? []).map((e) => e.source_case)));
      } catch {
        // the rail is decoration on top of the page; a failed poll leaves the last picture up
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 6000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, []);

  const slots = useMemo(() => {
    const list = sb?.sandboxes ?? [];
    const n = Math.max(sb?.limit ?? 10, list.length);
    return Array.from({ length: n }, (_, i) => list[i] ?? null);
  }, [sb]);

  if (!LIVE || !sb || !sb.real) return null;
  const full = sb.used >= sb.limit;
  return (
    <Link to="/app/blaxel" className="mx-1 block rounded-ctl border border-line px-2.5 py-2 hover:border-muted/40" aria-label={`Blaxel: ${sb.used} of ${sb.limit} sandboxes in use`}>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="font-medium text-ink">Blaxel sandboxes</span>
        <span className={cx('font-mono', full ? 'text-error-text' : 'text-muted')}>{sb.used}/{sb.limit}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {slots.map((s, i) =>
          s ? (
            <i
              key={s.name}
              title={`${s.name}: ${WORD[kindFor(s, status, remembered)]}`}
              className={cx('h-3.5 w-3.5 rounded-[4px] border animate-wake', TILE[kindFor(s, status, remembered)])}
              style={{ animationDelay: `${i * 60}ms` }}
            />
          ) : (
            <i key={`free-${i}`} className="h-3.5 w-3.5 rounded-[4px] border border-dashed border-line" />
          ),
        )}
      </div>
      {full && <p className="mt-1.5 text-[11.5px] text-error-text">Full. The next case escalates.</p>}
    </Link>
  );
}
