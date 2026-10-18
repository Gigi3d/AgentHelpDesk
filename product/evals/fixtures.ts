// The document bundle a simulated fresh agent is allowed to read, plus the error
// body it starts from. These are the ONLY inputs the fresh agent gets: no resolver
// reasoning, no diff, no fix steps (see the leak guard in ./install-eval.ts).
//
// PROVENANCE — mirrored by hand from surfaces another module owns. If a source
// changes, this copy must change too (drift is the known weakness; the README says so):
//   * llms.txt ............... web/src/pages/Install.tsx (rung 1 `llms` template) and
//                              AgentHelpDesk Frontend and Product Surface Plan.md
//                              §"The agent help page" ("A line in llms.txt and the docs
//                              footer points here").
//   * error body + help field  Frontend and Product Surface Plan.md §"The error body gets
//                              a help field", and `withHelp()` in web/src/pages/Install.tsx.
//   * help page (JSON twin) ... web/src/data/help_page.json. Plan §"The agent help page":
//                              "Plain Markdown with a JSON twin at the same path, no
//                              scripts and no login."
//   * rung 4 install artifacts . web/src/pages/Install.tsx rung 4: `npx agenthelpdesk init`,
//                              agenthelpdesk.json, src/errors/help.ts, llms.txt,
//                              .github/workflows/agenthelpdesk.yml.
//
// No secrets: every URL is the demo vendor's `.example` domain used by the seeded fixtures.

export const DESK_HELP_URL = 'https://help.ledgerly.example/agents';
export const DESK_MCP_SERVER = 'https://ledgerly-desk.manufact.app/mcp';
export const DESK_TOOL = 'report_problem';

/** The help page's JSON twin, as an agent would fetch it (plan §"The agent help page"). */
export const HELP_PAGE_JSON: Record<string, unknown> = {
  provider: 'Ledgerly',
  version: '2026-10-18',
  how_to_ask: {
    mcp: { server: DESK_MCP_SERVER, tool: DESK_TOOL },
    http: 'POST https://help.ledgerly.example/agents/cases',
    email: 'desk@ledgerly.example',
  },
  identify_yourself: {
    header: 'AHD-Agent-Id',
    optional: true,
    why: 'So we can tell you when a fix you needed has shipped.',
  },
  commitments: {
    blocked_order: { ack_within: '5m', resolve_within: '1h' },
    default: { ack_within: '15m', resolve_within: '4h' },
    on_breach: 'case.breached_sla is pushed and a human is paged.',
  },
  can_change: ['docs', 'error text', 'OpenAPI descriptions', 'test-key config', 'bounded grants listed under authority'],
  cannot_change: ['your account limits', 'prices', 'anything outside an authority envelope'],
  authority: [
    {
      verb: 'POST /v1/entitlements/{id}/reissue',
      status: 'live',
      per_user: 1,
      cap_usd_per_case: 30,
      idempotency_key: 'required',
    },
  ],
  push_topics: ['case.acknowledged', 'case.needs_user_input', 'case.resolved', 'case.breached_sla'],
  handoff: 'POST /cases/{id}/handoff brings a human into the same thread with the full transcript.',
  delete_user_data: 'DELETE /v1/users/{id}/data returns a confirmation receipt.',
  known_issues_fixed: [
    { case: 'ahd_01JBG7PA1M', summary: 'Quickstart used x-api-key. Use Authorization: Bearer.' },
    { case: 'ahd_01JBGM9W2E', summary: 'Entry date must be YYYY-MM-DD. The 422 now names the field.' },
  ],
  human_fallback: 'support@ledgerly.example (a person reads this, even when the desk is down)',
};

/** Rung 4 only: the repo-side install path an agent must find before it can open a PR. */
const RUNG4_INSTALL_MD = `# Installing AgentHelpDesk (rung 4)

Run one command, or paste the prompt into your coding agent:

    npx agenthelpdesk init

It opens one pull request with four files and does not merge it:

    agenthelpdesk.json                     every setting in one reviewable place
    src/errors/help.ts                     adds the help field to error responses
    llms.txt                               agents read this first
    .github/workflows/agenthelpdesk.yml    re-runs the regression tests on every PR

Agent prompt: "Install AgentHelpDesk on this repo. Read
https://agenthelpdesk.dev/llms.txt and follow the steps. Open a pull request; do not merge it."
`;

const LLMS_TXT = `# Ledgerly
> Agents: if a call fails, call report_problem (MCP) or POST /agents/cases.
> Help for agents: ${DESK_HELP_URL}
`;

/** One document the fresh agent may read. `body` is exactly what it sees, nothing more. */
export interface FreshAgentDoc {
  name: string;
  url: string;
  body: string;
}

/** Default bundle: rungs 0-3 need the first three; rung 4 also needs the install doc. */
export const DEFAULT_INSTALL_DOCS: readonly FreshAgentDoc[] = [
  { name: 'llms.txt', url: 'https://ledgerly.example/llms.txt', body: LLMS_TXT },
  { name: 'help_page.json', url: DESK_HELP_URL, body: `${JSON.stringify(HELP_PAGE_JSON, null, 2)}\n` },
  { name: 'install.md', url: 'https://agenthelpdesk.dev/docs/install', body: RUNG4_INSTALL_MD },
];

/**
 * The failing response the agent is holding when the eval starts: a 422 with the
 * rung 1 `help` field attached. This is the "error body" half of the plan's rule
 * "a clean agent with only the help page and the error body".
 */
export const DEFAULT_ERROR_BODY: Record<string, unknown> = {
  status: 422,
  error: { code: 'invalid_request', message: 'date must be an ISO-8601 timestamp' },
  help: {
    desk: DESK_HELP_URL,
    tool: DESK_TOOL,
    request_id: 'req_test_0001',
    hint: 'If this keeps failing, call report_problem with this request_id.',
  },
};

/** Printed on every response and stored on every event. Do not soften this wording. */
export const DISCLAIMER =
  'Simulated fresh-agent eval. The "agent" is a deterministic policy that may use only the documents it is given; ' +
  'it is not a real LLM run. A pass is evidence about our docs — every affordance an agent needs to install and open ' +
  'a first ticket is present and reachable — and is NOT proof that real coding agents pick the desk.';
