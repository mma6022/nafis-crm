/* t984 «تراکنش‌های کیف پول» (Armita bale-chat-fullheight v1.1 §5): desktop = button in the context column + centred window; phones = header ⋯ menu + bottom sheet.
   Window: balance, all / deposit / withdrawal, list, detail IN THE SAME window with «بازگشت», empty and loading states. Read-only: no write is reachable from here. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { I } from '@/features/bale-bot/ui';
import { DIR_FA, WALLET_FA, faDigits, dayFa, dayTimeFa, filterItems, signed, toman, tomanDigits, type BfhFilter, type BfhItem, type BfhWallet } from './model';
import { useBfhWallet } from './useWallet';
import './bale-fullheight.css';

const FILTERS: [BfhFilter, string][] = [['all', 'همه'], ['in', 'واریز'], ['out', 'برداشت']];

/** The balance text for the button / menu: cash first, credit only when there is some (both are wallets of the same customer). */
function BalanceLines({ w }: { w: BfhWallet | undefined }) {
  if (!w) return <span className="bfh-bal sk" aria-hidden="true" />;
  const credit = w.creditToman !== '0' && /^\d+$/.test(w.creditToman);
  return <span className="bfh-bal"><b className="bfh-num">{toman(w.cashToman)}</b>{credit ? <small className="bfh-num">اعتباری: {toman(w.creditToman)}</small> : null}</span>;
}

export function WalletButton({ chatId, onOpen }: { chatId: number; onOpen: () => void }) {
  const q = useBfhWallet(chatId, true);
  return <button type="button" className="bfh-walbtn" onClick={onOpen} data-testid="bfh-wallet-open" aria-haspopup="dialog">
    <span className="l"><b>تراکنش‌های کیف پول</b><span>{q.isError ? 'دریافت نشد؛ بزنید تا دوباره امتحان شود' : 'نمایش جزئیات'}</span></span>
    {q.isError ? null : <BalanceLines w={q.data} />}
  </button>;
}

/** Phones: the header «⋯» menu. Hidden ≥1024 by CSS (the column button is there). */
export function HeadMenu({ chatId, onWallet }: { chatId: number; onWallet: () => void }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  const q = useBfhWallet(chatId, open);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent | TouchEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('touchstart', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h); document.removeEventListener('keydown', k); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [chatId]);
  return <div className="bfh-hm" ref={ref}>
    <button type="button" className="ib bfh-hmb" aria-label="گزینه‌های بیشتر" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="bfh-head-menu"><I n="more" /></button>
    {open ? <div className="bfh-hmm" role="menu" aria-label="گزینه‌های گفتگو">
      <button type="button" role="menuitem" onClick={() => { setOpen(false); onWallet(); }} data-testid="bfh-menu-wallet"><b>تراکنش‌های کیف پول</b>{q.data ? <BalanceLines w={q.data} /> : null}</button>
    </div> : null}
  </div>;
}

function Row({ it, onPick }: { it: BfhItem; onPick: () => void }) {
  return <li><button type="button" className="bfh-wrow" onClick={onPick} data-testid="bfh-wallet-row">
    <span className="tp">{DIR_FA[it.dir]}<em>{WALLET_FA[it.wallet]}</em></span>
    <span className={`amt bfh-num ${it.dir === 'in' ? 'plus' : 'minus'}`}>{signed(it.dir, it.amountToman)}</span>
    <span className="dt">{dayFa(it.at)}</span>
    <span className="ds">{it.label}</span>
  </button></li>;
}

