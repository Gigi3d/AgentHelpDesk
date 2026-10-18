// Test environment for desk/. Imported FIRST by desk.test.ts so the fake
// selectors are set before any module under test reads them (ESM evaluates
// imports before the importing module's body, so setting env inside the test
// file would be too late for a module that reads env at import time).
//
// No secrets here: these are behaviour switches only.
process.env['AHD_SANDBOX_FAKE'] = '1';
process.env['AHD_PROOFS_FAKE'] = '1';
// The local approval stub must not inherit a hostile or stale decision.
process.env['AHD_APPROVAL_STUB_DECISION'] = 'yes';
// Keep the loop fast and deterministic under test.
process.env['AHD_SANDBOX_TIMEOUT_MS'] = '5000';
process.env['AHD_LOOP_BUDGET_MS'] = '60000';
process.env['AHD_MAX_ATTEMPTS'] = '3';
process.env['AHD_REPRO_EXPECT'] = 'any';
process.env['AHD_LOG_BASE_URL'] = 'https://logs.test.invalid';
// billing/ owns the Stripe meter; desk only writes the ToolEvent.
process.env['AHD_DESK_METER'] = '0';

export {};
