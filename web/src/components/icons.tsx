import type { ReactNode } from 'react';
import { cx } from './ui';

/**
 * Hand-drawn 24px stroke icons. One grid, one stroke weight (1.75), round caps,
 * so they read as one family at 20px and stay crisp at 2x. Colour comes from
 * currentColor; the tile decides the tone.
 */

type P = { size?: number; className?: string };

function Svg({ size = 20, className, children }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden focusable="false">
      {children}
    </svg>
  );
}

/** A sealed parcel with a check: a fix that left the building, proven. */
export function ShippedIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M3.5 7.5L12 3l8.5 4.5v6" />
      <path d="M3.5 7.5v9L12 21l2.5-1.3" />
      <path d="M3.5 7.5L12 12l8.5-4.5" />
      <path d="M12 12v9" />
      <path d="M7.8 5.2l8.4 4.6" />
      <path d="M16 17.6l1.9 1.9 3.6-3.8" />
    </Svg>
  );
}

/** An hourglass with sand mid-fall: someone's decision is pending. */
export function AwaitingIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M6.5 3h11M6.5 21h11" />
      <path d="M7.5 3c0 4.2 4.5 5.3 4.5 9s-4.5 4.8-4.5 9" />
      <path d="M16.5 3c0 4.2-4.5 5.3-4.5 9s4.5 4.8 4.5 9" />
      <path d="M9.6 18.4c.8-.9 1.6-1.3 2.4-1.3s1.6.4 2.4 1.3" />
      <path d="M12 14.6h.01" strokeWidth="2.2" />
    </Svg>
  );
}

/** An agent's head with a speech bubble: it asked, and got an answer. */
export function AgentHelpedIcon(p: P) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="8.5" width="12" height="10" rx="3" />
      <path d="M8.5 8.5V5.8" />
      <circle cx="8.5" cy="4.6" r="1.2" />
      <path d="M6 13h.01M11 13h.01" strokeWidth="2.4" />
      <path d="M6.6 15.9h3.8" />
      <path d="M15.5 4.5h5a1.5 1.5 0 011.5 1.5v3.2a1.5 1.5 0 01-1.5 1.5h-2.3l-2.2 1.8v-1.8a1.5 1.5 0 01-1.5-1.5V6a1.5 1.5 0 011-1.5z" />
      <path d="M16.6 7.7l1 1 2-2.1" />
    </Svg>
  );
}

/** A trophy: the agent came back and finished its task. */
export function AgentWonIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M7.5 3.5h9v5.2a4.5 4.5 0 01-9 0z" />
      <path d="M7.5 5.5H5.6a2.25 2.25 0 000 4.5H8" />
      <path d="M16.5 5.5h1.9a2.25 2.25 0 010 4.5H16" />
      <path d="M12 13.2v3.3" />
      <path d="M8.5 20.5h7l-.8-4h-5.4z" />
      <path d="M10.6 7.4l1.4-1.4v4" />
    </Svg>
  );
}

/** A shield with a check: proofs that held. */
export function ShieldCheckIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6z" />
      <path d="M8.6 12.2l2.4 2.4 4.5-4.7" />
    </Svg>
  );
}

/** A lifebuoy: cases that need a person from our team. */
export function HumanQueueIcon(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M9.5 9.5L6 6M14.5 9.5L18 6M14.5 14.5L18 18M9.5 14.5L6 18" />
    </Svg>
  );
}

/** An unplugged connector: installs that stopped before going live. */
export function InstallStuckIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.5 7.5h11v3a5.5 5.5 0 01-11 0z" />
      <path d="M12 16v2.5a2.5 2.5 0 002.5 2.5" />
      <path d="M18.5 15.5l3 3M21.5 15.5l-3 3" />
    </Svg>
  );
}

/** Stacked coins: what each ticket costs us to run. */
export function CostIcon(p: P) {
  return (
    <Svg {...p}>
      <ellipse cx="9.5" cy="6.5" rx="6" ry="2.5" />
      <path d="M3.5 6.5v4c0 1.4 2.7 2.5 6 2.5" />
      <path d="M3.5 10.5v4c0 1.4 2.7 2.5 6 2.5" />
      <path d="M15.5 6.5v3" />
      <ellipse cx="15.5" cy="13.5" rx="5" ry="2.2" />
      <path d="M10.5 13.5v4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2v-4" />
    </Svg>
  );
}

export type IconTone = 'green' | 'pink' | 'blue' | 'ink' | 'amber';
const toneClass: Record<IconTone, string> = {
  green: 'bg-success-tint text-success-text ring-success/15',
  pink: 'bg-pink-tint text-pink-text ring-pink/15',
  blue: 'bg-blue-tint text-blue-text ring-blue/15',
  ink: 'bg-surface text-ink ring-line',
  amber: 'bg-warning-tint text-warning ring-warning/15',
};

/** The rounded square an icon sits in. Tone follows the colour rules: pink is a decision, blue is the system, green is done. */
export function IconTile({ tone = 'ink', children, pulse }: { tone?: IconTone; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={cx('relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ring-1 ring-inset', toneClass[tone])}>
      {children}
      {pulse && (
        <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pink opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-pink ring-2 ring-white" />
        </span>
      )}
    </span>
  );
}
