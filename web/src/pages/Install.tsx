import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import config from '../data/agenthelpdesk.json';
import { Code, Diff, JsonView } from '../components/Json';
import { Logo } from '../components/Shell';
import { Button, Card, Chip, CopyButton, ProofIcon, SampleTag, Segmented, cx } from '../components/ui';
import type { ProofStatus } from '../lib/types';

const STEPS = ['Sign in', 'Connect GitHub', 'Detect your API', 'Merge one PR', 'Test ticket', 'Live'];

type Rung = { n: number; name: string; youDo: string; youGet: string; effort: string; honest: string; recommended?: boolean };

const RUNGS: Rung[] = [
  { n: 0, name: 'An agent forwards its own failing call', youDo: 'Share your help link. An agent operator sends the request that just failed straight to your desk.', youGet: 'A classified case with a suggested answer.', effort: 'Nothing to install', honest: 'Suggest only · unproven · never billed' },
  { n: 1, name: 'Point your errors at the desk', youDo: 'Add one help field to your error bodies, or one line to llms.txt.', youGet: 'Failing agents find the desk at the moment they fail.', effort: 'One line of code', honest: 'Suggest only · unproven · never billed' },
  { n: 2, name: 'Show us your spec', youDo: 'Paste an OpenAPI spec URL or drop the file. No GitHub, no repo access.', youGet: 'Answers for knowledge and authority failures, and bounded grant drafts.', effort: 'Two minutes', honest: 'Suggest only · unproven · never billed', recommended: true },
  { n: 3, name: 'Route cases to your channels', youDo: 'Send new cases to Slack, Linear, email or a webhook your team already staffs.', youGet: 'Cases reach the people who can answer them.', effort: 'One connection', honest: 'Suggest only · unproven · never billed' },
  { n: 4, name: 'Connect GitHub', youDo: 'Merge one install pull request. Every fix is proved three ways before it ships.', youGet: 'Proven fixes, opened pull requests, regression tests. The only rung that can bill.', effort: 'One merge', honest: 'Proven first · billed only after all three proofs pass' },
];

type Nav = { onBack: () => void; onNext: () => void; onGithub: () => void };

export default function Install() {
  const [rung, setRung] = useState<number | null>(null);
  const back = () => setRung(null);
  const github = () => setRung(4);
  return (
    <div className="min-h-screen bg-white">
      <header className="flex h-14 items-center justify-between border-b border-line px-4 md:px-8">
        <Link to="/"><Logo /></Link>
        <div className="flex items-center gap-3 text-[13px]">
          <span className="hidden text-muted sm:inline">Every path is free until a fix is proven</span>
          <Chip tone="amber" dot>Test mode</Chip>
        </div>
      </header>
      {rung === null && <Ladder onPick={setRung} />}
      {rung === 0 && <RungForward onBack={back} onNext={() => setRung(1)} onGithub={github} />}
      {rung === 1 && <RungErrorLine onBack={back} onNext={() => setRung(2)} onGithub={github} />}
      {rung === 2 && <RungSpec onBack={back} onNext={() => setRung(3)} onGithub={github} />}
      {rung === 3 && <RungChannels onBack={back} onNext={github} onGithub={github} />}
      {rung === 4 && <Wizard onBack={back} />}
    </div>
  );
}

