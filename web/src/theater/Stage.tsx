import type { Step, StepKey, StepState } from './steps';

/**
 * The sandbox, drawn as the thing it is: a sealed box with the case inside.
 * One scene per step. Scenes are keyed by step, so changing focus restarts the
 * animation. Everything here is decoration of values the desk recorded; the
 * words on it (names, status codes, counts) come in as props.
 */
export interface StageProps {
  focus: StepKey;
  steps: Step[];
  sandbox: string;
  vendor: string;
  file: string;
  removed: string;
  added: string;
  code: { before: string; after: string };
  testsCount: number | null;
  price: string | null;
  boxState: StepState;
}

const C = {
  ink: '#0B1020',
  panel: '#121A33',
  line: '#26335C',
  text: '#E8ECF6',
  muted: '#8C97B2',
  blue: '#6C8CFF',
  pink: '#FF2D87',
  green: '#34D399',
  red: '#F87171',
  amber: '#FBBF24',
};

const ring: Record<StepState, string> = { pending: C.line, active: C.blue, done: C.green, failed: C.red, skipped: C.line };

function Packet({ x1, x2, y, color, label, back, delay = 0 }: { x1: number; x2: number; y: number; color: string; label?: string; back?: string; delay?: number }) {
  const dx = x2 - x1;
  return (
    <g style={{ animation: `ahd-out 2.4s ${delay}s cubic-bezier(.6,0,.3,1) infinite`, ['--dx' as string]: `${dx}px` }}>
      <rect x={x1 - 9} y={y - 9} width="18" height="18" rx="5" fill={color} />
      {label && (
        <text x={x1} y={y - 16} textAnchor="middle" fontSize="11" fill={C.muted} className="font-mono">
          {label}
        </text>
      )}
      {back && (
        <text x={x1} y={y + 28} textAnchor="middle" fontSize="12" fontWeight="600" fill={color} className="font-mono" style={{ animation: 'ahd-badge 2.4s infinite' }}>
          {back}
        </text>
      )}
    </g>
  );
}

function Bracket({ x, y, r }: { x: number; y: number; r: number }) {
  return <path d="M0 18V4a4 4 0 014-4h14" transform={`translate(${x} ${y}) rotate(${r})`} fill="none" stroke={C.blue} strokeWidth="3" strokeLinecap="round" style={{ animation: 'ahd-pop .7s both' }} />;
}

function Doc({ x, y, w = 250, children, tone = C.line }: { x: number; y: number; w?: number; children?: React.ReactNode; tone?: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height="104" rx="10" fill={C.ink} stroke={tone} strokeWidth="1.5" />
      <circle cx="14" cy="14" r="3" fill={C.line} />
      <circle cx="26" cy="14" r="3" fill={C.line} />
      <circle cx="38" cy="14" r="3" fill={C.line} />
      {children}
    </g>
  );
}

