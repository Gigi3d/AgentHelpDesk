import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { agents, HERO_ID, useStore } from '../lib/store';
import { Kbd, StageChip, cx } from './ui';

export function Logo({ dark }: { dark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill={dark ? '#fff' : '#111827'} />
        <path d="M9 21l7-11 7 11" stroke="#E6007A" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="16" cy="22.5" r="1.8" fill={dark ? '#111827' : '#fff'} />
      </svg>
      <span className={cx('text-[15px] font-semibold tracking-tight', dark ? 'text-white' : 'text-ink')}>AgentHelpDesk</span>
    </span>
  );
}

const Icon = {
  home: 'M3 10.5L10 4l7 6.5V17a1 1 0 01-1 1h-4v-5H8v5H4a1 1 0 01-1-1z',
  tickets: 'M3 6a2 2 0 012-2h10a2 2 0 012 2v2a2 2 0 000 4v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 000-4z',
  agents: 'M10 10a3 3 0 100-6 3 3 0 000 6zm-6 7a6 6 0 0112 0',
  reports: 'M4 16V9m4 7V5m4 11v-5m4 5V7',
  billing: 'M3 6h14v9H3zM3 9h14',
  settings: 'M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM10 2v2m0 12v2m8-8h-2M4 10H2m13.7-5.7l-1.4 1.4M5.7 14.3l-1.4 1.4m11.4 0l-1.4-1.4M5.7 5.7L4.3 4.3',
  endpoints: 'M6 7l-3 3 3 3m8-6l3 3-3 3M11 4l-2 12',
  agent: 'M4 4h12v9H8l-4 3z',
  install: 'M10 3v10m0 0l-4-4m4 4l4-4M4 17h12',
  theater: 'M5 4l11 6-11 6z',
  memory: 'M4 5c0-1.1 2.7-2 6-2s6 .9 6 2-2.7 2-6 2-6-.9-6-2zm0 0v5c0 1.1 2.7 2 6 2s6-.9 6-2V5M4 10v5c0 1.1 2.7 2 6 2s6-.9 6-2v-5',
  blaxel: 'M3 4h6v6H3zm8 0h6v6h-6zM3 12h6v4H3zm8 0h6v4h-6z',
  armature: 'M10 3l7 4v6l-7 4-7-4V7zm0 0v14M3 7l7 4 7-4',
  staff: 'M10 2l6 3v5c0 4-3 6.5-6 8-3-1.5-6-4-6-8V5z',
};

function NavIcon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Item({ to, icon, children, badge, end }: { to: string; icon: string; children: ReactNode; badge?: number; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cx('flex h-8 items-center gap-2.5 rounded-ctl px-2.5 text-[14px] font-medium transition-colors', isActive ? 'bg-surface text-ink' : 'text-muted hover:bg-surface/70 hover:text-ink')}
    >
      <NavIcon d={icon} />
      <span className="flex-1">{children}</span>
      {!!badge && <span className="rounded-full bg-pink px-1.5 text-[11px] font-semibold leading-[18px] text-white">{badge}</span>}
    </NavLink>
  );
}

function useRecent() {
  const loc = useLocation();
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    const m = loc.pathname.match(/^\/app\/tickets\/(.+)$/);
    if (m) setRecent((r) => [m[1], ...r.filter((x) => x !== m[1])].slice(0, 5));
  }, [loc.pathname]);
  return recent;
}

