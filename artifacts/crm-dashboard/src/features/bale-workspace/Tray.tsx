/* «فضای کار بله» ب — دکمهٔ «ابزار» کنار کادر ارسال؛ سینی بین آخرین پیام و کادر ارسال باز می‌شود (in flow: the thread shrinks, nothing is covered).
   Experts: quick messages, plan terms, customer training files, invite, stars, request contact. No bulk here (manager-only, «مدیریت فروش»). */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bbFetch } from '@/features/bale-bot/api';
import { I } from '@/features/bale-bot/ui';
import { StarPicker } from './Stars';
import { InviteButton } from './Invite';
import { bwsErr, fd, jDate, type BwsChatCtx } from './api';

export function ToolsButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return <button className={`ib bws-tools${open ? ' on' : ''}`} type="button" aria-label="ابزار" aria-expanded={open} aria-controls="bws-tray" onClick={onClick} data-bws-tools="1" data-testid="bws-tools"><I n="grid" /></button>;
}
type Sub = null | 'plans' | 'train';
export function BwTray({ chatId, ctx, initialSub = null, toast, refresh, onClose }: { chatId: number; ctx: BwsChatCtx | undefined; initialSub?: Sub; toast: (t: string) => void; refresh: () => void; onClose: () => void }) {
  const qc = useQueryClient(); const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<Sub>(initialSub); const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: MouseEvent | TouchEvent) => { const t = e.target as HTMLElement; if (ref.current?.contains(t) || t.closest?.('[data-bws-tools]') || t.closest?.('.bws-sheet')) return; onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', h); document.addEventListener('touchstart', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h); document.removeEventListener('keydown', k); };
  }, [onClose]);
  const reload = () => { void qc.invalidateQueries({ queryKey: ['bws-ctx', chatId] }); refresh(); };
  const a = ctx?.assets; const c = ctx?.context && !ctx.context.restricted ? ctx.context : null; const canSend = !!ctx?.canSend;
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => { setBusy(key); try { await fn(); toast(ok); reload(); } catch (e) { toast(bwsErr(e)); } finally { setBusy(null); } };
  return <div className="bws-tray" id="bws-tray" ref={ref} role="region" aria-label="ابزار گفتگو" data-testid="bws-tray">
    {sub === 'plans' && c ? <PlanTerms chatId={chatId} explained={c.explained} toast={toast} onSent={() => { setSub(null); reload(); }} onBack={() => setSub(null)} /> : null}
    {sub === 'train' && a ? <div className="bws-sub"><h4><button className="ib" type="button" aria-label="بازگشت" onClick={() => setSub(null)}><I n="back" /></button>فایل آموزشی برای مشتری</h4>
      <ul className="bws-pick">{a.customerTraining.map((t) => <li key={t.id}><button type="button" disabled={!canSend || busy != null} onClick={() => act(`t${t.id}`, () => bbFetch(`/bale-workspace/chats/${chatId}/training/${t.id}`, { body: {} }), `«${t.title}» فرستاده شد`)}>
        <b>{t.title}</b><span>{t.kind === 'link' ? 'پیوند' : t.kind === 'video' ? 'ویدیو' : 'فایل'} · {t.plansLabel}</span></button></li>)}</ul></div> : null}
    {!sub ? <>
      {a?.quick.length ? <div className="bws-trow" role="group" aria-label="پیام‌های آماده؛ یک ضربه می‌فرستد"><span className="lbl">پیام آماده</span>
        {a.quick.map((q) => <button key={q.id} type="button" className="qb" disabled={!canSend || busy != null} aria-busy={busy === q.id}
          onClick={() => act(q.id, () => bbFetch(`/bale-bot/chats/${chatId}/quick/${q.id}`, { body: {} }), `«${q.title}» فرستاده شد`)}>{q.title}</button>)}</div> : null}
      <div className="bws-tgrid">
        {c && a?.plans.length ? <button type="button" className="bws-tile" disabled={!canSend} onClick={() => setSub('plans')} data-testid="bws-tile-plans"><I n="doc" /><b>شرایط طرح</b>{c.explained.length ? <small>{fd(c.explained.length)} طرح توضیح داده شده</small> : <small>انتخاب و ارسال</small>}</button> : null}
        {a?.customerTraining.length ? <button type="button" className="bws-tile" disabled={!canSend} onClick={() => setSub('train')} data-testid="bws-tile-train"><I n="book" /><b>فایل آموزشی</b><small>{fd(a.customerTraining.length)} فایل برای مشتری</small></button> : null}
        <button type="button" className="bws-tile" disabled={!canSend || busy != null} onClick={() => act('rc', () => bbFetch(`/bale-bot/chats/${chatId}/request-contact`, { body: {} }), 'درخواست شماره فرستاده شد')}><I n="contact" /><b>درخواست شماره</b><small>دکمهٔ اشتراک</small></button>
      </div>
      {c ? <div className="bws-trow2">
        <span className="lbl">ستاره</span><StarPicker chatId={chatId} value={c.stars} toast={toast} onChange={() => reload()} />
        <span className="sp" />
        <InviteButton path={`/bale-workspace/chats/${chatId}/invite`} last={c.invites[0] ?? null} toast={toast} onDone={() => reload()} cls="bws-btn sec" />
      </div> : <p className="bws-mut">برای ستاره، شرایط طرح و دعوت، اول گفتگو را به پرونده وصل کنید.</p>}
      {c?.explained.length ? <p className="bws-mut">آخرین طرح توضیح‌داده‌شده: {c.explained[0].name} · {jDate(c.explained[0].at)}</p> : null}
    </> : null}
  </div>;
}
function PlanTerms({ chatId, explained, toast, onSent, onBack }: { chatId: number; explained: { planId: number; at: string }[]; toast: (t: string) => void; onSent: () => void; onBack: () => void }) {
  const q = useQuery<{ items: { id: number; name: string; terms: string }[] }>({ queryKey: ['bws-plans'], staleTime: 60_000, queryFn: () => bbFetch('/bale-workspace/plans') });
  const [sel, setSel] = useState<number[]>([]); const [busy, setBusy] = useState(false);
  const items = q.data?.items ?? []; const ex = new Map(explained.map((e) => [e.planId, e.at]));
  const send = async () => { setBusy(true); try { const r = await bbFetch<{ files: number }>(`/bale-workspace/chats/${chatId}/plan-terms`, { body: { planIds: sel } }); toast(r.files ? `شرایط ${fd(sel.length)} طرح و ${fd(r.files)} فایل فرستاده شد` : `شرایط ${fd(sel.length)} طرح فرستاده شد`); onSent(); } catch (e) { toast(bwsErr(e)); } finally { setBusy(false); } };
  return <div className="bws-sheet" role="dialog" aria-label="ارسال شرایط طرح" data-testid="bws-plan-sheet">
    <h4><button className="ib" type="button" aria-label="بازگشت" onClick={onBack}><I n="back" /></button>طرح‌هایی که توضیح دادید</h4>
    <ul className="bws-plans">{items.map((p) => <li key={p.id}><label><input type="checkbox" checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} />
      <span><b>{p.name}</b>{ex.has(p.id) ? <small className="bws-chip">قبلاً فرستاده شد · {jDate(ex.get(p.id)!, false)}</small> : null}<em>{p.terms}</em></span></label></li>)}</ul>
    <div className="bws-sheet-f"><span className="bws-mut">{sel.length ? `${fd(sel.length)} طرح در یک پیام` : 'یک یا چند طرح را انتخاب کنید'}</span><button className="bws-btn" type="button" disabled={!sel.length || busy} onClick={send} data-testid="bws-plan-send">{busy ? 'در حال ارسال…' : 'ارسال در بله'}</button></div>
  </div>;
}
