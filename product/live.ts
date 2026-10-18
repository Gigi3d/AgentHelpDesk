// live.ts: opt-in "run it for real" wiring, read from the environment.
//
// Nothing here is on by default. With no AHD_* live variables set, server.ts behaves exactly as
// before. Each switch turns ONE component from stand-in to real, and `runtimeReport()` states,
// from the environment as it really is, which components are real and which are not. The
// console and the demo runner read that report so a recording never claims more than ran.
import type { Mode, Vendor } from './shared/types.ts';
import type { LoopDeps } from './desk/loop.ts';
import type { Repository } from './store/repository.ts';
import { makeClaudeResolver } from './desk/resolver-claude.ts';
import { makeProvisioner } from './sandbox/provision.ts';

const MODES: readonly Mode[] = ['auto', 'approve_first', 'suggest_only'];

/** Blaxel's SDK documents BL_API_KEY / BL_WORKSPACE; this repo's client checks BLAXEL_API_KEY.
 * Accept either name and make both visible so neither layer rejects a valid key. */
export function normalizeBlaxelEnv(env: NodeJS.ProcessEnv = process.env): void {
  const a = env['BLAXEL_API_KEY'];
  const b = env['BL_API_KEY'];
  if (a && !b) env['BL_API_KEY'] = a;
  if (b && !a) env['BLAXEL_API_KEY'] = b;
  const w = env['BL_WORKSPACE'];
  const w2 = env['BLAXEL_WORKSPACE'];
  if (w && !w2) env['BLAXEL_WORKSPACE'] = w;
  if (w2 && !w) env['BL_WORKSPACE'] = w2;
}

