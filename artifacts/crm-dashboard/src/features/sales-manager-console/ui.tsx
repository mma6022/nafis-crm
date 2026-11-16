// Small building blocks for «مدیریت تیم فروش» (classes come from smc.css, all prefixed smc-).
import type { ReactNode } from 'react';

/** 'btn pri' → 'smc-btn smc-pri' (false/empty parts are skipped). */
export const c = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean).map((x) => `smc-${x}`).join(' ');
export const fa = (s: unknown) => String(s ?? '').replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
export const latin = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
export const hm = (min: number) => `${fa(Math.floor(min / 60))}:${fa(String(min % 60).padStart(2, '0'))}`;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const P: Record<string, ReactNode> = {
  up: <path d="M12 19V5M6 11l6-6 6 6" />, down: <path d="M12 5v14M6 13l6 6 6-6" />, x: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />, chev: <path d="M6 9l6 6 6-6" />, clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>, undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>,
  cal: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>, rf: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  team: <><circle cx="9" cy="8" r="3.5" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c1-3.5 3.5-5 6-5s5 1.5 6 5M15 15c2.5 0 4.5 1.5 5.5 4" /></>,
  edit: <path d="M4 20h4L19 9l-4-4L4 16z" />, play: <path d="M8 5l11 7-11 7z" />,
  more: <><circle cx="6" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18" cy="12" r="1.2" /></>,
  grip: <><circle cx="9" cy="6" r="1.1" /><circle cx="15" cy="6" r="1.1" /><circle cx="9" cy="12" r="1.1" /><circle cx="15" cy="12" r="1.1" /><circle cx="9" cy="18" r="1.1" /><circle cx="15" cy="18" r="1.1" /></>,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />, copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>,
};
export function I({ n, cls, style }: { n: keyof typeof P | string; cls?: string; style?: React.CSSProperties }) {
  return <svg className={`${c('i')}${cls ? ` ${c(cls)}` : ''}`} viewBox="0 0 24 24" aria-hidden="true" style={style}>{P[n]}</svg>;
}

/** The seven queue colours of «کارهای امروز من»; «سرد» only in the model mix. */
export const TY: Record<string, [string, string]> = {
  in: ['ورودی', '--t-in'], lead: ['لید تازه', '--t-lead'], fu: ['پیگیری', '--t-fu'], rem: ['یادآور', '--t-rem'],
  file: ['اقدام پرونده', '--t-file'], pay: ['دستور پرداخت', '--t-pay'], out: ['تماس خروجی', '--t-out'],
};
export const TYX: Record<string, [string, string]> = { ...TY, cold: ['سرد', '--t-cold'] };
export const Dot = ({ t }: { t: string }) => <span className={c('dt')} style={{ background: `var(${(TYX[t] ?? TYX.fu)![1]})` }} />;
export const TyLabel = ({ t }: { t: string }) => { const x = TYX[t] ?? TYX.fu!; return <span className={c('ty')} style={{ color: `var(${x[1]})` }}><Dot t={t} />{x[0]}</span>; };

export function Stp({ value, onChange, min = 0, max = 999, step = 1, label, fmt }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label: string; fmt?: (v: number) => string }) {
  return (
    <span className={c('stp')} role="group" aria-label={label}>
      <button type="button" aria-label={`کم کردن ${label}`} disabled={value - step < min} onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <b aria-live="polite">{fmt ? fmt(value) : fa(value)}</b>
      <button type="button" aria-label={`زیاد کردن ${label}`} disabled={value + step > max} onClick={() => onChange(Math.min(max, value + step))}>+</button>
    </span>
  );
}
export function Seg<T extends string>({ value, options, onChange, label, lockFirst }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string; lockFirst?: boolean }) {
  return (
    <div className={c('seg')} role="radiogroup" aria-label={label}>
      {options.map(([v, l], i) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} className={c(v === value && 'on', lockFirst && i === 0 && 'lockd')} onClick={() => onChange(v)}>
          {lockFirst && i === 0 ? <I n="lock" /> : null}{l}
        </button>
      ))}
    </div>
  );
}
export const Tgl = ({ on, onClick, children, cls, disabled }: { on: boolean; onClick: () => void; children: ReactNode; cls?: string; disabled?: boolean }) => (
  <button type="button" role="switch" aria-checked={on} disabled={disabled} className={c('tgl', on && 'on', cls)} onClick={onClick}><span className={c('sw')} />{children}</button>
);
export const Pick = ({ on, onClick, children, cnt, label }: { on: boolean; onClick: () => void; children: ReactNode; cnt?: ReactNode; label?: string }) => (
  <button type="button" aria-pressed={on} aria-label={label} className={c('pick', on && 'on')} onClick={onClick}>{children}{cnt != null ? <span className={c('cnt')}>{cnt}</span> : null}</button>
);
export const Chip = ({ k, children }: { k?: 'g' | 'b' | 'ok' | 'r' | 'lock'; children: ReactNode }) => <span className={c('chip', k)}>{children}</span>;
/** «توکن» of the rule sentences: a native select so it works with keyboard and touch. */
export function Tok<T extends string>({ value, options, onChange, k, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; k?: 'g' | 'n'; label: string }) {
  return (
    <select className={c('tok', 'sel', k)} value={value} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
export const Kw = ({ children }: { children: ReactNode }) => <span className={c('kw')}>{children}</span>;
/** 2026-11-19 → «۲۸ آبان» (Jalali, Persian digits); weekday too when asked. */
export const jd = (ymd: string, weekday = false) => {
  try { return new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-arabext', { day: 'numeric', month: 'long', ...(weekday ? { weekday: 'long' } : {}) }).format(new Date(`${ymd}T12:00:00+03:30`)).replace(/٬|،(?= )/g, '،').replace(/[٠-٩]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)]!); } catch { return fa(ymd); }
};
export const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const WD = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
const WEEKS = ['', 'هفته‌ی بعد', 'دو هفته‌ی بعد', 'سه هفته‌ی بعد', 'چهار هفته‌ی بعد'];
/** Day labels without day-of-month digits («امروز»، «فردا»، «جمعه‌ی هفته‌ی بعد»): the design keeps the forbidden digit pair off the page. */
export const relDay = (today: string, ymd: string) => {
  const n = Math.round((Date.parse(`${ymd}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (n === 0) return 'امروز'; if (n === 1) return 'فردا'; if (n === 2) return 'پس‌فردا'; if (n < 0) return 'گذشته';
  const wd = WD[new Date(`${ymd}T12:00:00Z`).getUTCDay()]!;
  // weeks counted Saturday-first, like the Iranian calendar week
  const sat = (d: string) => { const x = new Date(`${d}T12:00:00Z`); return Math.floor((x.getTime() / 86_400_000 + 5) / 7); };
  const w = sat(ymd) - sat(today);
  return w <= 0 ? wd : w < WEEKS.length ? `${wd}‌ی ${WEEKS[w]}` : wd;
};