function Scene({ p }: { p: StageProps }) {
  const cx = 400;
  switch (p.focus) {
    case 'create':
      return (
        <g>
          <Bracket x={246} y={96} r={0} />
          <Bracket x={554} y={96} r={90} />
          <Bracket x={554} y={344} r={180} />
          <Bracket x={246} y={344} r={270} />
          <text x={cx} y={226} textAnchor="middle" fontSize="15" fill={C.text} className="font-mono" style={{ animation: 'ahd-type 1.6s steps(24) both', clipPath: 'inset(0 0 0 0)' }}>
            {p.sandbox}
          </text>
          <text x={cx} y={250} textAnchor="middle" fontSize="12" fill={C.muted}>
            {p.vendor} repo copied in
          </text>
        </g>
      );
    case 'reproduce':
      return (
        <g>
          <Packet x1={120} x2={330} y={232} color={C.red} label="the agent’s call" back="401" />
          <text x={cx + 40} y={226} fontSize="12" fill={C.muted} className="font-mono">
            {p.code.before}
          </text>
        </g>
      );
    case 'draft':
      return (
        <g>
          <Doc x={cx - 125} y={150} tone={C.blue}>
            <text x="14" y="38" fontSize="11" fill={C.muted} className="font-mono">
              {p.file}
            </text>
            <g style={{ animation: 'ahd-fadein .5s .3s both' }}>
              <rect x="10" y="48" width="230" height="20" rx="4" fill="rgba(248,113,113,.14)" />
              <text x="18" y="62" fontSize="11" fill={C.red} className="font-mono">
                - {p.removed}
              </text>
              <line x1="18" y1="58" x2="226" y2="58" stroke={C.red} strokeWidth="1.2" style={{ animation: 'ahd-strike .5s .9s both' }} />
            </g>
            <g style={{ animation: 'ahd-fadein .5s 1.3s both' }}>
              <rect x="10" y="72" width="230" height="20" rx="4" fill="rgba(52,211,153,.16)" />
              <text x="18" y="86" fontSize="11" fill={C.green} className="font-mono">
                + {p.added}
              </text>
            </g>
          </Doc>
          <path d="M376 128l6 12 12 6-12 6-6 12-6-12-12-6 12-6z" fill={C.pink} style={{ animation: 'ahd-spin 3s linear infinite', transformOrigin: '376px 146px' }} />
          <text x="404" y="150" fontSize="12" fill={C.muted}>
            Claude is writing
          </text>
        </g>
      );
    case 'replay':
      return (
        <g>
          <Packet x1={120} x2={330} y={232} color={C.green} label="same call, fixed docs" back="200" />
        </g>
      );
    case 'tests': {
      const n = Math.max(6, Math.min(p.testsCount ?? 8, 14));
      return (
        <g>
          {Array.from({ length: n }, (_, i) => (
            <g key={i} style={{ animation: `ahd-tick .35s ${0.25 + i * 0.16}s both` }}>
              <rect x={cx - (n * 26) / 2 + i * 26} y={212} width="20" height="20" rx="5" fill={C.green} />
              <path d={`M${cx - (n * 26) / 2 + i * 26 + 5} 222l4 4 7-8`} stroke={C.ink} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          ))}
          <text x={cx} y={262} textAnchor="middle" fontSize="12" fill={C.muted} className="font-mono">
            node --test test/*.test.mjs
          </text>
        </g>
      );
    }
    case 'fresh':
      return (
        <g>
          <g style={{ animation: 'ahd-split 1.2s .2s both cubic-bezier(.3,.8,.3,1)' }}>
            <rect x={cx - 90} y="196" width="180" height="100" rx="14" fill={C.panel} stroke={C.pink} strokeWidth="2" strokeDasharray="5 5" />
            <text x={cx} y="228" textAnchor="middle" fontSize="12" fill={C.muted} className="font-mono">
              {p.sandbox}-fresh
            </text>
            <circle cx={cx - 30} cy="262" r="9" fill="none" stroke={C.pink} strokeWidth="2" />
            <path d={`M${cx - 30} 271v12M${cx - 40} 276h20`} stroke={C.pink} strokeWidth="2" strokeLinecap="round" />
            <text x={cx - 8} y="266" fontSize="12" fill={C.text}>
              task + fixed docs only
            </text>
          </g>
        </g>
      );
    case 'approval':
      return (
        <g>
          <rect x="548" y="150" width="14" height="164" rx="7" fill={C.amber} style={{ animation: 'ahd-latch 2.2s infinite' }} />
          <circle cx="640" cy="232" r="30" fill="none" stroke={C.amber} strokeWidth="2" style={{ animation: 'ahd-ping 2s infinite', transformOrigin: '640px 232px' }} />
          <circle cx="640" cy="224" r="9" fill={C.amber} />
          <path d="M622 252a18 18 0 0136 0" fill={C.amber} />
          <text x="640" y="296" textAnchor="middle" fontSize="12" fill={C.muted}>
            waiting for one reply
          </text>
        </g>
      );
    case 'ship':
      return (
        <g>
          <g style={{ animation: 'ahd-ship 2.2s infinite cubic-bezier(.6,0,.3,1)' }}>
            <rect x={cx - 60} y="212" width="120" height="40" rx="9" fill={C.blue} />
            <text x={cx} y="237" textAnchor="middle" fontSize="12" fontWeight="600" fill="#fff" className="font-mono">
              PR + test
            </text>
          </g>
        </g>
      );
    case 'retry':
      return <Packet x1={120} x2={330} y={232} color={C.green} label="the agent retries" back="200" />;
    case 'bill':
      return (
        <g>
          <circle cx={cx} cy="232" r="46" fill="none" stroke={C.line} strokeWidth="6" />
          <circle cx={cx} cy="232" r="46" fill="none" stroke={C.green} strokeWidth="6" strokeLinecap="round" strokeDasharray="289" style={{ animation: 'ahd-dial 1.4s .2s both ease-out', transform: 'rotate(-90deg)', transformOrigin: `${cx}px 232px` }} />
          <text x={cx} y="238" textAnchor="middle" fontSize="18" fontWeight="600" fill={C.text} className="font-mono">
            {p.price ?? '1 event'}
          </text>
        </g>
      );
  }
}

export function Stage(p: StageProps) {
  return (
    <svg viewBox="0 0 800 440" role="img" aria-label={`Sandbox ${p.sandbox}, showing the step: ${p.focus}`} className="h-full w-full">
      <style>{`
        @keyframes ahd-out{0%{transform:translateX(0);opacity:0}12%{opacity:1}55%{transform:translateX(var(--dx))}70%{transform:translateX(var(--dx))}100%{transform:translateX(0);opacity:1}}
        @keyframes ahd-badge{0%,55%{opacity:0}70%,100%{opacity:1}}
        @keyframes ahd-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
        @keyframes ahd-fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        @keyframes ahd-strike{from{stroke-dasharray:0 208}to{stroke-dasharray:208 0}}
        @keyframes ahd-spin{to{transform:rotate(360deg)}}
        @keyframes ahd-tick{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:none}}
        @keyframes ahd-type{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
        @keyframes ahd-split{from{transform:translateY(-70px);opacity:0}to{transform:none;opacity:1}}
        @keyframes ahd-latch{0%,100%{transform:translateY(0)}50%{transform:translateY(-22px)}}
        @keyframes ahd-ping{from{transform:scale(.8);opacity:.9}to{transform:scale(1.6);opacity:0}}
        @keyframes ahd-ship{0%,15%{transform:translateX(0);opacity:0}30%{opacity:1}75%,100%{transform:translateX(330px);opacity:0}}
        @keyframes ahd-dial{from{stroke-dashoffset:289}to{stroke-dashoffset:0}}
        @keyframes ahd-breathe{0%,100%{opacity:.55}50%{opacity:1}}
        @media (prefers-reduced-motion:reduce){svg *{animation-duration:.01ms!important;animation-iteration-count:1!important}}
      `}</style>
      <defs>
        <pattern id="ahd-grid" width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" fill="none" stroke={C.line} strokeWidth=".6" opacity=".5" />
        </pattern>
      </defs>
      <rect width="800" height="440" fill={C.ink} />
      <rect width="800" height="440" fill="url(#ahd-grid)" />

      {/* the agent, outside the wall */}
      <g>
        <circle cx="70" cy="232" r="26" fill={C.panel} stroke={C.line} strokeWidth="1.5" />
        <path d="M58 226h24M58 238h16" stroke={C.muted} strokeWidth="2.4" strokeLinecap="round" />
        <text x="70" y="278" textAnchor="middle" fontSize="12" fill={C.muted}>
          agent
        </text>
      </g>

      {/* the sandbox */}
      <g>
        <rect x="240" y="90" width="320" height="260" rx="18" fill={C.panel} fillOpacity=".72" stroke={ring[p.boxState]} strokeWidth="2.5" style={p.boxState === 'active' ? { animation: 'ahd-breathe 1.8s infinite' } : undefined} />
        <text x="256" y="76" fontSize="12" fill={C.muted} className="font-mono">
          {p.sandbox}
        </text>
        <text x="544" y="76" textAnchor="end" fontSize="12" fill={ring[p.boxState] === C.line ? C.muted : ring[p.boxState]}>
          Blaxel sandbox
        </text>
      </g>

      {/* what the box has proved so far, always visible */}
      <g>
        {(['replay', 'tests', 'fresh'] as StepKey[]).map((k, i) => {
          const st = p.steps.find((x) => x.key === k)?.state ?? 'pending';
          const col = st === 'done' ? C.green : st === 'failed' ? C.red : st === 'active' ? C.blue : C.line;
          const label = k === 'replay' ? 'replay' : k === 'tests' ? 'vendor tests' : 'fresh agent';
          const w = k === 'tests' ? 96 : 86;
          const x = 256 + (i === 0 ? 0 : i === 1 ? 96 : 202);
          return (
            <g key={k} transform={`translate(${x} 314)`}>
              <rect width={w} height="24" rx="12" fill="none" stroke={col} strokeWidth="1.5" />
              {st === 'done' && <circle cx="13" cy="12" r="4" fill={col} />}
              <text x={st === 'done' ? 22 : 12} y="16" fontSize="11" fill={st === 'pending' ? C.muted : C.text}>
                {label}
              </text>
            </g>
          );
        })}
      </g>

      <g key={p.focus}>
        <Scene p={p} />
      </g>
    </svg>
  );
}
