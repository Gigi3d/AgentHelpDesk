import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/api';

// "Wake the desk": asks GitHub to run the desk-control workflow (action: wake), which restarts
// the desk on Blaxel, and polls /healthz until it answers. The token is a fine-grained GitHub
// token limited to Actions on this one repository, baked in at build time from the WAKE_TOKEN
// secret. It can start workflows and nothing else.
const TOKEN = (import.meta.env.VITE_WAKE_TOKEN as string | undefined) ?? '';
const REPO = 'Gigi3d/AgentHelpDesk';
const COOLDOWN_KEY = 'ahd-wake-at';

type Phase = 'idle' | 'asking' | 'waiting' | 'back' | 'failed';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = async () => {
  try { return (await fetch(`${API_BASE}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(6000) })).ok; } catch { return false; }
};

export function WakeDesk({ compact = false }: { compact?: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  const [secs, setSecs] = useState(0);
  const run = useRef(0);

  useEffect(() => () => { run.current += 1; }, []);

  async function wake() {
    const me = ++run.current;
    setPhase('asking');
    setNote('');
    try {
      // Within two minutes of the last request the workflow is already running: just wait for it.
      const last = Number(sessionStorage.getItem(COOLDOWN_KEY) ?? 0);
      if (Date.now() - last > 120_000) {
        const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/desk-control.yml/dispatches`, {
          method: 'POST',
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${TOKEN}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
          body: JSON.stringify({ ref: 'main', inputs: { action: 'wake' } }),
        });
        if (res.status !== 204) throw new Error(`GitHub answered ${res.status}. The wake token may have expired.`);
        try { sessionStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch { /* private window */ }
      }
    } catch (err) {
      if (me !== run.current) return;
      setPhase('failed');
      setNote(err instanceof Error ? err.message : String(err));
      return;
    }
    setPhase('waiting');
    const started = Date.now();
    while (me === run.current && Date.now() - started < 8 * 60_000) {
      setSecs(Math.round((Date.now() - started) / 1000));
      if (await alive()) {
        if (me !== run.current) return;
        setPhase('back');
        await sleep(800);
        window.location.reload();
        return;
      }
      await sleep(4000);
    }
    if (me === run.current) {
      setPhase('failed');
      setNote('The desk did not answer within 8 minutes. Try again, or open the repository Actions tab and run desk-control.');
    }
  }

  if (!TOKEN) {
    return compact ? null : <p className="mt-4 text-[13px] text-muted">The desk restarts on its own within a minute or two. Reload shortly.</p>;
  }
  const busy = phase === 'asking' || phase === 'waiting';
  const label = phase === 'asking' ? 'Asking GitHub…' : phase === 'waiting' ? `Waking the desk… ${secs}s` : phase === 'back' ? 'Back. Reloading…' : 'Wake the desk';
  return (
    <div className={compact ? 'inline-flex items-center gap-2' : 'mt-5'}>
      <button
        type="button"
        disabled={busy || phase === 'back'}
        onClick={wake}
        className={compact
          ? 'rounded bg-pink px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-pink-hover disabled:opacity-60'
          : 'inline-flex h-10 items-center rounded-ctl bg-pink px-5 text-[14px] font-medium text-white hover:bg-pink-hover disabled:opacity-60'}
      >
        {label}
      </button>
      {!compact && phase === 'waiting' && <p className="mt-3 text-[13px] text-muted">Usually under a minute. If the sandbox has to be rebuilt it takes about four. This page reloads when the desk answers.</p>}
      {!compact && phase === 'failed' && <p className="mt-3 text-[13px] text-error-text" role="alert">{note}</p>}
    </div>
  );
}
