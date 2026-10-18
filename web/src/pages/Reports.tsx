import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import report from '../data/daily_report.json';
import { getReport, sendReportNow, type DeskReport } from '../lib/api';
import { useStore } from '../lib/store';
import { TZ, now, ptDay, usd } from '../lib/clock';
import { JsonView } from '../components/Json';
import { Button, Card, CardHead, Label, PageHeader, SampleTag, Segmented } from '../components/ui';
import type { Ticket } from '../lib/types';

type Period = 'daily' | 'weekly' | 'monthly' | 'quarterly';
type View = 'email' | 'json';

const labelFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const utcLabelFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const stampFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });

function bucketKey(period: Period, iso: string) {
  const { y, m, d, date } = ptDay(iso);
  if (period === 'daily') return labelFmt.format(new Date(iso));
  if (period === 'weekly') {
    const monday = new Date(date);
    monday.setUTCDate(d - ((date.getUTCDay() + 6) % 7));
    return `Week of ${utcLabelFmt.format(monday)}`;
  }
  if (period === 'monthly') return monthFmt.format(date);
  return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
}

interface Bucket {
  key: string;
  at: number;
  opened: number;
  fixed: number;
  waiting: number;
  escalated: number;
  won: number;
  prs_merged: number;
  regression_tests: number;
  grants: number;
  billed_usd: number;
}

const isFixed = (t: Ticket) => t.stage === 'shipped' || t.stage === 'closed' || t.stage === 'answered';
const isWaiting = (t: Ticket) => t.stage === 'awaiting_approval';
const isEscalated = (t: Ticket) => t.stage === 'failed_proof' || t.stage === 'escalated' || t.stage === 'rejected';
const isWon = (t: Ticket) => Boolean(t.outcome?.agent_retry_ok);

/** Counts over the tickets on this console. Nothing here is typed in by hand. */
function bucketsFor(period: Period, tickets: Ticket[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const t of tickets) {
    const key = bucketKey(period, t.created_at);
    const b = map.get(key) ?? { key, at: 0, opened: 0, fixed: 0, waiting: 0, escalated: 0, won: 0, prs_merged: 0, regression_tests: 0, grants: 0, billed_usd: 0 };
    b.at = Math.max(b.at, Date.parse(t.created_at));
    b.opened++;
    if (isFixed(t)) b.fixed++;
    if (isWaiting(t)) b.waiting++;
    if (isEscalated(t)) b.escalated++;
    if (isWon(t)) b.won++;
    if (t.pr?.merged) b.prs_merged++;
    if (t.regression_test_id) b.regression_tests++;
    b.grants += (t.grants ?? []).filter((g) => g.status === 'issued').length;
    if (t.billed) b.billed_usd += t.price_usd;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => b.at - a.at);
}

const totalsOf = (rows: Bucket[]) =>
  rows.reduce(
    (a, b) => ({
      opened: a.opened + b.opened,
      fixed: a.fixed + b.fixed,
      waiting: a.waiting + b.waiting,
      escalated: a.escalated + b.escalated,
      won: a.won + b.won,
      prs_merged: a.prs_merged + b.prs_merged,
      regression_tests: a.regression_tests + b.regression_tests,
      grants: a.grants + b.grants,
      billed_usd: a.billed_usd + b.billed_usd,
    }),
    { opened: 0, fixed: 0, waiting: 0, escalated: 0, won: 0, prs_merged: 0, regression_tests: 0, grants: 0, billed_usd: 0 },
  );

