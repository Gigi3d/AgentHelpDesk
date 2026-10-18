// sandbox/provision.ts: put the vendor's checkout and the proof tools into a case sandbox.
//
// The Build Plan says a case sandbox holds a checkout of the vendor's repo. A `git clone`
// needs the sandbox to reach GitHub (flagged OPEN in README), so this uploads a local
// directory tree instead, through the documented `fs.write`. The directory mirrors the
// sandbox root: `<dir>/ahd/work/server.mjs` lands at `/ahd/work/server.mjs`.
//
// It is called at the start of EVERY loop run, so a case re-entered after an approval starts
// from the pristine checkout instead of from the fix an earlier run already wrote.
//
// The model key for the fresh-agent proof is written to `/ahd/secrets/anthropic.key` (mode
// 600) only when it is set. It lives in the sandbox because the fresh-agent runs there; use a
// restricted, throwaway key and delete the sandboxes afterwards.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SandboxHandle, Vendor } from '../shared/types.ts';

const SKIP_DIRS: readonly string[] = ['node_modules', '.git'];
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 200;
const STAGE = 'sandbox.provision';

export const SECRET_KEY_PATH = '/ahd/secrets/anthropic.key';

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.includes(entry.name)) continue;
      await walk(root, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)));
      if (out.length > MAX_FILES) throw new Error(`${STAGE}: more than ${MAX_FILES} files under ${root}; refusing to upload a tree that large`);
    }
  }
}

/** Upload every file under `localDir` to the same relative path under `/` in the sandbox. */
export async function uploadTree(sb: SandboxHandle, localDir: string): Promise<string[]> {
  const root = localDir;
  try {
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch (err) {
    throw new Error(`${STAGE}: provision directory '${root}' is not readable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rel: string[] = [];
  await walk(root, root, rel);
  rel.sort();
  const uploaded: string[] = [];
  for (const r of rel) {
    const full = join(root, r);
    const info = await stat(full);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${STAGE}: '${r}' is ${info.size} bytes, over the ${MAX_FILE_BYTES} byte cap`);
    const remote = `/${r.split(sep).join('/')}`;
    await sb.write(remote, await readFile(full, 'utf8'));
    uploaded.push(remote);
  }
  return uploaded;
}

export interface ProvisionOptions {
  dir: string;
  /** Written to SECRET_KEY_PATH when non-empty. */
  anthropicKey?: string;
}

export function makeProvisioner(opts: ProvisionOptions): (sb: SandboxHandle, vendor: Vendor, caseId: string) => Promise<void> {
  return async (sb: SandboxHandle): Promise<void> => {
    const uploaded = await uploadTree(sb, opts.dir);
    if (uploaded.length === 0) throw new Error(`${STAGE}: '${opts.dir}' contains no files`);
    if (typeof opts.anthropicKey === 'string' && opts.anthropicKey.length > 0) {
      await sb.write(SECRET_KEY_PATH, opts.anthropicKey);
      const chmod = await sb.exec(`chmod 600 ${SECRET_KEY_PATH}`, { timeout_ms: 15_000 });
      if (chmod.exit_code !== 0) throw new Error(`${STAGE}: chmod on the key file failed (exit ${chmod.exit_code}): ${chmod.stderr.slice(-200)}`);
    }
    // Fail loud if the tools the proofs call are not where the proofs look.
    for (const required of ['/ahd/replay.mjs', '/ahd/fresh-agent.mjs']) {
      const check = await sb.exec(`test -f ${required}`, { timeout_ms: 15_000 });
      if (check.exit_code !== 0) throw new Error(`${STAGE}: ${required} is missing after upload; the proof tools must be in the provision directory under ahd/`);
    }
  };
}