/** Parse AHD_VENDOR_JSON into a Vendor row, failing loud on a missing or malformed field. */
export function parseVendorJson(raw: string): Vendor {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    throw new Error(`AHD_VENDOR_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('AHD_VENDOR_JSON must be a JSON object');
  const r = v as Record<string, unknown>;
  const text = (k: string): string => {
    const x = r[k];
    if (typeof x !== 'string' || x.trim().length === 0) throw new Error(`AHD_VENDOR_JSON.${k} must be a non-empty string`);
    return x.trim();
  };
  const id = text('id');
  const policy = text('risk_policy');
  if (!MODES.includes(policy as Mode)) throw new Error(`AHD_VENDOR_JSON.risk_policy must be one of ${MODES.join(', ')}`);
  const contacts = r['report_contacts'];
  if (!Array.isArray(contacts) || contacts.some((c) => typeof c !== 'string')) {
    throw new Error('AHD_VENDOR_JSON.report_contacts must be an array of strings');
  }
  const payer = r['payer_mode'] === 'agent' ? 'agent' : 'vendor';
  const vendor: Vendor = {
    id,
    name: typeof r['name'] === 'string' && r['name'].length > 0 ? r['name'] : id,
    repo_url: typeof r['repo_url'] === 'string' ? r['repo_url'] : '',
    sandbox_name: typeof r['sandbox_name'] === 'string' && r['sandbox_name'].length > 0 ? r['sandbox_name'] : `ahd-vendor-${id}`,
    risk_policy: policy as Mode,
    stripe_customer_id: typeof r['stripe_customer_id'] === 'string' ? r['stripe_customer_id'] : '',
    payer_mode: payer,
    report_contacts: contacts as string[],
  };
  if (typeof r['test_command'] === 'string' && r['test_command'].length > 0) vendor.test_command = r['test_command'];
  if (r['agent_pay_rail'] === 'mpp' || r['agent_pay_rail'] === 'x402') vendor.agent_pay_rail = r['agent_pay_rail'];
  if (r['billing_exempt'] === true) vendor.billing_exempt = true;
  return vendor;
}

/** Loop overrides selected by the environment. Empty object means "all stand-ins, as before". */
export function liveLoopDeps(env: NodeJS.ProcessEnv = process.env): Pick<LoopDeps, 'draft' | 'provision' | 'freshBaseline'> {
  const out: Pick<LoopDeps, 'draft' | 'provision' | 'freshBaseline'> = {};
  if (env['AHD_RESOLVER'] === 'claude') out.draft = makeClaudeResolver();
  const dir = env['AHD_PROVISION_DIR'];
  if (typeof dir === 'string' && dir.length > 0) {
    out.provision = makeProvisioner({ dir, anthropicKey: env['ANTHROPIC_API_KEY'] ?? '' });
  }
  if (env['AHD_FRESH_BASELINE'] === '1') out.freshBaseline = true;
  return out;
}

export async function seedLiveVendor(repo: Repository, env: NodeJS.ProcessEnv = process.env): Promise<Vendor | null> {
  const raw = env['AHD_VENDOR_JSON'];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const vendor = parseVendorJson(raw);
  await repo.putVendor(vendor);
  return vendor;
}

export interface RuntimeComponent {
  name: string;
  real: boolean;
  detail: string;
}

/** What is real and what is not, computed from the environment. No secrets are returned. */
export function runtimeReport(env: NodeJS.ProcessEnv = process.env): { all_real: boolean; components: RuntimeComponent[] } {
  const sandboxReal = env['AHD_SANDBOX_FAKE'] !== '1' && Boolean(env['BLAXEL_API_KEY']);
  const proofsFake = env['AHD_PROOFS_FAKE'] === '1' || env['AHD_SEED'] === 'demo';
  const hasAnthropic = Boolean(env['ANTHROPIC_API_KEY']);
  const components: RuntimeComponent[] = [
    {
      name: 'sandbox',
      real: sandboxReal,
      detail: sandboxReal ? `Blaxel, image ${env['AHD_SANDBOX_IMAGE'] ?? 'default'}` : 'in-memory fake: runs no commands',
    },
    {
      name: 'reproduction',
      real: sandboxReal && Boolean(env['AHD_REPRO_COMMAND']) && env['AHD_REPRO_EXPECT'] === 'nonzero',
      detail: env['AHD_REPRO_COMMAND'] ? `runs '${env['AHD_REPRO_COMMAND']}' in the sandbox, expects a non-zero exit` : 'no AHD_REPRO_COMMAND set',
    },
    {
      name: 'resolver',
      real: env['AHD_RESOLVER'] === 'claude' && hasAnthropic,
      detail: env['AHD_RESOLVER'] === 'claude' ? `Claude (${env['AHD_RESOLVER_MODEL'] ?? 'claude-sonnet-5-5'}) reads the vendor files` : 'deterministic template',
    },
    {
      name: 'vendor_tests',
      real: sandboxReal && Boolean(env['AHD_VENDOR_TEST_COMMAND'] || env['AHD_VENDOR_JSON']?.includes('test_command')),
      detail: 'the vendor test command runs in the sandbox',
    },
    {
      name: 'fresh_agent',
      real: sandboxReal && hasAnthropic && !proofsFake && Boolean(env['AHD_PROVISION_DIR']),
      detail: 'a clean-context Claude call made from a forked sandbox',
    },
    {
      name: 'billing',
      real: Boolean(env['STRIPE_SECRET_KEY']) && env['AHD_BILLING_FAKE'] !== '1',
      detail: env['STRIPE_SECRET_KEY'] ? 'Stripe meter events' : 'no STRIPE_SECRET_KEY: meter events are not sent to Stripe',
    },
    {
      name: 'approval_channel',
      real: Boolean(env['INKBOX_API_KEY']) && env['AHD_APPROVALS_FAKE'] !== '1',
      detail: env['INKBOX_API_KEY'] ? 'Inkbox send_text (its email call is undocumented)' : 'no INKBOX_API_KEY: approval emails are not sent; use POST /v1/approvals reply',
    },
  ];
  return { all_real: components.every((c) => c.real), components };
}

/** REHEARSAL ONLY: AHD_LOCAL_SANDBOX_DIR swaps in demo/local-runner.ts (a temp-directory sandbox that
 * runs real commands without isolation). runtimeReport() still reports the sandbox as NOT real. */
export async function localRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Pick<LoopDeps, 'runner'>> {
  const dir = env['AHD_LOCAL_SANDBOX_DIR'];
  if (typeof dir !== 'string' || dir.length === 0) return {};
  const specifier = '../demo/local-runner.ts'; // non-literal: product/ must not depend on demo/ at load time
  const mod = (await import(specifier)) as { makeLocalRunner: (base: string) => NonNullable<LoopDeps['runner']> };
  return { runner: mod.makeLocalRunner(dir) };
}
