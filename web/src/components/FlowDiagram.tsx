// The landing page's "how it fits together" figure: one SVG, drawn from data so the
// coordinates stay in one place. Claude (the resolver, and the fresh-agent proof) is blue.

type Kind = 'box' | 'hero' | 'dash';
interface Box { x: number; y: number; w: number; h: number; title: string; lines: string[]; tag?: string; kind?: Kind }
interface Arrow { d: string; label?: string; lx?: number; ly?: number; kind?: 'plain' | 'blue' | 'dash' }

const BOXES: Box[] = [
  { x: 20, y: 30, w: 170, h: 80, title: 'Agent fails', lines: ['calls a vendor API and gets', 'an error it cannot fix'] },
  { x: 20, y: 150, w: 170, h: 80, title: 'Armature feed', lines: ['open issues from its MCP', 'server become cases'], tag: 'Armature' },
  { x: 320, y: 60, w: 170, h: 110, title: 'Desk intake', lines: ['opens a case and commits', 'ack_by and resolve_by'], tag: 'hosted on Blaxel' },
  { x: 600, y: 60, w: 170, h: 110, title: 'Fix memory', lines: ['same failure seen before?', 'reuse the proven fix'], tag: 'keyed by failure signature' },
  { x: 870, y: 60, w: 170, h: 110, title: 'Case sandbox', lines: ['ahd-<caseId> replays', 'the failing call'], tag: 'Blaxel' },
  { x: 1120, y: 60, w: 170, h: 110, title: 'Claude resolver', lines: ["reads the vendor's files,", 'drafts the fix'], tag: 'Anthropic', kind: 'hero' },
  { x: 884, y: 322, w: 118, h: 76, title: 'Replay', lines: ['original call', 'now passes'] },
  { x: 1016, y: 322, w: 118, h: 76, title: 'Vendor tests', lines: ["vendor's own", 'tests pass'] },
  { x: 1148, y: 322, w: 130, h: 76, title: 'Fresh agent', lines: ['clean-context', 'Claude, fixed docs'], kind: 'hero' },
  { x: 600, y: 300, w: 170, h: 100, title: 'Gate', lines: ['all three green?', 'no human approval'] },
  { x: 320, y: 300, w: 170, h: 100, title: 'Ship', lines: ['answer, docs fix, PR or', 'bounded grant'] },
  { x: 20, y: 300, w: 170, h: 100, title: 'Agent retries', lines: ['with the fix, then reports', 'the result'] },
  { x: 600, y: 430, w: 170, h: 60, title: 'Escalate', lines: ['a person gets an email'], kind: 'dash' },
  { x: 320, y: 540, w: 170, h: 100, title: 'Desk records retry', lines: ['report_retry_result', 'closes the case'], tag: 'Manufact MCP' },
  { x: 600, y: 540, w: 170, h: 100, title: 'Stripe meter event', lines: ['test mode, billed only', 'if all proofs passed and', 'the retry worked'], tag: 'Stripe' },
  { x: 870, y: 540, w: 170, h: 100, title: 'Email sent', lines: ['case fixed and verified,', 'to vendor and agent'], tag: 'Inkbox' },
  { x: 1120, y: 540, w: 170, h: 100, title: 'Fix memory updated', lines: ['the next agent with this', 'failure skips Claude'] },
];

const ARROWS: Arrow[] = [
  { d: 'M190 70 H320', label: 'MCP (Manufact)', lx: 196, ly: 64 },
  { d: 'M190 100 H320', label: 'email, A2A (Inkbox)', lx: 196, ly: 94 },
  { d: 'M190 160 H320', label: 'list_issues', lx: 220, ly: 154 },
  { d: 'M490 115 H600', label: 'check', lx: 522, ly: 108 },
  { d: 'M770 115 H870', label: 'miss', lx: 804, ly: 108 },
  { d: 'M1040 115 H1120', label: 'evidence', lx: 1048, ly: 108, kind: 'blue' },
  { d: 'M1205 170 V290', label: 'draft fix', lx: 1214, ly: 236, kind: 'blue' },
  { d: 'M685 170 V240 H990 V290', label: 'hit: reuse it, no model call', lx: 702, ly: 232 },
  { d: 'M870 350 H770', label: 'results', lx: 798, ly: 343 },
  { d: 'M600 350 H490', label: 'all green', lx: 506, ly: 343 },
  { d: 'M320 350 H190', label: 'answer', lx: 236, ly: 343 },
  { d: 'M685 400 V430', label: 'any red', lx: 694, ly: 420, kind: 'dash' },
  { d: 'M105 400 V590 H320', label: 'report_retry_result', lx: 116, ly: 583 },
  { d: 'M490 590 H600', label: 'billable?', lx: 512, ly: 583 },
  { d: 'M770 590 H870', label: 'notify', lx: 802, ly: 583 },
  { d: 'M1040 590 H1120', label: 'remember', lx: 1046, ly: 583 },
];

