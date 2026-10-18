import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import config from '../data/agenthelpdesk.json';
import { agents, useStore } from '../lib/store';
import { ago } from '../lib/clock';
import type { Mode } from '../lib/types';
import { JsonView } from '../components/Json';
import { LiveSampleNote } from '../components/Shell';
import { Button, Card, CardHead, Chip, PageHeader, StageChip, Toggle, cx, modeLabel } from '../components/ui';

export function Agents() {
  const [params, setParams] = useSearchParams();
  const { tickets, propose } = useStore();
  const [muted, setMuted] = useState<string[]>(config.mute_list);
  const [partners, setPartners] = useState<string[]>(config.partners);
  const openId = params.get('a');
  const open = agents.find((a) => a.id === openId);
  const toggle = (list: string[], client: string, setList: (v: string[]) => void, key: string) => {
    const next = list.includes(client) ? list.filter((x) => x !== client) : [...list, client];
    setList(next);
    propose(key, next);
  };
  return (
    <div>
      <PageHeader title="Agents" sub="Agents that called your API. Helped: got a verified answer. Won: then succeeded." />
      <LiveSampleNote>
        this table is recorded data. Live cases show their agent ID on each ticket.
      </LiveSampleNote>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-table">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-[12px] text-muted">
                <th className="px-4 py-2.5 font-medium">Agent</th><th className="font-medium">Calls 7d</th><th className="font-medium">Failures</th><th className="font-medium">Tickets</th><th className="font-medium">Status</th><th className="pr-4 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr
                  key={a.id}
                  tabIndex={0}
                  aria-current={openId === a.id ? 'true' : undefined}
                  onClick={() => setParams({ a: a.id })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setParams({ a: a.id }); } }}
                  className={cx('cursor-pointer border-b border-line last:border-0 focus-visible:outline-2 focus-visible:-outline-offset-2', openId === a.id ? 'bg-blue-tint/60' : 'hover:bg-surface/60')}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 text-ink">{a.name}{partners.includes(a.client) && <Chip tone="blue">Partner</Chip>}{muted.includes(a.client) && <Chip>Muted</Chip>}</div>
                    <div className="font-mono text-[12px] text-muted">{a.client}</div>
                  </td>
                  <td className="tabular-nums">{a.calls_7d.toLocaleString()}</td>
                  <td className="tabular-nums">{a.failures_7d} <span className="text-muted">({((a.failures_7d / a.calls_7d) * 100).toFixed(1)}%)</span></td>
                  <td className="tabular-nums">{a.tickets}</td>
                  <td><Chip tone={a.status === 'won' ? 'green' : a.status === 'lost' ? 'red' : 'blue'}>{a.status}</Chip></td>
                  <td className="pr-4 text-right text-muted">{ago(a.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div>
          {open ? (
            <Card className="lg:sticky lg:top-20">
              <CardHead title={open.name} sub={<span className="font-mono">{open.client}</span>} />
              <div className="space-y-4 p-5">
                {!open.identified && <p className="rounded-ctl bg-warning-tint px-3 py-2 text-[13px] text-warning">This client does not send the AHD-Agent-Id header, so “won” cannot be measured for it.</p>}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => toggle(muted, open.client, setMuted, 'mute_list')}>{muted.includes(open.client) ? 'Unmute' : 'Mute noisy agent'}</Button>
                  <Button size="sm" onClick={() => toggle(partners, open.client, setPartners, 'partners')}>{partners.includes(open.client) ? 'Unmark partner' : 'Mark as partner'}</Button>
                </div>
                <div>
                  <div className="mb-2 text-[13px] font-semibold">History</div>
                  <ul className="space-y-2">
                    {tickets.filter((t) => t.agent_id === open.id).map((t) => (
                      <li key={t.id}><Link to={`/app/tickets/${t.id}`} className="block rounded-ctl border border-line px-3 py-2 hover:bg-surface"><StageChip stage={t.stage} /><p className="mt-1 line-clamp-2 text-[13px] text-ink">{t.title}</p></Link></li>
                    ))}
                    {!tickets.some((t) => t.agent_id === open.id) && <li className="text-[13px] text-muted">No tickets in this demo data.</li>}
                  </ul>
                </div>
                <JsonView file={`agents.json → ${open.id}`} data={open} maxHeight={200} />
              </div>
            </Card>
          ) : (
            <Card className="p-6 text-center text-[14px] text-muted">Pick an agent to see its history, mute it, or mark it as a known partner.</Card>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A configured route carries `{id}` placeholders; a case carries the path the agent actually
 * called. Equality alone therefore never matches a parameterised endpoint, and its open-ticket
 * count reads as zero no matter how many cases the desk is holding for it.
 */
function routeMatches(endpoint: string, route: string): boolean {
  if (endpoint === route) return true;
  const space = route.indexOf(' ');
  if (space < 0) return false;
  const method = route.slice(0, space);
  if (!endpoint.startsWith(`${method} `)) return false;
  const routeSegs = route.slice(space + 1).split('/');
  const endpointSegs = endpoint.slice(endpoint.indexOf(' ') + 1).split('?')[0].split('/');
  if (routeSegs.length !== endpointSegs.length) return false;
  return routeSegs.every((seg, i) =>
    seg.startsWith('{') && seg.endsWith('}') ? endpointSegs[i].length > 0 : seg === endpointSegs[i],
  );
}

export function Endpoints() {
  const { tickets, propose } = useStore();
  const [eps, setEps] = useState(config.endpoints.map((e) => ({ ...e, mode: e.mode as Mode })));
  const patchEp = (i: number, p: Partial<(typeof eps)[number]>) => {
    setEps(eps.map((x, k) => (k === i ? { ...x, ...p } : x)));
    const [key, value] = Object.entries(p)[0];
    propose(`endpoints[${i}].${key}`, value);
  };
  /** Cases the desk took on a path this table has no row for. Worth showing: the table reads
   * the spec, and a call the spec does not describe gets no per-endpoint mode at all. */
  const outside = [...new Set(tickets.map((t) => t.endpoint).filter((ep) => ep !== '' && !eps.some((e) => routeMatches(ep, e.route))))];
  const outsideCount = tickets.filter((t) => outside.includes(t.endpoint)).length;
  return (
    <div>
      <PageHeader title="Endpoints" sub="From your OpenAPI spec. Turn the desk on or off per endpoint and set what may ship alone." />
      <LiveSampleNote>
        volumes, failure rates and modes are recorded config. Open tickets and last fix are live.
      </LiveSampleNote>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-table">
          <thead>
            <tr className="border-b border-line bg-surface text-left text-[12px] text-muted"><th className="px-4 py-2.5 font-medium">Endpoint</th><th className="font-medium">Calls 7d</th><th className="font-medium">Failure rate</th><th className="font-medium">Open tickets</th><th className="font-medium">Last fix</th><th className="font-medium">Approval mode</th><th className="pr-4 text-right font-medium">Desk</th></tr>
          </thead>
          <tbody>
            {eps.map((e, i) => {
              const open = tickets.filter((t) => routeMatches(t.endpoint, e.route) && !['shipped', 'closed', 'answered', 'rejected'].includes(t.stage)).length;
              const last = tickets.find((t) => routeMatches(t.endpoint, e.route) && t.stage === 'shipped');
              const r = e.failure_rate_7d;
              const fails = Math.round((e.calls_7d * r) / 100);
              return (
                <tr key={e.route} className="border-b border-line last:border-0">
                  <td className="px-4 py-3"><span className="font-mono text-[12.5px] text-ink">{e.route}</span>{'sensitive' in e && e.sensitive && <Chip className="ml-2">Sensitive</Chip>}</td>
                  <td><div className="tabular-nums">{e.calls_7d.toLocaleString()}</div><div className="text-[12px] text-muted">{fails.toLocaleString()} failed</div></td>
                  <td><div className="flex items-center gap-2"><div className="h-1.5 w-20 rounded-full bg-surface"><div className={cx('h-1.5 rounded-full', r > 8 ? 'bg-error' : r > 4 ? 'bg-warning' : 'bg-blue')} style={{ width: `${Math.min(100, r * 7)}%` }} /></div><span className="tabular-nums text-muted">{r}%</span></div></td>
                  <td className="tabular-nums">{open || <span className="text-muted">0</span>}</td>
                  <td className="text-muted">{last ? <Link className="text-blue hover:underline" to={`/app/tickets/${last.id}`}>PR #{last.pr?.number}</Link> : '—'}</td>
                  <td>
                    <select disabled={!e.desk} value={e.mode} onChange={(ev) => patchEp(i, { mode: ev.target.value as Mode })} className="h-8 rounded-ctl border border-line bg-white px-2 text-[13px] disabled:opacity-50">
                      {(['auto', 'approve_first', 'suggest_only'] as Mode[]).map((m) => <option key={m} value={m}>{modeLabel[m]}</option>)}
                    </select>
                  </td>
                  <td className="pr-4 text-right"><Toggle label={`Desk on ${e.route}`} on={e.desk} onChange={(v) => patchEp(i, { desk: v })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <p className="mt-3 text-[13px] text-muted">Nothing ships without three proofs. Changes here open a pull request on <span className="font-mono">agenthelpdesk.json</span> through a pull request.</p>
      {outside.length > 0 && (
        <p className="mt-2 text-[13px] text-muted">
          {outsideCount} case{outsideCount === 1 ? '' : 's'} came in on <span className="font-mono text-[12.5px] text-ink">{outside.join(' · ')}</span> are not in your spec, so they use your default mode.
        </p>
      )}
      <div className="mt-4"><JsonView file="agenthelpdesk.json → endpoints (live preview)" data={eps} maxHeight={220} /></div>
    </div>
  );
}