function Sidebar({ onNav }: { onNav?: () => void }) {
  const { tickets, live } = useStore();
  const waiting = tickets.filter((t) => t.stage === 'awaiting_approval').length;
  const recent = useRecent();
  const short = (id: string) => tickets.find((t) => t.id === id);
  // The pin is a shortcut to the case that needs a human. Under the fixtures that is the
  // recorded demo case; live it is whatever the desk is actually holding, because pinning a
  // case id the live store has never seen just opens a not-found page.
  const pinned = live.on ? tickets.find((t) => t.stage === 'awaiting_approval') : tickets.find((t) => t.id === HERO_ID);
  return (
    <nav className="flex h-full flex-col gap-6 px-3 py-4" onClick={onNav}>
      <Link to="/app" className="px-2.5"><Logo /></Link>
      <div className="mx-1 flex items-center justify-between rounded-ctl border border-line px-2.5 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">Ledgerly</div>
          <div className="text-[11.5px] text-muted">Demo vendor · test mode</div>
        </div>
        <span className="h-2 w-2 rounded-full bg-success" title="Desk live" />
      </div>
      <div className="flex flex-col gap-0.5">
        <Item to="/app" icon={Icon.home} end>Home</Item>
        <Item to="/app/tickets" icon={Icon.tickets} badge={waiting}>Tickets</Item>
        <Item to="/app/agents" icon={Icon.agents}>Agents</Item>
        <Item to="/app/reports" icon={Icon.reports}>Reports</Item>
        <Item to="/app/billing" icon={Icon.billing}>Billing</Item>
        <Item to="/app/settings" icon={Icon.settings}>Settings</Item>
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="mb-1 px-2.5 text-label font-medium uppercase text-muted">Under the hood</div>
        <Item to="/app/theater" icon={Icon.theater}>Case Theater</Item>
        <Item to="/app/memory" icon={Icon.memory}>Fix memory</Item>
        <Item to="/app/blaxel" icon={Icon.blaxel}>Blaxel</Item>
        <Item to="/app/armature" icon={Icon.armature}>Armature</Item>
      </div>
      <div>
        <div className="mb-1 px-2.5 text-label font-medium uppercase text-muted">Pinned</div>
        {pinned && (
          <Link to={`/app/tickets/${pinned.id}`} className="flex items-center gap-2 rounded-ctl px-2.5 py-1.5 text-[13px] text-ink hover:bg-surface">
            <span className="text-pink">●</span><span className="truncate">{live.on ? pinned.title : 'Gift card won’t apply'}</span>
          </Link>
        )}
        <Link to="/app/endpoints" className="flex items-center gap-2 rounded-ctl px-2.5 py-1.5 text-[13px] text-ink hover:bg-surface">
          <span className="text-muted">◆</span><span className="truncate font-mono text-[12px]">POST /v1/checkout</span>
        </Link>
        {recent.length > 0 && <div className="mb-1 mt-3 px-2.5 text-label font-medium uppercase text-muted">Recent</div>}
        {recent.map((id) => (
          <Link key={id} to={`/app/tickets/${id}`} className="block truncate rounded-ctl px-2.5 py-1 font-mono text-[12px] text-muted hover:bg-surface hover:text-ink">
            {id}<span className="ml-1 font-sans">· {short(id)?.endpoint.split(' ')[1]}</span>
          </Link>
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-0.5 border-t border-line pt-4">
        <div className="mb-1 px-2.5 text-label font-medium uppercase text-muted">Surfaces</div>
        <Item to="/app/endpoints" icon={Icon.endpoints}>Endpoints</Item>
        <Item to="/agents" icon={Icon.agent}>Agent view</Item>
        <Item to="/install" icon={Icon.install}>Install flow</Item>
        <Item to="/staff" icon={Icon.staff}>Staff ops</Item>
      </div>
    </nav>
  );
}

/* ---------- Command search ---------- */

function CommandSearch({ onClose }: { onClose: () => void }) {
  const { tickets, live } = useStore();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const items = useMemo(() => {
    // The phone-approval surface carries a case id in its route, so live it has to be a case
    // the desk actually has — the fixture hero id is not in the live store.
    const approveId = live.on ? tickets.find((t) => t.stage === 'awaiting_approval')?.id : HERO_ID;
    const pages = [
      ['Home', '/app'], ['Tickets', '/app/tickets'], ['Agents', '/app/agents'], ['Endpoints', '/app/endpoints'], ['Reports', '/app/reports'],
      ['Billing', '/app/billing'], ['Settings', '/app/settings'], ['Case Theater', '/app/theater'], ['Fix memory', '/app/memory'], ['Blaxel sandboxes', '/app/blaxel'], ['Armature feed', '/app/armature'], ['Authority envelope', '/app/settings?s=authority'], ['Stack', '/app/settings?s=stack'],
      ['Agent help page', '/agents'], ['Install flow', '/install'], ['Staff ops', '/staff'],
      ...(approveId ? [['Approve by text (phone)', `/approve/${approveId}`]] : []),
    ].map(([label, to]) => ({ kind: 'Page', label, sub: '', to }));
    const t = tickets.map((x) => ({ kind: 'Ticket', label: x.title, sub: `${x.id} · ${x.endpoint} · ${(x.response.headers['Request-Id'] ?? '')}`, to: `/app/tickets/${x.id}` }));
    const a = agents.map((x) => ({ kind: 'Agent', label: x.name, sub: x.client, to: `/app/agents?a=${x.id}` }));
    const all = [...pages, ...t, ...a];
    const s = q.trim().toLowerCase();
    return (s ? all.filter((i) => (i.label + i.sub).toLowerCase().includes(s)) : all).slice(0, 9);
  }, [q, tickets, live.on]);
  const go = (to: string) => { nav(to); onClose(); };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div className="w-full max-w-xl animate-fadein overflow-hidden rounded-card border border-line bg-white shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter' && items[sel]) go(items[sel].to);
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Search tickets, agents, endpoints, request IDs…"
          className="h-12 w-full border-b border-line px-4 text-[15px] outline-none placeholder:text-muted"
        />
        <ul className="max-h-[50vh] overflow-auto py-1">
          {items.map((i, k) => (
            <li key={i.to + k}>
              <button onMouseEnter={() => setSel(k)} onClick={() => go(i.to)} className={cx('flex w-full items-center gap-3 px-4 py-2 text-left', k === sel && 'bg-blue-tint')}>
                <span className="w-12 shrink-0 text-[11px] font-medium uppercase text-muted">{i.kind}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{i.label}</span>
                  {i.sub && <span className="block truncate font-mono text-[11.5px] text-muted">{i.sub}</span>}
                </span>
              </button>
            </li>
          ))}
          {!items.length && <li className="px-4 py-6 text-center text-[14px] text-muted">Nothing matches “{q}”.</li>}
        </ul>
      </div>
    </div>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [['/', 'Search everything'], ['?', 'Show shortcuts'], ['J / K', 'Move through a ticket list'], ['Enter', 'Open the selected ticket'], ['A', 'Approve (asks to confirm on risky fixes)'], ['R', 'Reject with a reason'], ['G then H', 'Go Home'], ['G then T', 'Go to Tickets'], ['Esc', 'Close a dialog']];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm animate-fadein rounded-card border border-line bg-white p-5 shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-[15px] font-semibold">Keyboard shortcuts</h3>
        <ul className="divide-y divide-line">
          {rows.map(([k, v]) => (
            <li key={k} className="flex items-center justify-between py-2 text-[14px]"><span className="text-muted">{v}</span><span className="flex gap-1">{k.split(' ').map((p) => p === 'then' || p === '/' && k.length > 1 ? <span key={p} className="text-[12px] text-muted">{p}</span> : <Kbd key={p}>{p}</Kbd>)}</span></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={cx('pointer-events-auto animate-fadein rounded-card border bg-white px-4 py-3 text-[14px] shadow-pop', t.tone === 'success' ? 'border-success/40' : t.tone === 'error' ? 'border-error/40' : t.tone === 'pink' ? 'border-pink/50' : 'border-line')}>
          <span className={cx('mr-2 inline-block h-2 w-2 rounded-full', t.tone === 'success' ? 'bg-success' : t.tone === 'error' ? 'bg-error' : t.tone === 'pink' ? 'bg-pink' : 'bg-blue')} />
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function useGlobalKeys(open: (k: 'search' | 'keys') => void) {
  const nav = useNavigate();
  useEffect(() => {
    let g = false;
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey) return;
      if (e.key === '/') { e.preventDefault(); open('search'); }
      else if (e.key === '?') open('keys');
      else if (g && e.key === 'h') nav('/app');
      else if (g && e.key === 't') nav('/app/tickets');
      g = e.key === 'g';
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [nav, open]);
}

/**
 * A surface with no live source at all. Under the LIVE badge a reader assumes everything on
 * screen came from the running desk, so a page that can only show recorded sample data has to
 * say so itself. It renders nothing in fixture mode: there the whole console is sample data
 * and the test-mode banner already covers it.
 */
export function LiveSampleNote({ children }: { children: ReactNode }) {
  const { live } = useStore();
  if (!live.on) return null;
  return (
    <p className="mb-4 rounded-ctl border border-dashed border-muted/50 bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-muted">
      <span className="font-semibold text-ink">Recorded sample, not live:</span> {children}
    </p>
  );
}

export function TestModeBanner() {
  const { live } = useStore();
  return (
    <div className="flex h-8 items-center justify-center gap-2 bg-pink-tint px-3 text-[12.5px] font-medium text-pink-text">
      <span className="rounded bg-pink px-1.5 text-[10.5px] font-bold uppercase leading-4 tracking-wide text-white">Test mode</span>
      Nothing is charged.<span className="hidden sm:inline"> Stripe test keys. Ledgerly is a demo vendor with seeded failures.</span>
      {live.on && (
        <span className="ml-1 flex items-center gap-1.5 rounded bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold" title={`Reading cases and events from ${live.url}`}>
          <i className={cx('h-1.5 w-1.5 rounded-full', live.state === 'open' ? 'bg-success' : live.state === 'error' ? 'bg-error' : 'bg-muted')} />
          LIVE · {live.state === 'error' ? `cannot reach ${live.url}` : live.url}
        </span>
      )}
    </div>
  );
}

function LiveGate() {
  const { live } = useStore();
  const connecting = live.state === 'connecting';
  return (
    <div className="mx-auto max-w-lg rounded-card border border-line bg-white p-8 text-center">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">Live mode</p>
      <h2 className="mt-2 text-[20px] font-semibold text-ink">{connecting ? 'Connecting to the desk API…' : 'The desk API is not answering'}</h2>
      <p className="mt-2 text-[14px] text-muted">
        {connecting ? (
          <>Reading cases and tool events from <span className="font-mono">{live.url}</span>. Until the first poll answers there is nothing to count, so this console stays empty rather than showing fixtures as if they were live.</>
        ) : (
          <>
            Cannot reach <span className="font-mono">{live.url}</span>. Start the desk with <span className="font-mono">node --experimental-strip-types server.ts</span> in <span className="font-mono">product/</span> (port 8787), or drop <span className="font-mono">VITE_LIVE=1</span> to run on the recorded fixtures.
            <span className="mt-2 block text-[13px]">If it is running, the browser may still be blocked: the API answers the loopback dev ports (<span className="font-mono">5173</span>, <span className="font-mono">5180</span>, <span className="font-mono">5181</span>) by default, and any other origin has to be named in <span className="font-mono">AHD_CORS_ORIGINS</span>.</span>
          </>
        )}
      </p>
      <a href="/app" className="mt-5 inline-flex h-9 items-center rounded-ctl border border-line bg-white px-4 text-[14px] font-medium text-ink hover:bg-surface">Reload the console</a>
    </div>
  );
}

export function AppShell() {
  const [dialog, setDialog] = useState<null | 'search' | 'keys'>(null);
  const [mobile, setMobile] = useState(false);
  useGlobalKeys(setDialog);
  const { tickets, replay, live } = useStore();
  const hero = tickets.find((t) => t.id === HERO_ID);
  return (
    <div className="min-h-screen bg-white">
      <TestModeBanner />
      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 border-r border-line bg-white lg:block"><Sidebar /></aside>
        {mobile && (
          <div className="fixed inset-0 z-40 bg-ink/20 lg:hidden" onClick={() => setMobile(false)}>
            <aside className="h-full w-[260px] bg-white shadow-pop" onClick={(e) => e.stopPropagation()}><Sidebar onNav={() => setMobile(false)} /></aside>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white/90 px-4 backdrop-blur md:px-6">
            <button className="rounded-ctl p-1.5 text-muted hover:bg-surface lg:hidden" onClick={() => setMobile(true)} aria-label="Open menu">
              <svg width="20" height="20" viewBox="0 0 20 20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 6h14M3 10h14M3 14h14" /></svg>
            </button>
            <button onClick={() => setDialog('search')} className="flex h-9 w-full max-w-md items-center gap-2 rounded-ctl border border-line bg-surface px-3 text-left text-[14px] text-muted hover:border-muted/40">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="9" r="6" /><path d="M14 14l4 4" strokeLinecap="round" /></svg>
              <span className="flex-1 truncate">Search tickets, agents, request IDs</span>
              <Kbd>/</Kbd>
            </button>
            <div className="ml-auto flex items-center gap-2">
              {replay.phase === 'running' && hero && (
                <Link to={`/app/tickets/${HERO_ID}`} className="hidden items-center gap-2 md:flex"><StageChip stage={hero.stage} /></Link>
              )}
              <button onClick={() => setDialog('keys')} className="hidden h-8 w-8 items-center justify-center rounded-ctl text-muted hover:bg-surface md:flex" aria-label="Keyboard shortcuts"><Kbd>?</Kbd></button>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[12px] font-semibold text-white" title="Gideon · Admin">GN</div>
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1120px] px-4 py-8 md:px-6">
            {live.on && live.state !== 'open' && !tickets.length ? <LiveGate /> : <Outlet />}
          </main>
          <footer className="mx-auto max-w-[1120px] px-6 pb-8 text-[12px] text-muted">
            Live-on-screen data reads from <span className="font-mono">tool_events</span>. Waiting {tickets.filter((t) => t.stage === 'awaiting_approval').length} · Press <Kbd>?</Kbd> for shortcuts.
          </footer>
        </div>
      </div>
      {dialog === 'search' && <CommandSearch onClose={() => setDialog(null)} />}
      {dialog === 'keys' && <Shortcuts onClose={() => setDialog(null)} />}
      <Toasts />
    </div>
  );
}

export { Toasts };
