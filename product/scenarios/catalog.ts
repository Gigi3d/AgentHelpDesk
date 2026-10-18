// scenarios/catalog.ts: the x402 failures an agent can hit on Ledgerly's paid premium report.
//
// Everything here is SIMULATED and test mode: Ledgerly's "facilitator" is the vendor server in
// demo/sandbox-root/ahd/work/server.mjs, no wallet is touched and nothing is charged. Each
// scenario is one realistic way the vendor's documentation can be wrong about a paid call.
// The scenario id is the error code the agent saw; the sandbox provisioner uses it to pick the
// matching broken quickstart from demo/scenarios/<id>/.
import type { ProblemReport } from '../shared/types.ts';

export interface Scenario {
  id: string;
  title: string;
  /** What the quickstart got wrong, in one sentence. */
  defect: string;
  /** The header or field the agent sent that the API rejected. */
  sent: string;
  message: string;
  /** Part of the default run: four sandboxes per round. The rest run only when named. */
  featured?: boolean;
}

export const SCENARIOS: readonly Scenario[] = [
  { featured: true, id: 'payment_header_missing', title: 'Payment sent in the wrong header', defect: 'The quickstart names the header Payment, the API reads X-PAYMENT.', sent: 'Payment: scheme=exact,...', message: 'Send the payment in the X-PAYMENT header.' },
  { id: 'unsupported_scheme', title: 'Wrong payment scheme', defect: 'The quickstart pays with scheme=upto, the API only takes exact.', sent: 'scheme=upto', message: 'Only the exact scheme is accepted.' },
  { featured: true, id: 'wrong_network', title: 'Mainnet payment on a testnet API', defect: 'The quickstart pays on base, the API settles on base-sepolia.', sent: 'network=base', message: 'This API settles on base-sepolia.' },
  { id: 'wrong_recipient', title: 'Paid the old address', defect: 'The quickstart pays an old pay_to address, not the one in the 402.', sent: 'pay_to=0xLedgerlyOld', message: 'The payment names a different recipient than the one in accepts.' },
  { featured: true, id: 'insufficient_amount', title: 'Short by one decimal place', defect: 'The quickstart pays 1000 base units, the price is 10000.', sent: 'amount=1000', message: 'The price is 10000 base units.' },
  { id: 'nonce_reused', title: 'Replayed nonce', defect: 'The quickstart hardcodes a nonce that was already settled.', sent: 'nonce=n-demo-0001', message: 'That nonce was already settled. Every payment needs a fresh nonce.' },
  { featured: true, id: 'quote_expired', title: 'Stale quote', defect: 'The quickstart hardcodes an old quote id instead of the current one.', sent: 'quote=q-2025-10-01', message: 'That quote is no longer current. Use the quote from the latest 402.' },
];

export const DEFAULT_IDS: readonly string[] = SCENARIOS.filter((s) => s.featured).map((s) => s.id);

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** The report an agent would file after the paid call is refused. */
export function reportFor(s: Scenario, agent: string, key: string): ProblemReport {
  return {
    agent_id: agent,
    task: 'Buy the Ledgerly premium report over x402, exactly as the quickstart shows.',
    request: { method: 'GET', url: 'https://api.ledgerly.test/v1/premium/report', headers: { 'x-payment': `${s.sent} (simulated)` } },
    response: {
      status: 402,
      x402Version: 1,
      error: { code: s.id, message: s.message },
      accepts: [{ scheme: 'exact', network: 'base-sepolia', asset: 'USDC' }],
    },
    channel: 'mcp',
    klass: 'knowledge',
    vendor_hint: 'ledgerly',
    idempotency_key: key,
  };
}
