import { Link, useLocation } from 'react-router-dom';

export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="mx-auto max-w-xl px-6 py-24 text-center">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">404</p>
      <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-ink">There is nothing at {pathname}</h1>
      <p className="mt-2 text-[14px] text-muted">
        The console lives under <span className="font-mono">/app</span>. Case links look like <span className="font-mono">/app/tickets/ahd_…</span>, and approval texts land on <span className="font-mono">/approve/:id</span>.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link to="/app" className="h-9 rounded-ctl bg-pink px-4 text-[14px] font-medium leading-9 text-white hover:bg-pink-hover">Open the console</Link>
        <Link to="/" className="h-9 rounded-ctl border border-line bg-white px-4 text-[14px] font-medium leading-9 text-ink hover:bg-surface">Landing page</Link>
      </div>
    </div>
  );
}
