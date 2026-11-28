/* t979 v1.1 — «پیام‌های آماده» panel of the Bale chat tray and of the customer file's Bale tab (design: bale-quick-replies-tabs).
   Three tabs, plan groups with search and chips, cards with «پیش‌نمایش» / «ارسال». «ارسال» sends at once (the server holds the message for the
   undo window); a toast «ارسال شد · برگرداندن» stays ~5 s; the panel stays open. The preview shows the full text and lets the expert change the type. */
import './quick-replies.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { I } from '@/features/bale-bot/ui';
import { TabBar } from './TabBar';
import { QR_EMPTY, QR_TABS, QR_TAB_HINT, QR_TAB_LABEL, countByTab, defaultTab, fdig, inTab, loadTab, matchesQuery, planGroups, renderText, saveTab, tabOf, type QrItem, type QrTab } from './model';
import { qrErr, qrSend, qrSetType, qrUndo, type QrReady } from './api';

type Props = {
  ready: QrReady; chatId: number; canSend: boolean; blockedHint?: string | null;
  customer: string | null; expert: string | null; explained: number[];
  onChanged: () => void; onSent: () => void; onClose?: () => void; headExtra?: ReactNode; surface?: 'tray' | 'file';
};
type Toast = { text: string; undo?: number; key: number };

