/** Part 5 (design simotel v1.2 scenes 34–35): «تماس‌های بی‌پاسخ امروز» in «کارهای امروز من». One row per number; separate from «درخواست‌های تماس».
 *  Never bypasses a lock: a number that is today's task opens that task card (its turn), an open callback opens the callback, and «تماس دوباره»
 *  goes through the server's one-call / result / lockdown checks. Renders nothing while flag.voip_missed is off. */
import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Lock, PhoneMissed, PhoneOutgoing, RefreshCw } from 'lucide-react';
import { CallNumber } from '@/features/call-number/CallNumber';
import { fa, hm, viApi, viRefresh, ViError, type ViMissed, type ViMissedItem } from './api';
import { NewCustomerInline } from './NewCustomerInline';
import './vi.css';

export function MissedLink({ d, onOpen }: { d: ViMissed | undefined; onOpen: () => void }) {
  if (!d?.on || !d.count) return null;
  return <button type="button" className="vi vi-mlink" onClick={onOpen} data-testid="vi-missed-link"><PhoneMissed className="i" aria-hidden="true" />{fa(d.count)} تماس بی‌پاسخ امروز</button>;
}

export function MissedCard({ d, curPos, onTask }: { d: ViMissed | undefined; curPos: number | null; onTask: () => void }) {
  if (!d?.on) return null;
  const items = d.items ?? [];
  return <section className="vi card vi-mc" id="vi-missed" aria-labelledby="vi-mc-h" data-testid="vi-missed" tabIndex={-1}>
    <div className="vi-mch"><h3 id="vi-mc-h"><PhoneMissed className="i" aria-hidden="true" /> تماس‌های بی‌پاسخ امروز</h3><span className="vi-badge" data-testid="vi-missed-count">{fa(items.length)}</span></div>
    <p className="muted">هر شماره یک ردیف؛ جدا از «درخواست‌های تماس». بعد از جواب دادن یا تماس دوباره‌ی موفق، از این لیست می‌رود.</p>
    {d.lock ? <p className="vi-ln vi-lockn" role="note" data-testid="vi-missed-lock" data-code={d.lock.code}><Lock className="i" aria-hidden="true" /><span>{d.lock.reason}</span></p> : null}
    {items.length ? <ol className="vi-ml">{items.map((i) => <MissedRow key={i.eventId} i={i} voip={Boolean(d.voip)} curPos={curPos} onTask={onTask} />)}</ol>
      : <p className="vi-empty" data-testid="vi-missed-empty">امروز تماس بی‌پاسخی نمانده.</p>}
  </section>;
}

function MissedRow({ i, voip, curPos, onTask }: { i: ViMissedItem; voip: boolean; curPos: number | null; onTask: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const redial = async () => { setBusy(true); setMsg(null);
    try { await viApi.redial(i.eventId); setMsg({ ok: true, t: 'تماس شروع شد: اول تلفن ویپ شما زنگ می‌خورد؛ جواب بده تا شماره خودکار گرفته شود.' }); }
    catch (e) { setMsg({ ok: false, t: e instanceof ViError ? e.message : 'شروع تماس ناموفق بود.' }); }
    finally { setBusy(false); viRefresh(qc); } };
  const when = i.count > 1 ? `${fa(i.count)} بار، آخرین ${hm(i.lastAt)}` : hm(i.lastAt);
  const note = i.action === 'task' ? (i.taskPos != null && i.taskPos === curPos ? `همین مشتری تسک جاری توست (تسک ${fa(i.taskPos)})؛ تماس از کارت تسک.` : `این مشتری تسک ${fa(i.taskPos ?? 0)} امروز است؛ به نوبتش از کارت تسک تماس بگیر.`)
    : i.action === 'callback' ? 'درخواست تماس باز دارد؛ از همان درخواست پیگیری کن تا دوبار ثبت نشود.'
    : i.kind === 'unknown' ? 'شماره در CRM نیست؛ تماس دوباره بزن یا مشتری جدید بساز.'
    : i.action === 'none' ? 'این مشتری کارشناس دیگری دارد یا بدون کارشناس است؛ از صفحه‌ی مشتری پیگیری کن.' : 'مشتری خودت؛ تماس دوباره از تلفن ویپ.';
  return <li className="vi-mr" data-testid="vi-missed-row" data-kind={i.kind} data-action={i.action}>
    <div className="vi-mrh">{i.customer ? <><b>{i.customer.name}</b> <span className="muted">#{fa(i.customer.id)}</span></> : <b>شماره ناشناس</b>}
      <span className={`chip ${i.type === 'mine' ? 'b' : 'q'}`} data-testid="vi-missed-type">{i.typeLabel}</span>
      <span className="vi-when"><PhoneMissed className="i" aria-hidden="true" />{when}</span></div>
    <p className="muted vi-mn">{note}</p>
    {i.phone ? <div className="vi-phone"><CallNumber phone={i.phone} size="sm" testId="vi-mcn" disabled /></div> : null}
    <div className="vi-acts">
      {i.action === 'task' && i.taskPos != null && i.taskPos === curPos ? <button type="button" className="btn btn-primary vi-b" onClick={onTask} data-testid="vi-missed-task"><ClipboardList size={16} aria-hidden="true" />کارت تسک {fa(i.taskPos)}</button> : null}
      {i.action === 'callback' && i.callbackId != null ? <Link className="btn btn-primary vi-b" href={`/callback-requests?open=${i.callbackId}`} data-testid="vi-missed-cb"><PhoneOutgoing size={16} aria-hidden="true" />باز کردن درخواست تماس</Link> : null}
      {i.action === 'redial' && voip ? <button type="button" className="btn btn-primary vi-b" onClick={() => void redial()} disabled={busy || !i.canRedial} aria-describedby={i.redialReason ? `vi-rr-${i.eventId}` : undefined} data-testid="vi-missed-redial">
        <RefreshCw size={16} aria-hidden="true" />{busy ? 'در حال شروع…' : 'تماس دوباره'}</button> : null}
      {i.canNew ? <NewCustomerInline source="missed" eventId={i.eventId} /> : null}
      {i.customer && i.action === 'none' ? <Link className="btn btn-ghost vi-b" href={`/customers/${i.customer.id}`}>صفحه‌ی مشتری</Link> : null}
    </div>
    {i.action === 'redial' && voip && !i.canRedial && i.redialReason ? <p className="vi-ln muted" id={`vi-rr-${i.eventId}`} data-testid="vi-missed-reason"><Lock className="i" aria-hidden="true" /><span>{i.redialReason}</span></p> : null}
    {i.action === 'redial' && !voip ? <p className="vi-ln muted"><Lock className="i" aria-hidden="true" /><span>داخلی ویپ نداری؛ شماره را کپی کن و با گوشی خودت بگیر.</span></p> : null}
    {msg ? <p className={msg.ok ? 'vi-ok' : 'dp-err'} role={msg.ok ? 'status' : 'alert'} data-testid="vi-missed-msg">{msg.t}</p> : null}
  </li>;
}
