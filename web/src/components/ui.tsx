import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { FailureClass, Mode, ProofStatus, Stage, Ticket } from '../lib/types';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------- Button ---------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
const variants: Record<Variant, string> = {
  primary: 'bg-pink text-white hover:bg-pink-hover shadow-[0_1px_0_rgba(0,0,0,.06)]',
  secondary: 'bg-white text-ink border border-line hover:bg-surface',
  ghost: 'text-muted hover:text-ink hover:bg-surface',
  danger: 'bg-white text-error-text border border-line hover:bg-error-tint',
  link: 'text-blue hover:underline px-0 h-auto',
};

export function Button({ variant = 'secondary', size = 'md', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-ctl font-medium transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
        variant !== 'link' && (size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'lg' ? 'h-11 px-5 text-[15px]' : 'h-9 px-4 text-[14px]'),
        variants[variant],
        className,
      )}
    />
  );
}

/* ---------- Chips ---------- */

type Tone = 'blue' | 'pink' | 'green' | 'red' | 'gray' | 'amber';
const tones: Record<Tone, string> = {
  blue: 'bg-blue-tint text-blue-text',
  pink: 'bg-pink-tint text-pink-text',
  green: 'bg-success-tint text-success-text',
  red: 'bg-error-tint text-error-text',
  gray: 'bg-surface text-muted border border-line',
  amber: 'bg-warning-tint text-warning',
};

export function Chip({ tone = 'gray', children, dot, pulse, className }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium leading-5 whitespace-nowrap', tones[tone], className)}>
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full bg-current', pulse && 'animate-pulse')} />}
      {children}
    </span>
  );
}

export const STAGES: { key: Stage; label: string }[] = [
  { key: 'opened', label: 'Opened' },
  { key: 'reproducing', label: 'Reproducing' },
  { key: 'fix_drafted', label: 'Fix drafted' },
  { key: 'proving', label: 'Proving' },
  { key: 'awaiting_approval', label: 'Awaiting approval' },
  { key: 'answered', label: 'Answered' },
  { key: 'shipped', label: 'Shipped' },
];

const stageMeta: Record<Stage, { label: string; tone: Tone }> = {
  opened: { label: 'Opened', tone: 'blue' },
  reproducing: { label: 'Reproducing', tone: 'blue' },
  fix_drafted: { label: 'Fix drafted', tone: 'blue' },
  proving: { label: 'Proving', tone: 'blue' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'pink' },
  answered: { label: 'Answered', tone: 'green' },
  shipped: { label: 'Shipped', tone: 'green' },
  failed_proof: { label: 'Proof failed', tone: 'red' },
  rejected: { label: 'Rejected', tone: 'red' },
  closed: { label: 'Closed', tone: 'gray' },
  escalated: { label: 'Escalated', tone: 'red' },
};

export const isWorking = (s: Stage) => ['opened', 'reproducing', 'fix_drafted', 'proving'].includes(s);

export function StageChip({ stage }: { stage: Stage }) {
  const m = stageMeta[stage];
  return <Chip tone={m.tone} dot pulse={isWorking(stage)}>{m.label}</Chip>;
}
export const stageLabel = (s: Stage) => stageMeta[s].label;

const classMeta: Record<FailureClass, { label: string; hint: string }> = {
  knowledge: { label: 'Knowledge', hint: 'The answer is public; the docs were wrong or missing.' },
  code: { label: 'Code', hint: 'The fix lives in the provider’s repo.' },
  authority: { label: 'Authority', hint: 'Only the provider can grant it. No agent can fix this alone.' },
};
export function ClassChip({ c }: { c: FailureClass }) {
  return (
    <span title={classMeta[c].hint} className={cx('inline-flex items-center rounded-ctl border px-1.5 text-[11px] font-semibold uppercase tracking-wide leading-5', c === 'authority' ? 'border-ink text-ink' : 'border-line text-muted')}>
      {classMeta[c].label}
    </span>
  );
}

export const modeLabel: Record<Mode, string> = { auto: 'Auto', approve_first: 'Approve first', suggest_only: 'Suggest only', autonomous: 'Autonomous' };

export const changeLabel: Record<Ticket['change_type'], string> = {
  docs: 'docs',
  error_text: 'error text',
  config: 'config',
  grant: 'grant',
  code: 'code',
};

export function ToolChip({ tool, d, onClick, active }: { tool: string; d?: string; onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted transition-colors', active ? 'border-ink bg-white text-ink' : 'border-line bg-surface hover:border-muted hover:text-ink')}
    >
      <span className="font-semibold text-ink/80">{tool === 'AgentHelpDesk' ? 'Desk' : tool}</span>
      {d && <span className="font-mono text-[10.5px]">{d}</span>}
    </button>
  );
}

