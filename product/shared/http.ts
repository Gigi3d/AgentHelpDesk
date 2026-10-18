// Minimal dependency-free HTTP plumbing shared by every module's registerRoutes.
import type { IncomingHttpHeaders } from 'node:http';

export interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: IncomingHttpHeaders;
  requestId: string;
  /** Verified caller identity once auth lands; null until then. */
  caller: string | null;
}

export interface HttpResult {
  status: number;
  body: unknown;
  /** Response headers to set on the wire. Needed by the 402 lanes: an x402 client
   * reads the payment requirement from `x-payment-required`, not from the body. */
  headers?: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<HttpResult>;

export interface Router {
  add(method: 'GET' | 'POST' | 'DELETE', path: string, handler: Handler): void;
}

/** Uniform error envelope so every failure is machine-readable and names its stage. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly stage: string;
  constructor(status: number, code: string, message: string, stage: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.stage = stage;
  }
  toBody(requestId: string): unknown {
    return { error: { code: this.code, message: this.message, stage: this.stage, request_id: requestId } };
  }
}

export const ok = (body: unknown, status = 200): HttpResult => ({ status, body });

export function badRequest(stage: string, message: string): HttpError {
  return new HttpError(400, 'bad_request', message, stage);
}

/** Coerce + validate an unknown JSON body field, failing loud at the boundary. */
export function str(body: unknown, field: string, stage: string): string {
  const v = (body as Record<string, unknown> | null)?.[field];
  if (typeof v !== 'string' || v.length === 0) throw badRequest(stage, `field "${field}" must be a non-empty string`);
  return v;
}

export function num(body: unknown, field: string, stage: string): number {
  const v = (body as Record<string, unknown> | null)?.[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest(stage, `field "${field}" must be a finite number`);
  return v;
}
