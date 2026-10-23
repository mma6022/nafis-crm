import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  AlertCircle, Bell, Check, Clock, Copy, Eye, EyeOff, History, Link2, Moon, NotebookPen, Phone, PhoneCall, Search, Sun, User, UserPlus, X, Zap,
} from 'lucide-react';
import { ErrorState, SkeletonPanel } from '@/components/CrmShell';
import { Modal } from '@/components/DataTools';
import { UserAvatar } from '@/components/UserAvatar';
import { Stepper, WizardActions, type WizardStep } from '@/components/wizard/Wizard';
import { errText, rawCode } from '@/lib/goods-api';
import {
  CALLBACK_STATUS_FA, CALLBACK_TRANSITIONS, CANCEL_REASON_FA, CONTACT_TIME_FA, NEED_FA, STATUS_ORDER, callbacksApi, srcLabel,
  type CallbackEvent, type CallbackItem, type CallbackMeta, type CallbackStatus, type CallbackTab, type CallbackWho, type CancelReason,
} from '@/lib/callbacks-api';
import './callback-requests.css';

/*
 * «درخواست‌های تماس» — mockups/crm-callbacks.html. Mobile: card list + bottom sheet. ≥1024px: 384px list + detail pane.
 * Notes are timeline events (CaseNotesRoom is bound to loan applications, so it is not reused here).
 */
const DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const fa = (v: number | string) => String(v).replace(/\d/g, d => DIGITS[Number(d)]);
const fmtPhone = (p: string) => fa(p.length === 11 ? `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}` : p);
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
function ago(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (m < 1) return 'همین حالا';
  if (m < 60) return `${fa(m)} دقیقه پیش`;
  if (m < 1440) return `${fa(Math.round(m / 60))} ساعت پیش`;
  if (m < 2880) return 'دیروز';
  return `${fa(Math.round(m / 1440))} روز پیش`;
}
const waited = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
const clock = (iso: string) => new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const TIME_ICON = { now: Zap, morning: Sun, evening: Moon } as const;
const ERR_FA: Record<string, string> = {
  too_soon: 'هنوز زود است؛ بین دو تلاش باید فاصله باشد.',
  max_attempts: 'سقف تلاش‌ها پر شده؛ «لغو» یا «تماس گرفته شد» را بزنید.',
  cancel_reason_required: 'دلیل لغو را انتخاب کنید.',
  already_assigned: 'این درخواست همین حالا به همکار دیگری تخصیص داده شد.',
  invalid_transition: 'این تغییر وضعیت ممکن نیست؛ فهرست به‌روز شد.',
  forbidden: 'دسترسی لازم برای این کار را ندارید.',
  not_found: 'این درخواست دیگر در فهرست شما نیست.',
  already_converted: 'این درخواست قبلاً تبدیل شده است.',
};
const errFa = (e: unknown) => ERR_FA[rawCode(e)] ?? errText(e);

function useWide() {
  const q = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

function initial<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = new URLSearchParams(window.location.search).get(key);
  return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback;
}

