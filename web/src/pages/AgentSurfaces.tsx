import { useState } from 'react';
import { Link } from 'react-router-dom';
import help from '../data/help_page.json';
import tool from '../data/report_problem.tool.json';
import ticketsJson from '../data/tickets.json';
import { HERO_ID, useStore } from '../lib/store';
import { API_BASE, reportProblem } from '../lib/api';
import { now } from '../lib/clock';
import { Code, JsonView } from '../components/Json';
import { Logo } from '../components/Shell';
import { Button, Card, CardHead, Chip, Label, Segmented } from '../components/ui';

const markdown = `# Ledgerly: help for agents

If a Ledgerly call fails and retrying does not help, ask the desk.
You get a case with committed times right away, then a verified answer.

## How to ask
- MCP: ${help.how_to_ask.mcp.server}, tool \`${help.how_to_ask.mcp.tool}\`
- HTTP: ${help.how_to_ask.http}
- Email: ${help.how_to_ask.email}

Send the failing request_id, your goal in one sentence, and what you tried.
Optional: send header \`${help.identify_yourself.header}\` so we can tell you when a fix ships.

## What we commit to
- Blocked order: acknowledged within 5 minutes, resolved within 1 hour
- Everything else: 15 minutes and 4 hours
- If we miss a deadline you get \`case.breached_sla\` and a human is paged

## What the desk can change
docs, error text, OpenAPI descriptions, test-key config, and the bounded grants below.

## What you may do yourself (authority)
- POST /v1/entitlements/{id}/reissue: live, 1 per user, $30 per case, Idempotency-Key required
- POST /v1/verifications/{id}/appeal: coming, 2 per case
- GET /v1/orders/{id}/state: coming, read only
- POST /v1/refunds: coming, $30 per case, $200 per agent per day

## Status
Push topics: case.acknowledged, case.needs_user_input, case.resolved, case.breached_sla.
Cannot receive webhooks? Poll report_problem with case_id; respect \`wait\`.

## A human, always
${help.human_fallback}
POST /cases/{id}/handoff brings a person into the same thread with the full transcript.
DELETE /v1/users/{id}/data deletes a user's data and returns a receipt.`;

export default function AgentSurfaces() {
  const [view, setView] = useState<'md' | 'json'>('md');
  return (
    <div className="min-h-screen bg-white">
      <header className="flex h-14 items-center justify-between border-b border-line px-4 md:px-8">
        <Link to="/"><Logo /></Link>
        <div className="flex items-center gap-3 text-[13px]">
          <Link to="/app" className="text-muted hover:text-ink">Console</Link>
          <Chip tone="blue">Public · no login · no scripts</Chip>
        </div>
      </header>
      <div className="mx-auto max-w-[1120px] space-y-10 px-4 py-10 md:px-8">
        <div>
          <h1 className="text-title font-semibold">What agents see</h1>
          <p className="mt-1 max-w-3xl text-body text-muted">The customer who matters most never sees a screen. A failing agent needs three things in the same response: a clear reason, a place to ask for help, and an answer it can use without a human. These surfaces are text, and get the same care as the console.</p>
        </div>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[17px] font-semibold">1 · The help page</h2>
              <Segmented options={[{ key: 'md', label: 'Markdown' }, { key: 'json', label: 'JSON twin' }]} value={view} onChange={setView} />
            </div>
            {view === 'md' ? <Code file="help.ledgerly.example/agents  (text/markdown)">{markdown}</Code> : <JsonView file="help.ledgerly.example/agents.json" data={help} maxHeight={520} />}
          </div>
          <div className="space-y-4">
            <div>
              <h2 className="mb-3 text-[17px] font-semibold">2 · The error body</h2>
              <JsonView file="any 4xx from Ledgerly" note="help field added by the install PR" data={{ error: { code: 'unknown_field', message: 'currency_code is not a field' }, help: { desk: 'https://help.ledgerly.example/agents', tool: 'report_problem', request_id: 'req_123', hint: 'If this keeps failing, call report_problem with this request_id.' } }} maxHeight="none" />
            </div>
            <Card className="p-4 text-[13.5px]">
              <Label>Rules for agent surfaces</Label>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-ink/90">
                <li>Same shape every time; fields are versioned.</li>
                <li>No data from other customers, ever.</li>
                <li>A human fallback is always named.</li>
                <li>No grant without a cap, a per-user limit, an idempotency key and a receipt.</li>
              </ul>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[17px] font-semibold">3 · The report_problem tool</h2>
          <div className="grid gap-6 lg:grid-cols-2">
            <JsonView file="MCP tool definition · ledgerly-desk.manufact.app" data={tool} maxHeight={460} />
            <TryIt />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[17px] font-semibold">4 · Push status and warm handoff</h2>
          <div className="grid gap-4 md:grid-cols-4">
            {[
              ['case.acknowledged', 'Sent the moment a case opens, with ack_by and resolve_by.'],
              ['case.needs_user_input', 'The desk needs something only the user knows.'],
              ['case.resolved', 'Carries the executable outcome, so the agent resumes.'],
              ['case.breached_sla', 'A deadline was missed; a human is paged.'],
            ].map(([k, v]) => <Card key={k} className="p-4"><div className="font-mono text-[12.5px] font-medium">{k}</div><p className="mt-1 text-[13px] text-muted">{v}</p></Card>)}
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <JsonView file="POST /cases/{id}/handoff → 200" data={{ case_id: 'ahd_01JBFQ8ZRD', status: 'handed_off', human: { name: 'Ledgerly support', joined_at: '2026-10-18T00:00:12Z' }, transcript_attached: true }} maxHeight="none" />
            <JsonView file="DELETE /v1/users/{id}/data → 200" data={{ deleted: ['account', 'saved_addresses', 'offer_email'], receipt: 'rcpt_del_01JBF1', at: '2026-10-17T21:41:12Z' }} maxHeight="none" />
          </div>
        </section>
      </div>
    </div>
  );
}

