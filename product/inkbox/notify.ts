// inkbox/notify.ts: tells people and agents what happened, once.
//
// A sweep reads the cases and, for each state worth a message, sends it and records a `notify.*`
// event so the same message is never sent twice, even across restarts (events are persisted).
//   escalated  email the vendor's contact: a person has to look; link to the Case Theater
//   resolved   email the vendor's contact: fixed and verified
//   a2a / email cases also get the final answer on the channel the agent used
import { recordStage } from '../desk/obs.ts';
import type { InkboxClient } from '../approvals/inkbox-client.ts';
import type { Repository } from '../store/repository.ts';
import type { Failure } from '../shared/types.ts';
import type { A2AClient } from './a2a.ts';

export interface NotifyDeps {
  repo: Repository;
  mailer: InkboxClient;
  a2a: A2AClient;
  env?: Record<string, string | undefined>;
}

const DONE = new Set(['answered', 'shipped', 'closed']);

async function summaryOf(repo: Repository, f: Failure): Promise<string> {
  const evs = await repo.toolEvents({ ticket_id: f.id });
  const drafted = [...evs].reverse().find((e) => e.action === 'case.fix_drafted');
  const p = (drafted?.payload ?? {}) as { summary?: string };
  const attempt = await repo.latestAttempt(f.id);
  const proofs = attempt ? `replay ${attempt.proof_replay ? 'passed' : 'failed'}, vendor tests ${attempt.proof_vendor_tests ? 'passed' : 'failed'}, fresh agent ${attempt.proof_fresh_agent ? 'passed' : 'failed'}` : 'no proofs recorded';
  return `${p.summary ?? 'A fix was drafted.'}\nProofs: ${proofs}.`;
}

async function reasonOf(repo: Repository, f: Failure): Promise<string> {
  const evs = await repo.toolEvents({ ticket_id: f.id, action: 'case.escalated' });
  const last = evs[evs.length - 1];
  const p = (last?.payload ?? {}) as { reason?: string; detail?: string };
  return p.reason ?? p.detail ?? 'the desk could not prove a fix on its own';
}

export async function sweep(deps: NotifyDeps, skip: Set<string> = new Set()): Promise<{ sent: number }> {
  const env = deps.env ?? process.env;
  const base = (env['AHD_PUBLIC_URL'] ?? '').replace(/\/+$/, '');
  const link = (id: string) => (base ? `${base}/theater/${id}` : `case ${id}`);
  const handle = (env['AHD_INKBOX_HANDLE'] ?? 'agenthelpdesk').trim();
  let sent = 0;
  for (const f of await deps.repo.listFailures()) {
    if (skip.has(f.id)) continue;
    if (f.status !== 'escalated' && !DONE.has(f.status)) continue;
    const evs = await deps.repo.toolEvents({ ticket_id: f.id, tool: 'inkbox' });
    const did = (a: string) => evs.some((e) => e.action === a && e.result === 'ok');
    const vendor = await deps.repo.getVendor(f.vendor_id);
    const to = (vendor?.report_contacts.find((c) => c.includes('@')) ?? env['AHD_APPROVALS_FALLBACK_EMAIL'] ?? '').trim();
    const record = (action: string, payload: Record<string, unknown>, result = 'ok') =>
      recordStage(deps.repo, { ticketId: f.id, stage: f.status, tool: 'inkbox', action, result, payload });
    const guarded = async (action: string, fn: () => Promise<Record<string, unknown>>) => {
      try {
        await record(action, await fn());
        sent += 1;
      } catch (err) {
        await record(action, { error: err instanceof Error ? err.message : String(err) }, 'error');
      }
    };

    if (f.status === 'escalated' && to && !did('notify.escalated')) {
      await guarded('notify.escalated', async () => {
        const r = await deps.mailer.sendEmail(to, `AgentHelpDesk: case ${f.id} needs a person`, `The desk could not close this case on its own.\n\nTask: ${f.task}\nWhy: ${await reasonOf(deps.repo, f)}\nCommitted resolve time: ${f.resolve_by}\n\nWatch or take over: ${link(f.id)}`);
        return { to: to.replace(/^(.).*(@.*)$/, '$1***$2'), message_id: r.message_id, fake: r.fake };
      });
    }
    if (DONE.has(f.status) && to && !did('notify.resolved')) {
      await guarded('notify.resolved', async () => {
        const r = await deps.mailer.sendEmail(to, `AgentHelpDesk: case ${f.id} is fixed and verified`, `${await summaryOf(deps.repo, f)}\n\nTask: ${f.task}\nDetails: ${link(f.id)}`);
        return { to: to.replace(/^(.).*(@.*)$/, '$1***$2'), message_id: r.message_id, fake: r.fake };
      });
    }

    const ref = f.channel_ref ?? '';
    if (ref.startsWith('a2a:') && !did('notify.a2a_final')) {
      const [, h, taskId] = ref.split(':');
      if (taskId) {
        await guarded('notify.a2a_final', async () => {
          if (f.status === 'escalated') await deps.a2a.reply(h || handle, taskId, 'fail', `A person has this case. Committed to resolve by ${f.resolve_by}. ${link(f.id)}`);
          else await deps.a2a.reply(h || handle, taskId, 'complete', `${await summaryOf(deps.repo, f)}\nApply the fix, retry your original call, then report the result with report_retry_result on case ${f.id}.`);
          return { task_id: taskId, fake: deps.a2a.fake };
        });
      }
    }
    if (ref.startsWith('email:') && !did('notify.email_final')) {
      const sender = ref.split(':').slice(2).join(':');
      if (sender.includes('@')) {
        await guarded('notify.email_final', async () => {
          const body = f.status === 'escalated' ? `A person has this case. Committed to resolve by ${f.resolve_by}.` : `${await summaryOf(deps.repo, f)}\n\nApply the fix and retry your original call.`;
          const r = await deps.mailer.sendEmail(sender, `Re: case ${f.id}`, body);
          return { message_id: r.message_id, fake: r.fake };
        });
      }
    }
  }
  return { sent };
}

/**
 * Run the sweep on a timer. Cases already finished when the desk starts are remembered and never
 * announced, so a restart or a first deploy does not email about old work. The timer never keeps
 * the process alive and never throws.
 */
export function startNotifier(deps: NotifyDeps, everyMs = 5000): () => void {
  const skip = new Set<string>();
  let busy = false;
  let first = true;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    (async () => {
      if (first) {
        first = false;
        for (const f of await deps.repo.listFailures()) {
          if (f.status === 'escalated' || DONE.has(f.status)) skip.add(f.id);
        }
        return;
      }
      await sweep(deps, skip);
    })()
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
