import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { agentById, HERO_ID, useStore, type LiveEvent } from '../lib/store';
import { ago, clock, dur, until, usd, useNow } from '../lib/clock';
import type { Proof, Stage, Ticket } from '../lib/types';
import { Diff, JsonView } from '../components/Json';
import { Button, Card, CardHead, Chip, ClassChip, CopyButton, Empty, Label, ProofIcon, STAGES, StageChip, Tabs, ToolChip, changeLabel, cx, isWorking, modeLabel } from '../components/ui';

const ORDER: Stage[] = STAGES.map((s) => s.key);
const stageIndex = (s: Stage) => (s === 'failed_proof' || s === 'escalated' ? 3 : s === 'rejected' ? 4 : s === 'closed' ? 6 : ORDER.indexOf(s));

export default function TicketPage() {
  const { id = '' } = useParams();
  const store = useStore();
  const t = store.ticket(id);
  const events = store.eventsFor(id);
  const [tab, setTab] = useState<'story' | 'agent' | 'events'>('story');
  const [openEvent, setOpenEvent] = useState<LiveEvent | null>(null);
  const isHero = id === HERO_ID;

  if (!t) return <Empty title="No ticket with that ID" body={id} action={<Link to="/app/tickets"><Button>Back to tickets</Button></Link>} />;
  const agent = agentById(t.agent_id);

  return (
    <div>
      <Link to="/app/tickets" className="mb-3 inline-block text-[13px] text-muted hover:text-ink">← Tickets</Link>

      {isHero && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-2.5 text-[13px]">
          <span className="text-muted">
            <span className="font-semibold text-ink">Replay of a recorded ticket.</span> Ledgerly seeded failure #4, the shape of Hark’s launch night on Oct 16. Events replay from <span className="font-mono">tool_events.json</span>.
          </span>
          <Button size="sm" onClick={store.startReplay} disabled={store.replay.phase === 'running' || store.replay.phase === 'post'}>
            {store.replay.phase === 'running' ? 'Replaying…' : '↻ Replay from the failure'}
          </Button>
        </div>
      )}

      <Header t={t} agentName={agent?.name ?? t.agent_id} />
      <Commitments t={t} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Timeline t={t} events={events} open={openEvent} onOpen={setOpenEvent} />
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'story', label: 'What happened' },
              { key: 'agent', label: 'What did the agent see?' },
              { key: 'events', label: <>Raw events <span className="ml-1 rounded-full bg-surface px-1.5 text-[11px] text-muted">{events.length}</span></> },
            ]}
          />
          {tab === 'story' && <Story t={t} events={events} />}
          {tab === 'agent' && <AgentView t={t} />}
          {tab === 'events' && <JsonView file={`tool_events.json · ticket_id = ${t.id}`} data={events.map(({ at, ...e }) => ({ ...e, at: new Date(at).toISOString() }))} maxHeight={560} />}
        </div>
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Decision t={t} events={events} />
          <AgentCard t={t} />
        </aside>
      </div>
    </div>
  );
}

/* ---------------- header ---------------- */

function Header({ t, agentName }: { t: Ticket; agentName: string }) {
  const at = useNow();
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <StageChip stage={t.stage} />
        <ClassChip c={t.failure_class} />
        <span className="font-mono text-[12.5px] text-muted">{t.id}</span>
        <CopyButton text={t.id} label="Copy ID" />
      </div>
      <h1 className="max-w-4xl text-[24px] font-semibold leading-[1.25] tracking-tight text-ink md:text-title">{t.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px] text-muted">
        <span className="font-mono text-ink">{t.endpoint}</span>
        <span>Agent <span className="font-medium text-ink">{agentName}</span></span>
        <span>Opened {ago(t.created_at, at)}</span>
        <span>{t.affected_agents} agent{t.affected_agents === 1 ? '' : 's'} affected</span>
      </div>
    </div>
  );
}

