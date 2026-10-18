// Optional shared-secret gate for the desk API.
// AHD_API_TOKEN unset: no gate (local use). Set: every route except /healthz needs
// `Authorization: Bearer <token>`. The token is read from env only and never logged.
import { timingSafeEqual } from 'node:crypto';

/** May this request go through without the token? Only with AHD_PUBLIC_READ=1: GETs are open so the
 * console and a judge's browser can look, and the capped public demo door is open. Every other write
 * (approve, delete, open a case, bill) still needs the key. */
export function openWithoutToken(method: string | undefined, path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['AHD_PUBLIC_DEMO'] === '1' && path.startsWith('/v1/public/')) return true;
  return env['AHD_PUBLIC_READ'] === '1' && (method === 'GET' || method === 'HEAD') && !path.startsWith('/v1/public/');
}

export function bearerOk(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1]!);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}
