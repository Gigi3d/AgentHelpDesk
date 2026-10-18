import { Link } from 'react-router-dom';
import { Code, JsonView } from '../components/Json';
import { Logo } from '../components/Shell';
import { Button, Card } from '../components/ui';
import { HERO_ID, useStore } from '../lib/store';

export default function Landing() {
  const { tickets, live } = useStore();
  // The recorded hero case is a fixture id. Live, the desk holds different cases, so this points
  // at one it actually has — the one waiting on a human first — and at the list until the first
  // poll lands, because a case id that does not exist opens a not-found page.
  const heroCase = live.on ? tickets.find((t) => t.stage === 'awaiting_approval')?.id ?? tickets[0]?.id : HERO_ID;
  const heroTo = heroCase ? `/app/tickets/${heroCase}` : '/app/tickets';
  return (
    <div className="min-h-screen bg-white text-ink">
      <header className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-4 md:px-6">
        <Logo />
        <nav className="flex items-center gap-1 text-[14px] md:gap-4">
          <Link to="/agents" className="hidden px-2 text-muted hover:text-ink sm:inline">For agents</Link>
          <Link to="/app" className="px-2 text-muted hover:text-ink">Console</Link>
          <Link to="/install"><Button variant="primary" size="sm">Install in 5 minutes</Button></Link>
        </nav>
      </header>

      <section className="mx-auto grid max-w-[1120px] items-center gap-10 px-4 pb-16 pt-10 md:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-16">
        <div>
          <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-blue-tint px-3 py-1 text-[12.5px] font-medium text-blue-text"><span className="h-1.5 w-1.5 rounded-full bg-blue" />A support desk for agents</p>
          <h1 className="text-[40px] font-semibold leading-[1.08] tracking-tight md:text-[52px]">When an agent can’t use your API, it gets an answer. <span className="text-pink">Proven first.</span></h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted">The desk reproduces the failure in a sandbox, proves a fix three ways, and gives the agent something it can run. Proven fixes ship on their own.</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to="/install"><Button variant="primary" size="lg">Start without GitHub</Button></Link>
            <Link to={heroTo}><Button size="lg">See a live ticket</Button></Link>
          </div>
          <p className="mt-4 text-[13px] text-muted">You pay only for a fix the agent then uses successfully. Four of five install paths need no GitHub.</p>
        </div>
        <JsonView
          file="what the failing agent gets back"
          data={{ case_id: 'ahd_01JBH4RK7Q', ack_by: '03:17Z', resolve_by: '04:12Z', queue_position: 1, tested: { replay: true, vendor_tests: true, fresh_agent: true }, authority: { verbs: ['entitlements.reissue'], cap_usd: 30, per_user: 1 }, outcome: { action: 'reissued', amount: 3000, expires_at: '07:36Z' } }}
          maxHeight="none"
          className="shadow-pop"
        />
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1120px] px-4 py-14 md:px-6">
          <p className="text-label font-medium uppercase text-muted">Oct 16, 2026 · 7:33 p.m. · San Francisco</p>
          <blockquote className="mt-3 max-w-3xl text-[24px] font-medium leading-snug md:text-[28px]">“The snag is on our end applying it at checkout, so support@hark.com is the fastest fix.”</blockquote>
          <p className="mt-3 max-w-2xl text-[15px] text-muted">A vendor’s own agent, on launch night. It knew the problem and had no one to call but an inbox. That is an <span className="font-semibold text-ink">authority</span> failure: only the vendor can grant the fix.</p>
        </div>
      </section>

      <section className="mx-auto max-w-[1120px] px-4 py-16 md:px-6">
        <h2 className="text-[26px] font-semibold tracking-tight">Three kinds of failure, one desk</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {[
            ['Knowledge', 'The docs are wrong or missing. The desk corrects them and the agent retries.', 'Ships alone once proven'],
            ['Code', 'The fix is in your repo. The desk opens a proven PR with a regression test.', 'You merge the PR'],
            ['Authority', 'Only you can grant it. The desk offers a capped, receipted grant.', 'No agent can do this alone'],
          ].map(([k, v, s], i) => (
            <Card key={k} className={i === 2 ? 'border-ink p-6' : 'p-6'}>
              <div className="text-[15px] font-semibold">{k}</div>
              <p className="mt-2 text-[14.5px] text-ink/85">{v}</p>
              <p className="mt-4 text-[13px] text-muted">{s}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[1120px] px-4 pb-16 md:px-6">
        <h2 className="text-[26px] font-semibold tracking-tight">How a ticket moves</h2>
        <ol className="mt-6 grid gap-3 md:grid-cols-5">
          {[['Case', 'Committed ack and resolve times.'], ['Reproduce', 'The exact call, in a Blaxel sandbox.'], ['Fix', 'Docs, errors, config, code or a grant.'], ['Prove', 'Replay, your tests, a fresh agent.'], ['Ship', 'The agent retries. Billed on success.']].map(([k, v], i) => (
            <li key={k} className="rounded-card border border-line p-4"><div className="font-mono text-[12px] text-pink">0{i + 1}</div><div className="mt-1 text-[15px] font-semibold">{k}</div><p className="mt-1 text-[13.5px] text-muted">{v}</p></li>
          ))}
        </ol>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto grid max-w-[1120px] items-center gap-8 px-4 py-14 md:grid-cols-2 md:px-6">
          <div>
            <h2 className="text-[26px] font-semibold tracking-tight">Five ways in, least access first</h2>
            <p className="mt-2 text-[15px] text-muted">Start with a forwarded failing call or your OpenAPI spec: no repo access, answers are suggestions. Connect a repo to prove and ship fixes. We open pull requests, never merge, and never touch secrets or production.</p>
            <Link to="/install" className="mt-5 inline-block"><Button variant="primary" size="lg">See the install paths</Button></Link>
          </div>
          <Code file="terminal">npx agenthelpdesk init</Code>
        </div>
      </section>
      <footer className="border-t border-line py-8 text-center text-[12.5px] text-muted">AgentHelpDesk · built at YC “Make Something Agents Want”, Oct 17–18 2026 · Ledgerly is a demo vendor</footer>
    </div>
  );
}