export function ProofIcon({ s, size = 20 }: { s: ProofStatus; size?: number }) {
  const box = { width: size, height: size };
  if (s === 'passed')
    return (
      <svg viewBox="0 0 20 20" style={box} aria-label="passed"><circle cx="10" cy="10" r="10" fill="#0F8A5F" /><path d="M6 10.4l2.6 2.6L14 7.6" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
    );
  if (s === 'failed')
    return (
      <svg viewBox="0 0 20 20" style={box} aria-label="failed"><circle cx="10" cy="10" r="10" fill="#D92D20" /><path d="M7 7l6 6M13 7l-6 6" stroke="#fff" strokeWidth="2" strokeLinecap="round" /></svg>
    );
  if (s === 'running')
    return (
      <svg viewBox="0 0 20 20" style={box} className="animate-spin" aria-label="running"><circle cx="10" cy="10" r="8" stroke="#EAF0FF" strokeWidth="3" fill="none" /><path d="M10 2a8 8 0 018 8" stroke="#2554F5" strokeWidth="3" fill="none" strokeLinecap="round" /></svg>
    );
  if (s === 'skipped')
    return <svg viewBox="0 0 20 20" style={box} aria-label="skipped"><circle cx="10" cy="10" r="9" stroke="#E6E8EE" strokeWidth="2" fill="none" /><path d="M6 10h8" stroke="#5B6475" strokeWidth="2" strokeLinecap="round" /></svg>;
  return <svg viewBox="0 0 20 20" style={box} aria-label="pending"><circle cx="10" cy="10" r="9" stroke="#E6E8EE" strokeWidth="2" strokeDasharray="3 3" fill="none" /></svg>;
}

/* ---------- Layout bits ---------- */

export function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'pink' | 'blue' | 'green' | 'red' }) {
  const t = tone === 'pink' ? 'border-pink/30 bg-pink-tint/50' : tone === 'blue' ? 'border-blue/20 bg-blue-tint/50' : tone === 'green' ? 'border-success/25 bg-success-tint/60' : tone === 'red' ? 'border-error/25 bg-error-tint/60' : 'border-line bg-white';
  return <div className={cx('rounded-card border', t, className)}>{children}</div>;
}

export function CardHead({ title, right, sub }: { title: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        {sub && <p className="mt-0.5 text-[13px] text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function PageHeader({ title, sub, right, crumb }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; crumb?: { to: string; label: string } }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {crumb && <Link to={crumb.to} className="mb-2 inline-block text-[13px] text-muted hover:text-ink">← {crumb.label}</Link>}
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        {sub && <p className="mt-1 max-w-3xl text-body text-muted">{sub}</p>}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="text-label font-medium uppercase text-muted">{children}</div>;
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-line px-6 py-14 text-center">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {body && <p className="mt-1 max-w-md text-[14px] text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors', value === t.key ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface px-1 font-mono text-[11px] text-muted">{children}</kbd>;
}

export function Spark({ data, color = '#2554F5', w = 96, h = 28 }: { data: number[]; color?: string; w?: number; h?: number }) {
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Stat({ label, value, sub, spark, color, sample, icon }: { label: string; value: ReactNode; sub?: ReactNode; spark?: number[]; color?: string; sample?: boolean; icon?: ReactNode }) {
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-center gap-3">
        {icon}
        <Label>{label}</Label>
        {sample && <span className="ml-auto"><SampleTag /></span>}
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="text-[28px] font-semibold leading-none tracking-tight text-ink tabular-nums">{value}</div>
        {spark && <Spark data={spark} color={color} w={88} h={26} />}
      </div>
      {sub && <div className="mt-2 truncate text-[12.5px] text-muted" title={typeof sub === 'string' ? sub : undefined}>{sub}</div>}
    </Card>
  );
}

export function SampleTag({ children = 'Sample numbers' }: { children?: ReactNode }) {
  return <span className="rounded-full border border-dashed border-muted/50 px-2 text-[11px] font-medium leading-5 text-muted">{children}</span>;
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={cx('relative h-5 w-9 rounded-full transition-colors', on ? 'bg-blue' : 'bg-line')}>
      <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1200); }}
      className="rounded-md px-2 py-1 text-[12px] font-medium text-muted hover:bg-white hover:text-ink"
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-ctl border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button key={o.key} onClick={() => onChange(o.key)} className={cx('rounded-[6px] px-3 py-1 text-[13px] font-medium transition-colors', value === o.key ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
