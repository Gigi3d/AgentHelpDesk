import { useState, type ReactNode } from 'react';
import { CopyButton, cx } from './ui';

/** Tokenise JSON text into coloured spans. Keys ink, strings blue, numbers pink-text, literals muted. */
function highlight(src: string): ReactNode[] {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    if (m[1] && m[2]) out.push(<span key={k++} className="text-ink font-medium">{m[1]}</span>, m[2]);
    else if (m[1]) out.push(<span key={k++} className={m[1].includes('••') ? 'text-muted' : 'text-blue-text'}>{m[1]}</span>);
    else if (m[3]) out.push(<span key={k++} className="text-pink-text">{m[3]}</span>);
    else out.push(<span key={k++} className="text-muted italic">{m[4]}</span>);
    last = re.lastIndex;
  }
  out.push(src.slice(last));
  return out;
}

export function JsonView({
  data,
  file,
  note,
  maxHeight = 360,
  className,
  right,
}: {
  data: unknown;
  file?: string;
  note?: ReactNode;
  maxHeight?: number | 'none';
  className?: string;
  right?: ReactNode;
}) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const lines = text.split('\n').length;
  const collapsible = maxHeight !== 'none' && lines * 20 > maxHeight + 40;
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('overflow-hidden rounded-card border border-line bg-surface', className)}>
      {(file || right) && (
        <div className="flex items-center justify-between gap-3 border-b border-line bg-white/60 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded bg-ink px-1.5 font-mono text-[10px] font-semibold leading-4 text-white">JSON</span>
            {file && <span className="truncate font-mono text-[12px] text-ink">{file}</span>}
            {note && <span className="truncate text-[12px] text-muted">{note}</span>}
          </div>
          <div className="flex items-center gap-1">
            {right}
            <CopyButton text={text} />
          </div>
        </div>
      )}
      <div className="relative">
        <pre
          className="overflow-auto px-4 py-3 font-mono text-[12.5px] leading-5 text-ink/90"
          style={{ maxHeight: collapsible && !open ? maxHeight : undefined }}
        >
          {highlight(text)}
        </pre>
        {collapsible && (
          <div className={cx('flex justify-center pb-2', !open && 'absolute inset-x-0 bottom-0 bg-gradient-to-t from-surface via-surface/90 to-transparent pt-10')}>
            <button onClick={() => setOpen(!open)} className="rounded-full border border-line bg-white px-3 py-0.5 text-[12px] font-medium text-muted hover:text-ink">
              {open ? 'Collapse' : `Show all ${lines} lines`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Diff({ lines, file }: { lines: string[]; file: string }) {
  if (!lines.length) return <p className="text-[13px] text-muted">No change proposed.</p>;
  return (
    <div className="overflow-hidden rounded-card border border-line">
      <div className="flex items-center justify-between border-b border-line bg-surface px-3 py-1.5">
        <span className="font-mono text-[12px] text-ink">{file}</span>
        <span className="font-mono text-[11.5px] text-muted">
          <span className="text-success-text">+{lines.filter((l) => l.startsWith('+')).length}</span>{' '}
          <span className="text-error">−{lines.filter((l) => l.startsWith('-')).length}</span>
        </span>
      </div>
      <pre className="overflow-x-auto bg-white py-2 font-mono text-[12.5px] leading-5">
        {lines.map((l, i) => (
          <div key={i} className={cx('px-3', l.startsWith('+') ? 'bg-success-tint text-success-text' : l.startsWith('-') ? 'bg-error-tint text-error-text' : 'text-muted')}>
            <span className="mr-3 inline-block w-3 select-none opacity-60">{l[0] === '+' || l[0] === '-' ? l[0] : ' '}</span>
            {l.slice(l[0] === '+' || l[0] === '-' || l[0] === ' ' ? 1 : 0)}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function Code({ children, file }: { children: string; file?: string }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      {file && (
        <div className="flex items-center justify-between border-b border-line bg-white/60 px-3 py-1.5">
          <span className="font-mono text-[12px] text-ink">{file}</span>
          <CopyButton text={children} />
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-5 text-ink/90">{children}</pre>
    </div>
  );
}
