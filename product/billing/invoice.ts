// Invoice preview: the weekly "here is what you will be billed" view, computed entirely from
// the Repository. Build plan: "every number comes from the database, not from the model" and
// "It works as an invoice preview, so the vendor sees the value before they are charged."
//
// Nothing here is estimated. A case contributes to a line item only when `decide()` says it is
// billable — the same call the meter lane uses — so the preview and the meter cannot disagree.
import { HttpError } from '../shared/http.ts';
import type { PayLane } from '../shared/types.ts';
import type { Repository } from '../store/repository.ts';
import { decide } from './billable.ts';
import { priceBook, PRICE_LABELS, fromCents, priceKeyForClass, toCents, type PriceKey } from './prices.ts';
import { getBillingClient, type BillingMode, type StripeBillingClient } from './stripe-client.ts';

const STAGE = 'billing.invoice';
const USAGE_KEYS: PriceKey[] = ['docs_error_text', 'code_config_grant', 'migration_pr'];

export interface InvoiceLineItem {
  key: PriceKey;
  label: string;
  count: number;
  unit_price_usd: number;
  amount_usd: number;
}

export interface InvoicePreview {
  vendor_id: string;
  vendor_name: string;
  generated_at: string;
  currency: 'usd';
  mode: BillingMode;
  counts: {
    cases: number;
    billable: number;
    exempt: number;
    not_billable: number;
    metered: number;
    pending: number;
    by_lane: Record<PayLane, number>;
    by_class: { docs: number; code: number; migration: number };
  };
  line_items: InvoiceLineItem[];
  total_usd: number;
  note: string;
}

export async function invoicePreview(
  vendorId: string,
  repo: Repository,
  client: StripeBillingClient = getBillingClient(),
): Promise<InvoicePreview> {
  const id = vendorId.trim();
  if (id === '') {
    throw new HttpError(400, 'bad_request', 'vendor_id must be a non-empty string', STAGE);
  }
  const vendor = await repo.getVendor(id);
  if (!vendor) {
    throw new HttpError(404, 'vendor_not_found', `no vendor "${id}"`, STAGE);
  }

  const book = priceBook();
  const failures = await repo.listFailures({ vendor_id: id });
  const usage: Record<PriceKey, number> = {
    docs_error_text: 0,
    code_config_grant: 0,
    migration_pr: 0,
    platform_monthly: 0,
  };
  const byLane: Record<PayLane, number> = { b2b_meter: 0, a2a_x402: 0, b2b_mpp: 0 };
  let billable = 0;
  let exempt = 0;
  let notBillable = 0;
  let metered = 0;
  let pending = 0;

  for (const failure of failures) {
    const decision = await decide(failure.id, repo);
    if (!decision.billable || decision.lane === null) {
      if (decision.reason.startsWith('exempt_')) exempt += 1;
      else notBillable += 1;
      continue;
    }
    const outcome = await repo.getOutcome(failure.id);
    if (!outcome) {
      // decide() only returns billable when an outcome row exists, so this is a store bug.
      throw new HttpError(500, 'missing_outcome', `case "${failure.id}" is billable but has no outcome row`, STAGE);
    }
    billable += 1;
    usage[priceKeyForClass(failure.klass)] += 1;
    byLane[decision.lane] += 1;
    const receipt = await repo.meterEventByIdentifier(outcome.id);
    if (receipt) metered += 1;
    else pending += 1;
  }

  const lineItems: InvoiceLineItem[] = USAGE_KEYS.map((key) => {
    const count = usage[key];
    const unit = book.prices[key];
    return {
      key,
      label: PRICE_LABELS[key],
      count,
      unit_price_usd: unit,
      amount_usd: fromCents(toCents(unit) * count),
    };
  });
  // The platform line is $0 in test mode (default AHD_PRICE_PLATFORM_USD=0); set it for live.
  lineItems.push({
    key: 'platform_monthly',
    label: PRICE_LABELS.platform_monthly,
    count: 1,
    unit_price_usd: book.prices.platform_monthly,
    amount_usd: fromCents(toCents(book.prices.platform_monthly)),
  });

  const totalCents = lineItems.reduce((sum, line) => sum + toCents(line.amount_usd), 0);

  return {
    vendor_id: vendor.id,
    vendor_name: vendor.name,
    generated_at: new Date().toISOString(),
    currency: 'usd',
    mode: client.mode,
    counts: {
      cases: failures.length,
      billable,
      exempt,
      not_billable: notBillable,
      metered,
      pending,
      by_lane: byLane,
      by_class: {
        docs: usage.docs_error_text,
        code: usage.code_config_grant,
        migration: usage.migration_pr,
      },
    },
    line_items: lineItems,
    total_usd: fromCents(totalCents),
    note:
      'Computed from the repository: only cases where all three proofs passed and the agent retry succeeded, ' +
      'minus policy-exempt cases. This is a preview, not an invoice — Stripe bills from the usage meter.',
  };
}
