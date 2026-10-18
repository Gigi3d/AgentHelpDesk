// The only file in the billing module that touches the network.
//
// Stripe facts cited here (do not invent APIs — AGENTS.md "Sponsor SDK honesty"):
//   * Meter events are created with `stripe.billing.meter_events.create({ event_name,
//     payload: { stripe_customer_id, value }, identifier })`.
//     Doc: https://docs.stripe.com/api/billing/meter-event/create
//     REST equivalent (used below, because `product/` has zero runtime dependencies and
//     may not add the `stripe` package): POST https://api.stripe.com/v1/billing/meter_events
//     with form fields `event_name`, `identifier`, `payload[stripe_customer_id]`, `payload[value]`.
//   * `identifier` is Stripe's idempotency key for a meter event: the same identifier
//     cannot be recorded twice. We pass the outcome id, so a retried fix can never bill twice.
//   * Meters use **count** aggregation, so `value` is `1` per verified fix (build plan,
//     "Billing: Stripe meter for B2B, x402 for A2A"). Doc: https://docs.stripe.com/api/billing/meter/object
//   * A meter event can be cancelled within 24 hours of creation — that is the escape hatch
//     when a retry later turns out to have failed. The Node SDK call is
//     `stripe.billing.meter_events.deactivate`; the REST path used below is
//     POST /v1/billing/meter_event_adjustments with type=cancel and cancel[identifier]. Confirm that path against
//     your account's pinned API version before enabling live mode: offline this method is
//     only ever exercised by FakeStripeClient, and against the real API it fails loud on a
//     non-2xx instead of pretending the cancellation happened.
//
// Selection (AGENTS.md): `AHD_BILLING_FAKE=1`, or a missing `STRIPE_SECRET_KEY`, puts the
// module on FakeStripeClient, which records to memory and tags every event `mode: 'test'`.
import { HttpError } from '../shared/http.ts';

export type BillingMode = 'test' | 'live';

export interface MeterEventInput {
  /** Must match a meter created with count aggregation in the Stripe dashboard. */
  eventName: string;
  /** The vendor's Stripe customer id (`cus_...`), from `vendors.stripe_customer_id`. */
  customerId: string;
  /** Count aggregation: 1 per verified fix. */
  value: number;
  /** Idempotency key. Billing always passes the outcome id. */
  identifier: string;
}

export interface EmittedMeterEvent {
  id: string;
  identifier: string;
  event_name: string;
  customer_id: string;
  value: number;
  mode: BillingMode;
  created_at: string;
}

export interface CancelledMeterEvent {
  identifier: string;
  cancelled: boolean;
  mode: BillingMode;
  at: string;
}

export interface StripeBillingClient {
  readonly mode: BillingMode;
  emitMeterEvent(input: MeterEventInput): Promise<EmittedMeterEvent>;
  cancelMeterEvent(identifier: string): Promise<CancelledMeterEvent>;
}

const STRIPE_BASE = 'https://api.stripe.com/v1';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

function timeoutMs(): number {
  const raw = process.env.AHD_STRIPE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new HttpError(500, 'bad_stripe_timeout', `AHD_STRIPE_TIMEOUT_MS must be 1..${MAX_TIMEOUT_MS} ms`, 'billing.stripe');
  }
  return value;
}

function validate(input: MeterEventInput): void {
  if (input.eventName.trim() === '') {
    throw new HttpError(400, 'bad_meter_event', 'eventName must be a non-empty string', 'billing.stripe.emit');
  }
  if (input.customerId.trim() === '') {
    throw new HttpError(400, 'bad_meter_event', 'customerId must be a non-empty Stripe customer id', 'billing.stripe.emit');
  }
  if (input.identifier.trim() === '') {
    throw new HttpError(400, 'bad_meter_event', 'identifier must be a non-empty idempotency key', 'billing.stripe.emit');
  }
  if (!Number.isFinite(input.value) || input.value < 0) {
    throw new HttpError(400, 'bad_meter_event', `value must be a finite non-negative count, got ${String(input.value)}`, 'billing.stripe.emit');
  }
}

/**
 * Offline / test double. Records to memory, tags `mode: 'test'`, and is idempotent by
 * identifier exactly like the real API — so a replayed call in a test cannot double-count.
 */
export class FakeStripeClient implements StripeBillingClient {
  readonly mode: BillingMode = 'test';
  /** Every event this fake accepted, in order. Test-visible on purpose. */
  readonly emitted: EmittedMeterEvent[] = [];
  readonly cancelled: string[] = [];
  private byIdentifier = new Map<string, EmittedMeterEvent>();

  async emitMeterEvent(input: MeterEventInput): Promise<EmittedMeterEvent> {
    validate(input);
    const existing = this.byIdentifier.get(input.identifier);
    if (existing) return existing; // identifier uniqueness: a retry can never bill twice
    const event: EmittedMeterEvent = {
      id: `bme_fake_${this.emitted.length + 1}`,
      identifier: input.identifier,
      event_name: input.eventName,
      customer_id: input.customerId,
      value: input.value,
      mode: 'test',
      created_at: new Date().toISOString(),
    };
    this.emitted.push(event);
    this.byIdentifier.set(input.identifier, event);
    return event;
  }

