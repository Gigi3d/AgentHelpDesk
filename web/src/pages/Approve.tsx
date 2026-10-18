import { Link, useParams } from 'react-router-dom';
import { useStore } from '../lib/store';
import { clock } from '../lib/clock';
import { Button, Card, ProofIcon, StageChip } from '../components/ui';
import { Toasts } from '../components/Shell';

/** The approval text as the approver sees it on their phone, plus the signed one-ticket link. */
export default function Approve() {
  const { id = '' } = useParams();
  const { ticket, eventsFor, approve, reject } = useStore();
  const t = ticket(id);
  if (!t) return <div className="p-10">Unknown ticket.</div>;
  const evs = eventsFor(id);
  const sent = evs.find((e) => e.action === 'text.sent');
  const reply = evs.find((e) => e.action === 'text.reply' || e.action === 'decision.approved' || e.action === 'decision.rejected');
  const waiting = t.stage === 'awaiting_approval';
  const body = (sent?.payload.body as string) ?? `Ledgerly desk: ${t.fix.summary} 3 of 3 proofs passed. Reply YES or NO.`;

  return (
    <div className="min-h-screen bg-surface px-4 py-10">
      <div className="mx-auto mb-6 flex max-w-[860px] items-center justify-between">
        <Link to={`/app/tickets/${id}`} className="text-[13px] text-muted hover:text-ink">← Back to the ticket</Link>
        <span className="text-[13px] text-muted">Approve from a phone in about ten seconds</span>
      </div>
      <div className="mx-auto grid max-w-[860px] items-start gap-10 md:grid-cols-2">
        <div className="mx-auto w-[320px] rounded-[44px] border-[10px] border-ink bg-white p-0 shadow-pop">
          <div className="flex items-center justify-center gap-2 border-b border-line py-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-[11px] font-bold text-white">L</div>
            <div className="text-[13px] font-semibold">Ledgerly desk</div>
          </div>
          <div className="flex min-h-[420px] flex-col gap-2 px-3 py-4">
            <div className="text-center text-[11px] text-muted">Text message · {sent ? clock(sent.at) : 'now'}</div>
            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-surface px-3 py-2 text-[13.5px] leading-snug text-ink">{body}</div>
            {reply && <div className="ml-auto max-w-[70%] rounded-2xl rounded-br-md bg-blue px-3 py-2 text-[13.5px] text-white">{reply.action === 'decision.rejected' ? 'NO' : 'YES'}</div>}
            {reply && !waiting && <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-surface px-3 py-2 text-[13.5px] text-ink">{t.stage === 'rejected' ? 'Rejected. A person has the case. Nothing billed.' : 'Done. Shipped, and the agent’s retry succeeded.'}</div>}
            <div className="mt-auto flex gap-2 pt-4">
              <button disabled={!waiting} onClick={() => approve(id, 'Gideon (text)')} className="flex-1 rounded-full bg-blue py-2 text-[14px] font-semibold text-white disabled:opacity-40">YES</button>
              <button disabled={!waiting} onClick={() => reject(id, 'Rejected by text')} className="flex-1 rounded-full border border-line py-2 text-[14px] font-semibold text-ink disabled:opacity-40">NO</button>
            </div>
            <p className="text-center text-[11px] text-muted">Anything else opens a thread with the desk.</p>
          </div>
        </div>

        <div>
          <div className="mb-2 text-label font-medium uppercase text-muted">Signed link · scoped to this ticket</div>
          <Card className="p-5">
            <StageChip stage={t.stage} />
            <h1 className="mt-2 text-[18px] font-semibold leading-snug">{t.fix.summary}</h1>
            <p className="mt-2 text-[14px] text-muted">{t.cause}</p>
            <div className="mt-4 space-y-2">
              {Object.entries(t.proofs).map(([k, p]) => <div key={k} className="flex items-center gap-2 text-[13.5px]"><ProofIcon s={p.status} size={16} />{k.replace('_', ' ')}</div>)}
            </div>
            {waiting ? (
              <div className="mt-5 flex gap-2">
                <Button variant="primary" className="flex-1" onClick={() => approve(id, 'Gideon (signed link)')}>Approve and send</Button>
                <Button onClick={() => reject(id, 'Rejected from the signed link')}>Reject</Button>
              </div>
            ) : (
              <p className="mt-5 text-[14px] font-medium text-ink">Decision recorded. <Link className="text-blue hover:underline" to={`/app/tickets/${id}`}>See the ticket</Link></p>
            )}
          </Card>
          <p className="mt-3 text-[12.5px] text-muted">Opens without a full login. The signature expires after one decision.</p>
        </div>
      </div>
      <Toasts />
    </div>
  );
}
