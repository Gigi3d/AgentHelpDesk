// Optional shared-secret gate for the desk API.
// AHD_API_TOKEN unset: no gate (local use). Set: every route except /healthz needs
// `Authorization: Bearer <token>`. The token is read from env only and never logged.
import { timingSafeEqual } from 'node:crypto';

export function bearerOk(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1]!);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}