  async cancelMeterEvent(identifier: string): Promise<CancelledMeterEvent> {
    if (identifier.trim() === '') {
      throw new HttpError(400, 'bad_meter_cancel', 'identifier must be a non-empty string', 'billing.stripe.cancel');
    }
    if (!this.byIdentifier.has(identifier)) {
      throw new HttpError(404, 'meter_event_not_found', `no meter event with identifier "${identifier}"`, 'billing.stripe.cancel');
    }
    this.cancelled.push(identifier);
    return { identifier, cancelled: true, mode: 'test', at: new Date().toISOString() };
  }
}

/** Real calls, behind the same interface. Never used when the key is missing. */
export class LiveStripeClient implements StripeBillingClient {
  readonly mode: BillingMode;
  private readonly secretKey: string;

  constructor(secretKey: string) {
    if (secretKey.trim() === '') {
      throw new HttpError(500, 'missing_stripe_key', 'STRIPE_SECRET_KEY must not be empty', 'billing.stripe');
    }
    this.secretKey = secretKey;
    // Stripe test keys are prefixed `sk_test_`; anything else is treated as live.
    this.mode = secretKey.startsWith('sk_test_') ? 'test' : 'live';
  }

  private async post(path: string, form: URLSearchParams, stage: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${STRIPE_BASE}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        // Pin the API version so a Stripe rollout cannot change our payloads mid-demo.
        'stripe-version': process.env.AHD_STRIPE_API_VERSION ?? '2025-03-31.basil',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs()),
    }).catch((err: unknown) => {
      // Network failure, DNS, or the timeout above: never swallow it, never retry silently.
      throw new HttpError(502, 'stripe_unreachable', `Stripe call ${path} failed: ${(err as Error).message}`, stage);
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch (err) {
        throw new HttpError(502, 'stripe_bad_response', `Stripe returned non-JSON from ${path}: ${(err as Error).message}`, stage);
      }
    }
    if (!res.ok) {
      const errBody = (parsed['error'] ?? {}) as Record<string, unknown>;
      const message = typeof errBody['message'] === 'string' ? errBody['message'] : `HTTP ${String(res.status)}`;
      throw new HttpError(502, 'stripe_error', `Stripe rejected ${path}: ${message}`, stage);
    }
    return parsed;
  }

  async emitMeterEvent(input: MeterEventInput): Promise<EmittedMeterEvent> {
    validate(input);
    const form = new URLSearchParams({
      event_name: input.eventName,
      identifier: input.identifier,
      'payload[stripe_customer_id]': input.customerId,
      'payload[value]': String(input.value),
    });
    const body = await this.post('/billing/meter_events', form, 'billing.stripe.emit');
    // Stripe's billing.meter_event object has no `id`; it echoes the `identifier` we sent. The call
    // succeeded (res.ok above), so fall back to that identifier rather than failing a paid outcome.
    const id =
      typeof body['id'] === 'string' && body['id'] !== ''
        ? body['id']
        : typeof body['identifier'] === 'string' && body['identifier'] !== ''
          ? body['identifier']
          : input.identifier;
    return {
      id,
      identifier: input.identifier,
      event_name: input.eventName,
      customer_id: input.customerId,
      value: input.value,
      mode: this.mode,
      created_at: new Date().toISOString(),
    };
  }

  async cancelMeterEvent(identifier: string): Promise<CancelledMeterEvent> {
    if (identifier.trim() === '') {
      throw new HttpError(400, 'bad_meter_cancel', 'identifier must be a non-empty string', 'billing.stripe.cancel');
    }
    // Cancellable within 24h of creation (see the header comment).
    await this.post(
      '/billing/meter_event_adjustments',
      new URLSearchParams({ event_name: meterEventName(), type: 'cancel', 'cancel[identifier]': identifier }),
      'billing.stripe.cancel',
    );
    return { identifier, cancelled: true, mode: this.mode, at: new Date().toISOString() };
  }
}

export function billingIsFaked(env: Record<string, string | undefined> = process.env): boolean {
  return env['AHD_BILLING_FAKE'] === '1' || (env['STRIPE_SECRET_KEY'] ?? '').trim() === '';
}

let cached: StripeBillingClient | null = null;

/**
 * Process-level adapter chosen from env. This holds configuration, never case state:
 * all per-case facts live in the Repository, so N copies of the process agree.
 */
export function getBillingClient(): StripeBillingClient {
  if (cached) return cached;
  cached = billingIsFaked() ? new FakeStripeClient() : new LiveStripeClient(String(process.env['STRIPE_SECRET_KEY']));
  return cached;
}

/** Meter event name used for the count-aggregated "verified fix" meter. */
export function meterEventName(): string {
  const name = process.env['AHD_STRIPE_METER_EVENT_NAME'];
  return name === undefined || name.trim() === '' ? 'ahd_verified_fix' : name.trim();
}
