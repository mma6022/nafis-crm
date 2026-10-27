import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { HelpCircle, Send } from 'lucide-react';
import { Modal } from '@/components/DataTools';
import { toast } from '@/hooks/use-toast';
import { baleFetch, baleWhen, faNum } from '@/features/bale/api';
import { AR_LEARNED_MAX, type ArQuestion } from './api';
import './ar.css';

const errMsg = (e: unknown) => (e instanceof Error && e.message) || 'درخواست انجام نشد. دوباره تلاش کنید.';
/** «بعداً» hides one question on this device for SNOOZE_MS (client-only; the server timeout still runs). */
const SNOOZE_MS = 10 * 60_000;
const snoozeKey = (uid: number) => `nas-ask-snooze-${uid}`;
function loadSnooze(uid: number): Record<string, number> { try { const v = JSON.parse(localStorage.getItem(snoozeKey(uid)) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function saveSnooze(uid: number, v: Record<string, number>) { try { localStorage.setItem(snoozeKey(uid), JSON.stringify(v)); } catch { /* private mode */ } }

/** AR30 «سؤال از کارشناس»: Masoud did not know the answer → popup in the expert's dock. The answer goes to the customer as the reply
 *  through the same server caps/checks; it is saved as a learned answer ONLY when the box is ticked (unticked by default). */
export function AskExpertPopup({ uid }: { uid: number }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const q = useQuery({ queryKey: ['bale', 'ar', 'questions'], retry: false, refetchInterval: 20_000, refetchIntervalInBackground: false,
    queryFn: () => baleFetch<{ questions: ArQuestion[] }>('/bale/me/autoreply/questions') });
  const [snooze, setSnooze] = useState<Record<string, number>>(() => loadSnooze(uid));
  const [tick, setTick] = useState(0);
  useEffect(() => { const i = setInterval(() => setTick(x => x + 1), 30_000); return () => clearInterval(i); }, []);
  const pending = useMemo(() => (q.data?.questions ?? []).filter(x => x.status === 'pending'), [q.data]);
  const visible = useMemo(() => pending.filter(x => !(snooze[x.id] > Date.now())), [pending, snooze, tick]);
  const cur = visible[visible.length - 1] ?? null; // oldest first
  const [text, setText] = useState(''); const [save, setSave] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setText(''); setSave(false); setErr(null); }, [cur?.id]);
  if (!cur) return null;

  const later = () => { const v: Record<string, number> = { ...snooze, [cur.id]: Date.now() + SNOOZE_MS }; for (const k of Object.keys(v)) if (v[k] < Date.now()) delete v[k]; setSnooze(v); saveSnooze(uid, v); };
  const done = () => { void qc.invalidateQueries({ queryKey: ['bale', 'ar'] }); };
  const send = async () => {
    const t = text.trim(); if (!t) { setErr('جواب خالی است.'); return; }
    if (save && t.length > AR_LEARNED_MAX) { setErr('جواب ذخیره‌شونده حداکثر ۵۰۰ نویسه است.'); return; }
    setBusy(true); setErr(null);
    try { const r = await baleFetch<{ status: string; learnedId: number | null; message: string }>(`/bale/me/autoreply/questions/${cur.id}/answer`, { method: 'POST', body: { text: t, save } });
      toast({ title: r.message || 'جواب رفت' }); done(); }
    catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  const self = async () => {
    setBusy(true); setErr(null);
    try { await baleFetch(`/bale/me/autoreply/questions/${cur.id}/self`, { method: 'POST', body: {} }); done();
      toast({ title: 'گفتگو دست شماست', description: `${cur.assistantName || 'مسعود'} در این گفتگو دیگر جواب نمی‌دهد.` });
      navigate(cur.customerId ? `/customers/${cur.customerId}` : '/bale/autoreply'); }
    catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  const asst = cur.assistantName || 'مسعود';
  return <Modal title={`${asst} جواب رو نمی‌دونه`} eyebrow={`${cur.customerName ?? 'مشتری'} · بله · ${baleWhen(cur.createdAt)}${visible.length > 1 ? ` · ${faNum(visible.length)} سؤال` : ''}`} onClose={later} testId="ar-ask">
    <div className="arx ask" dir="rtl" style={{ display: 'grid', gap: 12 }}>
      <div><div className="eyebrow">سؤال مشتری</div><blockquote dir="auto" style={{ margin: '4px 0 0', padding: '8px 12px', borderInlineStart: '3px solid var(--nf-brand-600, #2563eb)', background: 'var(--nf-surface, #f8fafc)', borderRadius: 8 }} data-testid="ar-ask-question">{cur.question}</blockquote></div>
      {cur.summary ? <div><div className="eyebrow">خلاصه‌ی پرونده</div><p style={{ margin: '4px 0 0', fontSize: 13.5 }} data-testid="ar-ask-summary">{cur.summary}</p></div> : null}
      <label style={{ display: 'grid', gap: 4 }}><span><b>جواب تو</b> <small className="muted">به اسم تو در بله می‌رود</small></span>
        <textarea className="input" dir="auto" rows={4} maxLength={1000} value={text} onChange={e => setText(e.target.value)} data-testid="ar-ask-answer" /></label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} data-testid="ar-ask-save" />
        <span><b>برای دفعه‌های بعد هم همین جواب رو بده</b><br /><small className="muted">در «جواب‌های آموخته‌شده» ذخیره می‌شود. تو یا مدیر هر وقت بخواهید ویرایشش می‌کنید.{save ? ` (${faNum(text.trim().length)} از ${faNum(AR_LEARNED_MAX)} نویسه؛ بدون مبلغ و بدون قول)` : ''}</small></span></label>
      <div className="esc gold" style={{ borderRadius: 10 }}><HelpCircle size={16} /><div><p>{cur.holdResult === 'queued' || cur.holdResult === 'sent' ? <>تا جواب ندهی، مشتری فقط پیام نگه‌دار گرفته است: «{cur.holdText}»</> : <>پیام نگه‌دار برای مشتری نرفت؛ مشتری هنوز جوابی نگرفته است.</>}
        {cur.timeoutMin ? <> اگر تا {faNum(cur.timeoutMin)} دقیقه جواب نیاید، گفتگو به تو سپرده می‌شود.</> : null}</p></div></div>
      {err ? <div role="alert" style={{ color: "var(--nf-danger)", fontWeight: 700, fontSize: 13.5 }} data-testid="ar-ask-error">{err}</div> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={later} data-testid="ar-ask-later">بعداً</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void self()} data-testid="ar-ask-self">خودم در گفتگو جواب می‌دم</button>
        <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void send()} data-testid="ar-ask-send"><Send size={16} /> بفرست</button>
      </div>
    </div>
  </Modal>;
}
