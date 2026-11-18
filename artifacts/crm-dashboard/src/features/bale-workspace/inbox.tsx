/* «فضای کار بله» — glue for features/bale-bot/BaleBotInbox.tsx. One context so the inbox needs only small, gated edits.
   bw.on is false while flag.bale_workspace_v1 is OFF → the inbox renders exactly as before. */
import { createContext, useContext } from 'react';
import { StarPicker } from './Stars';
import { fd, phoneFa, type BwsChatCtx } from './api';

export type BwTab = 'chat' | 'file' | 'credit' | 'calls';
export type BwInbox = { on: boolean; ctx?: BwsChatCtx; tray: boolean; setTray: (v: boolean) => void; sub: 'plans' | null; tab: BwTab; setTab: (t: BwTab) => void; star: string; setStar: (s: string) => void; reload: () => void };
export const BW_OFF: BwInbox = { on: false, tray: false, setTray: () => {}, sub: null, tab: 'chat', setTab: () => {}, star: '', setStar: () => {}, reload: () => {} };
export const BwInboxCtx = createContext<BwInbox>(BW_OFF);
export const useBw = () => useContext(BwInboxCtx);

/** Chat header line: full phone, full national id (LTR), stars. */
export function BwHead({ chatId, toast }: { chatId: number; toast: (t: string) => void }) {
  const bw = useBw(); const c = bw.ctx?.chatId === chatId ? bw.ctx.context : null;
  if (!bw.on || !c || c.restricted) return null;
  return <div className="bws-hd" data-testid="bws-head">
    {c.customer.phone ? <span className="bws-num" dir="ltr" data-bws-phone="1">{phoneFa(c.customer.phone)}</span> : null}
    {c.customer.nationalCode ? <span className="bws-num" dir="ltr" data-bws-nid="1" aria-label="کد ملی">{fd(c.customer.nationalCode)}</span> : null}
    <StarPicker chatId={chatId} value={c.stars} toast={toast} onChange={() => bw.reload()} />
  </div>;
}
/** Star filter (همه / ۳ / ۲ / ۱ / بدون ستاره). */
export function BwStarFilter({ counts }: { counts?: Record<string, number> }) {
  const bw = useBw(); if (!bw.on) return null;
  const opts: [string, string][] = [['', 'همه'], ['3', '۳ ستاره'], ['2', '۲'], ['1', '۱'], ['0', 'بدون ستاره']];
  return <div className="flt bws-sf" role="radiogroup" aria-label="صافی ستاره" data-testid="bws-starfilter">{opts.map(([v, t]) => <button key={v} className="fb" type="button" role="radio" aria-checked={bw.star === v} onClick={() => bw.setStar(v)}>
    {v && v !== '0' ? <svg className="bws-star on" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z" /></svg> : null}{t}{v && counts?.[v] ? <span className="n">{fd(counts[v])}</span> : null}</button>)}</div>;
}
/** Mobile tabs, fixed just above the live dock. */
export function BwTabs() {
  const bw = useBw(); if (!bw.on) return null;
  const c = bw.ctx?.context; const full = !!c && !c.restricted;
  const T: [BwTab, string][] = [['chat', 'گفتگو'], ['file', 'پرونده'], ['credit', 'اعتبار'], ['calls', 'تماس‌ها']];
  return <nav className="bws-tabs" role="tablist" aria-label="زمینهٔ گفتگو" data-testid="bws-tabs">{T.map(([k, t]) => <button key={k} type="button" role="tab" aria-selected={bw.tab === k} disabled={k !== 'chat' && !full} onClick={() => bw.setTab(k)}>{t}</button>)}</nav>;
}
