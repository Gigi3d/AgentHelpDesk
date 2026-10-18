// The price list. All money in this module is computed from these numbers plus rows
// in the Repository — never invented at the call site.
//
// Defaults follow the build plan ("about $0.50 to $1 per resolved task in our first
// pricing guess") and the task brief: docs $0.50 / code $1 / migration $25, plus a
// $0 platform line while running in test mode. Key names match `web/src/data/billing.json`
// (`docs_error_text`, `code_config_grant`, `migration_pr`, `platform_monthly`) so the
// console fixture and the API preview speak the same language. That fixture currently
// shows migration 15 / platform 49; override with the env vars below to match it.
//
// Everything is read from `process.env` at call time: the service must stay stateless
// (AGENTS.md) so a price change is a restart, not a mutation of module state.
import { HttpError } from '../shared/http.ts';
import type { FailureClass } from '../shared/types.ts';
import type { BillingStage } from './log.ts';

const STAGE: BillingStage = 'billing.prices';

export type PriceKey = 'docs_error_text' | 'code_config_grant' | 'migration_pr' | 'platform_monthly';

export type PriceList = Record<PriceKey, number>;

export interface PriceBook {
  currency: 'usd';
  prices: PriceList;
  /** Per-call prices for the two agent-pays rails (build plan: the answer sits behind a 402 at $0.50). */
  lanes: { a2a_x402_usd: number; b2b_mpp_usd: number };
}

/**
 * `knowledge` fixes are docs / error-text edits, `code` fixes are code or config in the
 * vendor's repo, and `authority` fixes needed an envelope or a migration-scale change —
 * the expensive class, because it is the one a human had to approve (build plan, failure 3/4).
 */
export function priceKeyForClass(klass: FailureClass): PriceKey {
  if (klass === 'knowledge') return 'docs_error_text';
  if (klass === 'code') return 'code_config_grant';
  if (klass === 'authority') return 'migration_pr';
  throw new HttpError(500, 'unknown_failure_class', `cannot price failure class "${String(klass)}"`, STAGE);
}

export const PRICE_LABELS: Record<PriceKey, string> = {
  docs_error_text: 'Docs / error-text fixes (auto-merge on green)',
  code_config_grant: 'Code / config fixes',
  migration_pr: 'Migration / authority fixes (approved)',
  platform_monthly: 'Platform fee',
};

function envUsd(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new HttpError(500, 'bad_price_config', `${name} must be a non-negative USD amount, got "${raw}"`, STAGE);
  }
  return value;
}

export function priceBook(): PriceBook {
  return {
    currency: 'usd',
    prices: {
      docs_error_text: envUsd('AHD_PRICE_DOCS_USD', 0.5),
      code_config_grant: envUsd('AHD_PRICE_CODE_USD', 1),
      migration_pr: envUsd('AHD_PRICE_MIGRATION_USD', 25),
      // $0 while the desk runs in test mode; set AHD_PRICE_PLATFORM_USD=49 for live.
      platform_monthly: envUsd('AHD_PRICE_PLATFORM_USD', 0),
    },
    lanes: {
      a2a_x402_usd: envUsd('AHD_X402_PRICE_USD', 0.5),
      b2b_mpp_usd: envUsd('AHD_MPP_PRICE_USD', 0.5),
    },
  };
}

/** Whole cents, so previews and totals never show float dust like 1.5000000000000002. */
export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}
