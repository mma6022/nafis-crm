import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getListRemindersQueryKey, useCreateReminder } from '@workspace/api-client-react';
import { AlertCircle, BellPlus, Bot, Check, Clock, Eye, Info, MessageCircle, Moon, PauseCircle, Paperclip, Pencil, Play, Send, X, Zap } from 'lucide-react';
import { ErrorState } from '@/components/CrmShell';
import { toast } from '@/hooks/use-toast';
import { BALE_MAX_TEXT, baleFetch, baleWhen, faNum, MODE_LABEL, OUTBOX_STATUS_LABEL, type BaleChat, type BaleOutboxItem, type BaleSendResult } from './api';
import './bale.css';

const errMsg = (e: unknown) => (e instanceof Error && e.message) || 'درخواست انجام نشد. دوباره تلاش کنید.';
/** ISO for a Tehran wall-clock time `days` from today (Iran has no DST: +03:30). */
function tehranAt(days: number, hour: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Date.now() + days * 86_400_000)).map(x => [x.type, x.value]));
  return new Date(`${p.year}-${p.month}-${p.day}T${String(hour).padStart(2, '0')}:00:00+03:30`).toISOString();
}
const REMINDER_PRESETS = [
  { key: 'tomorrow', label: 'فردا ساعت ۱۰', at: () => tehranAt(1, 10) },
  { key: 'd3', label: 'سه روز دیگر ساعت ۱۰', at: () => tehranAt(3, 10) },
  { key: 'week', label: 'یک هفته دیگر ساعت ۱۰', at: () => tehranAt(7, 10) },
];

/** One outbox row inside the tab: approve-first draft card, queued/held item, or a blocked/failed notice. */
function OutboxCard({ o, busy, act }: { o: BaleOutboxItem; busy: boolean; act: (o: BaleOutboxItem, what: 'approve' | 'cancel' | 'send-now' | 'edit', text?: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false); const [text, setText] = useState(o.text ?? '');
  const held = o.status === 'queued' && o.scheduledAt && new Date(o.scheduledAt).getTime() > Date.now();
  if (o.status === 'pending_approval') return <div className="bl-draft" data-testid={`bale-draft-${o.id}`} role="group" aria-label="پیش‌نویس منتظر تأیید">
    <div className="hd"><Bot size={16} /> <b>پیش‌نویس {o.sourceLabel}</b><span className="bl-tag warn">{OUTBOX_STATUS_LABEL.pending_approval}</span></div>
    {o.reason ? <p className="why">{o.reason}</p> : null}
    {editing ? <textarea className="bl-ta" value={text} maxLength={BALE_MAX_TEXT} onChange={e => setText(e.target.value)} aria-label="متن پیش‌نویس" data-testid={`input-bale-draft-${o.id}`} />
      : <p className="txt">{o.text}</p>}
    {o.newChat ? <p className="note"><Info size={14} /> اولین پیام شما به این مشتری در بله است.</p> : null}
    {o.canAct ? <div className="bl-acts">
      <button type="button" className="btn btn-primary" disabled={busy || (editing && !text.trim())} data-testid={`button-bale-approve-${o.id}`}
        onClick={() => void act(o, 'approve', editing ? text : undefined).then(ok => ok && setEditing(false))}><Send size={15} /> {editing ? 'ذخیره و بفرست' : 'بفرست'}</button>
      {editing ? <button type="button" className="btn" disabled={busy || !text.trim()} onClick={() => void act(o, 'edit', text).then(ok => ok && setEditing(false))} data-testid={`button-bale-save-${o.id}`}><Check size={15} /> فقط ذخیره</button>
        : <button type="button" className="btn" disabled={busy} onClick={() => { setText(o.text ?? ''); setEditing(true); }} data-testid={`button-bale-edit-${o.id}`}><Pencil size={15} /> ویرایش</button>}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(o, 'cancel')} data-testid={`button-bale-cancel-${o.id}`}><X size={15} /> لغو</button>
    </div> : null}
  </div>;
  if (o.status === 'queued' || o.status === 'sending') return <div className="bl-msg out pending" data-testid={`bale-queued-${o.id}`}>
    {o.text}
    <span className="meta">{held ? <><Moon size={12} /> ساعت آرام؛ ارسال در {baleWhen(o.scheduledAt)}</> : <><Clock size={12} /> {OUTBOX_STATUS_LABEL[o.status]}</>} — {o.sourceLabel}</span>
    {o.canAct && o.status === 'queued' ? <span className="bl-mini">
      {held ? <button type="button" disabled={busy} onClick={() => void act(o, 'send-now')} data-testid={`button-bale-sendnow-${o.id}`}><Zap size={13} /> همین الان</button> : null}
      <button type="button" disabled={busy} onClick={() => void act(o, 'cancel')} data-testid={`button-bale-cancelq-${o.id}`}><X size={13} /> لغو</button>
    </span> : null}
  </div>;
  return <div className="bl-blocked" role="note" data-testid={`bale-blocked-${o.id}`}>
    <AlertCircle size={16} />
    <div><b>{OUTBOX_STATUS_LABEL[o.status]} — {o.sourceLabel}</b>
      <span>{o.blockMessage ?? o.errorMessage ?? ''}</span>
      {o.text ? <q>{o.text}</q> : null}
      <small>{baleWhen(o.createdAt)}</small></div>
  </div>;
}

