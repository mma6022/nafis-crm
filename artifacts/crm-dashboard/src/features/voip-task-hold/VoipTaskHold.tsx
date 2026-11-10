/** VOIP-TASK-HOLD UI (flag.voip_task_hold_v1). Pixel-matched to Armita v1.0 scenes 1–8. Renders nothing while the flag is off. */
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Eye, EyeOff, Headset, Phone, RefreshCw, X } from 'lucide-react';
import { Link } from 'wouter';
import { hm, shortDay } from '@/features/file-detail-v1/fdv1-api';
import { faNum } from '@/features/call-queue/api';
import { VoipCallBox } from '@/features/voip-call/VoipCall';
import { useVcMe, vcRefresh, type VcCall } from '@/features/voip-call/api';
import { useVth, useVthContext, vthApi, vthRefresh, type VthContext, type VthEntry, type VthForm, type VthMe, type VthPhase } from './api';
export { useVth, useVthContext, vthApi, vthRefresh };
import './voip-task-hold.css';
import '../reminder-voip/reminder-voip.css';

const I = { 'aria-hidden': true } as const;
const ENTRY_NAME: Record<VthEntry, string> = { file: 'جزئیات پرونده', carousel: 'گردونه‌ی پرونده‌ها', reminder: 'یادآورها', lead: 'لیدها', search: 'جست‌وجو' };
const OUTS: { k: 'answered' | 'no_answer' | 'follow_up'; l: string }[] = [
  { k: 'answered', l: 'پاسخ داد' }, { k: 'no_answer', l: 'پاسخ نداد' }, { k: 'follow_up', l: 'پیگیری بعدی' },
];

function durFa(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? `${faNum(m)} دقیقه و ${faNum(s)} ثانیه` : `${faNum(s)} ثانیه`;
}

/** «پنجشنبه ۷ آبان ساعت ۱۲:۳۶» in Asia/Tehran, Persian digits. */
export function vthSavedWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const day = shortDay(iso);
  const t = hm(iso);
  return day && t ? `${day} ساعت ${t}` : day || t;
}

/** Compact header button: only a live call stays «در حال تماس». After the call has dropped (pending, error, final, or manual end) it returns to a disabled «تماس». */
export function vthHeadCallLabel(phase: VthPhase | null | undefined): { label: string; disabled: boolean; inCall: boolean } {
  if (phase === 'in_call') return { label: 'در حال تماس', disabled: true, inCall: true };
  if (phase === 'pending_status' || phase === 'status_error' || phase === 'final') return { label: 'تماس', disabled: true, inCall: false };
  return { label: 'تماس', disabled: false, inCall: false };
}

