import { useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import config from '../data/agenthelpdesk.json';
import { agents, useStore } from '../lib/store';
import { clock, dur, now, usd } from '../lib/clock';
import { JsonView } from '../components/Json';
import { LiveSampleNote } from '../components/Shell';
import { Button, Card, CardHead, Chip, Label, PageHeader, Toggle, cx, modeLabel } from '../components/ui';
import type { Mode } from '../lib/types';

const sections = [
  ['install', 'Install'], ['modes', 'Approval modes'], ['authority', 'Authority envelope'], ['approvers', 'Approvers'], ['team', 'Team and roles'],
  ['notifications', 'Notifications'], ['branding', 'Branding'], ['agent', 'Agent settings'], ['stack', 'Stack'], ['keys', 'API keys and webhooks'], ['danger', 'Danger zone'],
] as const;
type Key = (typeof sections)[number][0];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('s');
  const s: Key = sections.some(([k]) => k === raw) ? (raw as Key) : 'install';
  const body: Record<Key, ReactNode> = {
    install: <Install />, modes: <Modes />, authority: <Authority />, approvers: <Approvers />, team: <Team />,
    notifications: <Notifications />, branding: <Branding />, agent: <AgentSettings />, stack: <Stack />, keys: <Keys />, danger: <Danger />,
  };
  return (
    <div>
      <PageHeader title="Settings" sub="Every setting lives in agenthelpdesk.json in your repo. Changes here open a pull request, so nothing changes without a reviewable diff." />
      <LiveSampleNote>
        these sections all render the recorded agenthelpdesk.json — the install rungs, approvers, team, envelope change history and the config itself. The desk API publishes no config route, so nothing here is read from or written to the running desk, and an edit changes no setting. The ticket counts and the tool-event cards inside these sections are the exception: those come off the cases and events the desk is holding.
      </LiveSampleNote>
      <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto md:flex-col">
          {sections.map(([k, label]) => (
            <button key={k} onClick={() => setParams({ s: k })} aria-current={s === k ? 'true' : undefined} className={cx('whitespace-nowrap rounded-ctl px-3 py-1.5 text-left text-[14px] font-medium focus-visible:outline-2 focus-visible:-outline-offset-2', s === k ? 'bg-surface text-ink' : 'text-muted hover:text-ink', k === 'danger' && 'text-error')}>{label}</button>
          ))}
        </nav>
        <div className="min-w-0 space-y-6">{body[s]}</div>
      </div>
    </div>
  );
}