/** «گفتگوی بله» on the customer page. Read-only for admins/others; the owning expert gets the composer and outbox (piece 1b).
 *  Scope, switches, caps, quiet hours and filters are enforced by the server. */
export function BaleChatSection({ customerId }: { customerId: number }) {
  const qc = useQueryClient(); const key = ['bale', 'chat', customerId];
  const q = useQuery({ queryKey: key, queryFn: () => baleFetch<BaleChat>(`/bale/customers/${customerId}/messages`), retry: false, refetchInterval: 20_000 });
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [info, setInfo] = useState<string | null>(null);
  const [remOpen, setRemOpen] = useState(false); const [remText, setRemText] = useState(''); const [remAt, setRemAt] = useState(REMINDER_PRESETS[0].key);
  const createReminder = useCreateReminder();
  const st = (q.error as unknown as { status?: number } | null)?.status;
  if (st === 403 || st === 404) return null;
  const d = q.data; const s = d?.sendState ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const send = async (e: FormEvent) => {
    e.preventDefault(); if (!text.trim() || busy) return;
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await baleFetch<BaleSendResult>(`/bale/customers/${customerId}/send`, { method: 'POST', body: { text } });
      setText(''); setInfo(r.message ?? (r.status === 'queued' ? 'پیام در صف ارسال قرار گرفت.' : null));
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); void refresh(); }
  };
  const act = async (o: BaleOutboxItem, what: 'approve' | 'cancel' | 'send-now' | 'edit', t?: string) => {
    setBusy(true); setErr(null); setInfo(null);
    try {
      if (what === 'edit') await baleFetch(`/bale/outbox/${o.id}`, { method: 'PUT', body: { text: t } });
      else await baleFetch(`/bale/outbox/${o.id}/${what}`, { method: 'POST', body: what === 'approve' && t !== undefined ? { text: t } : {} });
      toast({ title: what === 'approve' ? 'پیام تأیید شد و در صف ارسال است' : what === 'cancel' ? 'پیام لغو شد' : what === 'send-now' ? 'پیام همین الان فرستاده می‌شود' : 'پیش‌نویس ذخیره شد' });
      return true;
    } catch (x) { setErr(errMsg(x)); return false; } finally { setBusy(false); void refresh(); }
  };
  const addReminder = async (e: FormEvent) => {
    e.preventDefault(); if (!remText.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const at = (REMINDER_PRESETS.find(p => p.key === remAt) ?? REMINDER_PRESETS[0]).at();
      const r = await createReminder.mutateAsync({ data: { customerId, subject: 'پیام به مشتری', message: remText.trim(), remindAt: at } }) as unknown as { id: number };
      try { await baleFetch('/bale/reminder-messages', { method: 'POST', body: { reminderId: r.id, text: remText } }); }
      catch (x) { setErr(`یادآور ثبت شد ولی پیام بله به آن وصل نشد: ${errMsg(x)}`); return; }
      void qc.invalidateQueries({ queryKey: getListRemindersQueryKey() });
      setRemText(''); setRemOpen(false); toast({ title: 'یادآور «پیام به مشتری» ثبت شد', description: `در ${baleWhen(at)} پیام از بله‌ی شما فرستاده می‌شود.` });
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); void refresh(); }
  };
  const resume = async () => {
    setBusy(true); setErr(null);
    try { await baleFetch(`/bale/customers/${customerId}/resume`, { method: 'POST', body: {} }); toast({ title: 'گفتگوی بله دوباره فعال شد' }); }
    catch (x) { setErr(errMsg(x)); } finally { setBusy(false); void refresh(); }
  };
  const cancelReminder = async (id: number) => {
    setBusy(true); try { await baleFetch(`/bale/reminder-messages/${id}/cancel`, { method: 'POST', body: {} }); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); void refresh(); }
  };

  const owner = d && !d.readOnly;
  return <section className="csx-sec" id="sec-bale" aria-labelledby="h-bale" data-testid="section-customer-bale">
    <header><h2 id="h-bale"><MessageCircle size={20} /> گفتگوی بله</h2>{d ? <span className="muted">{faNum(d.messages.length)} پیام</span> : null}</header>
    {d?.readOnly ? <span className="bl-ro"><Eye size={14} /> فقط خواندنی{d.expert ? ` · کارشناس: ${d.expert.name} — ${d.expert.connected ? `بله وصل، حالت ${MODE_LABEL[d.expert.mode]}` : 'بله وصل نیست'}` : ''}{!d.masterEnabled ? ' · بله خاموش است' : ''}</span>
      : d?.expert ? <span className="bl-ro bl-wrap"><span>از حساب بله‌ی خودتان، حالت «{MODE_LABEL[d.expert.mode]}»</span>{s ? <span data-testid="text-bale-caps">ارسال این ساعت: {faNum(s.sentLastHour)} از {faNum(s.perHour)}؛ امروز: {faNum(s.sentToday)} از {faNum(s.perDay)}</span> : null}</span> : null}
    {q.isLoading ? <div className="stack" aria-busy="true"><span className="csx-sk" style={{ height: 44 }} /><span className="csx-sk" style={{ height: 44 }} /></div>
      : q.isError ? <ErrorState onRetry={() => q.refetch()} />
      : d ? <>
        {d.messages.length || d.outbox.length ? <div className="bl-chat" role="log" aria-label="پیام‌های بله" aria-live="polite">
          {d.messages.map(m => <div key={m.id} className={`bl-msg ${m.direction}`} data-testid={`bale-msg-${m.id}`}>
            {m.hasFile ? <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><Paperclip size={14} /> فایل</span> : null}
            {m.text ?? (m.hasFile ? null : '—')}
            <span className="meta">{m.direction === 'in' ? 'مشتری' : (m.expertName ?? 'کارشناس')} · {baleWhen(m.createdAt)}</span>
          </div>)}
          {d.outbox.map(o => <OutboxCard key={`${o.id}-${o.status}-${o.text}`} o={o} busy={busy} act={act} />)}
        </div> : <p className="muted" style={{ margin: 0 }}>هنوز گفتگویی در بله با این مشتری ثبت نشده است.</p>}
        {owner ? <>
          {d.paused ? <div className="bl-note warn bl-paused" data-testid="bale-paused"><PauseCircle size={18} /><span>
            <b>این گفتگو متوقف است.</b> احتمالاً مشتری شما را در بله مسدود کرده؛ فقط همین گفتگو متوقف شد و بقیه‌ی پیام‌ها عادی می‌روند.
            <small>از {baleWhen(d.paused.at)}{d.paused.unverified ? '؛ تشخیص «مسدود شدن» هنوز با سیم‌کارت آزمایشی تأیید نشده است.' : ''}</small></span>
            <button type="button" className="btn" disabled={busy} onClick={() => void resume()} data-testid="button-bale-resume"><Play size={15} /> دوباره فعال کن</button></div> : null}
          {d.sendBlockedMessage && !d.paused ? <div className="bl-note off" data-testid="bale-send-off"><Info size={18} /><span>{d.sendBlockedMessage}</span></div> : null}
          {s?.quietNow && d.canSend ? <div className="bl-note warn" data-testid="bale-quiet"><Moon size={18} /><span>ساعت آرام است؛ پیام‌ها {s.quietEnd ? `از ${baleWhen(s.quietEnd)}` : 'بعد از پایان ساعت آرام'} فرستاده می‌شوند.</span></div> : null}
          {d.canSend && !d.paused ? <form className="bl-compose" onSubmit={send} data-testid="form-bale-send">
            <label htmlFor={`bale-text-${customerId}`} className="sr-only">متن پیام بله</label>
            <textarea id={`bale-text-${customerId}`} className="bl-ta" placeholder="پیام به مشتری…" value={text} maxLength={BALE_MAX_TEXT} disabled={busy}
              onChange={e => { setText(e.target.value); setErr(null); }} aria-invalid={Boolean(err)} aria-describedby={err ? `bale-err-${customerId}` : undefined} data-testid="input-bale-text" />
            {s && !s.hasPriorChat ? <span className="hint"><Info size={13} /> اولین پیام شما به این مشتری در بله است؛ فقط وقتی خودتان بفرستید ارسال می‌شود.</span> : null}
            <div className="bl-acts">
              <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()} data-testid="button-bale-send"><Send size={15} /> {busy ? 'لطفاً صبر کنید…' : 'بفرست'}</button>
              <button type="button" className="btn" aria-expanded={remOpen} onClick={() => setRemOpen(v => !v)} data-testid="button-bale-reminder"><BellPlus size={15} /> یادآور پیام</button>
            </div>
          </form> : null}
          {err ? <p className="bl-err" id={`bale-err-${customerId}`} role="alert" data-testid="text-bale-error"><AlertCircle size={16} /> {err}</p> : null}
          {info ? <p className="bl-info" role="status" data-testid="text-bale-info"><Check size={16} /> {info}</p> : null}
          {remOpen && d.canSend ? <form className="bl-rem" onSubmit={addReminder} data-testid="form-bale-reminder">
            <b><BellPlus size={15} /> یادآور «پیام به مشتری»</b>
            <span className="hint">سر وقت یادآور، این پیام از بله‌ی شما فرستاده می‌شود{d.expert?.mode === 'approve_first' ? ' (اول برای تأیید شما می‌آید)' : ''}.</span>
            <textarea className="bl-ta" value={remText} maxLength={BALE_MAX_TEXT} onChange={e => setRemText(e.target.value)} aria-label="متن پیام یادآور" data-testid="input-bale-reminder-text" />
            <div className="bl-chips" role="radiogroup" aria-label="زمان">{REMINDER_PRESETS.map(p => <button key={p.key} type="button" role="radio" aria-checked={remAt === p.key} onClick={() => setRemAt(p.key)}>{p.label}</button>)}</div>
            <div className="bl-acts"><button type="submit" className="btn btn-primary" disabled={busy || !remText.trim()} data-testid="button-bale-reminder-save">ثبت یادآور</button></div>
          </form> : null}
          {s?.reminders.length ? <ul className="bl-rems" aria-label="یادآورهای پیام">{s.reminders.map(r => <li key={r.reminderId} data-testid={`bale-reminder-${r.reminderId}`}>
            <BellPlus size={14} /><span><b>{baleWhen(r.remindAt)}</b> {r.text}</span>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void cancelReminder(r.reminderId)}>لغو</button></li>)}</ul> : null}
        </> : null}
      </> : null}
  </section>;
}
