import { useState } from 'react';
import { Link } from 'react-router-dom';
import billing from '../data/billing.json';
import { useStore } from '../lib/store';
import { clock, usd } from '../lib/clock';
import { JsonView } from '../components/Json';
import { Button, Card, CardHead, Label, PageHeader, SampleTag } from '../components/ui';

export default function Billing() {
  const { tickets, events, toast, propose } = useStore();
  const [cap, setCap] = useState(billing.spend_cap_usd);
  const p = billing.prices;
  const sum = billing.usage_by_day.reduce((a, d) => ({ docs: a.docs + d.docs, code: a.code + d.code, migration: a.migration + d.migration }), { docs: 0, code: 0, migration: 0 });
  const lines = [
    { k: 'Docs and error text fixes', n: sum.docs, price: p.docs_error_text },
    { k: 'Code, config and grant fixes', n: sum.code, price: p.code_config_grant },
    { k: 'Merged migration pull requests', n: sum.migration, price: p.migration_pr },
    { k: 'Platform fee', n: 1, price: p.platform_monthly },
  ];
  const total = lines.reduce((a, l) => a + l.n * l.price, 0);
  const max = Math.max(...billing.usage_by_day.map((d) => d.docs + d.code + d.migration * 3));
  const meter = events.filter((e) => e.action === 'meter_event.created').sort((a, b) => b.at - a.at);
  const unbilled = tickets.filter((t) => !t.billed && (Boolean(t.not_billable_reason) || ['answered', 'failed_proof', 'escalated', 'rejected'].includes(t.stage) || (t.stage === 'shipped' && t.outcome?.agent_retry_ok !== true)));
  const pct = cap > 0 ? (total / cap) * 100 : 0;

  const esc = (v: unknown) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

  /** The browser's own print-to-PDF, so the button delivers what it says without a PDF dependency. */
  const openInvoice = (i: (typeof billing.invoices)[number]) => {
    const w = window.open('', '_blank', 'width=760,height=940');
    if (!w) { toast('The browser blocked the pop-up. Allow pop-ups on this page to save the invoice.', 'error'); return; }
    const priceRows = ([
      ['Docs and error text fixes', p.docs_error_text],
      ['Code, config and grant fixes', p.code_config_grant],
      ['Merged migration pull requests', p.migration_pr],
      ['Platform fee', p.platform_monthly],
    ] as [string, number][])
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(usd(v))}</td></tr>`)
      .join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(i.id)}</title>
<style>
body{font:14px/1.5 -apple-system,'Segoe UI',Helvetica,sans-serif;color:#111827;margin:48px}
h1{font-size:20px;margin:0}p{margin:4px 0}
table{width:100%;border-collapse:collapse;margin-top:24px}
th,td{border-bottom:1px solid #E6E8EE;padding:8px 0;text-align:left;font-size:13px}
th{color:#5B6475;font-weight:500;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
.n{text-align:right;font-variant-numeric:tabular-nums}
.total{font-size:17px;font-weight:600;border-bottom:none;padding-top:14px}
.note{margin-top:32px;font-size:12px;color:#5B6475}
</style></head><body>
<h1>AgentHelpDesk</h1>
<p>Invoice ${esc(i.id)} &middot; ${esc(i.period)} &middot; ${esc(i.status)}</p>
<p>Billed to Ledgerly (demo vendor)</p>
<table><thead><tr><th>Price list</th><th class="n">Per unit</th></tr></thead><tbody>${priceRows}</tbody></table>
<table><tbody><tr><td>${esc(i.fixes)} verified fixes</td><td class="n total">${esc(usd(i.total_usd))}</td></tr></tbody></table>
<p class="note">Test mode: this invoice is a sample and nothing was charged. In live mode Stripe issues the invoice and this row links to it.</p>
<script>window.print()</script>
</body></html>`);
    w.document.close();
  };

  const addPayment = () =>
    toast('Test mode charges nothing, so no card is collected. Leaving test mode opens Stripe’s hosted form — AgentHelpDesk never handles card numbers.', 'info');

  return (
    <div>
      <PageHeader title="Billing" sub="You pay per verified fix that the agent then uses successfully. Provider (B2B) metering settles on Stripe; agent-to-agent calls settle per-call on x402. The invoice is the proof the desk earned its fee." />
      <div className="mb-6 flex items-center gap-3 rounded-card bg-pink-tint px-5 py-3 text-[14px] text-pink-text">
        <span className="font-semibold">No live payment method.</span> Nothing is being charged. Meter events go to Stripe in test mode.
        <Button variant="primary" size="sm" className="ml-auto" onClick={addPayment}>Add payment method</Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHead title="Usage this period" sub="October 1–31 · verified fixes billed, by type" right={<SampleTag />} />
            <div className="p-5">
              <div className="flex h-40 items-end gap-1.5">
                {billing.usage_by_day.map((d) => (
                  <div key={d.d} className="group flex flex-1 flex-col items-center gap-1" title={`${d.d}: ${d.docs} docs, ${d.code} code, ${d.migration} migration`}>
                    <div className="flex w-full flex-col-reverse overflow-hidden rounded-t">
                      <div className="bg-blue" style={{ height: d.docs * (130 / max) }} />
                      <div className="bg-ink" style={{ height: d.code * (130 / max) }} />
                      <div className="bg-pink-bright" style={{ height: d.migration * 3 * (130 / max) }} />
                    </div>
                    <span className="text-[10px] text-muted">{d.d.slice(3)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-4 text-[12.5px] text-muted">
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-blue" />Docs and error text · {sum.docs}</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-ink" />Code, config, grant · {sum.code}</span>
                <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-pink-bright" />Migration PR · {sum.migration}</span>
              </div>
            </div>
          </Card>

          <Card>
            <CardHead title="Meter events" sub="One per billable outcome: three proofs passed and the agent’s retry succeeded. The outcome id is the identifier, so a retry can never bill twice." />
            <ul className="divide-y divide-line">
              {meter.map((e) => {
                const t = tickets.find((x) => x.id === e.ticket_id);
                return (
                  <li key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-[13.5px]">
                    <span className="w-20 font-mono text-[12px] text-muted">{clock(e.at)}</span>
                    <span className="font-mono text-[12px]">{String(e.payload.identifier ?? e.id)}</span>
                    <Link to={`/app/tickets/${e.ticket_id}`} className="min-w-0 flex-1 truncate text-blue hover:underline">{t?.title}</Link>
                    <span className="tabular-nums">{usd(t?.price_usd ?? 0)}</span>
                  </li>
                );
              })}
            </ul>
            {meter[0] && <div className="border-t border-line p-4"><JsonView file="stripe.billing.meter_events.create (latest)" data={{ event_name: 'ahd_verified_fix', payload: { stripe_customer_id: 'cus_test_ledgerly', value: '1' }, identifier: meter[0].payload.identifier, timestamp: Math.floor(meter[0].at / 1000) }} maxHeight={200} /></div>}
          </Card>

          {unbilled.length > 0 && (
            <Card>
              <CardHead title="Not billed" sub="Shown so you can see what the desk did not charge for." />
              <ul className="divide-y divide-line text-[13.5px]">
                {unbilled.map((t) => <li key={t.id} className="flex justify-between gap-3 px-5 py-2.5"><Link to={`/app/tickets/${t.id}`} className="truncate text-ink hover:underline">{t.title}</Link><span className="shrink-0 text-muted" title={t.not_billable_reason}>{t.not_billable_reason ? 'Exempt' : t.stage === 'answered' || t.stage === 'shipped' ? 'Retry not yet confirmed' : t.stage === 'failed_proof' ? 'Proof failed' : t.stage === 'escalated' ? 'Escalated, nothing shipped' : 'Rejected'}</span></li>)}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHead title="Invoice preview" sub="Matches what Stripe will invoice, over the recorded month" right={<SampleTag />} />
            <div className="p-5">
              <table className="w-full text-[13.5px]"><tbody>
                {lines.map((l) => <tr key={l.k} className="border-b border-line"><td className="py-2 pr-2">{l.k}<div className="text-[12px] text-muted">{l.n} × {usd(l.price)}</div></td><td className="py-2 text-right tabular-nums">{usd(l.n * l.price)}</td></tr>)}
              </tbody></table>
              <div className="mt-3 flex justify-between text-[15px] font-semibold"><span>Total so far</span><span className="tabular-nums">{usd(total)}</span></div>
              <p className="mt-2 text-[12px] text-muted">Prices are read from Stripe and are a hypothesis until pilots confirm them.</p>
            </div>
          </Card>
          <Card className="p-5">
            <Label>Spend cap</Label>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-muted">$</span>
              <input type="number" min={0} value={cap} onChange={(e) => setCap(Number(e.target.value))} onBlur={() => cap > 0 && cap !== billing.spend_cap_usd && propose('spend_cap_usd', cap)} className="h-9 w-28 rounded-ctl border border-line px-3 text-[14px] tabular-nums outline-none focus:border-blue" />
              <span className="text-[13px] text-muted">per month</span>
            </div>
            <div className="mt-3 h-2 rounded-full bg-surface"><div className="h-2 rounded-full bg-blue" style={{ width: `${Math.min(100, pct)}%` }} /></div>
            <p className="mt-2 text-[12.5px] text-muted">{cap > 0 ? `${Math.round(pct)}% used. At the cap the desk stops opening paid fixes and moves to suggest only. Admins get an email at 80%.` : 'Set a cap above zero. At the cap the desk stops opening paid fixes and moves to suggest only.'}</p>
          </Card>
          <Card className="p-5">
            <Label>Payment method</Label>
            <p className="mt-2 text-[14px] text-muted">None yet. Updated through a Stripe-hosted form, so AgentHelpDesk never handles card numbers.</p>
            <div className="mt-3"><Button size="sm" onClick={addPayment}>Add payment method</Button></div>
          </Card>
          <Card>
            <CardHead title="Invoices" right={<SampleTag />} />
            <ul className="divide-y divide-line text-[13.5px]">
              {billing.invoices.map((i) => <li key={i.id} className="flex items-center justify-between px-5 py-2.5"><div><div>{i.period}</div><div className="text-[12px] text-muted">{i.fixes} fixes · {i.status}</div></div><div className="text-right"><div className="tabular-nums">{usd(i.total_usd)}</div><button type="button" onClick={() => openInvoice(i)} className="text-[12px] text-blue hover:underline">PDF</button></div></li>)}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
