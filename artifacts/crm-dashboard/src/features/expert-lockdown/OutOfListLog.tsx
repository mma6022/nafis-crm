/** incoming2-59: the «خارج از لیست» call log for one customer (incoming call) — same request as LockedInbound's own-customer save:
 *  POST /calls { outOfList: true, context: 'out_of_list' } with outcome + one-line note (≤ 80). Used after «ثبت مشتری جدید» and by the carousel wizard. */
import { useState } from 'react';
import { Check, Flag } from 'lucide-react';
import { cqFollowUpAt, CqResultFields, cqResultError, emptyCqResult, type CqResultValue } from '@/features/call-queue/ResultFields';
import { announceCallSaved, faNum, useCqConfig } from '@/features/call-queue/api';
import { dpApi } from '@/features/daily-plan/api';
import { callErrorMessage } from '@/lib/call-error';

export function OutOfListLog({ customer, onSaved, currentNo, idPrefix = 'ool', saveLabel, extra }: {
  customer: { id: number; name: string }; onSaved: (msg: string) => void; currentNo?: number | null; idPrefix?: string; saveLabel?: string; extra?: React.ReactNode;
}) {
  const cq = useCqConfig().data;
  const [val, setVal] = useState<CqResultValue>(emptyCqResult());
  const [show, setShow] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const back = currentNo ? ` · برگشت به کار ${faNum(currentNo)}` : '';
  const save = async () => {
    setShow(true); if (cqResultError(val)) { setErr(''); return; }
    setBusy(true); setErr('');
    try { const one = val.oneLine.trim();
      const r = await dpApi.saveCall({ customerId: customer.id, salespersonId: cq?.salespersonId ?? undefined, subject: 'تماس ورودی', customerRequest: '', expertNotes: one, outcome: val.outcome, call_result: val.manual, oneLineNote: one,
        followUpAt: cqFollowUpAt(val), outOfList: true, context: 'out_of_list' });
      announceCallSaved(r.id, customer.id); onSaved(`${customer.name}: «خارج از لیست» ثبت شد${back}`);
    } catch (e) { const m = callErrorMessage(e); setErr(m !== 'ثبت تماس با خطا مواجه شد. لطفاً دوباره تلاش کنید.' ? m : e instanceof Error && /[\u0600-\u06FF]/.test(e.message) ? e.message : 'ثبت نشد. دوباره تلاش کن.'); }
    finally { setBusy(false); }
  };
  return <div className="dp-result" data-testid={`${idPrefix}-log`}>
    {extra}
    <CqResultFields value={val} onChange={setVal} showErrors={show} idPrefix={idPrefix} />
    <p className="el-xol"><Flag size={13} aria-hidden="true" /> با برچسب «خارج از لیست» ثبت می‌شود؛ در درصد انجام نمی‌آید.</p>
    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()} data-testid={`${idPrefix}-save`}><Check size={15} aria-hidden="true" /> {busy ? 'در حال ثبت…' : saveLabel ?? `ثبت «خارج از لیست»${currentNo ? ` و برگشت به کار ${faNum(currentNo)}` : ''}`}</button>
    {err ? <p className="dp-err" role="alert" data-testid={`${idPrefix}-err`}>{err}</p> : null}
  </div>;
}
