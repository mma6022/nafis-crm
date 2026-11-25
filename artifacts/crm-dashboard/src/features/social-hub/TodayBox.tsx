/* social-hub: identity + «ارسال پیام» on the today card (flag.social_hub_v1). */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertCircle, Check, Clock, Copy, FileText, RefreshCw, Send } from 'lucide-react';
import { fa, faDateTime, fileSize, messageError, shApi, useShMe, type ShToday } from './api';
import { CheckBox, Name, Radio, Wizard, copyText, shRenderPreview, useShToast } from './ui';
import './social-hub.css';

const bidi = (s: string) => fa(s);
const JM = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
export const faJalali = (v: string) => { const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(String(v).trim().replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))); return m && +m[2] >= 1 && +m[2] <= 12 ? fa(`${+m[3]} ${JM[+m[2] - 1]} ${m[1]}`) : fa(v); };
function CopyChip({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="sh-cp" aria-label={`کپی ${label}`} onClick={() => copyText(value, () => { setOk(true); window.setTimeout(() => setOk(false), 1400); })} data-testid={testId}>
    <span className="sh-lbl">{label}</span><b className="l">{bidi(value)}</b>{ok ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button>;
}
function SendStatus({ s, onRetry }: { s: ShToday['sends'][number]; onRetry?: () => void }) {
  const st = s.status === 'sent' ? 'ok' : s.status === 'failed' ? 'bad' : '';
  const label = s.status === 'sent' ? 'ارسال شد' : s.status === 'failed' ? 'ارسال نشد' : 'در صف';
  const Icon = s.status === 'sent' ? Check : s.status === 'failed' ? AlertCircle : Clock;
  return <div className={`sh-sendst ${st || 'queued'}`} data-testid={`sh-send-${s.status}`}>
    <span className={`sh-chip ${st}`}><Icon aria-hidden="true" />{s.title}، {label}، {faDateTime(s.at)}{s.source === 'auto' ? <span className="sh-auto" data-testid="sh-send-auto">خودکار</span> : null}</span>
    {s.status === 'failed' && s.failReason ? <span className="sh-sub sh-failr">{s.failReason}</span> : null}
    {s.retryable ? <button type="button" className="sh-btn sec sm sh-retry" onClick={onRetry} data-testid="sh-send-retry"><RefreshCw aria-hidden="true" />تلاش دوباره</button> : null}
  </div>;
}
export function ShTodayBox({ customerId, customerName }: { customerId: number; customerName: string }) {
  const me = useShMe().data;
  const q = useQuery<ShToday>({ queryKey: ['sh-today', customerId], queryFn: () => shApi(`/customers/${customerId}/today`), enabled: Boolean(me?.enabled), retry: false, staleTime: 30_000 });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false); const { toast, node } = useShToast();
  if (!me?.enabled || !q.data) return null;
  const d = q.data; const id = d.identity; const cur = d.plans.find((p) => p.current); const last = d.sends[0];
  const block = d.sendBlock;
  const sendTitle = block?.error === 'send_closed' ? 'ارسال از این ربات بسته است'
    : block?.error === 'other_expert' ? block.message
    : block?.error === 'blocked' ? block.message
    : null;
  return <div className="sh sh-today" dir="rtl" data-testid="sh-today">
    <div className="sh-lbl">اطلاعات هویتی</div>
    {id.nationalCode || id.birthDate ? <div className="sh-idl">
      {id.nationalCode ? <CopyChip label="کد ملی" value={id.nationalCode} testId="sh-today-nid" /> : null}
      {id.birthDate ? <span className="sh-cp" style={{ cursor: 'default' }}><span className="sh-lbl">تاریخ تولد</span><b>{faJalali(id.birthDate)}</b></span> : null}
    </div> : <div className="sh-row sh-wrap"><span className="sh-sub">هنوز اطلاعات هویتی ثبت نشده.</span><Link href={`/customers/${customerId}`} className="sh-btn sec sm" data-testid="sh-today-noid">ثبت اطلاعات هویتی</Link></div>}
    {cur ? <div className="sh-row sh-wrap"><span className="sh-chip tint">{cur.name}</span></div> : null}
    {d.sends.length ? <div className="sh-lasts" data-testid="sh-last-sends">
      <div className="sh-lbl">آخرین پیام‌ها</div>
      {d.sends.slice(0, 3).map((s) => <SendStatus key={s.id} s={s} onRetry={s.retryable ? () => { void shApi(`/customers/${customerId}/sends/${s.id}/retry`, 'POST').then(() => { void qc.invalidateQueries({ queryKey: ['sh-today', customerId] }); toast('دوباره در صف ارسال قرار گرفت.'); }).catch((e) => toast(messageError(e))); } : undefined} />)}
    </div> : last ? null : null}
    <div>
      {sendTitle ? <button type="button" className="sh-btn sec" disabled title={sendTitle} data-testid="sh-today-send-off">{sendTitle}</button>
        : <button type="button" className="sh-btn sec" onClick={() => setOpen(true)} data-testid="sh-today-send"><Send aria-hidden="true" />ارسال پیام</button>}
    </div>
    {open && !sendTitle ? <SendWizard d={d} name={customerName} onClose={() => setOpen(false)} onSent={(t) => { setOpen(false); toast(t); void qc.invalidateQueries({ queryKey: ['sh-today', customerId] }); }} /> : null}
    {node}
  </div>;
}
function SendWizard({ d, name, onClose, onSent }: { d: ShToday; name: string; onClose: () => void; onSent: (t: string) => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(d.plans.length ? 0 : 1); const [plan, setPlan] = useState<number | null>(d.currentPlanId ?? d.plans[0]?.id ?? null);
  const [msg, setMsg] = useState<number | null>(null); const [docs, setDocs] = useState<number[]>([]);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [unreach, setUnreach] = useState(!d.reachable); const [copied, setCopied] = useState(false);
  const p = d.plans.find((x) => x.id === plan) ?? null; const all = [...(p?.messages ?? []), ...d.free]; const m = all.find((x) => x.id === msg) ?? null;
  const recent = (d.recentMessageIds ?? []).includes(msg ?? -1);
  const oversize = docs.filter((id) => p?.docs.find((f) => f.id === id)?.tooBig);
  const send = async () => { if (!m || recent || oversize.length) return; setBusy(true); setErr('');
    try { await shApi(`/customers/${d.customerId}/send`, 'POST', { messageId: m.id, docIds: m.kind === 'plan' ? docs : [] }); void qc.invalidateQueries({ queryKey: ['sh-today', d.customerId] }); onSent('پیام در صف ارسال ثبت شد.'); }
    catch (e: any) { if (e?.code === 'unreachable') setUnreach(true); else setErr(messageError(e)); } finally { setBusy(false); } };
  const title = `ارسال پیام به ${name}`; const steps = ['طرح', 'پیام', 'ارسال'];
  const head = <span className="sh-row" style={{ gap: 6 }}>ارسال پیام به <Name name={name} id={d.customerId} /></span>;
  if (unreach) return <Wizard title={title} head={head} short onClose={onClose} testId="sh-send-unreach"
    foot={<><button type="button" className="sh-btn pri" disabled={!d.botLink} onClick={() => d.botLink && copyText(d.botLink, () => setCopied(true))} data-testid="sh-send-copylink">{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'پیوند کپی شد' : 'کپی پیوند ربات'}</button><button type="button" className="sh-btn ghost" onClick={onClose}>بستن</button></>}>
    <div className="sh-stack"><div className="sh-msg amber">این مشتری هنوز ربات {d.botName} را شروع نکرده؛ پیام نمی‌رود.</div></div></Wizard>;
  const canSend = Boolean(m) && !busy && !recent && !oversize.length;
  return <Wizard title={title} head={head} steps={steps} cur={step} onClose={onClose} testId={`sh-send-${step}`}
    foot={step === 2 ? <><button type="button" className="sh-btn pri" disabled={!canSend} onClick={() => void send()} data-testid="sh-send-go"><Send aria-hidden="true" />ارسال</button><button type="button" className="sh-btn ghost" onClick={() => setStep(1)}>قبلی</button></>
      : <><button type="button" className="sh-btn pri" disabled={step === 1 && !m} onClick={() => setStep(step + 1)} data-testid="sh-send-next">ادامه</button><button type="button" className="sh-btn ghost" onClick={() => (step === 0 || !d.plans.length ? onClose() : setStep(step - 1))}>{step === 0 || !d.plans.length ? 'انصراف' : 'قبلی'}</button></>}>
    {step === 0 ? <div className="sh-stack" role="radiogroup" aria-label="طرح">{d.plans.map((x) => <Radio key={x.id} on={plan === x.id} title={x.name} sub={x.current ? 'طرح فعلی مشتری' : `${fa(x.messages.length)} پیام`} onClick={() => { setPlan(x.id); setMsg(null); setDocs([]); }} />)}
      <Radio on={plan == null} title="بدون طرح" sub="فقط پیام‌های آزاد" onClick={() => { setPlan(null); setMsg(null); setDocs([]); }} /></div>
    : step === 1 ? <div className="sh-stack">
      {p ? <><span className="sh-chip tint" style={{ alignSelf: 'flex-start' }}>{p.name}</span>{p.messages.length ? <><div className="sh-lbl">پیام‌های {p.name}</div>
        <div className="sh-stack" role="radiogroup" aria-label={`پیام‌های ${p.name}`}>{p.messages.map((x) => <Radio key={x.id} on={msg === x.id} title={x.title} sub={shRenderPreview(x.body, { customer: d.customerName || name, expert: d.expertName, plan: p.choiceLabel || p.publicLabel })} onClick={() => setMsg(x.id)} testId="sh-send-msg" />)}</div></>
          : <p className="sh-sub" style={{ margin: 0 }}>پیامی برای این طرح نیست.</p>}
        {p.docs.length ? <><div className="sh-lbl">فایل‌های طرح (اختیاری)</div>{p.docs.map((f) => <div key={f.id} className="sh-stack" style={{ gap: 4 }}>
          <CheckBox on={docs.includes(f.id)} label={`${f.title}، ${f.fileType === 'pdf' ? 'پی‌دی‌اف' : f.fileType === 'video' ? 'ویدیو' : 'تصویر'}، ${fileSize(f.sizeBytes)}`}
            onChange={(v) => { if (f.tooBig) return; setDocs((s) => v ? [...s, f.id] : s.filter((z) => z !== f.id)); }} />
          {f.tooBig ? <span className="sh-sub sh-failr" data-testid="sh-doc-toobig">حجم فایل برای ارسال در بله زیاد است</span> : null}
        </div>)}</> : null}</> : null}
      {d.free.length ? <><div className="sh-lbl">پیام‌های آزاد</div><div className="sh-stack" role="radiogroup" aria-label="پیام‌های آزاد">{d.free.map((x) => <Radio key={x.id} on={msg === x.id} title={x.title} onClick={() => { setMsg(x.id); setDocs([]); }} testId="sh-send-msg" />)}</div></> : null}
      {!all.length ? <p className="sh-sub">پیامی برای کارهای امروز روشن نیست.</p> : null}</div>
    : <div className="sh-stack"><div className="sh-sumbox">
        <div className="sh-sumr"><span className="sh-lbl">به</span><Name name={name} id={d.customerId} /></div>
        <div className="sh-sumr"><span className="sh-lbl">از</span><b>ربات {d.botName}</b></div>
        {m ? <div className="sh-sumr col"><span className="sh-lbl">{m.title}</span><span style={{ whiteSpace: 'pre-wrap' }} data-testid="sh-send-preview">{shRenderPreview(m.body, { customer: d.customerName || name, expert: d.expertName, plan: m.kind === 'plan' ? (p?.choiceLabel || p?.publicLabel) : '' })}</span></div> : null}
        {docs.length ? <div className="sh-sumr"><span className="sh-lbl">فایل‌ها</span><span className="sh-row"><FileText size={16} aria-hidden="true" />{fa(docs.length)} فایل</span></div> : null}</div>
      {recent ? <p className="sh-err" role="alert" data-testid="sh-send-recent">همین الان فرستاده شد؛ ارسال دوباره بعد از ۱۰ دقیقه</p> : null}
      {oversize.length ? <p className="sh-err" role="alert">حجم فایل برای ارسال در بله زیاد است</p> : null}
      {err ? <p className="sh-err" role="alert">{err}</p> : null}</div>}
  </Wizard>;
}
