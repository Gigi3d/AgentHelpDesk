import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, reportFor } from './catalog.ts';
import { scenarioCodeOf } from '../sandbox/provision.ts';
import { existsSync } from 'node:fs';
import { normalizeReport } from '../desk/intake.ts';

test('every scenario has a broken quickstart overlay and files a valid knowledge report', () => {
  for (const s of SCENARIOS) {
    assert.ok(existsSync(new URL(`../../demo/scenarios/${s.id}/ahd/work/docs/quickstart.md`, import.meta.url)), `overlay for ${s.id}`);
    const report = reportFor(s, 'scn:alpha', `k-${s.id}`);
    assert.doesNotThrow(() => normalizeReport(report));
    assert.equal(report.klass, 'knowledge');
  }
});

test('the overlay is chosen from the error code the agent saw, and only a plain slug', () => {
  const f = (code: unknown) => ({ response: { status: 402, error: { code } } }) as never;
  assert.equal(scenarioCodeOf(f('wrong_network')), 'wrong_network');
  assert.equal(scenarioCodeOf(f('../../etc')), null);
  assert.equal(scenarioCodeOf(undefined), null);
});

// The reproduction the desk relies on: with the overlay in place the documented call fails with
// exactly this scenario's error code, and with the one defect corrected it succeeds. Runs the real
// replay harness against the real vendor server, no model involved.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GOOD = 'X-PAYMENT: scheme=exact,network=base-sepolia,amount=10000,pay_to=0xLedgerlyTest,nonce=n-fresh-1,quote=q-current';

for (const s of SCENARIOS) {
  test(`replay: ${s.id} fails as reported, and passes once the quickstart is corrected`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ahd-scn-'));
    cpSync(new URL('../../demo/sandbox-root/ahd', import.meta.url).pathname, join(root, 'ahd'), { recursive: true });
    cpSync(new URL(`../../demo/scenarios/${s.id}/ahd`, import.meta.url).pathname, join(root, 'ahd'), { recursive: true });
    const run = () => spawnSync('node', [join(root, 'ahd/replay.mjs')], { encoding: 'utf8' });
    const before = run();
    assert.equal(before.status, 1, before.stdout + before.stderr);
    assert.match(before.stdout, new RegExp(`"code":"${s.id}"`));
    const doc = join(root, 'ahd/work/docs/quickstart.md');
    const fixed = readFileSync(doc, 'utf8').replace(/-H "[^"]*"/, `-H "${GOOD}"`);
    writeFileSync(doc, fixed);
    const after = run();
    assert.equal(after.status, 0, after.stdout + after.stderr);
    void execFileSync;
  });
}