function Ladder({ onPick }: { onPick: (n: number) => void }) {
  return (
    <div className="mx-auto max-w-[900px] px-4 py-10 md:px-8">
      <div className="mb-8 max-w-2xl">
        <h1 className="text-title font-semibold">Give your API a help desk for agents</h1>
        <p className="mt-2 text-body text-muted">Five ways in, least permission first. Start with nothing but a failing call; climb to a desk that proves every fix before it ships. Nothing in your running API changes until you merge a pull request, and only rung 4 opens one.</p>
      </div>
      <ol className="relative space-y-3">
        <div aria-hidden className="absolute bottom-10 left-[27px] top-10 w-px bg-line" />
        {RUNGS.map((r) => (
          <li key={r.n} className="relative flex items-start gap-4">
            <span className={cx('z-10 flex h-14 w-14 shrink-0 items-center justify-center rounded-full border text-[17px] font-semibold', r.n === 4 ? 'border-ink bg-ink text-white' : 'border-line bg-white text-ink')}>{r.n}</span>
            <button
              type="button"
              onClick={() => onPick(r.n)}
              className="flex-1 rounded-card border border-line bg-white p-4 text-left transition hover:bg-surface/60 focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold text-ink">{r.name}</span>
                <Chip tone={r.n === 4 ? 'pink' : 'gray'}>{r.effort}</Chip>
                {r.recommended && <Chip tone="blue">Recommended first step</Chip>}
              </div>
              <p className="mt-1.5 text-[13.5px] text-ink">{r.youDo}</p>
              <p className="mt-1 text-[13px] text-muted">You get: {r.youGet}</p>
              <p className={cx('mt-2 text-[12.5px] font-medium', r.n === 4 ? 'text-pink-text' : 'text-warning')}>{r.honest}</p>
            </button>
          </li>
        ))}
      </ol>
      <p className="mt-6 max-w-2xl text-[13px] text-muted">The deal, printed on the tin: rungs 0–3 are free and every answer says “suggestion” on it. Only rung 4 can produce a billable fix, and only after replay, your tests and a fresh agent all pass.</p>
    </div>
  );
}

function RungShell({ n, title, sub, nextLabel, onBack, onNext, onGithub, children }: Nav & { n: number; title: string; sub: string; nextLabel: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[900px] px-4 py-10 md:px-8">
      <button type="button" onClick={onBack} className="mb-6 inline-flex items-center gap-1.5 text-[13.5px] text-muted hover:text-ink">← All install paths</button>
      <div className="mb-6 max-w-2xl">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Chip tone="gray">Rung {n} of 4</Chip>
          {RUNGS[n].recommended && <Chip tone="blue">Recommended first step</Chip>}
        </div>
        <h1 className="text-title font-semibold">{title}</h1>
        <p className="mt-2 text-body text-muted">{sub}</p>
      </div>
      {children}
      <div className="mt-8 max-w-2xl rounded-card border border-line bg-warning-tint px-4 py-3">
        <div className="text-[13px] font-semibold text-warning">Unproven suggestions — never billed</div>
        <p className="mt-1 text-[13.5px] text-ink">This rung answers with what we can see without repo access, and every answer is labelled a suggestion. Nothing merges into your code and nothing bills. Rung 4 is what turns a suggestion into a fix proved by replay, your tests and a fresh agent.</p>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" onClick={onNext}>{nextLabel}</Button>
        <Button onClick={onBack}>Back to all paths</Button>
        <span className="text-[13px] text-muted">or <button type="button" onClick={onGithub} className="font-medium text-blue-text underline hover:no-underline">go straight to the GitHub install</button></span>
      </div>
    </div>
  );
}

function RungForward({ onBack, onNext, onGithub }: Nav) {
  return (
    <RungShell
      n={0} onBack={onBack} onNext={onNext} onGithub={onGithub}
      title="An agent forwards its own failing call"
      sub="No install, no GitHub, no code change. An agent operator who already calls your API sends the request that just failed straight to your desk, and you get a case."
      nextLabel="Next: point your errors at the desk"
    >
      <ol className="max-w-2xl list-decimal space-y-1.5 pl-5 text-[14px] text-ink">
        <li>Share your help link with an agent operator you work with.</li>
        <li>Their next failing call gets forwarded to your desk — MCP tool, HTTP or plain email.</li>
        <li>You see a case classified as knowledge, code or authority, with a suggested answer you can edit before it goes back.</li>
      </ol>
      <div className="mt-5 max-w-2xl">
        <Code file="what the agent sends">{`// its own failing call
POST /v1/entries  ->  422 invalid_request

// forwarded to your desk, one tool call
report_problem({
  desk: "https://help.ledgerly.example/agents",
  request_id: "req_live_1042",
  error: { code: "invalid_request", message: "date must be an ISO-8601 timestamp" }
})`}</Code>
        <p className="mt-2 text-[13px] text-muted">No MCP client? The same payload posts to /agents/cases, or forwards to the desk address printed in your error responses.</p>
      </div>
      <Card className="mt-5 max-w-2xl px-5 py-4">
        <div className="text-[13px] font-semibold text-ink">Whose request is this?</div>
        <p className="mt-1 text-[13.5px] text-ink">The agent sends its own failing call — that is the whole rung. We never ingest your traffic without your consent, at any rung: those requests carry your users' data.</p>
      </Card>
    </RungShell>
  );
}