export function VthStatus({ call, vth, onRetry, savedAt, savedCallId }: { call: VcCall | null; vth: VthMe; onRetry?: () => void; savedAt?: string | null; savedCallId?: number | null }) {
  const [confirm, setConfirm] = useState(false);
  const [ending, setEnding] = useState(false);
  const qc = useQueryClient();
  const phase: VthPhase = vth.phase;
  const confirmEnd = async () => {
    if (!call || ending) return;
    setEnding(true);
    try { await vthApi.manualEnd(call.id); setConfirm(false); vthRefresh(qc); vcRefresh(qc); }
    finally { setEnding(false); }
  };
  const endDialog = confirm ? <div className="vh-cfw" role="presentation" data-testid="vth-manual-end-confirm">
    <div className="vh-cf" role="dialog" aria-modal="true" aria-labelledby="vhCfT">
      <h2 id="vhCfT">پایان تماس به‌صورت دستی ثبت شود؟</h2>
      <p>گزارش پایان از سیموتل نرسیده است.</p>
      <div className="vh-cfa">
        <button className="btn pri" type="button" data-testid="vth-manual-end-ok" disabled={ending} onClick={() => void confirmEnd()}>تماس تموم شد</button>
        <button className="btn gh" type="button" data-testid="vth-manual-end-cancel" onClick={() => setConfirm(false)}>انصراف</button>
      </div>
    </div>
  </div> : null;
  if (phase === 'idle' && !call) return null;
  if (phase === 'saved') {
    const id = savedCallId ?? call?.id;
    const when = vthSavedWhen(savedAt ?? (call as any)?.resultSavedAt ?? (call as any)?.result_saved_at);
    const mid = when ? `؛ ${when}` : '';
    const tail = vth.entry === 'carousel' || vth.queue ? '؛ کار جاری تمام شد' : '';
    return <div className="vh-status ok" role="status" data-testid="vth-status" data-phase="saved"><Check className="i" {...I} />
      <div><b>نتیجه روی تماس{id ? <> <bdi dir="ltr">#{faNum(id)}</bdi></> : ''} ثبت شد{mid}{tail}</b></div></div>;
  }
  if (phase === 'final' && (vth.manualEnd || call?.manualEnd)) {
    const who = vth.manualEndExpert || '';
    const when = vthSavedWhen(vth.manualEndedAt || call?.manualEndedAt);
    const bits = ['تماس به‌صورت دستی پایان یافت', who, when].filter(Boolean);
    return <div className="vh-status ok" role="status" data-testid="vth-status" data-phase="final" data-manual-end="1"><Check className="i" {...I} />
      <div><b>{bits.join('؛ ')}</b></div></div>;
  }
  if (phase === 'final') {
    const d = durFa(call?.durationSeconds ?? call?.billsec);
    return <div className="vh-status ok" role="status" data-testid="vth-status" data-phase="final"><Check className="i" {...I} />
      <div><b>قطع کامل؛ وضعیت نهایی: {call?.outcome === 'no_answer' || call?.custStatus && /NO ANSWER|BUSY|FAILED/.test(String(call.custStatus).toUpperCase()) ? 'پاسخ نداد' : 'پاسخ داد'}{d ? `، ${d}` : ''}</b></div></div>;
  }
  if (phase === 'pending_status' || phase === 'status_error') {
    const late = vth.canManualEnd === true;
    return <section className={`vh-status${phase === 'status_error' && !late ? ' err' : ''}`} role="status" data-testid="vth-status" data-phase={phase} data-can-manual-end={late ? '1' : undefined}>
      <Phone className="i" {...I} /><div>
        <b>تماس قطع شد؛ در انتظار وضعیت نهایی</b>
        <p>کار جاری حفظ شده؛ هنوز کار بعدی باز نمی‌شود.</p>
        {phase === 'status_error' ? <><p>وضعیت نهایی دریافت نشد.</p>
          <button className="btn gh sm" type="button" data-testid="vth-retry" onClick={onRetry}><RefreshCw className="i" {...I} />تلاش دوباره برای وضعیت</button></> : null}
        {late ? <><p>گزارش پایان از سیموتل نرسیده است.</p>
          <button className="btn pri vh-end" type="button" data-testid="vth-manual-end" onClick={() => setConfirm(true)}>تماس تموم شد</button></> : null}
      </div>{endDialog}</section>;
  }
  if (phase === 'in_call') {
    const expertUp = call?.state === 'dial_cust' || call?.state === 'in_call';
    return <section className="vh-status" role="status" data-testid="vth-status" data-phase="in_call">
      <Phone className="i" {...I} /><div>
        <b>در حال تماس</b>
        <p>برای قطع از گوشی ویپ استفاده کنید</p>
        {expertUp ? <small>گوشی کارشناس وصل است؛ پاسخ مشتری هنوز تأیید نشده.</small> : null}
      </div></section>;
  }
  return null;
}

export function VthTaskCard({ vth, savedStay }: { vth: VthMe; savedStay?: boolean }) {
  const hold = vth.phase === 'in_call' || vth.phase === 'pending_status' || vth.phase === 'status_error' || vth.phase === 'final';
  const saved = vth.phase === 'saved';
  return <section className="card vh-task" data-testid="vth-task">
    <div className="vh-task-head"><b>{ENTRY_NAME[vth.entry ?? 'file']}</b></div>
    {hold ? <button className="btn gh sm" type="button" disabled data-testid="vth-next-locked">کار بعدی؛ پس از وضعیت نهایی و ثبت نتیجه</button> : null}
    {saved ? <span className="chip s" data-testid="vth-saved-chip"><Check className="i" {...I} />{vth.queue && !savedStay ? 'انجام شد؛ آماده‌ی نمایش کار بعدی' : 'ثبت شد؛ در همین پرونده می‌مانید'}</span> : null}
  </section>;
}

export function VthSupportCard({ ctx, customerId }: { ctx: VthContext; customerId?: number | null }) {
  if (!ctx.support) return null;
  const elig = ctx.eligibility;
  const expert = ctx.expert?.name || ctx.otherOwner?.name;
  return <section className="card vh-task" data-testid="vth-support">
    <span className="chip b">پشتیبانی، داخلی ۲۲۰</span>
    <p>{elig?.reason ?? 'مشتری شما نیست؛ دسترسی نامعتبر یا مهلت پاسخ تمام شده'}</p>
    {expert ? <p data-testid="vth-support-expert">کارشناس: {expert} (فقط برای اطلاع)</p> : null}
    {customerId ? <Link href={`/customers/${customerId}`} className="btn gh sm" data-testid="vth-open-filing"><Eye className="i" {...I} />باز کردن پرونده (نمای ثبت‌نام)</Link> : null}
  </section>;
}

export function VthResultForm({ call, vth, name, customerId, phone, onClose, onSaved }: {
  call: VcCall; vth: VthMe; name: string; customerId: number | null; phone?: string | null;
  onClose: () => void; onSaved: (stay: boolean, meta?: { id: number; at: string }) => void;
}) {
  const [outcome, setOutcome] = useState<'answered' | 'no_answer' | 'follow_up' | null>(call.prefill === 'answered' ? 'answered' : call.prefill === 'no_answer' ? 'no_answer' : null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const ok = Boolean(outcome) && [...note].length > 0 && [...note].length <= 80;
  const d = durFa(call.durationSeconds ?? call.billsec);
  const title = vth.form === 'reminder_result' ? 'تماس گرفتم، ثبت نتیجه' : 'ثبت نتیجه‌ی تماس';
  const save = async () => {
    if (!ok || saving || !outcome) { if (!outcome) setErr('نتیجه‌ی تماس را انتخاب کن.'); else if (!note) setErr('یادداشت یک‌خطی را بنویس.'); return; }
    setSaving(true); setErr('');
    try {
      const r = await vthApi.result(call.id, { outcome, note });
      onSaved(r.stay, { id: r.callId ?? call.id, at: r.savedAt });
    } catch (e: any) { setErr(e?.message || 'ثبت نشد. دوباره تلاش کن.'); }
    finally { setSaving(false); }
  };
  return <section className="rv-mdl vth-form" role="region" aria-labelledby="vth-rvT" data-testid="vth-form">
    <header className="rv-mh"><div className="rv-mt">
      <span className="chip s rv-auto" data-testid="vth-auto"><Headset className="i" {...I} />{vth.manualEnd || call.manualEnd ? 'پایان تماس به‌صورت دستی ثبت شد' : 'خودکار باز شد؛ قطع کامل و وضعیت نهایی تأیید شد'}</span>
      <h2 id="vth-rvT">{title}</h2>
      <small>تماس ویپ <bdi dir="ltr">#{faNum(call.id)}</bdi>{vth.manualEnd || call.manualEnd ? '؛ بدون گزارش پایان سیموتل' : (d ? `؛ ${call.outcome === 'no_answer' ? 'پاسخ نداد' : 'پاسخ داد'}، ${d}` : '')}</small>
      <p className="rn"><b>{name}</b>{customerId ? <span className="cid">#{faNum(customerId)}</span> : null}</p>
      {phone ? <p className="rl" data-testid="vth-form-phone"><a className="phn" href={`tel:${phone}`} dir="ltr">{faNum(phone)}</a></p> : null}
    </div><button className="ib" type="button" aria-label="بستن" data-testid="vth-form-close" onClick={onClose}><X className="i" {...I} /></button></header>
    <div className="rv-mb">
      <div className="rv-fld"><span className="rv-lbl">نتیجه‌ی تماس<span className="req">*</span></span>
        <div className="rv-seg" role="radiogroup" aria-label="نتیجه‌ی تماس" aria-required="true">
          {OUTS.map((o) => <button key={o.k} type="button" role="radio" aria-checked={outcome === o.k} className={outcome === o.k ? 'on' : ''} data-testid={`vth-out-${o.k}`} onClick={() => setOutcome(o.k)}>{o.l}</button>)}
        </div></div>
      <div className="rv-fld"><div className="rv-fh"><label className="rv-lbl" htmlFor="vth-rvN">یادداشت یک‌خطی<span className="req">*</span> <small>تک‌خط، حداکثر ۸۰ نویسه</small></label>
        <span className="rv-cnt"><b>{faNum(note.length)}</b> / ۸۰</span></div>
        <input id="vth-rvN" className="rv-inp" maxLength={80} value={note} aria-required="true" data-testid="vth-note"
          onChange={(e) => setNote(e.target.value.replace(/[\r\n]+/g, ' ').slice(0, 80))} placeholder="مثلاً «فیش حقوقی رسید؛ تصویر واضح‌تر را می‌خواهم.»" /></div>
      {err ? <p className="rv-err" role="alert">{err}</p> : null}
    </div>
    <footer className="rv-mf">
      <button className="btn gh" type="button" data-testid="vth-save" aria-disabled={!ok || saving ? true : undefined} onClick={() => void save()}>
        <Check className="i" {...I} />{saving ? 'در حال ثبت…' : vth.saveLabel}</button>
      <button className="btn gh" type="button" data-close data-testid="vth-cancel" onClick={onClose}>انصراف</button>
    </footer>
  </section>;
}

/** File-detail host: VoIP button, hold strip, support / other-owner, auto form. Flag off → null (the page stays as it is). */
export function FileDetailVth({ customerId, fileId, customerName, phone, children }: {
  customerId: number; fileId: number; customerName: string; phone: string | null; children?: ReactNode;
}) {
  const qc = useQueryClient();
  const { me, vth, call, on } = useVth();
  const ctxQ = useVthContext(customerId, on);
  const ctx = ctxQ.data;
  const [formOpen, setFormOpen] = useState(false);
  const [stay, setStay] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [savedMeta, setSavedMeta] = useState<{ id: number; at: string } | null>(null);
  const mine = !call || call.customerId === customerId;
  const head = vthHeadCallLabel(vth?.phase);
  useEffect(() => {
    if (vth && mine && vth.phase === 'final' && vth.form && vth.form !== 'first_call') setFormOpen(true);
    if (vth && vth.phase !== 'final') setFormOpen(false);
  }, [vth?.phase, vth?.form, mine]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!on || !vth) return null;
  const hidden = ctx ? !ctx.phoneVisible : false;
  const hold = vth.phase === 'in_call' || vth.phase === 'pending_status' || vth.phase === 'status_error' || vth.phase === 'final';
  const retry = async () => {
    if (!call || retrying) return; setRetrying(true);
    try { await vthApi.retry(call.id); } finally { setRetrying(false); vthRefresh(qc); vcRefresh(qc); }
  };
  return <div className="vth-fd" data-testid="vth-root">
    {hidden && ctx && !ctx.canCall ? <p className="vh-hidden" data-testid="vth-hidden-phone">شماره نشان داده نمی‌شود</p> : children}
    {ctx && !ctx.canCall ? <div className="vh-status" data-testid="vth-other"><EyeOff className="i" {...I} />
      <span>{ctx.support ? 'مشتری شما نیست؛ مجوز تماس یا مهلت پاسخ معتبر نیست.' : `مشتری کارشناس دیگر${ctx.otherOwner?.name ? `؛ ${ctx.otherOwner.name}${ctx.otherOwner.extension ? `، داخلی ${faNum(ctx.otherOwner.extension)}` : ''}` : ''}`}</span>
    </div> : null}
    {ctx?.canCall || !ctx ? <div className="vth-box" data-testid="vth-call-box">
      {head.disabled ? <button type="button" className="btn gh vc-btn" disabled aria-disabled="true" data-testid="vc-call"><Phone className="i" {...I} />{head.label}</button> : <VoipCallBox customerId={customerId} fileId={fileId} entry="file" customerName={customerName} variant="customer" label={head.label} />}
    </div> : null}
    {mine ? <VthStatus call={call} vth={vth} onRetry={() => void retry()} savedAt={savedMeta?.at} savedCallId={savedMeta?.id} /> : null}
    {ctx ? <VthSupportCard ctx={ctx} customerId={customerId} /> : null}
    <VthTaskCard vth={vth} savedStay={stay} />
    {formOpen && call && mine && vth.form && vth.form !== 'first_call' ? <VthResultForm call={call} vth={vth} name={customerName} customerId={customerId} phone={phone}
      onClose={() => setFormOpen(false)} onSaved={(s, meta) => { setStay(s); if (meta) setSavedMeta(meta); setFormOpen(false); vthRefresh(qc); }} /> : null}
  </div>;
}

/** When flag is on, VoipCallBox uses this copy instead of mid-call "در مکالمه" / late 4-status-button bypass. */
export function useVthCallCopy(call: VcCall | null): { hideTalkTimer: boolean; hideManualStatus: boolean; neutralInCall: boolean } {
  const vth = vthOfMaybe();
  const on = Boolean(vth);
  const pending = on && (vth!.phase === 'pending_status' || vth!.phase === 'status_error');
  const live = on && vth!.phase === 'in_call';
  return { hideTalkTimer: live || pending, hideManualStatus: on, neutralInCall: live };
}
function vthOfMaybe(): VthMe | null {
  try {
    const { vth } = useVth();
    return vth;
  } catch { return null; }
}

export function VthHoldBanner() {
  const { vth, call, on } = useVth();
  const qc = useQueryClient();
  if (!on || !vth) return null;
  return <VthStatus call={call} vth={vth} onRetry={() => { if (call) void vthApi.retry(call.id).finally(() => vthRefresh(qc)); }} />;
}

export { useVcMe };