const boxClass: Record<Kind, string> = {
  box: 'fill-white stroke-line',
  hero: 'fill-blue-tint stroke-blue',
  dash: 'fill-white stroke-muted',
};

export function FlowDiagram() {
  return (
    <svg
      viewBox="0 0 1320 690"
      role="img"
      aria-label="An agent or an Armature issue opens a case. The desk checks fix memory, a Blaxel sandbox replays the failure, Claude drafts a fix, three proofs and a gate decide, the fix ships, the agent retries, and Stripe bills only on success."
      className="h-auto w-full min-w-[980px]"
    >
      <defs>
        <marker id="flow-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="fill-muted" /></marker>
        <marker id="flow-ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="fill-blue" /></marker>
      </defs>

      {[[18, '01  A case opens, the desk looks for a fix'], [278, '02  The fix has to earn its way out'], [528, '03  The vendor pays only if it worked']].map(([y, t]) => (
        <text key={String(y)} x={y === 528 ? 124 : 20} y={y as number} className="fill-pink font-mono text-[11px]">{t}</text>
      ))}

      <rect x={870} y={290} width={420} height={120} rx={10} className="fill-none stroke-line" strokeDasharray="3 4" strokeWidth={1.5} />
      <text x={884} y={309} className="fill-muted text-[11.5px]">Three proofs, each in a clean sandbox copy</text>

      {BOXES.map((b) => (
        <g key={`${b.x}-${b.y}`}>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={8} strokeWidth={b.kind === 'hero' ? 2 : 1.5} strokeDasharray={b.kind === 'dash' ? '5 4' : undefined} className={boxClass[b.kind ?? 'box']} />
          <text x={b.x + 14} y={b.y + 24} className="fill-ink text-[13.5px] font-semibold">{b.title}</text>
          {b.lines.map((l, i) => (
            <text key={l} x={b.x + 14} y={b.y + 42 + i * 14} className="fill-muted text-[11.5px]">{l}</text>
          ))}
          {b.tag && <text x={b.x + 14} y={b.y + b.h - 12} className="fill-blue-text font-mono text-[10px] font-medium">{b.tag}</text>}
        </g>
      ))}

      {ARROWS.map((a) => (
        <g key={a.d}>
          <path
            d={a.d}
            fill="none"
            strokeWidth={a.kind === 'blue' ? 2 : 1.5}
            strokeDasharray={a.kind === 'dash' ? '5 4' : undefined}
            markerEnd={a.kind === 'blue' ? 'url(#flow-ar2)' : 'url(#flow-ar)'}
            className={a.kind === 'blue' ? 'stroke-blue' : 'stroke-muted'}
          />
          {a.label && <text x={a.lx} y={a.ly} className="fill-muted font-mono text-[10.5px]">{a.label}</text>}
        </g>
      ))}
    </svg>
  );
}

export const SPONSORS: { name: string; role: string; what: string; tools: string[]; lead?: boolean }[] = [
  { name: 'Claude', role: 'Anthropic, the resolver', lead: true, what: "Reads the vendor's real files and drafts the docs or code fix. A second, clean-context call is the fresh-agent proof: it sees only the task and the fixed docs and has to succeed alone.", tools: ['Messages API', 'resolver draft', 'fresh-agent proof'] },
  { name: 'Blaxel', role: 'Where everything runs', what: 'Hosts the desk and gives every case its own sandbox, so replays and proofs never touch each other. Keeps state across restarts.', tools: ['@blaxel/core', 'sandbox per case', 'volume ahd-data', 'per-minute schedule', 'standby and wake'] },
  { name: 'Stripe', role: 'Billing on success only', what: "One meter event per verified fix, sent only when all three proofs passed and the agent's retry worked. Test mode, nothing is charged.", tools: ['billing meter events', 'test customer'] },
  { name: 'Inkbox', role: 'Reaches agents and people', what: 'Takes failures that arrive by email or agent-to-agent, sends the "fixed and verified" email, and asks a person when a case is escalated.', tools: ['email send and reply', 'A2A tasks', 'agent identity'] },
  { name: 'Manufact', role: 'The door agents call', what: 'The MCP server any agent connects to. It forwards each call to the desk and keeps no case state of its own.', tools: ['mcp-use', 'report_problem', 'report_retry_result'] },
  { name: 'Armature', role: 'Feeds the desk, tests it', what: 'Its MCP server lists where agents struggle; each open issue becomes a case. Its eval also runs our two tools end to end.', tools: ['list_issues', 'get_session', 'eval run'] },
];