function Commitments({ t }: { t: Ticket }) {
  const at = useNow();
  const done = ['answered', 'shipped', 'closed', 'rejected'].includes(t.stage);
  const resolvedAt = t.resolved_at ? Date.parse(t.resolved_at) : undefined;
  const late = !done && at > Date.parse(t.resolve_by);
  const cells = [
    {
      k: 'Acknowledged',
      v: t.acked_at ? `${clock(t.acked_at)}` : until(t.ack_by, at),
      s: t.acked_at ? `Committed by ${clock(t.ack_by)} · met` : `Committed by ${clock(t.ack_by)}`,
      tone: t.acked_at ? 'ok' : 'live',
    },
    {
      k: 'Resolve by',
      v: done ? (resolvedAt ? `Met at ${clock(resolvedAt)}` : 'Closed') : until(t.resolve_by, at),
      s: `${clock(t.resolve_by)} · ${t.sla === 'blocked_order' ? 'blocked-order SLA' : 'default SLA'}`,
      tone: done ? 'ok' : late ? 'late' : 'live',
    },
    { k: 'Queue position', v: t.queue_position ? `#${t.queue_position}` : '—', s: 'Returned to the agent at intake', tone: 'none' },
    { k: 'Approval mode', v: modeLabel[t.mode], s: `Risk ${t.risk} · ${changeLabel[t.change_type]}`, tone: 'none' },
  ];
  return (
    <div className="mt-5 grid grid-cols-2 overflow-hidden rounded-card border border-line md:grid-cols-4">
      {cells.map((c, i) => (
        <div key={c.k} className={cx('px-4 py-3', i > 0 && 'border-l border-line', i === 2 && 'max-md:border-l-0 max-md:border-t', i === 3 && 'max-md:border-t')}>
          <Label>{c.k}</Label>
          <div className={cx('mt-1 text-[17px] font-semibold tabular-nums', c.tone === 'late' ? 'text-error' : c.tone === 'ok' ? 'text-success-text' : 'text-ink')}>{c.v}</div>
          <div className="mt-0.5 text-[12px] text-muted">{c.s}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- timeline ---------------- */

function Timeline({ t, events, open, onOpen }: { t: Ticket; events: LiveEvent[]; open: LiveEvent | null; onOpen: (e: LiveEvent | null) => void }) {
  const cur = stageIndex(t.stage);
  const red = t.stage === 'failed_proof' || t.stage === 'escalated' || t.stage === 'rejected';
  const has = (a: string) => events.some((e) => e.action.startsWith(a));
  const strip = [
    { k: 'Sandbox', ok: has('sandbox.') || has('replay.') },
    { k: 'Proofs run', ok: has('proof') },
    { k: 'Text sent', ok: has('text.sent') },
    { k: 'Approved', ok: has('text.reply') || has('decision.approved') || (t.mode === 'auto' && has('case.resolved')) },
    { k: 'Shipped', ok: has('pr.merged') || has('grant.issued') },
    { k: t.not_billable_reason ? 'Exempt' : 'Billed', ok: has('meter_event') || has('billing.exempt') },
  ];
  return (
    <Card>
      <CardHead title="Timeline" sub="Each chip names the tool that did the work. Click one to see the raw event." />
      <ol className="grid grid-cols-1 gap-0 px-5 py-4 sm:grid-cols-7">
        {STAGES.map((s, i) => {
          const evs = events.filter((e) => e.stage === s.key || (s.key === 'proving' && e.stage === 'failed_proof') || (s.key === 'awaiting_approval' && e.stage === 'rejected'));
          const state = i < cur ? 'done' : i === cur ? (red ? 'red' : t.stage === 'closed' ? 'done' : isWorking(t.stage) ? 'live' : t.stage === 'awaiting_approval' ? 'pink' : 'done') : 'todo';
          return (
            <li key={s.key} className="relative flex gap-3 pb-4 sm:flex-col sm:gap-2 sm:pb-0 sm:pr-2">
              <div className="flex flex-col items-center sm:flex-row">
                <span
                  className={cx(
                    'z-10 h-3.5 w-3.5 shrink-0 rounded-full border-2',
                    state === 'done' && 'border-success bg-success',
                    state === 'live' && 'animate-pulsering border-blue bg-blue',
                    state === 'pink' && 'animate-pulse border-pink bg-pink',
                    state === 'red' && 'border-error bg-error',
                    state === 'todo' && 'border-line bg-white',
                  )}
                />
                {i < STAGES.length - 1 && <span className={cx('w-0.5 flex-1 sm:h-0.5 sm:w-auto', i < cur ? 'bg-success/50' : 'bg-line')} />}
              </div>
              <div className="min-w-0">
                <div className={cx('text-[12.5px] font-semibold', state === 'todo' ? 'text-muted' : state === 'pink' ? 'text-pink-text' : state === 'red' ? 'text-error' : 'text-ink')}>
                  {s.key === 'proving' && t.stage === 'failed_proof' ? 'Proof failed' : s.key === 'awaiting_approval' && t.stage === 'rejected' ? 'Rejected' : s.label}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1 sm:flex-col sm:items-start">
                  {evs.map((e) => (
                    <ToolChip key={e.id} tool={e.tool} d={e.d_ms ? dur(e.d_ms) : undefined} active={open?.id === e.id} onClick={() => onOpen(open?.id === e.id ? null : e)} />
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {open && (
        <div className="border-t border-line px-5 py-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-semibold text-ink">{open.tool}</span>
            <span className="font-mono text-muted">{open.action}</span>
            <Chip tone={/fail|denied/.test(open.result) ? 'red' : 'gray'}>{open.result}</Chip>
            <span className="text-muted">at {clock(open.at)}{open.cost_usd ? ` · cost ${usd(open.cost_usd)}` : ''}</span>
            <button className="ml-auto text-[12px] text-muted hover:text-ink" onClick={() => onOpen(null)}>Close</button>
          </div>
          <JsonView file={`tool_events/${open.id}.payload`} data={open.payload} maxHeight={240} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-6">
        {strip.map((s) => (
          <div key={s.k} className={cx('flex items-center gap-2 bg-white px-3 py-2.5 text-[12px] font-medium transition-colors', s.ok ? 'text-ink' : 'text-muted/70')}>
            <span className={cx('h-1.5 w-1.5 rounded-full', s.ok ? 'bg-success' : 'bg-line')} />
            {s.k}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------------- story ---------------- */

function Exchange({ title, x, kind }: { title: string; x: Ticket['request']; kind: 'req' | 'res' }) {
  const [headers, setHeaders] = useState(false);
  const line = kind === 'req' ? `${x.method} ${x.url}` : `HTTP ${x.status}`;
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between">
        <Label>{title}</Label>
        <button onClick={() => setHeaders(!headers)} className="text-[12px] font-medium text-blue hover:underline">{headers ? 'Hide headers' : 'Show headers'}</button>
      </div>
      <div className={cx('mb-2 truncate rounded-ctl px-3 py-1.5 font-mono text-[12.5px]', kind === 'res' && (x.status ?? 0) >= 400 ? 'bg-error-tint text-error-text' : 'bg-surface text-ink')}>{line}</div>
      {headers && <JsonView data={x.headers} file="headers" className="mb-2" maxHeight={160} />}
      <JsonView data={x.body ?? '// no body'} file={kind === 'req' ? 'request.body' : 'response.body'} maxHeight={260} />
    </div>
  );
}

function ProofRow({ name, sub, p }: { name: string; sub: string; p: Proof }) {
  const [open, setOpen] = useState(p.status === 'failed');
  return (
    <div className={cx('rounded-card border', p.status === 'failed' ? 'border-error/40 bg-error-tint/40' : 'border-line')}>
      <button className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={() => setOpen(!open)}>
        <ProofIcon s={p.status} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink">{name}</div>
          <div className="text-[12.5px] text-muted">{sub}</div>
        </div>
        <span className="font-mono text-[12px] text-muted">{p.status === 'pending' ? 'queued' : p.status === 'running' ? 'running…' : p.duration_ms ? dur(p.duration_ms) : p.status}</span>
        <span className="text-muted">{open ? '▾' : '▸'}</span>
      </button>
      {open && <p className="border-t border-line/70 px-4 py-3 text-[13.5px] text-ink/90">{p.status === 'pending' || p.status === 'running' ? 'Waiting for the sandbox…' : p.detail}</p>}
    </div>
  );
}

function Story({ t, events }: { t: Ticket; events: LiveEvent[] }) {
  const { editReply } = useStore();
  const editable = ['awaiting_approval', 'proving', 'fix_drafted'].includes(t.stage);
  const audit = events.filter((e) => /grant|envelope|decision|handoff|text\.|human/.test(e.action));
  const passed = Object.values(t.proofs).filter((p) => p.status === 'passed').length;
  return (
    <div className="space-y-6">
      <Card>
        <CardHead title="What the agent sent and got" sub={<>Secrets and personal data are masked before storage and display. Goal: <span className="text-ink">{t.goal}</span></>} />
        <div className="grid gap-5 p-5 md:grid-cols-2">
          <Exchange title="Request" x={t.request} kind="req" />
          <Exchange title="Response" x={t.response} kind="res" />
        </div>
        <div className="border-t border-line px-5 py-3 text-[13.5px]"><span className="font-medium text-ink">Already tried: </span><span className="text-muted">{t.tried}</span></div>
      </Card>

      <Card>
        <CardHead title="The fix" sub={t.fix.summary} right={t.pr && <Chip tone={t.pr.merged ? 'green' : 'gray'}>PR #{t.pr.number} {t.pr.merged ? 'merged' : 'open'}</Chip>} />
        <div className="space-y-4 p-5">
          <div className="rounded-ctl bg-surface px-4 py-3 text-[14px]"><span className="font-semibold text-ink">Cause. </span><span className="text-ink/85">{t.cause}</span></div>
          <Diff lines={t.fix.diff} file={t.fix.file} />
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label>Reply the agent will receive</Label>
              <span className="text-[12px] text-muted">{editable ? 'Editable until sent' : 'Sent'}</span>
            </div>
            <textarea
              value={t.fix.reply_text}
              readOnly={!editable}
              onChange={(e) => editReply(t.id, e.target.value)}
              rows={2}
              className={cx('w-full resize-none rounded-ctl border px-3 py-2 text-[14px] outline-none focus:border-blue focus:ring-2 focus:ring-blue/20', editable ? 'border-line bg-white' : 'border-transparent bg-surface text-muted')}
            />
          </div>
        </div>
      </Card>

      <Card>
        <CardHead title="Three proofs" sub="All three must pass before anything ships, whatever the mode." right={<span className="text-[13px] font-medium text-ink tabular-nums">{passed} of 3 passed</span>} />
        <div className="space-y-2 p-5">
          <ProofRow name="Replay passes" sub="The exact failing call, replayed in a sandbox of the provider’s product" p={t.proofs.replay} />
          <ProofRow name="Provider tests pass" sub="Ledgerly’s own suite still passes with the change" p={t.proofs.vendor_tests} />
          <ProofRow name="Fresh agent succeeds" sub="A clean agent with only the docs and error body completes the task" p={t.proofs.fresh_agent} />
        </div>
      </Card>

      <Card>
        <CardHead title="Grants and audit" sub="Every action the desk or an agent took under an authority envelope. This is the audit log the failing agent asked for." />
        <div className="p-5">
          {t.grants.length > 0 ? (
            <div className="mb-4 overflow-x-auto">
              <table className="w-full text-table">
                <thead className="text-left text-[12px] text-muted">
                  <tr className="border-b border-line"><th className="pb-2 font-medium">Verb</th><th className="pb-2 font-medium">Status</th><th className="pb-2 font-medium">Cap</th><th className="pb-2 font-medium">Per user</th><th className="pb-2 font-medium">Spent</th><th className="pb-2 font-medium">Idempotency key</th><th className="pb-2 font-medium">Receipt</th></tr>
                </thead>
                <tbody>
                  {t.grants.map((g) => (
                    <tr key={g.id} className="border-b border-line last:border-0">
                      <td className="py-2.5 font-mono text-[12.5px]">{g.verb}</td>
                      <td><Chip tone={g.status === 'issued' ? 'green' : g.status === 'denied' ? 'red' : 'pink'}>{g.status}</Chip></td>
                      <td className="tabular-nums">{usd(g.cap_usd)}</td>
                      <td className="tabular-nums">{g.per_user}</td>
                      <td className="tabular-nums">{usd(g.spent_usd)}</td>
                      <td className="font-mono text-[12px] text-muted">{g.idempotency_key}</td>
                      <td className="font-mono text-[12px]">{g.receipt ?? <span className="text-muted">on issue</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mb-4 text-[13.5px] text-muted">No grants on this ticket. The fix is a change, not a delegation.</p>
          )}
          <ul className="space-y-2">
            {audit.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
                <span className="w-20 shrink-0 font-mono text-[12px] text-muted">{clock(e.at)}</span>
                <span className="font-medium text-ink">{e.tool}</span>
                <span className="font-mono text-[12px] text-muted">{e.action}</span>
                <span className="text-ink/85">{e.result}</span>
              </li>
            ))}
            {!audit.length && <li className="text-[13px] text-muted">Nothing audited yet.</li>}
          </ul>
        </div>
      </Card>

      <Activity events={events} />
    </div>
  );
}

function Activity({ events }: { events: LiveEvent[] }) {
  const msgs = events.filter((e) => /text\.|email\.|handoff|decision|human\.paged/.test(e.action));
  const [note, setNote] = useState('');
  const [notes, setNotes] = useState<{ at: number; text: string }[]>([]);
  return (
    <Card>
      <CardHead title="Activity" sub="Messages by text or email, approvals and comments. Text replies land here." />
      <ul className="divide-y divide-line">
        {msgs.map((e) => (
          <li key={e.id} className="flex gap-3 px-5 py-3">
            <span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full', e.action === 'text.sent' ? 'bg-pink' : /reject|paged/.test(e.action) ? 'bg-error' : 'bg-blue')} />
            <div className="min-w-0 text-[13.5px]">
              <div className="text-muted"><span className="font-medium text-ink">{e.tool}</span> · {e.action.replace('.', ' ')} · {clock(e.at)}</div>
              {typeof e.payload.body === 'string' && <p className="mt-1 rounded-ctl bg-surface px-3 py-2 text-ink">{e.payload.body}</p>}
              {typeof e.payload.reason === 'string' && <p className="mt-1 text-ink">{e.payload.reason}</p>}
            </div>
          </li>
        ))}
        {notes.map((n) => (
          <li key={n.at} className="flex gap-3 px-5 py-3 text-[13.5px]"><span className="mt-1 h-2 w-2 rounded-full bg-muted" /><div><div className="text-muted"><span className="font-medium text-ink">Gideon</span> · comment · {clock(n.at)}</div><p className="mt-1 text-ink">{n.text}</p></div></li>
        ))}
      </ul>
      <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); if (note.trim()) { setNotes([...notes, { at: Date.now(), text: note.trim() }]); setNote(''); } }}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a comment for your team" className="h-9 flex-1 rounded-ctl border border-line px-3 text-[14px] outline-none focus:border-blue" />
        <Button type="submit">Comment</Button>
      </form>
    </Card>
  );
}

/* ---------------- agent view ---------------- */

function AgentView({ t }: { t: Ticket }) {
  // Only a case the desk has answered has a stored reply. For the rest this tab
  // rebuilds the shape from the case so an operator can see what will go out —
  // which is why the banner below never calls it something the agent received.
  const sent = t.reply ?? null;
  const reply = sent ?? {
    type: `problem/${t.fix.kind}`,
    title: t.fix.summary,
    status: t.response.status,
    case_id: t.id,
    ack_by: t.ack_by,
    resolve_by: t.resolve_by,
    fix_steps: t.fix.reply_text.trim() === '' ? [] : [t.fix.reply_text],
    tested: { replay: t.proofs.replay.status === 'passed', vendor_tests: t.proofs.vendor_tests.status === 'passed', fresh_agent: t.proofs.fresh_agent.status === 'passed' },
    outcome: t.outcome ?? null,
    regression_test_id: t.regression_test_id ?? null,
  };
  return (
    <div className="space-y-4">
      <Card tone="blue" className="px-5 py-4 text-[14px]">
        {sent ? (
          <p className="font-semibold text-ink">This is the exact reply, as the agent received it from <span className="font-mono">report_problem</span>.</p>
        ) : (
          <p className="font-semibold text-ink">No reply has gone out for this case yet — the desk has it at <span className="font-mono">{t.stage}</span>.</p>
        )}
        <p className="mt-1 text-ink/80">
          {sent
            ? <>Structured data, not prose: the agent can act on <span className="font-mono">fix_steps</span>, <span className="font-mono">authority</span> and <span className="font-mono">outcome</span> without a human reading anything.</>
            : <>Below is the shape it will send, rebuilt from this case — not something an agent received. Structured data, not prose: the agent acts on <span className="font-mono">fix_steps</span>, <span className="font-mono">authority</span> and <span className="font-mono">outcome</span> without a human reading anything.</>}
        </p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <JsonView file={sent ? 'report_problem → response' : 'report_problem → response (not sent yet)'} data={reply} maxHeight={520} />
        <div className="space-y-4">
          <JsonView file="error body with help field" note="what the agent saw first" data={t.response.body} maxHeight={260} />
          <Card className="p-4">
            <Label>Rendered for a human operator</Label>
            <p className="mt-2 text-[14px] text-ink">Your agent could not finish this call. {sent ? 'Here is the fix we proved.' : 'Here is the fix the desk has drafted.'}</p>
            <p className="mt-2 rounded-ctl bg-surface px-3 py-2 text-[14px] text-ink">{t.fix.reply_text}</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- right column ---------------- */

function Decision({ t, events }: { t: Ticket; events: LiveEvent[] }) {
  const { approve, reject, retryProof, handoff, close, startReplay } = useStore();
  const [rejecting, setRejecting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const passed = Object.values(t.proofs).filter((p) => p.status === 'passed').length;

  useEffect(() => {
    if (t.stage !== 'awaiting_approval') return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'a') { if (t.risk === 'low') approve(t.id); else setConfirm(true); }
      if (e.key === 'r') { e.preventDefault(); setRejecting(true); setTimeout(() => reasonRef.current?.focus(), 0); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [t.stage, t.id, t.risk, approve]);

  if (isWorking(t.stage))
    return (
      <Card tone="blue" className="p-5">
        <div className="flex items-center gap-2 text-[14px] font-semibold text-blue-text"><span className="h-2 w-2 animate-pulse rounded-full bg-blue" />The desk is working</div>
        <p className="mt-2 text-[13.5px] text-ink/80">No one needs to act. If a decision is needed, it appears here and goes out by text.</p>
      </Card>
    );

  if (t.stage === 'awaiting_approval')
    return (
      <Card className="overflow-hidden border-pink/40">
        <div className="bg-pink-tint px-5 py-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-pink-text">Your decision</div>
          <div className="mt-1 text-[14px] font-medium leading-snug text-ink">{t.fix.summary}</div>
        </div>
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap gap-2">
            <Chip tone={t.risk === 'high' ? 'red' : t.risk === 'medium' ? 'amber' : 'gray'}>Risk {t.risk}</Chip>
            <Chip tone="gray">Waiting because: {modeLabel[t.mode]} on {changeLabel[t.change_type]}</Chip>
          </div>
          <div className="flex items-center gap-2 text-[14px] font-medium text-success-text"><ProofIcon s={passed === 3 ? 'passed' : 'pending'} size={16} />{passed} of 3 proofs passed</div>
          <p className="text-[13px] text-muted">Affects {t.affected_agents} agents. Approving ships the change and sends the proven reply.</p>
          {confirm ? (
            <div className="rounded-ctl border border-pink/40 p-3">
              <p className="text-[13px] text-ink">This is a {t.risk}-risk {changeLabel[t.change_type]} change. Approve and send?</p>
              <div className="mt-2 flex gap-2"><Button variant="primary" size="sm" onClick={() => { setConfirm(false); approve(t.id); }}>Yes, approve</Button><Button size="sm" onClick={() => setConfirm(false)}>Cancel</Button></div>
            </div>
          ) : (
            <Button variant="primary" size="lg" className="w-full" onClick={() => approve(t.id)}>Approve and send <span className="ml-1 rounded bg-white/20 px-1 font-mono text-[11px]">A</span></Button>
          )}
          {rejecting ? (
            <form onSubmit={(e) => { e.preventDefault(); reject(t.id, reason || 'No reason given'); }} className="space-y-2">
              <textarea ref={reasonRef} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why? The desk learns from this." className="w-full rounded-ctl border border-line px-3 py-2 text-[14px] outline-none focus:border-blue" />
              <div className="flex gap-2"><Button type="submit" variant="danger" size="sm">Reject</Button><Button size="sm" type="button" onClick={() => setRejecting(false)}>Cancel</Button></div>
            </form>
          ) : (
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => setRejecting(true)}>Reject <span className="font-mono text-[11px] text-muted">R</span></Button>
              <Button className="flex-1" variant="ghost" onClick={() => handoff(t.id)}>Hand to a human</Button>
            </div>
          )}
          <Link to={`/approve/${t.id}`} className="block border-t border-line pt-3 text-[13px] text-blue hover:underline">The same card went out by text → see the phone view</Link>
        </div>
      </Card>
    );

  if (t.stage === 'answered' || t.stage === 'shipped')
    return (
      <Card tone="green" className="p-5">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-success-text">{t.stage === 'shipped' ? 'Shipped' : 'Answered'}</div>
        <p className="mt-1 text-[15px] font-semibold text-ink">{t.outcome?.agent_retry_ok ? 'The agent retried and succeeded.' : 'The agent got a verified answer.'}</p>
        <p className="mt-2 rounded-ctl bg-white/70 px-3 py-2 text-[13.5px] text-ink">{t.fix.reply_text}</p>
        <dl className="mt-3 space-y-1.5 text-[13px]">
          {t.pr && <Row k="Pull request" v={<span>#{t.pr.number} · {t.pr.merged ? 'merged' : 'open'}</span>} />}
          {t.regression_test_id && <Row k="Regression test" v={<span className="font-mono">{t.regression_test_id}</span>} />}
          <Row k="Billing" v={t.billed ? <span>{usd(t.price_usd)} · meter event sent (test)</span> : t.not_billable_reason ? <span className="text-muted">{t.not_billable_reason}</span> : <span className="text-muted">Not billed until the agent’s retry succeeds</span>} />
        </dl>
        {t.id === HERO_ID && <Button size="sm" className="mt-4" onClick={startReplay}>↻ Replay from the failure</Button>}
      </Card>
    );

  if (t.stage === 'failed_proof' || t.stage === 'escalated') {
    const escalated = t.stage === 'escalated';
    const failed = (Object.entries(t.proofs) as [string, Proof][]).filter(([, p]) => p.status === 'failed');
    // The desk records why it stopped on its own trail. Quoting that beats paraphrasing it,
    // because an escalation is not always a failed proof — the reason is the part a human needs.
    const stopped = events.find((e) => e.action === 'case.escalated');
    const stoppedReason = typeof stopped?.payload['reason'] === 'string' ? (stopped.payload['reason'] as string) : null;
    return (
      <Card tone="red" className="p-5">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-error">{escalated ? 'Escalated to a human' : 'Proof failed'}</div>
        <p className="mt-1 text-[14px] text-ink">
          {escalated
            ? 'The desk stopped and handed this case to a person. Nothing shipped and nothing is billed.'
            : 'The desk could not prove this fix, so it did not ship and nothing is billed.'}
        </p>
        {stoppedReason !== null && (
          <p className="mt-2 text-[13px] text-muted">Reason the desk recorded: <span className="font-mono text-ink">{stoppedReason}</span></p>
        )}
        {failed.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {failed.map(([k, p]) => (
              <li key={k} className="rounded-ctl bg-white/70 px-3 py-2 text-[13px]">
                <span className="font-semibold text-ink">{k.replace('_', ' ')}</span>
                <span className="text-ink/85"> · {p.detail}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="primary" onClick={() => retryProof(t.id)}>{escalated ? 'Ask the desk to try again' : 'Retry the proof'}</Button>
          <Button onClick={() => handoff(t.id)}>Hand to a human</Button>
          {closing ? (
            <div className="rounded-ctl border border-line bg-white p-3">
              <p className="text-[13px] text-ink">Close without a fix? The agent keeps the failure and nothing is billed.</p>
              <div className="mt-2 flex gap-2">
                <Button variant="danger" size="sm" onClick={() => { setClosing(false); close(t.id, escalated ? 'Closed after the desk escalated it to a human' : 'Closed after the proof failed twice'); }}>Close ticket</Button>
                <Button size="sm" onClick={() => setClosing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setClosing(true)}>Close ticket</Button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">{t.stage === 'rejected' ? 'Rejected' : 'Closed'}</div>
      <p className="mt-1 text-[14px] text-ink">{t.rejected_reason ?? `Outcome: ${t.outcome?.action ?? 'closed'}. Nothing left to do.`}</p>
      {t.stage === 'rejected' && <p className="mt-2 text-[13px] text-muted">Nothing is billed for a rejected fix.</p>}
      {t.not_billable_reason && <p className="mt-2 text-[13px] text-muted">{t.not_billable_reason}</p>}
      {t.id === HERO_ID && <Button size="sm" className="mt-4" onClick={startReplay}>↻ Replay from the failure</Button>}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="text-right text-ink">{v}</dd></div>;
}

function AgentCard({ t }: { t: Ticket }) {
  const a = agentById(t.agent_id);
  const rate = useMemo(() => (a ? Math.round((a.failures_7d / a.calls_7d) * 1000) / 10 : 0), [a]);
  if (!a) return null;
  return (
    <Card className="p-5">
      <Label>Agent</Label>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[15px] font-semibold text-ink">{a.name}</span>
        <Chip tone={a.status === 'won' ? 'green' : a.status === 'lost' ? 'red' : 'blue'}>{a.status}</Chip>
      </div>
      <div className="mt-0.5 font-mono text-[12px] text-muted">{a.client}</div>
      <dl className="mt-3 space-y-1.5 text-[13px]">
        <Row k="Calls, 7 days" v={a.calls_7d.toLocaleString()} />
        <Row k="Failure rate" v={`${rate}%`} />
        <Row k="Identified by header" v={a.identified ? 'AHD-Agent-Id' : 'No'} />
        {t.contact && <Row k="Operator" v={<span className="font-mono text-[12px]">{t.contact}</span>} />}
      </dl>
      <Link to={`/app/agents?a=${a.id}`} className="mt-3 inline-block text-[13px] text-blue hover:underline">Open agent history</Link>
    </Card>
  );
}
