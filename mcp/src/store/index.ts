import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Case, DeskStore, Stage, StoreChange, ToolEvent } from './types.js';

export type * from './types.js';

const OPEN: Stage[] = ['opened', 'reproducing', 'fix_drafted', 'proving', 'awaiting_approval'];
export const isOpen = (s: Stage) => OPEN.includes(s);

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory fake. Also the base the file store persists from. */
export function memoryStore(seed: { cases: Case[]; events: ToolEvent[] } = { cases: [], events: [] }, onWrite?: (data: { cases: Case[]; events: ToolEvent[] }) => void): DeskStore {
  const data = clone(seed);
  const subs = new Set<(c: StoreChange) => void>();
  const emit = (c: StoreChange) => {
    onWrite?.(data);
    for (const fn of subs) fn(clone(c));
  };
  return {
    async listCases() {
      return clone(data.cases);
    },
    async getCase(id) {
      return clone(data.cases.find((c) => c.id === id));
    },
    async findOpenCaseByRequestId(requestId) {
      return clone(data.cases.find((c) => c.request_id === requestId && isOpen(c.stage)));
    },
    async putCase(c) {
      const i = data.cases.findIndex((x) => x.id === c.id);
      if (i === -1) data.cases.push(clone(c));
      else data.cases[i] = clone(c);
      emit({ type: 'case', case: c });
    },
    async listEvents(caseId) {
      return clone(data.events.filter((e) => e.ticket_id === caseId).sort((a, b) => a.t_ms - b.t_ms));
    },
    async appendEvent(e) {
      data.events.push(clone(e));
      emit({ type: 'event', event: e });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** The same store, written through to one JSON file so cases survive a restart. */
export function jsonFileStore(path: string): DeskStore {
  let seed = { cases: [] as Case[], events: [] as ToolEvent[] };
  try {
    seed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // first run: start empty
  }
  mkdirSync(dirname(path), { recursive: true });
  return memoryStore(seed, (data) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${path}.tmp`, path);
  });
}

/** DESK_STORE=memory for a throwaway run; anything else persists to DESK_DATA (default data/desk.json under the working directory). */
export function createStore(): DeskStore {
  if (process.env.DESK_STORE === 'memory') return memoryStore();
  return jsonFileStore(resolve(process.env.DESK_DATA ?? 'data/desk.json'));
}
