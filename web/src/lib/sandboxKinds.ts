// One vocabulary for how a Blaxel sandbox is shown, shared by the sidebar rail, the Blaxel page
// and the scenario board so a colour means the same thing everywhere.
import type { BlaxelSandbox } from './api';

export type SandboxKind = 'desk' | 'remembered' | 'closed' | 'escalated' | 'working' | 'other';

export const TILE: Record<SandboxKind, string> = {
  desk: 'bg-blue border-blue',
  remembered: 'bg-success border-success',
  closed: 'bg-success/35 border-success/60',
  escalated: 'bg-error border-error',
  working: 'bg-warning border-warning animate-pulse',
  other: 'bg-line border-line',
};

export const WORD: Record<SandboxKind, string> = {
  desk: 'the desk',
  remembered: 'holds a remembered fix',
  closed: 'finished case',
  escalated: 'escalated case',
  working: 'case in progress',
  other: 'not in this desk’s records',
};

export function kindFor(s: BlaxelSandbox, status: Record<string, string>, remembered: Set<string>): SandboxKind {
  if (s.role === 'desk') return 'desk';
  if (s.role === 'fresh') return 'working';
  if (s.case_id && remembered.has(s.case_id)) return 'remembered';
  const st = s.case_id ? status[s.case_id] : undefined;
  if (st === 'escalated') return 'escalated';
  if (st === 'closed' || st === 'resolved' || st === 'shipped' || st === 'answered') return 'closed';
  if (st) return 'working';
  return 'other';
}
