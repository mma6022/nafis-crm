/** Today card numbers while flag.social_hub_v1 is ON (Armita build-r2 §1, §2).
 * Each number is a small card: label, full number (4-3-4, LTR), then equal buttons «تماس | کپی | حذف» (primary: «تماس | کپی»).
 * «افزودن شماره» full width under the cards. Desktop (≥1024) keeps one row per number. Flag OFF → the old CustomerPhonesBlock renders unchanged. */
import { useState } from 'react';
import { AddDialog } from '@/features/customer-phones/CustomerPhones';
import { cphApi, CphError, useCphInvalidate, useCustomerPhones, type ExtraPhone } from '@/features/customer-phones/api';
import { PhoneText, Wizard } from './ui';
import './social-hub.css';

const digits = (p: string) => String(p ?? '').replace(/\D/g, '');

function DelConfirm({ customerId, item, onClose }: { customerId: number; item: ExtraPhone; onClose: () => void }) {
  const invalidate = useCphInvalidate(); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const go = () => { if (busy) return; setBusy(true); setErr('');
    void cphApi.remove(customerId, item.id).then(() => { invalidate(customerId); onClose(); })
      .catch((e) => setErr(e instanceof CphError ? e.message : 'حذف انجام نشد. دوباره تلاش کنید.')).finally(() => setBusy(false)); };
  return <Wizard title="حذف شماره" short onClose={() => { if (!busy) onClose(); }} testId="sh-tph-del-dlg"
    foot={<><button type="button" className="sh-btn ghost" disabled={busy} onClick={onClose}>بازگشت</button>
      <button type="button" className="sh-btn pri" disabled={busy} onClick={go} data-testid="sh-tph-del-yes">{busy ? 'در حال حذف…' : 'حذف شود'}</button></>}>
    <p className="sh-p">شمارهٔ <PhoneText p={item.phone} /> از پروندهٔ مشتری حذف شود؟ شمارهٔ اصلی سر جایش می‌ماند.</p>
    {err ? <p className="sh-msg err" role="alert">{err}</p> : null}
  </Wizard>;
}

export function ShTodayPhones({ customerId, primary, onCopy, onCall }: { customerId: number; primary: string; onCopy: (v: string) => void; onCall: (phone?: string) => void }) {
  const q = useCustomerPhones(customerId); const invalidate = useCphInvalidate();
  const [add, setAdd] = useState(false); const [del, setDel] = useState<ExtraPhone | null>(null);
  const v = q.data; const main = v?.primary.phone || primary;
  const rows: { key: string; label: string; phone: string; x?: ExtraPhone }[] = [];
  if (main) rows.push({ key: 'primary', label: 'شمارهٔ اصلی', phone: main });
  for (const x of v?.extras ?? []) rows.push({ key: String(x.id), label: x.label?.trim() || 'شمارهٔ دیگر', phone: x.phone, x });
  return <div className="sh sh-tph" data-testid="sh-tph">
    {rows.map((r) => <div key={r.key} className={`sh-tph-c${r.x && v?.canDelete ? ' n3' : ''}`} data-testid={`sh-tph-${r.key}`}>
      <div className="sh-tph-n"><span className="sh-lbl">{r.label}</span><b><PhoneText p={r.phone} /></b></div>
      <div className="sh-tph-a">
        <button type="button" className="sh-btn sec sm" onClick={() => onCall(r.phone)} data-testid={`sh-tph-call-${r.key}`}>تماس</button>
        <button type="button" className="sh-btn sec sm" onClick={() => onCopy(digits(r.phone))} data-testid={`sh-tph-copy-${r.key}`}>کپی</button>
        {r.x && v?.canDelete ? <button type="button" className="sh-btn sm sh-del" onClick={() => setDel(r.x!)} data-testid={`sh-tph-del-${r.key}`}>حذف</button> : null}
      </div>
    </div>)}
    {v?.canAdd ? <button type="button" className="sh-btn sec sh-tph-add" onClick={() => setAdd(true)} data-testid="sh-tph-add">افزودن شماره</button> : null}
    {add ? <AddDialog customerId={customerId} onClose={() => setAdd(false)} onSaved={() => invalidate(customerId)} /> : null}
    {del ? <DelConfirm customerId={customerId} item={del} onClose={() => setDel(null)} /> : null}
  </div>;
}
