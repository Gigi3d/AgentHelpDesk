import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from '../store/memory.ts';
import { FakeInkbox } from '../approvals/inkbox-client.ts';
import { FakeA2A, readTask } from './a2a.ts';
import { FakeMailReader } from './mail.ts';
import { handleEvent } from './events.ts';
import { sweep } from './notify.ts';
import type { Vendor } from '../shared/types.ts';

const vendor: Vendor = { id: 'ledgerly', name: 'Ledgerly', repo_url: '', sandbox_name: 'x', risk_policy: 'approve_first', stripe_customer_id: '', payer_mode: 'vendor', report_contacts: ['ops@ledgerly.test'] };
const ENV = { AHD_INKBOX_MAILBOX: 'desk@inkboxmail.com', AHD_INKBOX_HANDLE: 'desk', AHD_APPROVALS_FALLBACK_EMAIL: 'boss@ledgerly.test', AHD_PUBLIC_URL: 'https://desk.test', AHD_DEFAULT_VENDOR: 'ledgerly' };

function rig() {
  const repo = new MemoryRepository();
  const a2a = new FakeA2A();
  const mail = new FakeMailReader();
  const mailer = new FakeInkbox();
  const started: string[] = [];
  const deps = { repo, a2a, mail, mailer, start: async (id: string) => void started.push(id), env: ENV };
  return { repo, a2a, mail, mailer, started, deps };
}

test('readTask finds text and data parts wherever they sit', () => {
  const t = readTask({ id: 't1', status: { state: 'TASK_STATE_SUBMITTED' }, messages: [{ parts: [{ text: 'hello' }, { data: { task: 'x' } }] }] }, 'fallback');
  assert.equal(t.id, 't1');
  assert.equal(t.state, 'TASK_STATE_SUBMITTED');
  assert.deepEqual(t.texts, ['hello']);
  assert.deepEqual(t.data, [{ task: 'x' }]);
});

test('an a2a task becomes a case, starts the loop, and gets a progress reply', async () => {
  const { repo, a2a, started, deps } = rig();
  await repo.putVendor(vendor);
  a2a.tasks.set('task-1', { id: 'task-1', state: 'submitted', texts: [], data: [{ task: 'List my entries', request: { method: 'GET' }, response: { status: 401 }, agent_id: 'agent-x' }] });
  const r = await handleEvent({ event_type: 'a2a.task.created', data: { task_id: 'task-1', requester_handle: 'agent-x' } }, deps);
  assert.equal(r.handled, 'a2a_task');
  const f = await repo.getFailure(r.case_id!);
  assert.equal(f?.channel_ref, 'a2a:desk:task-1');
  assert.equal(f?.agent_id, 'agent-x');
  assert.deepEqual(started, [r.case_id]);
  assert.equal(a2a.replies[0]?.intent, 'progress');
  assert.match(a2a.replies[0]!.text, /acknowledged by/);
  // the same task again is the same case
  const again = await handleEvent({ event_type: 'a2a.task.created', data: { task_id: 'task-1' } }, deps);
  assert.equal(again.case_id, r.case_id);
});

test('only the asked approver can decide by email, and the quoted original is ignored', async () => {
  const { repo, mail, started, deps } = rig();
  await repo.putVendor(vendor);
  const failure = await (await import('../desk/intake.ts')).intake({ agent_id: 'a', task: 't', request: {}, response: { status: 401 }, channel: 'mcp' }, repo);
  await repo.createApproval({ id: 'apv_0123456789ab', failure_id: failure.id, change_summary: 's', channel: 'email', sent_at: new Date().toISOString(), replied_at: null, decision: null, approver: 'ops@ledgerly.test' });

  mail.mails.set('m1', { id: 'm1', from: 'stranger@evil.test', subject: 'Re: approval apv_0123456789ab', text: 'yes' });
  const bad = await handleEvent({ event_type: 'message.received', data: { message: { id: 'm1', from_address: 'stranger@evil.test', subject: 'Re: apv_0123456789ab' } } }, deps);
  assert.equal(bad.handled, 'ignored');
  assert.equal((await repo.getApproval('apv_0123456789ab'))?.decision, null);

  mail.mails.set('m2', { id: 'm2', from: 'ops@ledgerly.test', subject: 'Re: approval apv_0123456789ab', text: 'Yes, ship it\n\nOn Sat wrote:\n> reply NO to refuse' });
  const good = await handleEvent({ event_type: 'message.received', data: { message: { id: 'm2', from_address: 'ops@ledgerly.test', subject: 'Re: apv_0123456789ab' } } }, deps);
  assert.equal(good.handled, 'approval_reply');
  assert.equal((await repo.getApproval('apv_0123456789ab'))?.decision, 'yes');
  assert.deepEqual(started, [failure.id]);
});

test('a problem email opens a case and the sender gets the receipt', async () => {
  const { repo, mail, mailer, deps } = rig();
  await repo.putVendor(vendor);
  mail.mails.set('m9', { id: 'm9', from: 'agent@bot.test', subject: 'quickstart 401', text: 'My GET /v1/entries returns 401 with x-api-key' });
  const r = await handleEvent({ event_type: 'message.received', data: { message: { id: 'm9', from_address: 'agent@bot.test', subject: 'quickstart 401' } } }, deps);
  assert.equal(r.handled, 'email_case');
  assert.equal(mailer.outbound.length, 1);
  assert.equal(mailer.outbound[0]!.to, 'agent@bot.test');
  assert.match(mailer.outbound[0]!.body, /resolved by/);
});

test('the sweep tells the vendor and the a2a caller once, and never twice', async () => {
  const { repo, a2a, mailer, deps } = rig();
  await repo.putVendor(vendor);
  a2a.tasks.set('task-2', { id: 'task-2', state: 'submitted', texts: ['it fails'], data: [] });
  const r = await handleEvent({ event_type: 'a2a.task.created', data: { task_id: 'task-2' } }, deps);
  await repo.setFailureStatus(r.case_id!, 'escalated');
  const out1 = await sweep({ repo, mailer, a2a, env: ENV });
  const out2 = await sweep({ repo, mailer, a2a, env: ENV });
  assert.equal(out1.sent, 2);
  assert.equal(out2.sent, 0);
  assert.equal(mailer.outbound.length, 1);
  assert.match(mailer.outbound[0]!.subject ?? '', /needs a person/);
  assert.ok(a2a.replies.some((x) => x.intent === 'fail'));
});
