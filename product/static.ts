// Serves the built console (web/dist) from the desk itself, so there is one URL.
// Dependency-free. Only GET/HEAD; never reads outside the root; unknown paths fall
// back to index.html so client-side routes survive a refresh.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Paths that belong to the API and must never be answered with the app shell. */
export function isApiPath(pathname: string): boolean {
  return pathname === '/healthz' || pathname === '/v1' || pathname.startsWith('/v1/');
}

export async function serveStatic(root: string, pathname: string): Promise<StaticResult | null> {
  if (isApiPath(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { status: 400, headers: { 'content-type': 'text/plain' }, body: Buffer.from('bad path') };
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const full = join(root, rel);
  if (full !== root && !full.startsWith(root + sep)) {
    return { status: 403, headers: { 'content-type': 'text/plain' }, body: Buffer.from('forbidden') };
  }
  const tryFile = async (p: string): Promise<StaticResult | null> => {
    try {
      const st = await stat(p);
      if (!st.isFile()) return null;
      const ext = extname(p).toLowerCase();
      const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2|svg|png)$/.test(p);
      return {
        status: 200,
        headers: {
          'content-type': TYPES[ext] ?? 'application/octet-stream',
          'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
        body: await readFile(p),
      };
    } catch {
      return null;
    }
  };
  const direct = await tryFile(full);
  if (direct) return direct;
  if (extname(rel) !== '') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
  return tryFile(join(root, 'index.html'));
}