function RungErrorLine({ onBack, onNext, onGithub }: Nav) {
  const helper = `export const withHelp = (err, requestId) => ({
  error: err,
  help: {
    desk: "https://help.ledgerly.example/agents",
    tool: "report_problem",
    request_id: requestId,
    hint: "If this keeps failing, call report_problem with this request_id.",
  },
});`;
  const llms = `# Ledgerly
> Agents: if a call fails, call report_problem (MCP) or POST /agents/cases.
> Help for agents: https://help.ledgerly.example/agents`;
  return (
    <RungShell
      n={1} onBack={onBack} onNext={onNext} onGithub={onGithub}
      title="Point your errors at the desk"
      sub="One helper in your error path, or one line in llms.txt. You merge it yourself — no app, no token, no repo access."
      nextLabel="Next: show us your spec"
    >
      <p className="max-w-2xl text-[14px] text-ink">A failing agent learns where to go at the moment it fails. Either snippet is enough; agents read error bodies and llms.txt before anything else.</p>
      <div className="mt-4 max-w-2xl space-y-4">
        <Diff file="src/errors/help.ts" lines={helper.split('\n').map((l) => `+${l}`)} />
        <Diff file="llms.txt" lines={llms.split('\n').map((l) => `+${l}`)} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <CopyButton label="Copy both snippets" text={`${helper}\n\n${llms}`} />
        <span className="text-[13px] text-muted">Nothing phones home until an agent uses it. Delete the helper and the desk goes quiet.</span>
      </div>
    </RungShell>
  );
}

