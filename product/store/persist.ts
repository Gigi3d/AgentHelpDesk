// File-backed persistence for the in-memory repository.
//
// The desk keeps cases in MemoryRepository. Wrapping it with withPersistence() writes a JSON snapshot
// after every mutating call (debounced) and loads it on boot, so a desk restart or a Blaxel sandbox
// restart does not lose cases. The same file is the fix-history record: every case, the proofs, the
// approvals and the tool events, in one place. Set AHD_DATA_FILE to enable it (default: off).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryRepository } from './memory.ts';
import type { Repository } from './repository.ts';

const MUTATING = /^(put|create|set|record|mark|update|append|erase)/;

export function withPersistence(repo: MemoryRepository, file: string | undefined, debounceMs = 250): Repository {
  if (!file) return repo;
  if (existsSync(file)) {
    try {
      repo.restore(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
    } catch (err) {
      // Never boot on a half-read file and then overwrite it: keep the bad file aside.
      try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      process.stderr.write(`persist: could not read ${file} (${(err as Error).message}); started empty\n`);
    }
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(repo.snapshot()));
      renameSync(tmp, file);
    } catch (err) {
      process.stderr.write(`persist: write failed: ${(err as Error).message}\n`);
    }
  };
  const schedule = (): void => { if (!timer) timer = setTimeout(flush, debounceMs); };
  process.once('SIGTERM', () => { flush(); process.exit(0); });
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (MUTATING.test(prop)) {
          if (out instanceof Promise) return out.then((r) => { schedule(); return r; });
          schedule();
        }
        return out;
      };
    },
  }) as Repository;
}
