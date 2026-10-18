import { useEffect, useState, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { ApiError, getToken, health, listCases, setToken } from '../lib/api';
import { LIVE } from '../lib/store';
import { Logo } from './Shell';

/** In live mode the desk wants a key. Ask once, keep it in this browser, and ask again on a 401. */
export function Gate({ children, forceLocked }: { children?: ReactNode; forceLocked?: boolean }) {
  const [state, setState] = useState<'checking' | 'open' | 'locked'>(forceLocked ? 'locked' : LIVE ? 'checking' : 'open');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!LIVE || forceLocked) return;
    let stop = false;
    const probe = () =>
      listCases(1)
        .then(() => !stop && setState('open'))
        .catch((e) => {
          if (stop) return;
          if (e instanceof ApiError && e.status === 401) setState('locked');
          else setState('open'); // unreachable shows its own banner in the shell
        });
    void health().then(probe, probe);
    const on = () => setState('locked');
    window.addEventListener('ahd-unauthorized', on);
    return () => {
      stop = true;
      window.removeEventListener('ahd-unauthorized', on);
    };
  }, []);

  if (state === 'open') return <>{children ?? <Outlet />}</>;
  if (state === 'checking') return <div className="grid min-h-screen place-items-center text-[14px] text-muted">Connecting to the desk</div>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setToken(value.trim());
    try {
      await listCases(1);
      window.location.assign('/app');
    } catch (err) {
      setToken('');
      setError(err instanceof ApiError && err.status === 401 ? 'That key was not accepted.' : 'The desk could not be reached. Try again in a moment.');
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-surface px-4">
      <form onSubmit={submit} className="w-full max-w-[400px] rounded-card border border-line bg-white p-7 shadow-pop">
        <Logo />
        <h1 className="mt-6 text-[22px] font-semibold tracking-tight">Admin key</h1>
        <p className="mt-1 text-[14px] leading-relaxed text-muted">Admin access. Without it you can still look around and run the demo. The key is in demo/.deploy.json.</p>
        <label htmlFor="desk-key" className="mt-5 block text-[13px] font-medium">Desk key</label>
        <input id="desk-key" type="password" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="mt-1 h-10 w-full rounded-ctl border border-line px-3 font-mono text-[14px]" />
        {error && <p role="alert" className="mt-2 text-[13px] text-error-text">{error}</p>}
        <button type="submit" disabled={!value.trim()} className="mt-4 h-10 w-full rounded-full bg-ink text-[14px] font-semibold text-white disabled:opacity-40">Unlock admin</button>
        {getToken() === '' ? null : <button type="button" onClick={() => { setToken(''); setError(null); }} className="mt-3 w-full text-[13px] text-muted underline underline-offset-4">Forget the saved key</button>}
      </form>
    </main>
  );
}
