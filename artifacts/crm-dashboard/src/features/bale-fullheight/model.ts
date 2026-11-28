/* t984 «گفتگوهای بله تمام‌قد» v1.1 (flag.bale_fullheight_v1, OFF by default): pure helpers + the read-only wallet client.
   Server: GET /api/bale-workspace/chats/:id/wallet (404 while the flag is OFF). Nothing here writes. */

export type BfhItem = { id: number; wallet: 'cash' | 'credit'; dir: 'in' | 'out'; amountToman: string; label: string; at: string; balanceAfterToman: string | null };
export type BfhWallet = { chatId: number; customerId: number; cashToman: string; creditToman: string; items: BfhItem[]; truncated: boolean };
export type BfhFilter = 'all' | 'in' | 'out';

const FD = '۰۱۲۳۴۵۶۷۸۹';
export const faDigits = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
/** «۱٬۸۵۰٬۰۰۰» — thousands separator U+066C (Arabic thousands separator), Persian digits; works on the stored digit string, so big values never lose precision. */
export function tomanDigits(s: string | number | null | undefined): string {
  const t = String(s ?? '').trim();
  if (!/^\d+$/.test(t)) return '—';
  return faDigits(t.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '٬'));
}
export const toman = (s: string | number | null | undefined) => { const d = tomanDigits(s); return d === '—' ? d : `${d} تومان`; };
export const signed = (dir: 'in' | 'out', s: string) => `${dir === 'in' ? '+' : '−'}${tomanDigits(s)}`;
const TZ = 'Asia/Tehran';
/** «۷ آذر ۱۴۰۵» */
export function dayFa(iso: string): string {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
}
/** «۷ آذر ۱۴۰۵، ۱۴:۳۰» */
export function dayTimeFa(iso: string): string {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  return `${dayFa(iso)}، ${d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ })}`;
}
export const WALLET_FA = { cash: 'نقدی', credit: 'اعتباری' } as const;
export const DIR_FA = { in: 'واریز', out: 'برداشت' } as const;
export const filterItems = (items: BfhItem[], f: BfhFilter) => (f === 'all' ? items : items.filter((x) => x.dir === f));
