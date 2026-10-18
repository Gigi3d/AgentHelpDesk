import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBlaxelEnv, parseVendorJson, runtimeReport } from './live.ts';
import { makeProvisioner, SECRET_KEY_PATH } from './sandbox/provision.ts';
import type { ExecResult, SandboxHandle } from './shared/types.ts';

const vendorJson = JSON.stringify({ id: 'ledgerly', risk_policy: 'approve_first', report_contacts: ['a@b.test'], test_command: 'npm test' });

test('parseVendorJson builds a vendor and rejects bad input loudly', () => {
  const v = parseVendorJson(vendorJson);
  assert.equal(v.id, 'ledgerly');
  assert.equal(v.sandbox_name, 'ahd-vendor-ledgerly');
  assert.equal(v.test_command, 'npm test');
  assert.throws(() => parseVendorJson('{'), /not valid JSON/);
  assert.throws(() => parseVendorJson(JSON.stringify({ id: 'x', risk_policy: 'yolo', report_contacts: [] })), /risk_policy/);
  assert.throws(() => parseVendorJson(JSON.stringify({ id: 'x', risk_policy: 'auto' })), /report_contacts/);
});

test('normalizeBlaxelEnv mirrors either key name', () => {
  const a: NodeJS.ProcessEnv = { BL_API_KEY: 'k' };
  normalizeBlaxelEnv(a);
  assert.equal(a['BLAXEL_API_KEY'], 'k');
  const b: NodeJS.ProcessEnv = { BLAXEL_API_KEY: 'k2', BLAXEL_WORKSPACE: 'w' };
  normalizeBlaxelEnv(b);
  assert.equal(b['BL_API_KEY'], 'k2');
  assert.equal(b['BL_WORKSPACE'], 'w');
});

test('runtimeReport never calls a stand-in real and leaks no secret', () => {
  const empty = runtimeReport({});
  assert.equal(empty.all_real, false);
  assert.ok(empty.components.every((c) => !c.real));
  const live = runtimeReport({
    BLAXEL_API_KEY: 'SECRETVALUE',
    ANTHROPIC_API_KEY: 'SECRETVALUE2',
    AHD_RESOLVER: 'claude',
    AHD_PROVISION_DIR: '/x',
    AHD_REPRO_COMMAND: 'node /ahd/replay.mjs',
    AHD_REPRO_EXPECT: 'nonzero',
    AHD_VENDOR_JSON: vendorJson,
  });
  for (const n of ['sandbox', 'reproduction', 'resolver', 'vendor_tests', 'fresh_agent']) {
    assert.equal(live.components.find((c) => c.name === n)?.real, true, n);
  }
  assert.ok(!JSON.stringify(live).includes('SECRETVALUE'));
  assert.equal(runtimeReport({ BLAXEL_API_KEY: 'k', AHD_SANDBOX_FAKE: '1' }).components[0]!.real, false);
  assert.equal(runtimeReport({ BLAXEL_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', AHD_PROVISION_DIR: '/x', AHD_PROOFS_FAKE: '1' }).components.find((c) => c.name === 'fresh_agent')?.real, false);
});

test('provisioner uploads the tree, protects the key, and fails loud when proof tools are missing', async () => {
  const written = new Map<string, string>();
  const cmds: string[] = [];
  const handle = (missing: string | null): SandboxHandle => ({
    name: 'ahd-t',
    async exec(cmd): Promise<ExecResult> {
      cmds.push(cmd);
      return { stdout: '', stderr: '', exit_code: missing !== null && cmd.includes(missing) ? 1 : 0 };
    },
    async write(p, c): Promise<void> {
      written.set(p, c);
    },
    async read(): Promise<string> {
      return '';
    },
    async snapshot(): Promise<string> {
      return 's';
    },
  });
  const dir = new URL('../demo/sandbox-root', import.meta.url).pathname;
  await makeProvisioner({ dir, anthropicKey: 'sk-test' })(handle(null), {} as never, 'c1');
  assert.ok(written.has('/ahd/replay.mjs') && written.has('/ahd/work/server.mjs'));
  assert.equal(written.get(SECRET_KEY_PATH), 'sk-test');
  assert.ok(cmds.some((c) => c.startsWith('chmod 600')));
  await assert.rejects(makeProvisioner({ dir })(handle('fresh-agent.mjs'), {} as never, 'c1'), /fresh-agent.mjs is missing/);
});
