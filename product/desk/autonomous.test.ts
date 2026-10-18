import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateWouldNeedApproval } from './gate.ts';

test('autonomous policy never asks a human, even for a grant', () => {
  for (const k of ['docs', 'error_text', 'code', 'config', 'schema', 'grant'] as const) {
    assert.equal(gateWouldNeedApproval('autonomous', k), false);
  }
  assert.equal(gateWouldNeedApproval('approve_first', 'docs'), true);
});
