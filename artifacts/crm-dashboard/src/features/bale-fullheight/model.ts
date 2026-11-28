/* t984 «گفتگوهای بله تمام‌قد» v1.1 (flag.bale_fullheight_v1, OFF by default): pure helpers + the read-only wallet client.
   Server: GET /api/bale-workspace/chats/:id/wallet (404 while the flag is OFF). Nothing here writes. */

export type BfhItem = { id: number; wallet: 'cash' | 'credit'; dir: 'in' | 'out'; amountToman: string; label: string; at: string; balanceAfterToman: string | null };
export type BfhWallet = { chatId: number; customerId: number; cashToman: string; creditToman: string; items: BfhItem[]; truncated: boolean };
export type BfhFilter = 'all' | 'in' | 'out';

const FD = '۰۱۲۳۴۵۶۷۸۹';
export const faDigits = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
/** U+066C ARABIC THOUSANDS SEPARATOR — never U+002C. Strips a Latin/Arabic comma already in the input so "8,000,000" still formats as «۸٬۰۰۰٬۰۰۰». */
export const TOMAN_SEP = '\u066C';
const STRIP_SEP = /[\u002C\u066C\u060C\u2009\u202F\s]/g;
const FA_TO_EN: Record<string, string> = Object.fromEntries([...FD].map((c, i) => [c, String(i)]));
export function tomanDigits(s: string | number | null | undefined): string {
  const t = String(s ?? '').trim().replace(STRIP_SEP, '').replace(/[۰-۹]/g, (d) => FA_TO_EN[d] ?? d);
  if (!/^\d+$/.test(t)) return '—';
  return faDigits(t.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, TOMAN_SEP));
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

/** A label is shown in full or not at all. Overflow: drop the expert label unless this is the manager view (then keep the expert label and drop later labels). */
export type BfhLabelKind = 'expert' | 'other';
export function packLabels<T extends { kind: BfhLabelKind; width: number }>(items: T[], avail: number, isManager: boolean, gap = 4): T[] {
  const sum = (xs: T[]) => xs.reduce((a, x, i) => a + x.width + (i ? gap : 0), 0);
  const pack = (xs: T[]) => {
    const out: T[] = [];
    let used = 0;
    for (const x of xs) {
      const need = x.width + (out.length ? gap : 0);
      if (used + need > avail) break;
      out.push(x); used += need;
    }
    return out;
  };
  if (avail <= 0) return isManager ? items.filter((x) => x.kind === 'expert').slice(0, 1) : [];
  if (sum(items) <= avail) return items;
  const expert = items.filter((x) => x.kind === 'expert');
  const other = items.filter((x) => x.kind !== 'expert');
  if (!isManager) return pack(other);
  return pack([...expert, ...other]);
}