export default function CallbackRequests() {
  const [tab, setTab] = useState<CallbackTab>(() => initial('tab', ['all', ...STATUS_ORDER] as const, 'all'));
  const [who, setWho] = useState<CallbackWho>(() => initial('who', ['all', 'me', 'none'] as const, 'all'));
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<number | null>(() => Number(new URLSearchParams(window.location.search).get('open')) || null);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [calledId, setCalledId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [converting, setConverting] = useState<CallbackItem | null>(null);
  const wide = useWide();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['callbacks', 'list', tab, who, q], queryFn: () => callbacksApi.list(tab, who, q), refetchInterval: 20_000 });
  const assignees = useQuery({ queryKey: ['callbacks', 'assignees'], queryFn: callbacksApi.assignees, staleTime: 60_000 });
  const meta = list.data?.meta;
  const items = list.data?.items ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['callbacks'] });
  const say = (text: string) => setToast(text);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 3200); return () => window.clearTimeout(t); }, [toast]);
  // Desktop opens the most urgent request, like the design; mobile only opens on «جزئیات».
  useEffect(() => {
    if (wide && selected == null && items.length && new URLSearchParams(window.location.search).get('open') !== '0') setSelected(items[0].id);
  }, [wide, selected, items]);

  const act = useMutation({
    mutationFn: async (fn: () => Promise<{ item: CallbackItem }>) => fn(),
    onSuccess: () => refresh(),
    onError: (e) => { say(errFa(e)); refresh(); },
  });
  const run = (fn: () => Promise<{ item: CallbackItem }>, done?: (item: CallbackItem) => void) =>
    act.mutate(fn, { onSuccess: r => done?.(r.item) });

  const reveal = (item: CallbackItem) => {
    if (revealed[item.id]) { setRevealed(({ [item.id]: _, ...rest }) => rest); return; }
    callbacksApi.reveal(item.id).then(r => setRevealed(v => ({ ...v, [item.id]: r.phone })), e => say(errFa(e)));
  };
  const onCall = (item: CallbackItem) => {
    void callbacksApi.call(item.id).catch(() => undefined);
    window.setTimeout(() => setCalledId(item.id), 50); // let tel: open first, then ask for the outcome
  };
  const outcome = (item: CallbackItem, to: CallbackStatus) =>
    run(() => callbacksApi.status(item.id, to), () => { setCalledId(null); say(`وضعیت: ${CALLBACK_STATUS_FA[to]}`); });
  const take = (item: CallbackItem) => meta && run(() => callbacksApi.assign(item.id, meta.me), () => say('به شما تخصیص داده شد'));

  const selectedItem = items.find(i => i.id === selected) ?? null;
  const counts = list.data?.counts;
  const tabs: [CallbackTab, string][] = [['all', 'همه'], ...STATUS_ORDER.map(s => [s, CALLBACK_STATUS_FA[s]] as [CallbackTab, string])];

  return (
    <div className="cbx" data-testid="page-callback-requests">
      <header className="cbx-top">
        <div className="cbx-bar">
          {/* The page title «درخواست‌های تماس» is the CrmShell <h1>; this bar only carries the search. */}
          <label className="cbx-search">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">جستجوی نام یا شماره</span>
            <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="جستجوی نام یا شماره" data-testid="input-callback-search" />
          </label>
        </div>
        <div className="cbx-tabs" role="tablist" aria-label="فیلتر وضعیت">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className="cbx-tab" data-s={k === 'all' ? undefined : k}
              onClick={() => { setTab(k); setCalledId(null); }} data-testid={`tab-callbacks-${k}`}>
              {k !== 'all' && <span className="dot" aria-hidden="true" />}{label}<span className="n">{fa(counts?.[k] ?? 0)}</span>
            </button>
          ))}
        </div>
      </header>
      <div className="cbx-panes">
        <section className="cbx-listpane" aria-label="فهرست درخواست‌ها">
          <div className="cbx-tools">
            <div className="cbx-seg" role="group" aria-label="مسئول">
              {([['all', 'همه'], ['me', 'مال من'], ['none', 'بدون مسئول']] as const).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={who === k} onClick={() => setWho(k)} data-testid={`who-${k}`}>{l}</button>
              ))}
            </div>
            <span className="cbx-sort">ترتیب: فوری‌ترین اول</span>
          </div>
          {list.isLoading ? <div className="cbx-list"><SkeletonPanel rows={4} /></div>
            : list.isError ? <div className="cbx-list"><ErrorState onRetry={() => list.refetch()} /></div>
            : !items.length ? <div className="cbx-empty">{q ? 'درخواستی با این جستجو پیدا نشد.' : 'در این وضعیت درخواستی نیست.'}</div>
            : <div className="cbx-list">{items.map(item => (
              <CallbackCard key={item.id} item={item} meta={meta!} selected={wide && item.id === selected} shownPhone={revealed[item.id]}
                calledPrompt={calledId === item.id} busy={act.isPending}
                onReveal={() => reveal(item)} onCall={() => onCall(item)} onOpen={() => setSelected(item.id)} onTake={() => take(item)}
                onOutcome={to => outcome(item, to)} />
            ))}</div>}
        </section>
        {selectedItem && meta
          ? <CallbackDetail key={selectedItem.id} item={selectedItem} meta={meta} wide={wide} assignees={assignees.data?.items ?? []}
              busy={act.isPending} run={run} say={say} onClose={() => setSelected(null)} onCall={() => onCall(selectedItem)}
              onConvert={() => setConverting(selectedItem)} />
          : <div className="cbx-pane-empty"><p>یک درخواست را از فهرست انتخاب کنید.</p></div>}
      </div>
      {toast && <div className="cbx-toast" role="status" data-testid="toast-callbacks"><Check size={20} aria-hidden="true" />{toast}</div>}
      {converting && <ConvertWizard item={converting} onClose={() => setConverting(null)} onDone={() => { setConverting(null); refresh(); say('به سرنخ تبدیل شد'); }} />}
    </div>
  );
}