function Detail({ it }: { it: BfhItem }) {
  const kv = (k: string, v: React.ReactNode) => <div className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>;
  return <div className="bfh-wdet" data-testid="bfh-wallet-detail">
    <p className={`amt-lg bfh-num ${it.dir === 'in' ? 'plus' : 'minus'}`}>{signed(it.dir, it.amountToman)} <small>تومان</small></p>
    <p className="pill ok">موفق</p>
    {kv('نوع', DIR_FA[it.dir])}{kv('کیف پول', WALLET_FA[it.wallet])}{kv('تاریخ', dayTimeFa(it.at))}{kv('شرح', it.label)}
    {kv('شناسه', <span dir="ltr">#{faDigits(it.id)}</span>)}
    {it.balanceAfterToman != null ? kv('مانده پس از تراکنش', <span className="bfh-num">{toman(it.balanceAfterToman)}</span>) : null}
  </div>;
}

export function WalletModal({ chatId, onClose }: { chatId: number; onClose: () => void }) {
  const q = useBfhWallet(chatId, true);
  const [f, setF] = useState<BfhFilter>('all'); const [pick, setPick] = useState<BfhItem | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null); const backRef = useRef<HTMLButtonElement>(null); const opener = useRef<Element | null>(null);
  useEffect(() => { opener.current = document.activeElement; return () => { (opener.current as HTMLElement | null)?.focus?.(); }; }, []);
  useEffect(() => { (pick ? backRef.current : closeRef.current)?.focus(); }, [pick]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); if (pick) setPick(null); else onClose(); } };
    document.addEventListener('keydown', k, true); return () => document.removeEventListener('keydown', k, true);
  }, [pick, onClose]);
  const w = q.data; const rows = useMemo(() => (w ? filterItems(w.items, f) : []), [w, f]);
  const state: 'load' | 'err' | 'empty' | 'list' = q.isLoading ? 'load' : q.isError || !w ? 'err' : w.items.length === 0 ? 'empty' : 'list';
  return <div className="bfh-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="bfh-wallet-scrim">
    <div className="bfh-modal" role="dialog" aria-modal="true" aria-labelledby="bfh-wt" data-state={pick ? 'detail' : state} data-testid="bfh-wallet">
      <span className="bfh-grab" aria-hidden="true" />
      <div className="bfh-mh">
        {pick ? <button ref={backRef} type="button" className="bfh-back" onClick={() => setPick(null)} data-testid="bfh-wallet-back"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M7 4l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>بازگشت</button> : null}
        <h2 id="bfh-wt">{pick ? 'جزئیات تراکنش' : 'تراکنش‌های کیف پول'}</h2>
        <button ref={closeRef} type="button" className="bfh-x" onClick={onClose} aria-label="بستن" data-testid="bfh-wallet-close">×</button>
      </div>
      {pick ? <Detail it={pick} /> : <>
        {w ? <div className="bfh-sum"><span>موجودی نقدی<b className="bfh-num">{toman(w.cashToman)}</b></span><span>اعتبار تسهیلات<b className="bfh-num">{toman(w.creditToman)}</b></span></div> : null}
        {state === 'list' ? <div className="bfh-wf" role="radiogroup" aria-label="نوع تراکنش">{FILTERS.map(([v, t]) => <button key={v} type="button" role="radio" aria-checked={f === v} className="chip" onClick={() => setF(v)} data-testid={`bfh-wallet-f-${v}`}>{t}</button>)}</div> : null}
        {state === 'load' ? <div className="bfh-wload" role="status" aria-busy="true" data-testid="bfh-wallet-loading"><div className="sk" aria-hidden="true"><i /><i /><i /></div><h3>در حال آماده شدن</h3></div> : null}
        {state === 'err' ? <div className="bfh-wempty" role="alert" data-testid="bfh-wallet-error"><h3>دریافت کیف پول ممکن نشد</h3><p>اتصال را بررسی کنید و دوباره امتحان کنید.</p><button type="button" className="btn gh sm" onClick={() => void q.refetch()}>تلاش دوباره</button></div> : null}
        {state === 'empty' ? <div className="bfh-wempty" data-testid="bfh-wallet-empty"><h3>تراکنشی ثبت نشده</h3><p>برای این مشتری هنوز تراکنش کیف پولی نیست.</p></div> : null}
        {state === 'list' ? (rows.length ? <ul className="bfh-wlist" data-testid="bfh-wallet-list">{rows.map((it) => <Row key={`${it.wallet}${it.id}`} it={it} onPick={() => setPick(it)} />)}
          {w?.truncated ? <li className="bfh-wnote">فقط جدیدترین تراکنش‌های هر کیف پول نمایش داده می‌شود.</li> : null}</ul>
          : <div className="bfh-wempty" data-testid="bfh-wallet-none"><h3>تراکنشی در این بخش نیست</h3></div>) : null}
      </>}
    </div>
  </div>;
}