function RungSpec({ onBack, onNext, onGithub }: Nav) {
  const [url, setUrl] = useState('https://ledgerly.example/openapi.yaml');
  const [read, setRead] = useState(false);
  const found = [
    ['Endpoints', '8 found · POST /v1/entries and DELETE /v1/entries/:id marked sensitive'],
    ['Auth', 'Bearer token · scopes documented'],
    ['Docs', 'docs/ · 14 pages · llms.txt missing, so we draft one'],
    ['Tests and CI', 'Not visible at this rung · code fixes stay off until rung 4'],
  ];
  return (
    <RungShell
      n={2} onBack={onBack} onNext={onNext} onGithub={onGithub}
      title="Show us your spec"
      sub="Paste a spec URL or drop the file. Two minutes, no GitHub, no repo access — enough for the desk to start answering the failures it can answer safely."
      nextLabel="Next: route cases to your channels"
    >
      <div className="max-w-2xl">
        <label htmlFor="spec-url" className="mb-1.5 block text-[13px] font-semibold text-ink">OpenAPI spec URL</label>
        <div className="flex gap-2">
          <input
            id="spec-url"
            value={url}
            spellCheck={false}
            onChange={(e) => { setUrl(e.target.value); setRead(false); }}
            className="w-full rounded-ctl border border-line px-3 py-2 font-mono text-[13px] text-ink focus:border-ink focus:outline-none"
          />
          <Button variant="primary" onClick={() => setRead(true)}>Read spec</Button>
        </div>
        <p className="mt-2 text-[13px] text-muted">YAML or JSON, read-only. We keep the shape of your API, not your code. Test mode fetches nothing — this is the screen you would get.</p>
      </div>
      {read && (
        <div className="mt-5 max-w-2xl">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">What the desk learns from {url || 'your spec'}</span>
            <SampleTag>Sample output</SampleTag>
          </div>
          <Card className="divide-y divide-line">
            {found.map(([k, v]) => (
              <div key={k} className="flex gap-4 px-5 py-3">
                <span className="w-32 shrink-0 text-[14px] font-semibold text-ink">{k}</span>
                <span className="text-[13.5px] text-ink">{v}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
      <div className="mt-5 max-w-2xl">
        <div className="mb-2 text-[13px] font-semibold text-ink">What this unlocks</div>
        <ul className="list-disc space-y-1.5 pl-5 text-[14px] text-ink">
          <li><span className="font-semibold">Knowledge answers</span> — documented fields, formats and enums, each quoted back to the line in your spec.</li>
          <li><span className="font-semibold">Authority answers</span> — a bounded grant draft with cap_usd, per_user, an idempotency key and a receipt. A draft until you approve it, and unproven until rung 4.</li>
          <li><span className="font-semibold">Code fixes stay off</span> — proving one needs your tests, and we only get those at rung 4.</li>
        </ul>
      </div>
    </RungShell>
  );
}

const CHANNELS = {
  slack: { to: '#api-support · ledgerly.slack.com', payload: { channel: '#api-support', text: 'New agent case ahd_01JBH4RK7Q · POST /v1/entries · 422 invalid_request · suggestion ready', case_url: 'https://help.ledgerly.example/app/tickets/ahd_01JBH4RK7Q' } },
  linear: { to: 'team API · label agent-desk', payload: { team: 'API', title: 'Agent case: POST /v1/entries rejects ISO-8601 dates', labels: ['agent-desk'], case_url: 'https://help.ledgerly.example/app/tickets/ahd_01JBH4RK7Q' } },
  email: { to: 'api-team@ledgerly.example', payload: { subject: 'AgentHelpDesk · 3 new cases today', digest: 'daily at 8:00 a.m. Pacific', case_url: 'https://help.ledgerly.example/app/tickets/ahd_01JBH4RK7Q' } },
  webhook: { to: 'POST https://ledgerly.example/hooks/agent-desk', payload: { event: 'case.opened', case_id: 'ahd_01JBH4RK7Q', endpoint: 'POST /v1/entries', failure_class: 'knowledge', mode: 'suggest_only', case_url: 'https://help.ledgerly.example/app/tickets/ahd_01JBH4RK7Q' } },
} as const;

function RungChannels({ onBack, onNext, onGithub }: Nav) {
  const [ch, setCh] = useState<'slack' | 'linear' | 'email' | 'webhook'>('slack');
  const picked = CHANNELS[ch];
  return (
    <RungShell
      n={3} onBack={onBack} onNext={onNext} onGithub={onGithub}
      title="Route cases to your channels"
      sub="New cases arrive where your team already works. You still review every answer in the console — this rung only moves the notification."
      nextLabel="Continue: connect GitHub"
    >
      <Segmented
        value={ch}
        onChange={setCh}
        options={[{ key: 'slack', label: 'Slack' }, { key: 'linear', label: 'Linear' }, { key: 'email', label: 'Email' }, { key: 'webhook', label: 'Webhook' }]}
      />
      <div className="mt-4 max-w-2xl space-y-3">
        <Code file={`goes to ${picked.to}`}>{JSON.stringify(picked.payload, null, 2)}</Code>
        <div className="flex flex-wrap items-center gap-3">
          <CopyButton label="Copy this payload" text={JSON.stringify(picked.payload, null, 2)} />
          <span className="text-[13px] text-muted">Test mode connects nothing and sends nothing.</span>
        </div>
      </div>
      <ul className="mt-5 max-w-2xl list-disc space-y-1.5 pl-5 text-[14px] text-ink">
        <li>Approvals stay in the console, so a Slack message can never ship a change by itself.</li>
        <li>Every notification carries the failure class and the mode, so your team knows a suggestion from a proven fix.</li>
        <li>Turning this off is one webhook delete; nothing in your API changes.</li>
      </ul>
    </RungShell>
  );
}

function Wizard({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [start] = useState(Date.now());
  const [t, setT] = useState(0);
  const [doneAt, setDoneAt] = useState<number | null>(null);
  useEffect(() => { const id = setInterval(() => setT(Date.now() - start), 250); return () => clearInterval(id); }, [start]);
  const elapsed = (doneAt ?? t) / 1000;
  const next = () => {
    const n = Math.min(step + 1, 5);
    setStep(n);
    setFurthest((f) => Math.max(f, n));
    if (n === 5) setDoneAt((d) => d ?? Date.now() - start);
  };
  const goto = (i: number) => setStep(Math.min(i, furthest));

  return (
    <div>
      <div className="flex h-11 items-center justify-between border-b border-line px-4 text-[13px] md:px-8">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-muted hover:text-ink">← All install paths</button>
        <div className="flex items-center gap-3">
          <span className="hidden text-muted sm:inline">Rung 4 · GitHub App · sign-in to live</span>
          <span className={cx('rounded-full px-2.5 py-0.5 font-mono text-[13px] font-medium tabular-nums', doneAt ? 'bg-success-tint text-success-text' : 'bg-blue-tint text-blue-text')}>
            {Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, '0')}
          </span>
          <span className="hidden text-muted sm:inline">target under 5:00</span>
        </div>
      </div>
      <div className="mx-auto grid max-w-[1120px] gap-8 px-4 py-10 md:grid-cols-[220px_minmax(0,1fr)] md:px-8">
        <ol className="flex gap-2 overflow-x-auto md:flex-col md:gap-1">
          {STEPS.map((s, i) => (
            <li key={s} className="shrink-0 md:shrink">
              <button
                type="button"
                onClick={() => goto(i)}
                disabled={i > furthest}
                aria-current={i === step ? 'step' : undefined}
                className={cx('flex w-full items-center gap-3 rounded-ctl px-2 py-2 text-left text-[14px] disabled:cursor-not-allowed', i === step ? 'bg-surface font-semibold text-ink' : i < step ? 'text-ink hover:bg-surface/60' : 'text-muted', i > furthest && 'opacity-60')}
              >
                <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold', i < step ? 'bg-success-text text-white' : i === step ? 'bg-ink text-white' : 'border border-line')}>{i < step ? '✓' : i + 1}</span>
                {s}
              </button>
            </li>
          ))}
        </ol>
        <div className="min-w-0" key={step}>
          {step > 0 && (
            <button type="button" onClick={() => goto(step - 1)} className="mb-4 inline-flex items-center gap-1.5 text-[13.5px] text-muted hover:text-ink">← Back</button>
          )}
          {step === 0 && <SignIn next={next} />}
          {step === 1 && <Consent next={next} />}
          {step === 2 && <Detect next={next} />}
          {step === 3 && <InstallPR next={next} />}
          {step === 4 && <TestTicket next={next} />}
          {step === 5 && <Live secs={elapsed} />}
        </div>
      </div>
    </div>
  );
}

function H({ title, sub }: { title: string; sub: string }) {
  return <div className="mb-6"><h1 className="text-title font-semibold">{title}</h1><p className="mt-1 max-w-2xl text-body text-muted">{sub}</p></div>;
}

function SignIn({ next }: { next: () => void }) {
  const [how, setHow] = useState<'app' | 'cli' | 'agent'>('app');
  return (
    <>
      <H title="Connect GitHub" sub="Rung 4 is the only path that proves a fix and opens a pull request. Three ways to open the same install PR — pick whichever your team prefers. Nothing in your running API changes until you merge it." />
      <Segmented value={how} onChange={setHow} options={[{ key: 'app', label: 'GitHub App' }, { key: 'cli', label: 'Command line' }, { key: 'agent', label: 'Let your coding agent do it' }]} />
      <div className="mt-5 max-w-xl">
        {how === 'app' && <Button variant="primary" size="lg" onClick={next}>Continue with GitHub</Button>}
        {how === 'cli' && <><Code file="terminal">npx agenthelpdesk init</Code><p className="mt-2 text-[13px] text-muted">Opens the same install PR from your terminal. Name is proposed.</p><Button className="mt-4" variant="primary" onClick={next}>I ran it</Button></>}
        {how === 'agent' && <><Code file="paste into your coding agent">{`Install AgentHelpDesk on this repo.\nRead https://agenthelpdesk.dev/llms.txt and follow the steps.\nOpen a pull request; do not merge it.`}</Code><p className="mt-2 text-[13px] text-muted">Docs are written for agents. Your agent follows the steps and opens the PR; you review it.</p><Button className="mt-4" variant="primary" onClick={next}>My agent opened the PR</Button></>}
      </div>
    </>
  );
}

function Consent({ next }: { next: () => void }) {
  const rows = [
    ['We read', 'Repository contents, the OpenAPI spec, docs and CI results.', 'blue'],
    ['We write', 'Pull requests and comments. Never direct commits.', 'blue'],
    ['We never', 'Merge, read secrets or environment variables, or touch production.', 'pink'],
    ['You can revoke', 'The GitHub App at any time, and the desk drops to suggest only.', 'gray'],
  ] as const;
  return (
    <>
      <H title="What the GitHub App can do" sub="Read this once. It is the whole permission story." />
      <Card className="max-w-2xl divide-y divide-line">
        {rows.map(([k, v, tone]) => (
          <div key={k} className="flex gap-4 px-5 py-4">
            <span className={cx('w-28 shrink-0 text-[14px] font-semibold', tone === 'pink' ? 'text-pink-text' : tone === 'blue' ? 'text-blue-text' : 'text-ink')}>{k}</span>
            <span className="text-[14px] text-ink">{v}</span>
          </div>
        ))}
      </Card>
      <div className="mt-5 flex items-center gap-3">
        <Button variant="primary" size="lg" onClick={next}>Install on ledgerly-demo/ledgerly-api</Button>
        <span className="flex items-center text-[13px] text-muted">Needs an org admin?
          <CopyButton
            label="Copy a message to send them"
            text={`Can you install the AgentHelpDesk GitHub App on ${config.provider.repo}? It reads repository contents, the OpenAPI spec, docs and CI results, and writes pull requests and comments only. No direct commits, no secrets or environment variables, no production access, and you can revoke it at any time — the desk just drops to suggest only.`}
          />
        </span>
      </div>
    </>
  );
}

function Detect({ next }: { next: () => void }) {
  const items = [
    ['OpenAPI spec', 'openapi/ledgerly.yaml · 8 endpoints, 2 marked sensitive', 'ok'],
    ['Tests', 'npm test · 403 tests · 18s', 'ok'],
    ['CI', 'GitHub Actions · ci.yml', 'ok'],
    ['Docs', 'docs/ · 14 pages, llms.txt missing (we add it)', 'warn'],
  ];
  const [shown, setShown] = useState(0);
  useEffect(() => { if (shown < items.length) { const id = setTimeout(() => setShown(shown + 1), 450); return () => clearTimeout(id); } }, [shown, items.length]);
  return (
    <>
      <H title="Reading your repo" sub="Read-only. We look for the spec, tests and CI so proofs can run." />
      <Card className="max-w-2xl divide-y divide-line">
        {items.map(([k, v, s], i) => (
          <div key={k} className="flex items-center gap-3 px-5 py-3.5">
            {i < shown ? <ProofIcon s={s === 'ok' ? 'passed' : 'skipped'} /> : <ProofIcon s={i === shown ? 'running' : 'pending'} />}
            <span className="w-28 text-[14px] font-semibold">{k}</span>
            <span className={cx('text-[13.5px]', i < shown ? 'text-ink' : 'text-muted')}>{i < shown ? v : 'Looking…'}</span>
          </div>
        ))}
      </Card>
      <details className="mt-4 max-w-2xl text-[13.5px] text-muted">
        <summary className="cursor-pointer text-ink">What if something is missing?</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>No spec: we ask for a spec file or a docs URL and show a sample of what we found.</li>
          <li>No tests: the desk starts with docs and error text only; code fixes stay off until tests exist.</li>
          <li>No CI: proofs run only in our sandbox, shown as a gap with a fix link.</li>
        </ul>
      </details>
      <Button className="mt-6" variant="primary" size="lg" disabled={shown < items.length} onClick={next}>Open the install PR</Button>
    </>
  );
}

function InstallPR({ next }: { next: () => void }) {
  const [file, setFile] = useState(0);
  const files = [
    { name: 'agenthelpdesk.json', why: 'One place to review and edit every setting', body: <JsonView file="agenthelpdesk.json" data={config} maxHeight={300} /> },
    { name: 'src/errors/help.ts', why: 'A failing agent learns where to go at the moment it fails', body: <Diff file="src/errors/help.ts" lines={['+export const withHelp = (err, requestId) => ({', '+  error: err,', '+  help: {', '+    desk: "https://help.ledgerly.example/agents",', '+    tool: "report_problem",', '+    request_id: requestId,', '+    hint: "If this keeps failing, call report_problem with this request_id."', '+  },', '+});']} /> },
    { name: 'llms.txt', why: 'Agents read this first', body: <Diff file="llms.txt" lines={['+# Ledgerly', '+> Agents: if a call fails, call report_problem (MCP) or POST /agents/cases.', '+> Help for agents: https://help.ledgerly.example/agents']} /> },
    { name: '.github/workflows/agenthelpdesk.yml', why: 'A later change cannot silently undo a fix', body: <Diff file=".github/workflows/agenthelpdesk.yml" lines={['+name: agenthelpdesk-regressions', '+on: [pull_request]', '+jobs:', '+  regressions:', '+    runs-on: ubuntu-latest', '+    steps:', '+      - uses: actions/checkout@v4', '+      - run: npx agenthelpdesk test --regressions']} /> },
  ];
  return (
    <>
      <H title="Review pull request #41" sub="This merge is the only change to your code. Everything before it only reads; everything after it is a ticket." />
      <Card className="mb-4 flex flex-wrap items-center gap-3 px-5 py-3 text-[14px]">
        <Chip tone="green" dot>Open</Chip>
        <span className="font-semibold">Add AgentHelpDesk</span>
        <span className="text-muted">ledgerly-demo/ledgerly-api · 4 files · CI passing</span>
      </Card>
      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li key={f.name}><button onClick={() => setFile(i)} className={cx('w-full rounded-ctl px-3 py-2 text-left', i === file ? 'bg-surface' : 'hover:bg-surface/60')}><div className="truncate font-mono text-[12.5px] text-ink">{f.name}</div><div className="text-[12px] text-muted">{f.why}</div></button></li>
          ))}
        </ul>
        <div className="min-w-0">{files[file].body}</div>
      </div>
      <div className="mt-6 flex items-center gap-3">
        <Button variant="primary" size="lg" onClick={next}>I merged it</Button>
        <span className="text-[13px] text-muted">Closed it instead? Nothing changes; the desk stays in suggest only.</span>
      </div>
    </>
  );
}

function TestTicket({ next }: { next: () => void }) {
  const names = ['Replay passes', 'Provider tests pass', 'Fresh agent succeeds'];
  const [st, setSt] = useState<ProofStatus[]>(['running', 'pending', 'pending']);
  useEffect(() => {
    const i = st.findIndex((s) => s === 'running');
    if (i === -1) return;
    const id = setTimeout(() => setSt(st.map((s, k) => (k === i ? 'passed' : k === i + 1 ? 'running' : s))), 1100);
    return () => clearTimeout(id);
  }, [st]);
  const done = st.every((s) => s === 'passed');
  return (
    <>
      <H title="Your first test ticket" sub="We send a known-bad call to your test API, the desk opens a case, and runs all three proofs. Nothing touches production." />
      <JsonView file="test call → POST /v1/entries" data={{ request: { date: '2026-10-17T14:02:00Z' }, response: { status: 422, error: { code: 'invalid_request' }, help: { tool: 'report_problem', request_id: 'req_test_0001' } } }} maxHeight={200} className="mb-4 max-w-2xl" />
      <Card className="max-w-2xl divide-y divide-line">
        {names.map((n, i) => <div key={n} className="flex items-center gap-3 px-5 py-3.5"><ProofIcon s={st[i]} /><span className="text-[14px]">{n}</span></div>)}
      </Card>
      <Button className="mt-6" variant="primary" size="lg" disabled={!done} onClick={next}>{done ? 'Go live' : 'Proving…'}</Button>
    </>
  );
}

function Live({ secs }: { secs: number }) {
  return (
    <>
      <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-success-text text-[22px] text-white">✓</div>
      <H title="Your desk is live" sub={`Sign-in to first passing test ticket in ${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s. Agents that fail on Ledgerly now get a help field, a case and a committed deadline.`} />
      <div className="flex gap-3">
        <Link to="/app"><Button variant="primary" size="lg">Open the console</Button></Link>
        <Link to="/agents"><Button size="lg">See what agents see</Button></Link>
      </div>
    </>
  );
}