function StatusPill({ status }: { status: CallbackStatus }) {
  return <span className="cbx-st" data-s={status}>{CALLBACK_STATUS_FA[status]}</span>;
}

function CallbackCard({ item, meta, selected, shownPhone, calledPrompt, busy, onReveal, onCall, onOpen, onTake, onOutcome }: {
  item: CallbackItem; meta: CallbackMeta; selected: boolean; shownPhone?: string; calledPrompt: boolean; busy: boolean;
  onReveal: () => void; onCall: () => void; onOpen: () => void; onTake: () => void; onOutcome: (to: CallbackStatus) => void;
}) {
  const TimeIcon = TIME_ICON[item.contactTime];
  const mine = item.assignedUserId === meta.me;
  const next = CALLBACK_TRANSITIONS[item.status];
  return (
    <article className={`cbx-card${selected ? ' is-sel' : ''}`} aria-labelledby={`cbn${item.id}`} data-testid={`card-callback-${item.id}`}
      onClick={e => { if (!(e.target as HTMLElement).closest('a,button,input,select,textarea')) onOpen(); }}>
      <div className="r1">
        <StatusPill status={item.status} />
        {item.attempts > 0 && <span className="cbx-tag">تلاش {fa(item.attempts)}</span>}
        <span className={`age${item.late ? ' late' : ''}`}>
          {item.late ? <AlertCircle size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
          {item.late ? `${fa(waited(item.createdAt))} دقیقه منتظر` : ago(item.createdAt)}
        </span>
      </div>
      <h3 className="nm" id={`cbn${item.id}`}>{item.name}</h3>
      <div className="meta">
        <span className={`cbx-tag${item.contactTime === 'now' ? ' now' : ''}`}><TimeIcon size={16} aria-hidden="true" />تماس: {CONTACT_TIME_FA[item.contactTime]}</span>
        <span className="cbx-tag">{item.need ? NEED_FA[item.need] : 'موضوع: —'}</span>
        {item.planId && <span className="cbx-tag">{item.planName ?? `طرح ${fa(item.planId)}`}</span>}
      </div>
      <div className="phone">
        <b dir="ltr">{shownPhone ? fmtPhone(shownPhone) : fa(item.phoneMasked)}</b>
        {meta.canSeePhone && <button type="button" className="cbx-ib" onClick={onReveal} aria-label={shownPhone ? 'پنهان کردن شماره' : 'نمایش شماره'} data-testid={`button-reveal-${item.id}`}>
          {shownPhone ? <EyeOff size={22} /> : <Eye size={22} />}
        </button>}
      </div>
      <p className="src"><Link2 size={16} aria-hidden="true" />از: {srcLabel(item.src)}</p>
      <div className="asg">
        {item.assignedUserId
          ? <><UserAvatar userId={item.assignedUserId} name={item.assignedUserName} size={28} />{item.assignedUserName}{mine ? ' (شما)' : ''}</>
          : <><span className="none">بدون مسئول</span>{meta.canManage && <button type="button" className="cbx-text" disabled={busy} onClick={onTake} data-testid={`button-take-${item.id}`}>به من بسپار</button>}</>}
      </div>
      {item.status === 'cancelled' ? <>
        <p className="src">دلیل لغو: {item.cancelReason ? CANCEL_REASON_FA[item.cancelReason] : '—'}</p>
        <button type="button" className="cbx-more small" onClick={onOpen} data-testid={`button-open-${item.id}`}>جزئیات</button>
      </> : <div className="acts">
        {item.phone
          ? <a className="cbx-call" href={`tel:${item.phone}`} onClick={onCall} data-testid={`link-tel-${item.id}`}><Phone size={22} aria-hidden="true" />تماس</a>
          : <span className="cbx-call is-off" aria-disabled="true"><Phone size={22} aria-hidden="true" />شماره در دسترس شما نیست</span>}
        <button type="button" className="cbx-more" onClick={onOpen} data-testid={`button-open-${item.id}`}>جزئیات{item.notesCount > 0 && <span className="n">{fa(item.notesCount)}</span>}</button>
      </div>}
      {calledPrompt && meta.canManage && (
        <div className="outcome" role="group" aria-label="نتیجه تماس">
          <p>نتیجه تماس با {firstName(item.name)} چه شد؟</p>
          <div className="row">
            <button type="button" data-to="called" disabled={busy || !next.includes('called')} onClick={() => onOutcome('called')} data-testid={`outcome-called-${item.id}`}>تماس گرفته شد</button>
            <button type="button" data-to="no_answer" disabled={busy || !item.canRetry} onClick={() => onOutcome('no_answer')} data-testid={`outcome-noans-${item.id}`}>پاسخ نداد</button>
          </div>
          {!item.canRetry && item.nextAttemptAt && <p className="hint">تلاش بعدی از ساعت {clock(item.nextAttemptAt)}</p>}
          {item.suggestCancel && <p className="hint">سقف {fa(meta.maxAttempts)} تلاش رسید؛ پیشنهاد: «لغو».</p>}
          {next.includes('in_progress') && <button type="button" className="cbx-text later" disabled={busy} onClick={() => onOutcome('in_progress')} data-testid={`outcome-later-${item.id}`}>در حال پیگیری (بعداً)</button>}
        </div>
      )}
    </article>
  );
}

function CallbackDetail({ item, meta, wide, assignees, busy, run, say, onClose, onCall, onConvert }: {
  item: CallbackItem; meta: CallbackMeta; wide: boolean; assignees: { id: number; name: string }[]; busy: boolean;
  run: (fn: () => Promise<{ item: CallbackItem }>, done?: (item: CallbackItem) => void) => void; say: (t: string) => void;
  onClose: () => void; onCall: () => void; onConvert: () => void;
}) {
  const detail = useQuery({ queryKey: ['callbacks', 'detail', item.id, item.updatedAt, item.lastActivityAt], queryFn: () => callbacksApi.detail(item.id) });
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState('');
  const sheet = useRef<HTMLElement>(null);
  const next = CALLBACK_TRANSITIONS[item.status];
  const names = useMemo(() => new Map(assignees.map(a => [a.id, a.name])), [assignees]);
  useEffect(() => {
    if (wide) return;
    const prev = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [wide, onClose]);
  // Showing the full number here is logged once per open, same as the card's eye button.
  useEffect(() => { if (meta.canSeePhone) void callbacksApi.reveal(item.id).catch(() => undefined); }, [item.id, meta.canSeePhone]);

  const pick = (to: CallbackStatus) => {
    if (to === item.status && to !== 'no_answer') return;
    if (to === 'cancelled') { setPicking(true); return; }
    setPicking(false);
    run(() => callbacksApi.status(item.id, to), () => say(`وضعیت: ${CALLBACK_STATUS_FA[to]}`));
  };
  const cancelWith = (reason: CancelReason) =>
    run(() => callbacksApi.status(item.id, 'cancelled', reason), () => { setPicking(false); say(`وضعیت: لغو (${CANCEL_REASON_FA[reason]})`); });
  const shownStatus: CallbackStatus = picking ? 'cancelled' : item.status;
  const copy = () => item.phone && navigator.clipboard?.writeText(item.phone).then(() => say('شماره کپی شد'), () => undefined);

  const body = (
    <section ref={sheet} tabIndex={-1} className="cbx-detail" role={wide ? 'region' : 'dialog'} aria-modal={wide ? undefined : true}
      aria-labelledby={`cbd${item.id}`} data-testid="callback-detail">
      {!wide && <div className="grab" aria-hidden="true" />}
      <div className="dh">
        <h2 id={`cbd${item.id}`}>{item.name}</h2>
        <StatusPill status={item.status} />
        {!wide && <button type="button" className="cbx-ib" onClick={onClose} aria-label="بستن" data-testid="button-close-detail"><X size={22} /></button>}
      </div>
      <div className="cols">
        <div>
          <div className="dsec">
            <div className="bigphone">
              <b dir="ltr">{item.phone ? fmtPhone(item.phone) : fa(item.phoneMasked)}</b>
              {item.phone && <button type="button" className="cbx-ib" onClick={copy} aria-label="کپی شماره" data-testid="button-copy-phone"><Copy size={22} /></button>}
            </div>
            {item.phone && item.status !== 'cancelled' && <a className="nf-btn nf-btn-primary cbx-bigcall" href={`tel:${item.phone}`} onClick={onCall} data-testid="link-tel-detail">
              <PhoneCall size={20} aria-hidden="true" /> تماس با {firstName(item.name)}</a>}
            <dl className="dl">
              <dt>زمان درخواستی</dt><dd>{CONTACT_TIME_FA[item.contactTime]}</dd>
              <dt>موضوع</dt><dd>{item.need ? NEED_FA[item.need] : 'انتخاب نشده'}</dd>
              {item.planId && <><dt>طرح</dt><dd>{item.planName ?? `#${fa(item.planId)}`}</dd></>}
              <dt>منبع</dt><dd>{srcLabel(item.src)}</dd>
              <dt>ثبت</dt><dd>{ago(item.createdAt)}{item.trackingCode ? <> · کد <span dir="ltr">{item.trackingCode}</span></> : null}</dd>
              {item.customerId && <><dt>مشتری</dt><dd><Link href={`/customers/${item.customerId}`}>{item.customerName ?? `#${fa(item.customerId)}`}</Link></dd></>}
            </dl>
          </div>
          <div className="dsec">
            <h3 id={`cbs${item.id}`}>وضعیت</h3>
            <div className="sts" role="radiogroup" aria-labelledby={`cbs${item.id}`}>
              {STATUS_ORDER.map(s => {
                const allowed = s === item.status || next.includes(s);
                const disabled = !meta.canManage || busy || !allowed || (s === 'no_answer' && !item.canRetry);
                return <button key={s} type="button" role="radio" data-s={s} aria-checked={shownStatus === s} disabled={disabled && shownStatus !== s}
                  onClick={() => pick(s)} data-testid={`status-${s}`}>{CALLBACK_STATUS_FA[s]}</button>;
              })}
            </div>
            {shownStatus === 'cancelled' && (
              <div className="reason">
                <span className="lbl">دلیل لغو (لازم)</span>
                <div className="chips" role="radiogroup" aria-label="دلیل لغو">
                  {(Object.keys(CANCEL_REASON_FA) as CancelReason[]).map(r => (
                    <button key={r} type="button" role="radio" aria-checked={item.status === 'cancelled' && item.cancelReason === r}
                      disabled={!meta.canManage || busy || item.status === 'cancelled'} onClick={() => cancelWith(r)} data-testid={`reason-${r}`}>{CANCEL_REASON_FA[r]}</button>
                  ))}
                </div>
              </div>
            )}
            {(item.status === 'no_answer' || item.attempts > 0) && item.status !== 'cancelled' && item.status !== 'called' && (
              <p className="src big">
                تا الان {fa(item.attempts)} تلاش ناموفق.
                {item.suggestCancel ? ` سقف ${fa(meta.maxAttempts)} تلاش رسید؛ پیشنهاد: «لغو» (خودکار لغو نمی‌شود).`
                  : item.nextAttemptAt ? ` تلاش بعدی از ساعت ${clock(item.nextAttemptAt)}.` : ''}
              </p>
            )}
          </div>
          <div className="dsec">
            <h3><label htmlFor={`cba${item.id}`}>مسئول پیگیری</label></h3>
            {meta.canAssign
              ? <select className="cbx-sel" id={`cba${item.id}`} value={item.assignedUserId ?? ''} disabled={busy}
                  onChange={e => run(() => callbacksApi.assign(item.id, e.target.value ? Number(e.target.value) : null), () => say('مسئول به‌روز شد'))} data-testid="select-assign">
                  <option value="">بدون مسئول</option>
                  {assignees.map(a => <option key={a.id} value={a.id}>{a.name}{a.id === meta.me ? ' (شما)' : ''}</option>)}
                </select>
              : <div className="asg" id={`cba${item.id}`}>
                  {item.assignedUserId
                    ? <><UserAvatar userId={item.assignedUserId} name={item.assignedUserName} size={28} />{item.assignedUserName}{item.assignedUserId === meta.me ? ' (شما)' : ''}</>
                    : <><span className="none">بدون مسئول</span>{meta.canManage && <button type="button" className="cbx-text" disabled={busy}
                        onClick={() => run(() => callbacksApi.assign(item.id, meta.me), () => say('به شما تخصیص داده شد'))} data-testid="button-take-detail">به من بسپار</button>}</>}
                </div>}
          </div>
          {meta.canConvert && !item.convertedAt && item.status !== 'cancelled' && (
            <div className="dsec">
              <button type="button" className="nf-btn nf-btn-ghost" onClick={onConvert} data-testid="button-convert"><UserPlus size={18} /> تبدیل به سرنخ CRM</button>
            </div>
          )}
        </div>
        <div>
          {meta.canManage && (
            <div className="dsec">
              <h3><NotebookPen size={18} aria-hidden="true" /><label htmlFor={`cbt${item.id}`}>یادداشت</label></h3>
              <textarea className="cbx-ta" id={`cbt${item.id}`} maxLength={2000} value={note} onChange={e => setNote(e.target.value)}
                placeholder="مثلاً: عصر دوباره تماس بگیرم" data-testid="input-note" />
              <button type="button" className="cbx-secondary" disabled={busy}
                onClick={() => note.trim() ? run(() => callbacksApi.note(item.id, note), () => { setNote(''); say('یادداشت اضافه شد'); }) : say('اول متن یادداشت را بنویسید')} data-testid="button-add-note">افزودن یادداشت</button>
            </div>
          )}
          <div className="dsec">
            <h3><History size={18} aria-hidden="true" />تاریخچه</h3>
            {detail.isLoading ? <SkeletonPanel rows={3} /> : <Timeline item={item} events={detail.data?.events ?? []} names={names} me={meta.me} />}
          </div>
        </div>
      </div>
    </section>
  );
  if (wide) return <div className="cbx-detail-host">{body}</div>;
  return <><div className="cbx-scrim" onClick={onClose} aria-hidden="true" />{body}</>;
}

function Timeline({ item, events, names, me }: { item: CallbackItem; events: CallbackEvent[]; names: Map<number, string>; me: number }) {
  const who = (e: CallbackEvent) => (e.userId == null ? 'سیستم' : `${e.userName ?? 'کارشناس'}${e.userId === me ? ' (شما)' : ''}`);
  const userName = (id: string | null) => (id ? names.get(Number(id)) ?? `کاربر ${fa(id)}` : 'بدون مسئول');
  const statusText = (v: string | null) => {
    if (!v) return '—';
    const [s, reason] = v.split(':') as [CallbackStatus, CancelReason | undefined];
    return `${CALLBACK_STATUS_FA[s] ?? s}${reason ? ` (${CANCEL_REASON_FA[reason] ?? reason})` : ''}`;
  };
  const rows: { key: string; icon: ReactNode; who: string; at: string; text: ReactNode; note?: boolean }[] = [];
  for (const e of events) {
    const base = { key: String(e.id), who: who(e), at: e.createdAt };
    switch (e.action) {
      case 'note': rows.push({ ...base, icon: null, text: e.toValue, note: true }); break;
      case 'status': rows.push({ ...base, icon: <History size={16} />, text: `وضعیت: ${statusText(e.fromValue)} ← ${statusText(e.toValue)}` }); break;
      case 'assign': rows.push({ ...base, icon: <User size={16} />, text: e.toValue === e.userId?.toString() && !e.fromValue ? 'مسئول شد' : `مسئول: ${userName(e.toValue)}` }); break;
      case 'reveal': rows.push({ ...base, icon: <Eye size={16} />, text: 'شماره را دید' }); break;
      case 'call': rows.push({ ...base, icon: <Phone size={16} />, text: 'تماس گرفت (از دکمه تماس)' }); break;
      case 'convert': rows.push({ ...base, icon: <UserPlus size={16} />, text: 'به سرنخ CRM تبدیل شد' }); break;
      case 'notify': rows.push({ ...base, icon: <Bell size={16} />, text: `هشدار تلگرام «درخواست تماس»: ${({ sent: 'ارسال شد', failed: 'ناموفق', disabled: 'غیرفعال', not_configured: 'تنظیم نشده' } as Record<string, string>)[e.toValue ?? ''] ?? e.toValue}` }); break;
    }
  }
  rows.push({
    key: 'created', icon: <PhoneCall size={16} />, who: 'سیستم', at: item.createdAt,
    text: `ثبت از فرم «${srcLabel(item.src)}» · تماس: ${CONTACT_TIME_FA[item.contactTime]}${item.need ? ` · ${NEED_FA[item.need]}` : ''}`,
  });
  return (
    <ol className="cbx-tl">
      {rows.map(r => (
        <li key={r.key}>
          <span className={`ic${r.note ? ' note' : ''}`} aria-hidden="true">{r.note ? <NotebookPen size={16} /> : r.icon}</span>
          <div><div className="who">{r.who} · <time dateTime={r.at}>{ago(r.at)}</time></div><p className={`tx${r.note ? ' q' : ''}`}>{r.text}</p></div>
        </li>
      ))}
    </ol>
  );
}

const CONVERT_STEPS: readonly WizardStep<'review' | 'confirm'>[] = [{ key: 'review', title: 'بررسی' }, { key: 'confirm', title: 'تأیید' }];

function ConvertWizard({ item, onClose, onDone }: { item: CallbackItem; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<'review' | 'confirm'>('review');
  const [error, setError] = useState('');
  const convert = useMutation({ mutationFn: () => callbacksApi.convert(item.id), onSuccess: onDone, onError: e => setError(errFa(e)) });
  return (
    <Modal title="تبدیل به سرنخ" eyebrow={item.name} onClose={onClose} testId="convert-callback">
      <form className="cb-wizard" onSubmit={e => { e.preventDefault(); if (step === 'review') setStep('confirm'); else convert.mutate(); }}>
        <Stepper<'review' | 'confirm'> steps={CONVERT_STEPS} current={step} onGo={k => setStep(k)} />
        {step === 'review' ? <dl className="cb-meta">
          <div><dt>نام</dt><dd>{item.name}</dd></div>
          <div><dt>موبایل</dt><dd dir="ltr">{item.phone ? fmtPhone(item.phone) : fa(item.phoneMasked)}</dd></div>
          <div><dt>موضوع</dt><dd>{item.need ? NEED_FA[item.need] : '—'}</dd></div>
          <div><dt>کارشناس</dt><dd>{item.assignedUserName ?? 'طبق برنامه تخصیص'}</dd></div>
        </dl> : <p className="cb-confirm">
          {item.customerId
            ? <>این شماره قبلاً مشتری «{item.customerName}» است. درخواست به همان پرونده وصل می‌شود و برچسب «سرنخ سایت» می‌گیرد؛ اطلاعات مشتری تغییر نمی‌کند.</>
            : <>یک مشتری جدید (تأییدنشده) با برچسب «سرنخ سایت» ساخته می‌شود و یادداشت‌ها در توضیحات پرونده می‌آید. درخواست تسهیلات خودکار ساخته نمی‌شود.</>}
        </p>}
        {error && <p className="cb-error" role="alert">{error}</p>}
        <WizardActions onBack={step === 'confirm' ? () => setStep('review') : undefined} nextLabel={step === 'review' ? 'ادامه' : 'تبدیل'} pending={convert.isPending} testPrefix="convert-callback" />
      </form>
    </Modal>
  );
}