const PERIOD_NOUN: Record<Period, string> = { daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter' };

export default function Reports() {
  const { tickets, toast, live } = useStore();
  const [period, setPeriod] = useState<Period>('daily');
  const [view, setView] = useState<View>('email');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const h = report.headline;

  /** The window the desk has a route for. Monthly and quarterly are counted here instead,
   * over the same cases, and say so on the card. */
  const deskKind = period === 'daily' || period === 'weekly' ? period : null;
  const [desk, setDesk] = useState<{ report: DeskReport | null; loading: boolean; error: string | null }>({
    report: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!live.on || deskKind === null || live.vendor === null) return;
    let stop = false;
    const read = () => {
      setDesk((d) => ({ ...d, loading: true }));
      getReport(deskKind, live.vendor as string)
        .then((r) => { if (!stop) setDesk({ report: r, loading: false, error: null }); })
        // A failed refresh keeps the last report: stale and labelled beats blank.
        .catch((e: unknown) => { if (!stop) setDesk((d) => ({ ...d, loading: false, error: e instanceof Error ? e.message : String(e) })); });
    };
    read();
    const timer = window.setInterval(read, 15000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [live.on, live.vendor, deskKind]);

  const liveReport = live.on && deskKind !== null ? desk.report : null;

  const buckets = useMemo(() => bucketsFor(period, tickets), [period, tickets]);
  const totals = useMemo(() => totalsOf(buckets), [buckets]);

  const won = tickets.filter(isWon);
  const waiting = tickets.filter(isWaiting);
  const topEndpoints = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tickets) m.set(t.endpoint, (m.get(t.endpoint) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [tickets]);

  const pick = (p: Period) => { setPeriod(p); setSent(false); };
  const digest = { period, generated_at: new Date(now()).toISOString(), buckets, totals };

  /** Live mode asks the desk to deliver it, and the desk records `report.sent` on the vendor's
   * trail. Without Inkbox credentials it uses the offline client and every receipt says so. */
  const send = async () => {
    const vendor = live.vendor;
    if (!live.on || deskKind === null || vendor === null) {
      setSent(true);
      toast(`Test mode emails nothing. The ${period} report is the preview above and the Source JSON view; leaving test mode sends it to founders@ledgerly.example at 8:00 a.m. Pacific.`, 'info');
      return;
    }
    setSending(true);
    try {
      const r = await sendReportNow(deskKind, vendor);
      setDesk({ report: r.report, loading: false, error: null });
      setSent(true);
      const offline = r.delivered.every((d) => d.fake);
      toast(
        `The desk sent the ${deskKind} report to ${r.delivered.length} contact${r.delivered.length === 1 ? '' : 's'} by ${r.delivered.map((d) => d.channel).join(' and ')}, and recorded report.sent on its trail.${offline ? ' Delivery used the offline Inkbox client, so nothing left this machine.' : ''}`,
        offline ? 'info' : 'success',
      );
    } catch (err) {
      toast(`The desk could not send the ${deskKind} report: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        sub="The report connects fixes to agents won. Every number is a count over the case store — cases, proofs, grants and outcomes — and every sentence is those numbers written out. No language model composes any part of it."
        right={<>
          <Segmented<Period>
            options={[{ key: 'daily', label: 'Daily' }, { key: 'weekly', label: 'Weekly' }, { key: 'monthly', label: 'Monthly' }, { key: 'quarterly', label: 'Quarterly' }]}
            value={period}
            onChange={pick}
          />
          <Segmented<View> options={[{ key: 'email', label: 'Email preview' }, { key: 'json', label: 'Source JSON' }]} value={view} onChange={setView} />
          <Button variant="primary" onClick={() => void send()} disabled={sending}>
            {sending
              ? 'Sending…'
              : sent
                ? live.on && deskKind !== null
                  ? 'Sent by the desk ✓'
                  : 'Preview only ✓'
                : `Send ${period === 'daily' ? 'today’s' : period} report`}
          </Button>
        </>}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        {view === 'json' ? (
          <JsonView
            file={
              live.on && deskKind !== null
                ? `GET /v1/reports/${deskKind}?vendor_id=${live.vendor ?? '…'}`
                : period === 'daily'
                  ? 'daily_report.json'
                  : `${period}_report.json (computed)`
            }
            data={
              live.on && deskKind !== null
                ? liveReport ?? {
                    route: `/v1/reports/${deskKind}?vendor_id=${live.vendor ?? ''}`,
                    ...(desk.error !== null ? { error: desk.error } : { status: 'reading from the desk' }),
                  }
                : period === 'daily'
                  ? report
                  : digest
            }
            maxHeight="none"
          />
        ) : live.on && deskKind !== null ? (
          <DeskEmail report={liveReport} loading={desk.loading} error={desk.error} />
        ) : period === 'daily' ? (
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-line bg-surface px-5 py-2 text-[12.5px] text-muted">
              <span>From <span className="text-ink">desk@ledgerly.inkbox.example</span> · To founders@ledgerly.example</span>
              <SampleTag />
            </div>
            <div className="mx-auto max-w-[640px] px-6 py-8">
              <div className="mb-6 flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#0E7C66] text-[13px] font-bold text-white">L</div><span className="font-semibold">Ledgerly agent desk</span><span className="ml-auto text-[13px] text-muted">{stampFmt.format(now())}</span></div>
              <h2 className="text-[22px] font-semibold leading-snug">{h.opened} agents asked for help. {h.fixed} were fixed, {h.waiting} wait for you, and {h.agents_won} agents finished their task after a fix.</h2>
              <Section title="Agents you won">
                {report.agents_won.map((a) => (
                  <Link key={a.case} to={`/app/tickets/${a.case}`} className="block rounded-ctl border border-line px-4 py-3 hover:bg-surface">
                    <div className="flex justify-between text-[14px]"><span className="font-semibold">{a.agent}</span><span className="font-mono text-[12px] text-muted">{a.endpoint}</span></div>
                    <p className="mt-0.5 text-[13.5px] text-muted">{a.story}</p>
                  </Link>
                ))}
              </Section>
              <Section title="Still waiting for you">
                {report.still_waiting.map((id) => (
                  <Link key={id} to={`/app/tickets/${id}`} className="flex items-center justify-between rounded-ctl bg-pink-tint px-4 py-2.5 text-[14px] text-pink-text hover:underline"><span className="font-mono text-[12.5px]">{id}</span><span className="font-semibold">Review in one tap →</span></Link>
                ))}
              </Section>
              <Section title="Where your docs mislead agents">
                <table className="w-full text-[14px]"><tbody>
                  {report.docs_mislead.map((d) => <tr key={d.where} className="border-b border-line last:border-0"><td className="py-2 font-mono text-[12.5px]">{d.where}</td><td className="py-2 text-muted">{d.change}</td><td className="py-2 text-right tabular-nums">{d.cases} cases</td></tr>)}
                </tbody></table>
              </Section>
              <Section title="What changed">
                <p className="text-[14px] text-ink">{report.changed.prs_opened} pull requests opened, {report.changed.prs_merged} merged, {report.changed.regression_tests_added} regression tests added, {report.changed.grants_issued} grant issued under your envelope.</p>
              </Section>
              <Section title="Spend">
                <p className="text-[14px] text-ink">{usd(report.spend.today_usd)} today for verified fixes, {usd(report.spend.period_usd)} this period. A fix that fails a proof is never billed.</p>
              </Section>
            </div>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-line bg-surface px-5 py-2 text-[12.5px] text-muted">
              <span>
                The {period} digest, counted over the {totals.opened} case{totals.opened === 1 ? '' : 's'} on this console
                {live.on && ` · the desk publishes a daily and a weekly report only, so the console counted this window itself`}
              </span>
              <span className="font-mono text-[12px]">{buckets.length} {PERIOD_NOUN[period]}{buckets.length === 1 ? '' : 's'} with activity</span>
            </div>
            <div className="mx-auto max-w-[640px] px-6 py-8">
              <div className="mb-6 flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#0E7C66] text-[13px] font-bold text-white">L</div><span className="font-semibold">Ledgerly agent desk</span><span className="ml-auto text-[13px] text-muted">{stampFmt.format(now())}</span></div>
              <h2 className="text-[22px] font-semibold leading-snug">
                {totals.opened} agents asked for help this {PERIOD_NOUN[period]}. {totals.fixed} were fixed, {totals.waiting} wait for you, {totals.escalated} went to a human, and {totals.won} agent{totals.won === 1 ? '' : 's'} finished their task after a fix.
              </h2>
              <Section title={`Every ${PERIOD_NOUN[period]} in this report`}>
                <table className="w-full text-[14px]"><thead>
                  <tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-muted">
                    <th className="py-2 font-medium">{PERIOD_NOUN[period]}</th><th className="py-2 text-right font-medium">Opened</th><th className="py-2 text-right font-medium">Fixed</th><th className="py-2 text-right font-medium">Waiting</th><th className="py-2 text-right font-medium">Won</th><th className="py-2 text-right font-medium">Billed</th>
                  </tr>
                </thead><tbody>
                  {buckets.map((b) => (
                    <tr key={b.key} className="border-b border-line last:border-0">
                      <td className="py-2">{b.key}</td><td className="py-2 text-right tabular-nums">{b.opened}</td><td className="py-2 text-right tabular-nums">{b.fixed}</td><td className="py-2 text-right tabular-nums">{b.waiting}</td><td className="py-2 text-right tabular-nums">{b.won}</td><td className="py-2 text-right tabular-nums">{usd(b.billed_usd)}</td>
                    </tr>
                  ))}
                </tbody></table>
              </Section>
              <Section title="Agents you won">
                {won.length === 0 && <p className="text-[14px] text-muted">No agent has retried successfully yet in this {PERIOD_NOUN[period]}.</p>}
                {won.map((t) => (
                  <Link key={t.id} to={`/app/tickets/${t.id}`} className="block rounded-ctl border border-line px-4 py-3 hover:bg-surface">
                    <div className="flex justify-between text-[14px]"><span className="font-semibold">{t.agent_id}</span><span className="font-mono text-[12px] text-muted">{t.endpoint}</span></div>
                    <p className="mt-0.5 text-[13.5px] text-muted">{t.title}</p>
                  </Link>
                ))}
              </Section>
              <Section title="Still waiting for you">
                {waiting.length === 0 && <p className="text-[14px] text-muted">Nothing is waiting on you in this {PERIOD_NOUN[period]}.</p>}
                {waiting.map((t) => (
                  <Link key={t.id} to={`/app/tickets/${t.id}`} className="flex items-center justify-between rounded-ctl bg-pink-tint px-4 py-2.5 text-[14px] text-pink-text hover:underline"><span className="font-mono text-[12.5px]">{t.id}</span><span className="font-semibold">Review in one tap →</span></Link>
                ))}
              </Section>
              <Section title="Where your API misleads agents">
                <table className="w-full text-[14px]"><tbody>
                  {topEndpoints.map(([endpoint, n]) => <tr key={endpoint} className="border-b border-line last:border-0"><td className="py-2 font-mono text-[12.5px]">{endpoint}</td><td className="py-2 text-right tabular-nums">{n} case{n === 1 ? '' : 's'}</td></tr>)}
                </tbody></table>
              </Section>
              <Section title="What changed">
                <p className="text-[14px] text-ink">{totals.prs_merged} pull requests merged, {totals.regression_tests} regression tests added, {totals.grants} grant{totals.grants === 1 ? '' : 's'} issued under your envelope.</p>
              </Section>
              <Section title="Spend">
                <p className="text-[14px] text-ink">{usd(totals.billed_usd)} in verified fixes this {PERIOD_NOUN[period]}. A fix that fails a proof is never billed.</p>
                <p className="mt-1 text-[12px] text-muted">Prices are read from Stripe and are a hypothesis until pilots confirm them.</p>
              </Section>
            </div>
          </Card>
        )}
        <div className="space-y-4">
          <Card>
            <CardHead title="Schedule" />
            <div className="space-y-3 p-5 text-[14px]">
              <div><Label>Send time</Label><p className="mt-1">8:00 a.m. Pacific, daily</p></div>
              <div><Label>Recipients</Label><p className="mt-1 font-mono text-[12.5px]">founders@ledgerly.example</p></div>
              <div><Label>Weekly email</Label><p className="mt-1">Fridays · adds the invoice preview</p></div>
              <div><Label>Monthly and quarterly</Label><p className="mt-1">1st of the month and the month after quarter close · the same counts over a longer window</p></div>
            </div>
          </Card>
          <Card>
            <CardHead title="Archive" sub={`Every ${PERIOD_NOUN[period]} in this report, counted in Pacific time`} />
            <ul className="divide-y divide-line text-[14px]">
              {buckets.map((b) => <li key={b.key} className="flex justify-between px-5 py-2.5"><span>{b.key}</span><span className="text-muted">{b.opened} ticket{b.opened === 1 ? '' : 's'} · {usd(b.billed_usd)}</span></li>)}
              {buckets.length === 1 && <li className="px-5 py-2.5 text-[12.5px] text-muted">Test mode seeds one {PERIOD_NOUN[period]} of cases. Older reports land here as they accumulate.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/**
 * The report the desk wrote about itself, from GET /v1/reports/{kind}. Every number is a
 * count over the case store and every sentence the desk sends is those numbers written out,
 * so the card shows the counts, the cases behind them, and the definitions the desk states
 * for its own numbers — a count without its rule is just an assertion.
 */
function DeskEmail({ report, loading, error }: { report: DeskReport | null; loading: boolean; error: string | null }) {
  if (report === null) {
    return (
      <Card className="p-8 text-center">
        <p className="text-[14px] font-semibold text-ink">{error !== null ? 'The desk did not return a report' : 'Reading the report from the desk…'}</p>
        <p className="mt-1 text-[13px] text-muted">
          {error !== null ? 'Nothing is shown instead of it: the recorded sample email is not this desk’s data.' : 'GET /v1/reports/daily aggregates the case store on every call.'}
        </p>
        {error !== null && <p className="mt-3 font-mono text-[12.5px] text-error-text">{error}</p>}
      </Card>
    );
  }
  const n = report.numbers;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-2 text-[12.5px] text-muted">
        <span className="truncate font-mono text-[12px]">GET /v1/reports/{report.kind}?vendor_id={report.vendor_id}</span>
        <span className="flex shrink-0 items-center gap-2">
          {loading && <span className="text-[11.5px]">refreshing…</span>}
          {error !== null && <span className="text-[11.5px] text-error-text" title={error}>last refresh failed</span>}
          <span className="rounded-full bg-success-tint px-2 text-[11px] font-semibold leading-5 text-success-text">Written by the desk</span>
        </span>
      </div>
      <div className="mx-auto max-w-[640px] px-6 py-8">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#0E7C66] text-[13px] font-bold text-white">L</div>
          <span className="font-semibold">{report.vendor_name} agent desk</span>
          <span className="ml-auto text-[13px] text-muted">{stampFmt.format(new Date(report.generated_at))}</span>
        </div>
        <h2 className="text-[22px] font-semibold leading-snug">
          {n.cases_opened} agents asked for help. {n.cases_fixed} were fixed, {n.awaiting_approval} wait for you, and {n.agent_retries_ok} agent{n.agent_retries_ok === 1 ? '' : 's'} finished their task after a fix.
        </h2>
        <p className="mt-2 text-[13px] text-muted">
          Counted over {labelFmt.format(new Date(report.window_start))} – {labelFmt.format(new Date(report.window_end))}, Pacific time.
        </p>

        <Section title="Waiting on you">
          {n.waiting_on_vendor.length === 0 && <p className="text-[14px] text-muted">Nothing is waiting on you.</p>}
          {n.waiting_on_vendor.map((id) => (
            <Link key={id} to={`/app/tickets/${id}`} className="flex items-center justify-between rounded-ctl bg-pink-tint px-4 py-2.5 text-[14px] text-pink-text hover:underline">
              <span className="font-mono text-[12.5px]">{id}</span><span className="font-semibold">Review in one tap →</span>
            </Link>
          ))}
        </Section>

        <Section title="Where your API misleads agents">
          {n.top_failures.length === 0 && <p className="text-[14px] text-muted">No repeating failure on record for this vendor.</p>}
          {n.top_failures.length > 0 && (
            <table className="w-full text-[14px]"><tbody>
              {n.top_failures.map((f) => (
                <tr key={f.signature} className="border-b border-line last:border-0">
                  <td className="py-2 font-mono text-[12.5px]">{f.signature}</td>
                  <td className="py-2 text-right tabular-nums text-muted">{f.count} case{f.count === 1 ? '' : 's'}</td>
                  <td className="py-2 pl-3 text-right"><Link to={`/app/tickets/${f.example_failure_id}`} className="font-mono text-[12px] text-blue hover:underline">{f.example_failure_id.slice(0, 12)}…</Link></td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Section>

        <Section title="What changed">
          <p className="text-[14px] text-ink">
            {n.fixes_merged} fix{n.fixes_merged === 1 ? '' : 'es'} merged, {n.regression_tests_added} regression test{n.regression_tests_added === 1 ? '' : 's'} added, {n.grants_issued} grant{n.grants_issued === 1 ? '' : 's'} issued under your envelope, {n.cases_escalated} case{n.cases_escalated === 1 ? '' : 's'} escalated to a human.
          </p>
        </Section>

        <Section title="Spend">
          <p className="text-[14px] text-ink">
            {usd(n.expected_bill_usd)} expected across {n.billable_cases} billable case{n.billable_cases === 1 ? '' : 's'}. A fix that fails a proof is never billed.
          </p>
          <p className="mt-1 text-[12px] text-muted">The meter is authoritative; this is what the desk expects it to have recorded.</p>
        </Section>

        <Section title="How the desk defines these numbers">
          <ul className="space-y-1.5">
            {report.assumptions.map((a) => <li key={a} className="text-[12.5px] leading-relaxed text-muted">· {a}</li>)}
          </ul>
          <p className="pt-1 text-[12px] text-muted">
            The desk publishes these definitions with every report. The exact text it emails is <span className="font-mono">text</span> in the Source JSON view; no part of it was composed by a language model.
          </p>
        </Section>
      </div>
    </Card>
  );
}