export function ReadyTray({ ready, chatId, canSend, blockedHint, customer, expert, explained, onChanged, onSent, onClose, headExtra, surface = 'tray' }: Props) {
  const items = ready.items;
  const counts = useMemo(() => countByTab(items), [items]);
  const [tab, setTabState] = useState<QrTab>(() => defaultTab(items, explained, loadTab()));
  const setTab = (t: QrTab) => { setTabState(t); saveTab(t); };
  const [q, setQ] = useState('');
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const [prev, setPrev] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const vars = { customer, expert };
  const hold = ready.holdMs ?? 6000;

  useEffect(() => { if (!toast) return; const h = setTimeout(() => setToast(null), toast.undo ? Math.max(2000, hold - 1000) : 2600); return () => clearTimeout(h); }, [toast, hold]);

  const groups = useMemo(() => planGroups(items, { explained, currentPlanId: ready.currentPlanId, query: q, toggled }), [items, explained, ready.currentPlanId, q, toggled]);
  const chips = useMemo(() => planGroups(items, { explained, currentPlanId: ready.currentPlanId }), [items, explained, ready.currentPlanId]);
  const flat = tab === 'plans' ? [] : inTab(items, tab);
  const send = async (it: QrItem) => {
    if (!canSend || busy != null) return;
    setBusy(it.id);
    try {
      const r = await qrSend(chatId, it.id);
      setToast({ text: 'ارسال شد', undo: r.message.id, key: Date.now() });
      onSent(); setTimeout(onSent, hold + 1500);
    } catch (e) { setToast({ text: qrErr(e), key: Date.now() }); } finally { setBusy(null); }
  };
  const undo = async (id: number) => {
    setToast({ text: 'در حال برگرداندن…', key: Date.now() });
    try { await qrUndo(id); setToast({ text: 'برگردانده شد؛ پیام نرفت', key: Date.now() }); } catch (e) { setToast({ text: qrErr(e), key: Date.now() }); } finally { onSent(); }
  };
  const jump = (planId: number) => {
    setToggled((s) => ({ ...s, [planId]: true }));
    setTimeout(() => bodyRef.current?.querySelector<HTMLElement>(`[data-plan="${planId}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30);
  };
  const card = (it: QrItem) => <article key={it.id} className="qr-card" data-msg={it.id} data-testid="qr-card">
    <h3>{it.title}</h3>
    <p className="qr-prev">{renderText(it, vars)}</p>
    <div className="qr-acts">
      <button type="button" className="qr-btn" onClick={() => setPrev(it.id)}>پیش‌نمایش</button>
      <button type="button" className="qr-btn pri" disabled={!canSend || busy != null} aria-busy={busy === it.id} onClick={() => void send(it)} data-testid="qr-send">ارسال</button>
    </div>
  </article>;
  const empty = (t: QrTab) => <div className="qr-empty" data-testid={`qr-empty-${t}`}><h3>{QR_EMPTY[t].h}</h3><p>{QR_EMPTY[t].p}</p></div>;
  const shown = items.find((x) => x.id === prev) ?? null;

  return <section className={`qr-panel qr-${surface}`} aria-label="پیام‌های آماده" data-testid="qr-panel">
    <header className="qr-h"><h2>پیام‌های آماده</h2>{headExtra}{onClose ? <button type="button" className="qr-x" aria-label="بستن" onClick={onClose} data-testid="qr-close"><I n="x" /></button> : null}</header>
    <TabBar value={tab} counts={counts} onChange={setTab} />
    {tab === 'plans' ? <div className="qr-tools">
      <label className="qr-search"><I n="search" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی پیام یا طرح" aria-label="جستجوی پیام یا طرح" /></label>
      {chips.length ? <div className="qr-chips" role="group" aria-label="رفتن به طرح">{chips.map((g) => <button key={g.planId} type="button" className={`qr-chip${g.explained ? ' on' : ''}`} onClick={() => jump(g.planId)}>{g.title.replace(/^طرح\s+/, '')}</button>)}</div> : null}
    </div> : null}
    {!canSend && blockedHint ? <p className="qr-blocked" role="status">{blockedHint}</p> : null}
    <div className="qr-body" ref={bodyRef} data-testid="qr-body">
      {tab === 'plans'
        ? (groups.length ? groups.map((g) => <section key={g.planId} className={`qr-grp${g.open ? '' : ' closed'}`} data-plan={g.planId}>
            <button type="button" className="qr-ghd" aria-expanded={g.open} onClick={() => setToggled((s) => ({ ...s, [g.planId]: !g.open }))}>
              <span>{g.title.startsWith('طرح') ? g.title : `طرح ${g.title}`}</span><span className="qr-gc">{fdig(g.items.length)}</span>
              {g.current ? <span className="qr-cur">طرح فعلی</span> : null}<I n="chev" c="qr-chev" />
            </button>
            {g.open ? <div className="qr-gbody">{g.items.map(card)}</div> : null}
          </section>) : q.trim() ? <div className="qr-empty" data-testid="qr-empty-search"><h3>چیزی پیدا نشد</h3><p>عبارت دیگری را جستجو کنید.</p></div> : empty('plans'))
        : flat.length ? flat.map(card) : empty(tab)}
    </div>
    {shown ? <PreviewSheet key={shown.id} item={shown} text={renderText(shown, vars)} plans={ready.plans ?? []} canSend={canSend && busy == null}
      onClose={() => setPrev(null)} onSend={() => { setPrev(null); void send(shown); }}
      onType={async (t, planId) => { try { await qrSetType(shown.id, t, planId); setPrev(null); setTab(t); setToast({ text: `پیام به «${QR_TAB_LABEL[t]}» رفت`, key: Date.now() }); onChanged(); } catch (e) { setToast({ text: qrErr(e), key: Date.now() }); } }} /> : null}
    {toast ? createPortal(<div className={`qr-toast ${surface}`} role="status" aria-live="polite" key={toast.key} data-testid="qr-toast">
      <span>{toast.text}</span>{toast.undo ? <><span className="qr-dot" aria-hidden="true">·</span><button type="button" onClick={() => void undo(toast.undo!)} data-testid="qr-undo">برگرداندن</button></> : null}
    </div>, document.body) : null}
  </section>;
}

function PreviewSheet({ item, text, plans, canSend, onClose, onSend, onType }: { item: QrItem; text: string; plans: { id: number; name: string }[]; canSend: boolean; onClose: () => void; onSend: () => void; onType: (t: QrTab, planId?: number | null) => Promise<void> }) {
  const cur = tabOf(item);
  const [t, setT] = useState<QrTab>(cur);
  const [pid, setPid] = useState<number | null>(item.planId ?? plans[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const changed = t !== cur || (t === 'plans' && pid !== item.planId);
  const ok = changed && (t !== 'plans' || pid != null);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return createPortal(<div className="qr-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="qr-preview">
    <div className="qr-sheet" role="dialog" aria-modal="true" aria-labelledby="qr-pv-t" dir="rtl">
      <h2 id="qr-pv-t">پیش‌نمایش پیام</h2>
      <p className="qr-lead">{item.title}</p>
      <div className="qr-full">{text}</div>
      <div className="qr-fld"><div className="qr-lab">نوع پیام</div>
        <div className="qr-cats sm" role="radiogroup" aria-label="تغییر نوع پیام" data-testid="qr-type">
          {QR_TABS.map((x) => <button key={x.id} type="button" role="radio" aria-checked={t === x.id} className={`qr-cat${t === x.id ? ' on' : ''}`} onClick={() => setT(x.id)}><b>{x.label}</b></button>)}
        </div>
        {t === 'plans' ? <div className="qr-planfld"><label htmlFor="qr-pv-plan">طرح</label>
          {plans.length ? <select id="qr-pv-plan" className="qr-sel" value={pid ?? ''} onChange={(e) => setPid(Number(e.target.value))}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            : <p className="qr-mut">طرح فعالی نیست.</p>}</div> : null}
        {changed ? <button type="button" className="qr-btn pri qr-save" disabled={!ok || saving} onClick={async () => { setSaving(true); try { await onType(t, t === 'plans' ? pid : null); } finally { setSaving(false); } }} data-testid="qr-type-save">ذخیرهٔ نوع پیام</button> : null}
      </div>
      <div className="qr-sheet-acts"><button type="button" className="qr-btn" onClick={onClose}>بستن</button><button type="button" className="qr-btn pri" disabled={!canSend} onClick={onSend}>ارسال</button></div>
    </div>
  </div>, document.body);
}
