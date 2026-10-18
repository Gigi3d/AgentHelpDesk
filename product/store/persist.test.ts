import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository } from './memory.ts';
import { withPersistence } from './persist.ts';

const vendor = { id: 'v1', name: 'V', risk_policy: 'approve_first', report_contacts: ['a@b.c'], test_command: 'true', stripe_customer_id: '', payer_mode: 'vendor' } as never;

test('a restart restores what was written', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ahd-persist-')), 'cases.json');
  const a = withPersistence(new MemoryRepository(), file, 5);
  await a.putVendor(vendor);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, 'utf8'), /"v1"/);
  const b = withPersistence(new MemoryRepository(), file, 5);
  assert.equal((await b.getVendor('v1'))?.name, 'V');
});

test('no file configured: plain repository, nothing written', async () => {
  const repo = new MemoryRepository();
  assert.equal(withPersistence(repo, undefined), repo);
});

test('a corrupt file is moved aside and the desk starts empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahd-persist-'));
  const file = join(dir, 'cases.json');
  const { writeFileSync, readdirSync } = await import('node:fs');
  writeFileSync(file, '{not json');
  const r = withPersistence(new MemoryRepository(), file, 5);
  assert.equal(await r.getVendor('v1'), null);
  assert.ok(readdirSync(dir).some((n) => n.includes('corrupt')));
});