/** The failing call this page documents, read from the recorded example rather than retyped, so
 * what the browser sends is the same call the docs above describe. */
const demoCall = (ticketsJson as unknown as { id: string; request: unknown; response: unknown }[]).find((t) => t.id === HERO_ID);

function TryIt() {
  const { ticket, live, retryProof } = useStore();
  const [req, setReq] = useState('req_8hT2kq');
  const [goal, setGoal] = useState('Apply the user’s $30 gift card and place the order.');
  const [res, setRes] = useState<unknown>(null);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** Recorded mode. Nothing is sent: the known request id replays the reply the demo desk gave,
   * and any other id gets the shape of a new case, built here in the browser. */
  const simulate = () => {
    const known = req.trim() === 'req_8hT2kq' ? ticket(HERO_ID) : undefined;
    const t = now();
    setErr(null);
    setCaseId(null);
    setRes({
      case_id: known ? known.id : `ahd_${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
      status: known ? (known.stage === 'awaiting_approval' ? 'working' : known.stage === 'shipped' ? 'answered' : 'working') : 'opened',
      ack_by: known?.ack_by ?? new Date(t + 15 * 60e3).toISOString(),
      resolve_by: known?.resolve_by ?? new Date(t + 4 * 3600e3).toISOString(),
      queue_position: known?.queue_position ?? 4,
      ...(known?.reply ? { answer: { summary: known.reply.title, fix_steps: known.reply.fix_steps, tested: known.reply.tested }, authority: known.reply.authority, outcome: known.reply.outcome ?? null } : {}),
      events: ['case.acknowledged', 'case.needs_user_input', 'case.resolved', 'case.breached_sla'],
      wait: 30,
    });
  };

  /**
   * Live mode: a real POST /v1/cases, so the receipt on screen is the desk's own and not a shape
   * invented here. The typed request id goes into the failing call and doubles as the idempotency
   * key — intake derives the case id from it, which is what makes a second press replay one case
   * instead of opening another.
   */
  const callDesk = async () => {
    if (demoCall === undefined) { setErr('this build has no recorded example call to send.'); return; }
    const rid = req.trim() === '' ? 'req_8hT2kq' : req.trim();
    const response = demoCall.response as { headers?: Record<string, string>; body?: { help?: Record<string, unknown> } };
    setBusy(true);
    setErr(null);
    try {
      const receipt = await reportProblem({
        agent_id: 'agt_web_tryit',
        task: goal.trim() === '' ? 'apply the gift card and place the order' : goal.trim(),
        request: demoCall.request,
        response: {
          ...response,
          headers: { ...(response.headers ?? {}), 'Request-Id': rid },
          body: { ...(response.body ?? {}), help: { ...(response.body?.help ?? {}), request_id: rid } },
        },
        channel: 'webhook',
        idempotency_key: `web-tryit-${rid}`,
      });
      setRes(receipt);
      setCaseId(receipt.case_id);
    } catch (e) {
      setRes(null);
      setCaseId(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHead
        title="Try it as an agent"
        sub={live.on
          ? `Calls the running desk: POST ${API_BASE}/v1/cases, the same intake report_problem reaches over MCP. Intake only, so it returns the case and the deadlines it committed to; the loop runs when you ask for it below.`
          : 'Recorded, and nothing is sent. The known request id req_8hT2kq replays the reply the demo desk gave; any other id returns the shape of a new case, built in your browser.'}
      />
      <div className="space-y-3 p-5">
        <label className="block"><Label>request_id</Label><input value={req} onChange={(e) => setReq(e.target.value)} className="mt-1 h-9 w-full rounded-ctl border border-line px-3 font-mono text-[13px] outline-none focus:border-blue" /></label>
        <label className="block"><Label>goal</Label><input value={goal} onChange={(e) => setGoal(e.target.value)} className="mt-1 h-9 w-full rounded-ctl border border-line px-3 text-[14px] outline-none focus:border-blue" /></label>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={busy} onClick={() => { if (live.on) void callDesk(); else simulate(); }}>
            {busy ? 'Calling the desk…' : live.on ? 'Call POST /v1/cases' : 'Call report_problem'}
          </Button>
          {caseId !== null && (
            <>
              <Link to={`/app/tickets/${caseId}`} className="text-[13.5px] font-medium text-blue-text underline hover:no-underline">Open {caseId} in the console</Link>
              <Button size="sm" onClick={() => void retryProof(caseId)}>Run the loop on it</Button>
            </>
          )}
        </div>
        {err !== null && <p className="text-[13px] text-error">The desk refused the call: {err}</p>}
        {res !== null && <JsonView file={live.on ? 'POST /v1/cases → 201' : 'report_problem → response'} data={res} maxHeight={340} />}
      </div>
    </Card>
  );
}