/** An inline two-step confirm, so a destructive control cannot fire on one click. */
function Confirm({ verb, note, onConfirm, onCancel }: { verb: string; note?: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="w-full max-w-sm rounded-ctl border border-line bg-white p-3 text-left">
      {note && <p className="mb-2 text-[13px] text-ink">{note}</p>}
      <div className="flex gap-2">
        <Button variant="danger" size="sm" onClick={onConfirm}>{verb}</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

const field = 'mt-1 h-9 w-full rounded-ctl border border-line px-3 text-[14px] outline-none focus:border-blue disabled:bg-surface disabled:text-muted';

function Install() {
  const { tickets, propose } = useStore();
  const [revoking, setRevoking] = useState(false);
  const first = tickets
    .filter((t) => t.resolved_at && Object.values(t.proofs).every((p) => p.status === 'passed'))
    .sort((a, b) => (a.resolved_at ?? '').localeCompare(b.resolved_at ?? ''))[0];
  const repo = config.provider.repo.split('/').slice(-2).join('/');
  const steps: [string, string, boolean][] = [
    [`GitHub App installed on ${repo}`, 'Reads contents, OpenAPI spec, docs and CI. Writes pull requests and comments only.', true],
    ['OpenAPI spec found', `${config.provider.openapi} · ${config.endpoints.length} endpoints, desk on for ${config.endpoints.filter((e) => e.desk).length}`, true],
    ['Install PR #41 merged', 'agenthelpdesk.json, error help field, llms.txt line, CI check', true],
    first
      ? [`First test case passed · ${first.id}`, `3 of 3 proofs in ${dur(Date.parse(first.resolved_at ?? first.created_at) - Date.parse(first.created_at))} from open to answer`, true]
      : ['First test case', 'No case has passed all three proofs yet.', false],
    ['Live payment method', 'Optional while in test mode', false],
  ];
  return (
    <>
      <Card>
        <CardHead title="Install status" right={<Chip tone="green" dot>Rung 4 of 4 · Live</Chip>} />
        <ul className="divide-y divide-line">
          {steps.map(([k, v, done]) => (
            <li key={k} className="flex gap-3 px-5 py-3">
              <span className={done ? 'text-success-text' : 'text-muted'}>{done ? '✓' : '○'}</span>
              <div><div className={cx('text-[14px]', done ? 'text-ink' : 'text-muted')}>{k}</div><div className="text-[12.5px] text-muted">{v}</div></div>
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-[13px] text-muted">You are on the top rung, so a fix can be proved three ways and billed. Rungs 0 to 3 — a forwarded failing call, an error help line, spec only, and channel routing — stay available and always run in suggest only, never billed. <Link to="/install" className="font-medium text-blue-text underline hover:no-underline">Review the install paths</Link></p>
      <JsonView file="agenthelpdesk.json" note="in your repo root" data={config} maxHeight={320} />
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><div className="text-[14px] font-semibold">Revoke the GitHub App</div><div className="text-[13px] text-muted">The desk drops to suggest only. Nothing in your API changes.</div></div>
          {revoking ? <Confirm verb="Revoke" note={`Turn the desk off for all ${config.endpoints.length} endpoints?`} onCancel={() => setRevoking(false)} onConfirm={() => { setRevoking(false); propose('endpoints[*].desk', false); }} /> : <Button variant="danger" onClick={() => setRevoking(true)}>Revoke</Button>}
        </div>
      </Card>
    </>
  );
}

function Modes() {
  const { propose } = useStore();
  const [def, setDef] = useState<Mode>(config.mode_default as Mode);
  const rows: [Mode, string, string, string][] = [
    ['auto', 'Docs and error text changes that pass all three proofs', 'Anything touching code or schema', 'Docs and error text only'],
    ['approve_first', 'Nothing', 'Code and schema changes, sent as a text message', 'New accounts and code changes'],
    ['suggest_only', 'Nothing', 'Every fix, shown as a draft you apply', 'Sensitive endpoints, such as payments'],
  ];
  return (
    <Card>
      <CardHead title="Approval modes" sub="Whatever the mode, nothing ships without three proofs. Override per endpoint on the Endpoints page." />
      <div className="divide-y divide-line">
        {rows.map(([m, alone, waits, dflt]) => (
          <label key={m} className={cx('flex cursor-pointer gap-4 px-5 py-4', def === m && 'bg-blue-tint/40')}>
            <input type="radio" name="mode" checked={def === m} onChange={() => { setDef(m); propose('mode_default', m); }} className="mt-1 accent-blue" />
            <div className="grid flex-1 gap-2 text-[13.5px] md:grid-cols-[140px_1fr_1fr]">
              <div className="font-semibold text-ink">{modeLabel[m]}{def === m && <div className="text-[12px] font-normal text-blue-text">Account default</div>}</div>
              <div><Label>Ships alone</Label><div className="mt-0.5">{alone}</div></div>
              <div><Label>Waits</Label><div className="mt-0.5">{waits}</div><div className="mt-1 text-[12px] text-muted">Default for: {dflt}</div></div>
            </div>
          </label>
        ))}
      </div>
    </Card>
  );
}

function Authority() {
  const { toast, propose } = useStore();
  const [env, setEnv] = useState(config.authority);
  const live = config.authority['entitlements.reissue'];
  const [log, setLog] = useState<{ at: number; text: string }[]>([
    { at: Date.parse('2026-10-17T19:02:00Z'), text: `entitlements.reissue enabled at the tightest defaults (${live.per_user} per user, $${live.cap_usd_per_case} per case)` },
  ]);
  const set = (verb: keyof typeof env, field: string, v: number | boolean) => {
    setEnv({ ...env, [verb]: { ...env[verb], [field]: v } });
    setLog((l) => [{ at: now(), text: `${verb}.${field} → ${v}` }, ...l]);
    propose(`authority.${verb}.${field}`, v);
  };
  const verbs: { key: keyof typeof env; route: string; what: string }[] = [
    { key: 'entitlements.reissue', route: 'POST /v1/entitlements/{id}/reissue', what: 'Re-hold an expired or stale offer or card' },
    { key: 'verifications.appeal', route: 'POST /v1/verifications/{id}/appeal', what: 'Re-check a rejected verification with a second carrier, or fall back to email or ID' },
    { key: 'orders.state', route: 'GET /v1/orders/{id}/state', what: 'True order status from the merchant, not a guess' },
    { key: 'refunds.create', route: 'POST /v1/refunds', what: 'Refund up to a cap' },
  ];
  return (
    <>
      <Card tone="blue" className="px-5 py-4 text-[14px] text-ink">
        <p className="font-semibold">For authority failures the answer is a grant, not a document.</p>
        <p className="mt-1 text-ink/80">Each verb an agent may call carries a cap, a per-user limit, an idempotency key and a receipt. Defaults are the tightest option. <span className="font-medium">This page is the only writer</span>: an agent can never widen its own envelope.</p>
      </Card>
      {verbs.map((v) => {
        const e = env[v.key] as Record<string, unknown>;
        const coming = e.status === 'coming';
        return (
          <Card key={v.key}>
            <div className="flex items-start justify-between gap-4 px-5 py-4">
              <div>
                <div className="flex items-center gap-2"><span className="font-mono text-[13px] font-medium text-ink">{v.route}</span>{coming ? <Chip>Coming</Chip> : e.enabled ? <Chip tone="green" dot>Live</Chip> : <Chip>Off</Chip>}</div>
                <p className="mt-1 text-[13.5px] text-muted">{v.what}</p>
              </div>
              <Toggle label={`Enable ${v.key}`} on={!!e.enabled} onChange={(on) => { if (coming) { toast('This verb is in the schema and docs but ships after the hackathon.', 'info'); return; } set(v.key, 'enabled', on); }} />
            </div>
            <div className="grid gap-4 border-t border-line px-5 py-4 sm:grid-cols-3">
              {(['per_user', 'cap_usd_per_case', 'cap_usd_per_agent_day', 'per_case'] as const).filter((f) => f in e).map((f) => (
                <label key={f} className="block">
                  <Label>{f.replace(/_/g, ' ').replace('usd', '$')}</Label>
                  <input type="number" min={0} disabled={coming} value={Number(e[f])} onChange={(ev) => set(v.key, f, Number(ev.target.value))} className={cx(field, 'tabular-nums')} />
                </label>
              ))}
              {'read_only' in e && <div><Label>Access</Label><p className="mt-2 text-[14px]">Read only</p></div>}
              <div><Label>Idempotency key</Label><p className="mt-2 text-[14px]">Required</p></div>
            </div>
          </Card>
        );
      })}
      <Card>
        <CardHead title="Envelope change log" sub="Every widening lands here and in the audit log." />
        <ul className="divide-y divide-line text-[13.5px]">
          {log.map((l, i) => <li key={i} className="flex gap-3 px-5 py-2.5"><span className="w-20 shrink-0 font-mono text-[12px] text-muted">{clock(l.at)}</span><span className="font-mono text-[12.5px]">{l.text}</span></li>)}
        </ul>
      </Card>
      <JsonView file="agenthelpdesk.json → authority" note="preview of the PR this change opens" data={env} maxHeight={260} />
    </>
  );
}

function Approvers() {
  const { propose } = useStore();
  const [list, setList] = useState(config.approvers);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('text');
  const waits = [['15m', '15 minutes'], ['1h', '1 hour'], ['4h', '4 hours']];
  const add = () => {
    const n = name.trim();
    if (!n) return;
    setList([...list, { name: n, role: 'approver', channel, backup: true }]);
    propose(`approvers[${list.length}]`, { name: n, channel });
    setName(''); setAdding(false);
  };
  return (
    <Card>
      <CardHead title="Approvers" sub="Who approves risky fixes, and how to reach them. Quiet hours apply to everything except a spend cap breach." right={<Button size="sm" onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : 'Add approver'}</Button>} />
      <ul className="divide-y divide-line">
        {list.map((a) => (
          <li key={a.name} className="flex items-center gap-4 px-5 py-3 text-[14px]">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface text-[12px] font-semibold">{a.name.split(' ').map((p) => p[0]).join('')}</div>
            <div className="flex-1"><div className="text-ink">{a.name}</div><div className="text-[12.5px] text-muted">{a.role} · by {a.channel}{a.backup ? ' · backup' : ''}</div></div>
            <span className="text-[13px] text-muted">Quiet 11 p.m.–7 a.m.</span>
          </li>
        ))}
      </ul>
      {adding && (
        <div className="flex flex-wrap items-end gap-3 border-t border-line bg-surface px-5 py-3">
          <label className="flex-1"><Label>Name</Label><input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Dana Ruiz" className={field} /></label>
          <label><Label>Reach by</Label>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={cx(field, 'w-32')}><option value="text">text</option><option value="email">email</option></select>
          </label>
          <Button variant="primary" size="sm" onClick={add} disabled={!name.trim()}>Add</Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3 text-[13px] text-muted">
        <label htmlFor="reminder">Reminder if no reply after</label>
        <select id="reminder" value={config.reminder_after} onChange={(e) => propose('reminder_after', e.target.value)} className="h-8 rounded-ctl border border-line px-2 text-[13px] text-ink">
          {waits.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span>, then email the backup.</span>
      </div>
    </Card>
  );
}

const roles: [string, string][] = [
  ['Admin', 'Everything, including billing, team and revoking access'],
  ['Engineer', 'See all tickets, retry proofs, edit settings except billing and team'],
  ['Approver', 'See tickets and approve or reject; no settings'],
  ['Viewer', 'Read tickets, agents and reports'],
];

function Team() {
  const { propose } = useStore();
  const [people, setPeople] = useState(config.team);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Viewer');
  const invite = () => {
    const e = email.trim();
    if (!/@/.test(e)) return;
    setPeople([...people, { name: e.split('@')[0], email: e, role }]);
    propose(`team[${people.length}]`, { email: e, role });
    setEmail(''); setInviting(false);
  };
  return (
    <>
      <Card>
        <CardHead title="Team" right={<Button size="sm" onClick={() => setInviting((v) => !v)}>{inviting ? 'Cancel' : 'Invite by email'}</Button>} />
        <ul className="divide-y divide-line text-[14px]">
          {people.map((p) => (
            <li key={p.email} className="flex items-center justify-between gap-4 px-5 py-3">
              <span><span className="text-ink">{p.name}</span><span className="ml-2 font-mono text-[12px] text-muted">{p.email}</span></span>
              <select aria-label={`Role for ${p.name}`} value={p.role} onChange={(e) => { const r = e.target.value; setPeople(people.map((x) => (x.email === p.email ? { ...x, role: r } : x))); propose(`team · ${p.email} role`, r); }} className="h-8 rounded-ctl border border-line px-2 text-[13px]">
                {roles.map(([x]) => <option key={x}>{x}</option>)}
              </select>
            </li>
          ))}
        </ul>
        {inviting && (
          <div className="flex flex-wrap items-end gap-3 border-t border-line bg-surface px-5 py-3">
            <label className="min-w-[220px] flex-1"><Label>Email</Label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && invite()} placeholder="dana@ledgerly.example" className={field} /></label>
            <label><Label>Role</Label>
              <select value={role} onChange={(e) => setRole(e.target.value)} className={cx(field, 'w-36')}>{roles.map(([x]) => <option key={x}>{x}</option>)}</select>
            </label>
            <Button variant="primary" size="sm" onClick={invite} disabled={!/@/.test(email.trim())}>Send invite</Button>
          </div>
        )}
      </Card>
      <Card>
        <CardHead title="Roles" />
        <ul className="divide-y divide-line text-[13.5px]">{roles.map(([r, d]) => <li key={r} className="flex gap-4 px-5 py-2.5"><span className="w-24 font-semibold">{r}</span><span className="text-muted">{d}</span></li>)}</ul>
      </Card>
    </>
  );
}

function Notifications() {
  const { propose } = useStore();
  const [rows, setRows] = useState(config.notifications);
  return (
    <Card className="overflow-x-auto">
      <CardHead title="Notifications" sub="Slack can be added as a channel later." />
      <table className="w-full min-w-[560px] text-table">
        <thead><tr className="border-b border-line bg-surface text-left text-[12px] text-muted"><th className="px-5 py-2 font-medium">Event</th><th className="font-medium">Channel</th><th className="font-medium">When</th><th className="pr-5 text-right font-medium">On</th></tr></thead>
        <tbody>
          {Object.entries(rows).map(([k, n]) => (
            <tr key={k} className="border-b border-line last:border-0">
              <td className="px-5 py-3">{n.label}</td>
              <td className="text-muted">{n.channel}</td>
              <td className="text-muted">{n.when}</td>
              <td className="pr-5 text-right"><Toggle label={n.label} on={n.on} onChange={(on) => { setRows({ ...rows, [k]: { ...n, on } }); propose(`notifications.${k}.on`, on); }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Branding() {
  const { tickets, propose } = useStore();
  const [color, setColor] = useState(config.branding.color);
  const [hex, setHex] = useState(config.branding.color);
  const [logo, setLogo] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const won = tickets.filter((t) => t.outcome?.agent_retry_ok).length;
  const commit = (v: string) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) { setHex(color); return; }
    setColor(v); setHex(v);
    if (v.toLowerCase() !== config.branding.color.toLowerCase()) propose('branding.color', v);
  };
  return (
    <Card>
      <CardHead title="Branding" sub="Used on the agent help page (human view only) and the daily report." />
      <div className="grid gap-6 p-5 md:grid-cols-2">
        <div className="space-y-4">
          <div>
            <Label>Logo</Label>
            <div className="mt-2 flex items-center gap-3">
              {logo
                ? <img src={logo} alt="Your logo" className="h-10 w-10 rounded-ctl border border-line object-cover" />
                : <div className="flex h-10 w-10 items-center justify-center rounded-ctl text-[16px] font-bold text-white" style={{ background: color }}>{config.branding.logo_text}</div>}
              <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; setLogo(URL.createObjectURL(f)); propose('branding.logo', f.name); }} />
              <Button size="sm" onClick={() => file.current?.click()}>{logo ? 'Replace' : 'Upload'}</Button>
              {logo && <Button variant="ghost" size="sm" onClick={() => { setLogo(null); if (file.current) file.current.value = ''; }}>Remove</Button>}
            </div>
            <p className="mt-1 text-[12px] text-muted">Stored in your repo. A local pick is a preview until the PR merges.</p>
          </div>
          <div>
            <Label>Brand color</Label>
            <div className="mt-2 flex items-center gap-2">
              <input type="color" aria-label="Brand color picker" value={color} onChange={(e) => setColor(e.target.value)} onBlur={() => commit(color)} className="h-9 w-12 rounded border border-line" />
              <input aria-label="Brand color hex" value={hex} onChange={(e) => setHex(e.target.value)} onBlur={(e) => commit(e.target.value)} className="h-9 w-28 rounded-ctl border border-line px-2 font-mono text-[13px] outline-none focus:border-blue" />
            </div>
          </div>
        </div>
        <div className="rounded-card border border-line p-4">
          <Label>Preview</Label>
          <div className="mt-3 flex items-center gap-2">
            {logo ? <img src={logo} alt="" className="h-6 w-6 rounded object-cover" /> : <div className="flex h-6 w-6 items-center justify-center rounded text-[12px] font-bold text-white" style={{ background: color }}>{config.branding.logo_text}</div>}
            <span className="text-[14px] font-semibold">{config.provider.name} agent desk</span>
          </div>
          <p className="mt-2 text-[13px] text-muted">{won} agent{won === 1 ? '' : 's'} finished their task after a fix.</p>
          <div className="mt-3 h-1 rounded" style={{ background: color }} />
        </div>
      </div>
    </Card>
  );
}

function AgentSettings() {
  const { propose } = useStore();
  const pay = config.agent_payments;
  const muted = config.mute_list.map((c) => {
    const a = agents.find((x) => x.client === c);
    return a ? `${c} (unidentified, ${a.failures_7d} failures in 7 days)` : c;
  });
  return (
    <Card>
      <CardHead title="Agent settings" />
      <div className="divide-y divide-line text-[14px]">
        <div className="flex items-center justify-between gap-4 px-5 py-4"><div><div className="text-ink">Agent identifier header</div><div className="text-[12.5px] text-muted">Optional. Lets the desk measure “won” when an agent returns.</div></div><span className="font-mono text-[13px]">{config.agent_identifier_header}</span></div>
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div><div className="text-ink">Agents may pay for a verified answer</div><div className="text-[12.5px] text-muted">Agent-to-agent: x402 open protocol, HTTP {pay.status_code} at {usd(pay.price_usd)} settled in stablecoin. Provider (B2B) metering stays on Stripe. Off by default; you pay.</div></div>
          <Toggle label="Agents may pay" on={pay.enabled} onChange={(on) => propose('agent_payments.enabled', on)} />
        </div>
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div>
            <div className="text-ink">Mute list</div>
            <div className="text-[12.5px] text-muted">{muted.length ? muted.join(', ') : 'Nothing is muted.'}</div>
          </div>
          <Link to="/app/agents"><Button size="sm">Edit</Button></Link>
        </div>
      </div>
    </Card>
  );
}

const stackMeta: Record<string, { role: string; metric: string; line: string }> = {
  Blaxel: { role: 'A fresh sandbox per ticket where the fix is tried and proved', metric: 'Median failure → first proof', line: 'Without a sandbox, no fix is tried before a human reads the ticket' },
  Stripe: { role: 'Meters each verified fix and bills the provider', metric: 'Verified fixes billed', line: 'Pay for proven fixes, not for tickets opened' },
  Manufact: { role: 'Hosts report_problem as an MCP server any agent can call', metric: 'MCP calls that became tickets', line: 'One endpoint any agent can use, no custom SDK' },
  Inkbox: { role: 'The desk’s identity; sends approval requests by text', metric: 'Approval texts sent', line: 'Approve a schema change from your phone' },
  Primitive: { role: 'Agent-to-agent email threads with verified senders', metric: 'Threads answered without a human', line: 'Agents get a reply in the channel they already use' },
  Armature: { role: 'Tests whether a fresh agent installs the desk unprompted', metric: 'Fresh-agent install eval', line: 'A fresh agent installs it from the docs alone' },
};

function Stack() {
  const { events } = useStore();
  return (
    <>
      <p className="text-[14px] text-muted">One card per tool, counted from <span className="font-mono">tool_events</span>. If an event is not in that table, it does not appear here.</p>
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(stackMeta).map(([tool, m]) => {
          const evs = events.filter((e) => e.tool === tool);
          const cost = evs.reduce((a, e) => a + (e.cost_usd ?? 0), 0);
          const median = evs.length ? dur([...evs].sort((a, b) => a.d_ms - b.d_ms)[Math.floor(evs.length / 2)].d_ms) : '—';
          const value = tool === 'Armature' ? 'Not run yet' : `${evs.length} events`;
          return (
            <Card key={tool} className="p-5">
              <div className="flex items-center justify-between"><span className="text-[15px] font-semibold">{tool}</span><Chip tone={evs.length ? 'green' : 'gray'} dot>{evs.length ? 'Working' : 'Idle'}</Chip></div>
              <p className="mt-1 text-[13px] text-muted">{m.role}</p>
              <div className="mt-4 flex items-end justify-between">
                <div><Label>{m.metric}</Label><div className="mt-1 text-[22px] font-semibold tabular-nums">{value}</div></div>
                <div className="text-right text-[12px] text-muted">median {median}{cost ? <><br />cost {usd(cost)}</> : null}</div>
              </div>
              <p className="mt-3 border-t border-line pt-3 text-[12.5px] italic text-muted">“{m.line}”</p>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function Keys() {
  const { events, tickets, propose, toast } = useStore();
  const pushes = events
    .filter((e) => e.result === 'pushed' || e.action.startsWith('case.'))
    .sort((a, b) => b.at - a.at);
  const newest = pushes[0];
  return (
    <>
      <Card>
        <CardHead title="API keys" sub="Test and live keys are kept apart." />
        <ul className="divide-y divide-line text-[14px]">
          <li className="flex items-center justify-between px-5 py-3"><span>Test secret key</span><span className="font-mono text-[13px] text-muted">ahd_sk_test_••••••••8c2e</span></li>
          <li className="flex items-center justify-between gap-4 px-5 py-3">
            <span>Live secret key</span>
            <Button size="sm" onClick={() => toast('A live key is issued when you leave test mode and add a payment method. Until then there is nothing to reveal.', 'info')}>Reveal after leaving test mode</Button>
          </li>
        </ul>
      </Card>
      <Card>
        <CardHead title="Webhook deliveries" sub={`Endpoint ${config.webhook_url} · every case pushed to it, newest first`} />
        {pushes.length === 0 ? (
          <p className="px-5 py-6 text-[13.5px] text-muted">Nothing has been pushed yet. Deliveries appear here as cases are acknowledged and resolved.</p>
        ) : (
          <ul className="divide-y divide-line text-[13.5px]">
            {pushes.slice(0, 8).map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-5 py-2.5">
                <Chip tone={e.result === 'pushed' ? 'green' : 'gray'}>{e.result}</Chip>
                <span className="font-mono text-[12.5px]">{String(e.payload.topic ?? e.action)}</span>
                <Link to={`/app/tickets/${e.ticket_id}`} className="font-mono text-[12px] text-muted hover:text-ink hover:underline">{e.ticket_id}</Link>
                <span className="ml-auto font-mono text-[12px] text-muted">{clock(e.at)} PT</span>
              </li>
            ))}
          </ul>
        )}
        {newest && (
          <div className="border-t border-line p-4">
            <JsonView file={`webhook payload · ${String(newest.payload.topic ?? newest.action)}`} data={{ id: newest.id, type: newest.payload.topic ?? newest.action, data: { case_id: newest.ticket_id, ...newest.payload } }} maxHeight={200} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 text-[13px] text-muted">
          <label htmlFor="hook">Change the endpoint</label>
          <input id="hook" defaultValue={config.webhook_url} onBlur={(e) => e.target.value !== config.webhook_url && propose('webhook_url', e.target.value)} className="h-8 min-w-[260px] flex-1 rounded-ctl border border-line px-2 font-mono text-[12.5px] outline-none focus:border-blue" />
        </div>
        <p className="border-t border-line px-5 py-2.5 text-[12.5px] text-muted">{tickets.length} cases on this console · {pushes.length} of their events were pushed to the endpoint.</p>
      </Card>
    </>
  );
}

function Danger() {
  const { tickets, events, propose, toast } = useStore();
  const [armed, setArmed] = useState<string | null>(null);
  const exportAll = () => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify({ exported_at: new Date(now()).toISOString(), tickets, events, agents }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agenthelpdesk-export-${day}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${tickets.length} cases and ${events.length} events.`, 'success');
  };
  const rows: [string, string, string, (() => void) | null][] = [
    ['Pause the desk', 'Agents still get the help field; no cases are opened.', 'Pause', () => propose('paused', true)],
    ['Export all data', 'Tickets, proofs, grants and outcomes as JSON.', 'Export', exportAll],
    ['Delete the account', 'Revokes the GitHub App and deletes all data. Cannot be undone.', 'Delete', () => propose('paused', true)],
  ];
  return (
    <Card className="border-error/30">
      <CardHead title="Danger zone" sub="Export is real and downloads now. The other two draft a PR, because the account itself lives in your repo." />
      <ul className="divide-y divide-line">
        {rows.map(([k, d, b, fn]) => (
          <li key={k} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div><div className="text-[14px] text-ink">{k}</div><div className="text-[12.5px] text-muted">{d}</div></div>
            {armed === k ? (
              <Confirm
                verb={b}
                note={k === 'Delete the account' ? 'Test mode holds no account to delete. Merging this PR turns the desk off for every endpoint.' : 'Agents will still see the help field, but no new case is opened.'}
                onCancel={() => setArmed(null)}
                onConfirm={() => { setArmed(null); fn?.(); }}
              />
            ) : (
              <Button variant={k === 'Export all data' ? 'secondary' : 'danger'} onClick={() => (k === 'Export all data' ? exportAll() : setArmed(k))}>{b}</Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
