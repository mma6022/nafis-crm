/** INCALL-FIX step 3 (flag.after_call_skip_missed): missed incoming in «کارهای امروز».
 *  Armita daily-customer-inline v1.1 inbound scene + review r2 (incall-fix-step3/REVIEW.md):
 *  «بی‌پاسخ» badge and «تماس دوباره»; no «·» next to digits (time on its own line, then «ورودی؛ بی‌پاسخ»);
 *  full LTR phone with copy (CallNumber, server already scopes to the expert's own customers);
 *  copyable grey #id badge after the name (CustomerName); flat primary button (no heavy shadow).
 *  Flag off → the endpoint returns {enabled:false} and this renders nothing (no extra chrome).
 *  Optional per-call note and moving this list into the right column are out of scope (daily-customer-inline v1.1). */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PhoneCall } from 'lucide-react';
import { faClock, faNum } from '@/features/call-queue/api';
import { CallNumber } from '@/features/call-number/CallNumber';
import { CustomerName } from '@/components/customer/CustomerName';
import { VoipCallAnywhere } from '@/features/voip-call/VoipAnywhere';
import { VCA_REDIAL_LABEL } from '@/features/voip-call/anywhere-rules';
import { useVcMe, vcApi, VcError, VC_ME_KEY } from '@/features/voip-call/api';
import './missed-incoming-today.css';

export const MIT_KEY = ['voip', 'after-call', 'missed-today'] as const;

export type MitItem = {
  id: number; startedAt: string; status: string; statusLabel: string;
  customerId: number; customerName: string; phone: string | null;
};
export type MitPayload = { enabled: boolean; items: MitItem[] };

async function loadMissedToday(): Promise<MitPayload> {
  const res = await fetch('/api/voip/after-call/missed-today', { credentials: 'include', headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) return { enabled: false, items: [] };
  if (!res.ok) throw new Error('لیست تماس‌های بی‌پاسخ بارگذاری نشد.');
  const data = await res.json() as MitPayload;
  return { enabled: data?.enabled === true, items: Array.isArray(data?.items) ? data.items : [] };
}

export function MissedIncomingToday() {
  const q = useQuery({ queryKey: MIT_KEY, queryFn: loadMissedToday, refetchInterval: 15_000, retry: false });
  if (!q.data?.enabled) return null;
  const items = q.data.items;
  return <section className="mit-today" data-testid="mit-today">
    <h2>تماس‌های بی‌پاسخ امروز <span className="mit-cnt">{faNum(items.length)}</span></h2>
    {q.isError ? <p className="mit-err" role="alert" data-testid="mit-err">لیست تماس‌های بی‌پاسخ بارگذاری نشد.</p> : null}
    {!items.length ? <p className="mit-empty" data-testid="mit-empty">تماس بی‌پاسخ امروز برای مشتری‌های تو ثبت نشده است.</p> : (
      <ul className="mit-in">
        {items.map((it) => <MissedRow key={it.id} it={it} />)}
      </ul>
    )}
  </section>;
}

function MissedRow({ it }: { it: MitItem }) {
  const qc = useQueryClient();
  const me = useVcMe().data;
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const vcOn = Boolean(me?.on);
  const anywhere = Boolean((me as { anywhere?: boolean } | undefined)?.anywhere);
  const redialVoip = async () => {
    if (busy) return; setBusy(true); setMsg('');
    try { await vcApi.start({ customerId: it.customerId, fileId: null }); void qc.invalidateQueries({ queryKey: VC_ME_KEY }); }
    catch (e) { setMsg(e instanceof VcError ? e.message : 'تماس گرفته نشد؛ دوباره بزن.'); }
    finally { setBusy(false); }
  };
  const when = faClock(it.startedAt);
  return <li className="mit-incall" data-testid="mit-row" data-id={it.id}>
    <div className="mit-cmeta">
      <CustomerName id={it.customerId} name={it.customerName} href={`/customers/${it.customerId}`} className="mit-who" badgeTestId={`mit-id-${it.id}`} />
      <span className="mit-when" data-testid="mit-when">امروز، ساعت {when}</span>
      <span className="mit-dir">ورودی؛ <span className="mit-res" data-testid="mit-badge">{it.statusLabel || 'بی‌پاسخ'}</span></span>
      {it.phone ? <CallNumber phone={it.phone} customerId={it.customerId} size="md" testId={`mit-ph-${it.id}`} /> : null}
    </div>
    {anywhere ? <VoipCallAnywhere customerId={it.customerId} customerName={it.customerName} own label={VCA_REDIAL_LABEL} testId={`mit-vca-${it.id}`} />
      : vcOn ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void redialVoip()} data-testid={`mit-redial-${it.id}`}><PhoneCall size={15} aria-hidden="true" />تماس دوباره</button>
      : it.phone ? <a className="btn btn-primary" href={`tel:${it.phone}`} data-testid={`mit-tel-${it.id}`}>تماس دوباره</a>
      : null}
    {msg ? <p className="mit-err" role="alert">{msg}</p> : null}
  </li>;
}
