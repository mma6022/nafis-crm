/**
 * Q1 «زمان دلخواه» (Armita reminder-custom-time v1.0 + PM answers) — the inline picker under the fifth «یادآور بعدی» card.
 * All rules come from the feed (rules.custom + serverNow): Sat–Thu, 10:00–18:00 (10:00 rule t651u) (both ends), 15-minute steps, ≥ 15 min from the
 * server's now, ≤ maxDay (90 days). Official holidays stay selectable with a faint «تعطیل» mark. The server re-checks everything
 * (remind_at_past / remind_at_closed / remind_at_too_far) and never silently moves a custom time.
 * Times are Tehran wall-clock (fixed +03:30, same as the server's tParts/fromTehran).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKE } from 'react';
import { CalendarClock, Check, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { faNum as fa } from '@/features/call-queue/api';

export type RctRules = { workStart: string; workEnd: string; stepMin: number; minLeadMin: number; maxDays: number; closedWeekdays: number[];
  today: string; maxDay: string; holidays: { date: string; label: string | null }[] };
export type RctVal = { ymd: string; h: number; mi: number };

const OFF = 210 * 60_000;
const p2 = (n: number) => String(n).padStart(2, '0');
const ymdOf = (ms: number) => { const w = new Date(ms + OFF); return `${w.getUTCFullYear()}-${p2(w.getUTCMonth() + 1)}-${p2(w.getUTCDate())}`; };
const minOf = (ms: number) => { const w = new Date(ms + OFF); return w.getUTCHours() * 60 + w.getUTCMinutes(); };
const utcDay = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d, 12); };
export const addDays = (ymd: string, n: number) => new Date(utcDay(ymd) + n * 86_400_000).toISOString().slice(0, 10);
export const wdOf = (ymd: string) => new Date(utcDay(ymd)).getUTCDay();
export const rctIso = (v: RctVal) => { const [y, m, d] = v.ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, v.h, v.mi) - OFF).toISOString(); };
const jFmt = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
const mFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', month: 'long' });
const wFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'UTC', weekday: 'long' });
const jCache = new Map<string, { y: number; m: number; d: number }>();
export const jOf = (ymd: string) => {
  let j = jCache.get(ymd);
  if (!j) { const ps = jFmt.formatToParts(new Date(utcDay(ymd))); const g = (t: string) => Number(ps.find((x) => x.type === t)?.value); j = { y: g('year'), m: g('month'), d: g('day') }; jCache.set(ymd, j); }
  return j;
};
export const monthName = (ymd: string) => mFmt.format(new Date(utcDay(ymd)));
export const dayName = (ymd: string) => wFmt.format(new Date(utcDay(ymd)));
/** «شنبه ۹ آبان» */
export const faDayLong = (ymd: string) => `${dayName(ymd)} ${fa(jOf(ymd).d)} ${monthName(ymd)}`;
export const faHm = (h: number, mi: number) => fa(`${h}:${p2(mi)}`);
/** «شنبه ۹ آبان، ساعت ۱۱:۳۰» — the success/summary format (HANDOFF phase 2 §4). */
export const rctLong = (v: RctVal) => `${faDayLong(v.ymd)}، ساعت ${faHm(v.h, v.mi)}`;
export const rctShort = (v: RctVal) => `${faDayLong(v.ymd)}، ${faHm(v.h, v.mi)}`;
export const rctFromIso = (iso: string): RctVal => { const ms = Date.parse(iso); const m = minOf(ms); return { ymd: ymdOf(ms), h: Math.floor(m / 60), mi: m % 60 }; };
const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

export function rctModel(r: RctRules, nowMs: number) {
  const start = hm(r.workStart), end = hm(r.workEnd), step = r.stepMin || 15;
  const lead = nowMs + r.minLeadMin * 60_000;
  const hol = new Map(r.holidays.map((h) => [h.date, h.label]));
  const today = ymdOf(nowMs) > r.today ? ymdOf(nowMs) : r.today;
  const closed = (ymd: string) => r.closedWeekdays.includes(wdOf(ymd));
  const slotOk = (ymd: string, h: number, mi: number) => {
    const m = h * 60 + mi;
    if (closed(ymd) || ymd < today || ymd > r.maxDay || m < start || m > end || mi % step) return false;
    return Date.parse(rctIso({ ymd, h, mi })) >= lead;
  };
  const hours: number[] = []; for (let h = Math.floor(start / 60); h * 60 <= end; h++) hours.push(h);
  const mins: number[] = []; for (let m = 0; m < 60; m += step) mins.push(m);
  const hourOk = (ymd: string, h: number) => mins.some((mi) => slotOk(ymd, h, mi));
  const dayOk = (ymd: string) => hours.some((h) => hourOk(ymd, h));
  const firstFree = () => { for (let i = 0, d = today; i <= r.maxDays + 1; i++, d = addDays(d, 1)) if (dayOk(d)) return d; return null; };
  return { today, hol, closed, slotOk, hourOk, dayOk, firstFree, hours, mins, start, end };
}
export type RctModel = ReturnType<typeof rctModel>;

/** Jalali months between today and maxDay, each with its Gregorian days. */
function months(m: RctModel, r: RctRules) {
  const out: { key: string; label: string; days: string[] }[] = [];
  let d = addDays(m.today, -(jOf(m.today).d - 1));
  const lastJ = jOf(r.maxDay);
  for (let guard = 0; guard < 6; guard++) {
    const j = jOf(d); const days: string[] = [];
    let x = d; while (jOf(x).m === j.m) { days.push(x); x = addDays(x, 1); }
    out.push({ key: `${j.y}-${j.m}`, label: `${monthName(d)} ${fa(j.y)}`, days });
    if (j.y > lastJ.y || (j.y === lastJ.y && j.m >= lastJ.m)) break;
    d = x;
  }
  return out;
}
const col = (ymd: string) => (wdOf(ymd) + 1) % 7; // Sat 0 … Thu 5, Fri 6 (not drawn)
const WD = ['ش', 'ی', 'د', 'س', 'چ', 'پ'];
const WDL = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه'];

export function RctPicker({ rules, model, initial, bad, onConfirm, onCancel, announce, hoursRef }: { rules: RctRules; model: RctModel; initial: RctVal | null;
  bad: boolean; onConfirm: (v: RctVal) => void; onCancel: () => void; announce: (s: string) => void; hoursRef: React.RefObject<HTMLDivElement | null> }) {
  const jumped = useRef<string | null>(null);
  const [day, setDay] = useState<string | null>(() => {
    if (initial && model.dayOk(initial.ymd)) return initial.ymd;
    const f = model.firstFree(); if (f && f !== model.today) jumped.current = f; return f;
  });
  const [h, setH] = useState<number | null>(initial && model.slotOk(initial.ymd, initial.h, initial.mi) ? initial.h : null);
  const [mi, setMi] = useState<number | null>(initial && model.slotOk(initial.ymd, initial.h, initial.mi) ? initial.mi : null);
  const ms = useMemo(() => months(model, rules), [model, rules]);
  const [mIdx, setMIdx] = useState(() => Math.max(0, ms.findIndex((x) => x.days.includes(day ?? model.today))));
  const [focus, setFocus] = useState<string>(day ?? model.today);
  const gridRef = useRef<HTMLTableElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (jumped.current) {
      const why = model.closed(model.today) ? 'امروز جمعه است' : `ساعت کاری امروز تمام شده${model.closed(addDays(model.today, 1)) ? ' و فردا جمعه است' : ''}`;
      announce(`${why}؛ اولین روز آزاد را برایت انتخاب کردیم: ${faDayLong(jumped.current)}.`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (moved.current) { moved.current = false; gridRef.current?.querySelector<HTMLButtonElement>(`[data-ymd="${focus}"]`)?.focus(); } }, [focus, mIdx]);
  const pick = (d: string) => {
    if (!model.dayOk(d)) return;
    setDay(d); setFocus(d);
    if (h != null && mi != null && !model.slotOk(d, h, mi)) { setH(null); setMi(null); }
  };
  const pickH = (x: number) => {
    if (!day || !model.hourOk(day, x)) return;
    setH(x); if (mi == null || !model.slotOk(day, x, mi)) setMi(model.mins.find((m) => model.slotOk(day, x, m)) ?? null);
  };
  const val: RctVal | null = day && h != null && mi != null && model.slotOk(day, h, mi) ? { ymd: day, h, mi } : null;
  const why = model.closed(model.today) ? 'امروز جمعه است' : `ساعت کاری امروز تمام شده${model.closed(addDays(model.today, 1)) ? ' و فردا جمعه است' : ''}`;
  const chips = [0, 1, 2].map((n) => {
    const d = addDays(model.today, n); const lbl = ['امروز', 'فردا', 'پس‌فردا'][n];
    const off = model.closed(d) ? 'جمعه، تعطیل' : !model.dayOk(d) ? (n === 0 ? 'ساعت کاری گذشت' : 'خارج از بازه') : '';
    const hol = model.hol.has(d);
    return { d, lbl, off, sub: off || `${hol ? 'تعطیل، ' : ''}${faDayLong(d)}` };
  });
  const mo = ms[mIdx];
  const rows: (string | null)[][] = [];
  if (mo) { let row: (string | null)[] = Array(6).fill(null);
    for (const d of mo.days) { const c = col(d); if (c === 6) continue; row[c] = d; if (c === 5) { rows.push(row); row = Array(6).fill(null); } }
    if (row.some(Boolean)) rows.push(row); }
  const allDays = ms.flatMap((x) => x.days);
  const go = (d: string) => {
    if (d < allDays[0] || d > allDays[allDays.length - 1]) return;
    let x = d; if (col(x) === 6) x = addDays(x, x > focus ? 1 : -1);
    if (x < allDays[0] || x > allDays[allDays.length - 1]) return;
    moved.current = true; setFocus(x); const i = ms.findIndex((m) => m.days.includes(x)); if (i >= 0 && i !== mIdx) setMIdx(i);
  };
  const onGridKey = (e: RKE<HTMLTableElement>) => {
    const k = e.key; let t: string | null = null;
    if (k === 'ArrowLeft') t = addDays(focus, col(focus) === 5 ? 2 : 1);
    else if (k === 'ArrowRight') t = addDays(focus, col(focus) === 0 ? -2 : -1);
    else if (k === 'ArrowDown') t = addDays(focus, 7);
    else if (k === 'ArrowUp') t = addDays(focus, -7);
    else if (k === 'Home') t = addDays(focus, -col(focus));
    else if (k === 'End') t = addDays(focus, 5 - col(focus));
    else if (k === 'PageDown' || k === 'PageUp') {
      const j = mIdx + (k === 'PageDown' ? 1 : -1); const m2 = ms[j];
      if (m2) { const dd = jOf(focus).d; t = m2.days[Math.min(dd, m2.days.length) - 1]; }
    }
    if (t) { e.preventDefault(); go(t); }
  };
  return <div className="rct-pk" id="rct-pk" data-testid="rct-panel">
    {jumped.current && day === jumped.current ? <p className="rct-jmp" data-testid="rct-jump"><Info size={15} aria-hidden="true" /> {why}؛ اولین روز آزاد را برایت انتخاب کردیم: {faDayLong(jumped.current)}.</p> : null}
    <div className="rct-blk">
      <span className="rct-bl" id="rct-dl">روز</span>
      <div className="rct-chips" role="group" aria-labelledby="rct-dl">{chips.map((c) =>
        <button key={c.d} type="button" className={`rct-chip${day === c.d ? ' on' : ''}`} aria-pressed={day === c.d} aria-disabled={c.off ? true : undefined}
          onClick={() => { if (!c.off) { pick(c.d); const i = ms.findIndex((m) => m.days.includes(c.d)); if (i >= 0) setMIdx(i); } }} data-testid={`rct-chip-${c.d}`}>
          <b>{c.lbl}</b><small>{c.sub}</small></button>)}</div>
      <div className="rct-mh">
        <button type="button" className="rct-nav" aria-label="ماه قبل" aria-disabled={mIdx <= 0 ? true : undefined} onClick={() => { if (mIdx > 0) setMIdx(mIdx - 1); }} data-testid="rct-prev"><ChevronRight size={18} aria-hidden="true" /></button>
        <b aria-live="polite" data-testid="rct-month">{mo?.label}</b>
        <button type="button" className="rct-nav" aria-label="ماه بعد" aria-disabled={mIdx >= ms.length - 1 ? true : undefined} onClick={() => { if (mIdx < ms.length - 1) setMIdx(mIdx + 1); }} data-testid="rct-nextm"><ChevronLeft size={18} aria-hidden="true" /></button>
      </div>
      <table className="rct-grid" role="grid" aria-label={mo?.label} ref={gridRef} onKeyDown={onGridKey} data-testid="rct-grid">
        <thead><tr>{WD.map((w, i) => <th key={w} scope="col" abbr={WDL[i]}>{w}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => <tr key={i}>{row.map((d, c) => <td key={c} role="gridcell" aria-selected={d ? day === d : undefined}>{d ? (() => {
          const ok = model.dayOk(d); const hol = model.hol.get(d); const past = d < model.today;
          const reason = past ? 'گذشته' : d > rules.maxDay ? `بیشتر از ${fa(rules.maxDays)} روز` : !ok ? 'ساعت کاری گذشت' : '';
          return <button type="button" className={`rct-day${day === d ? ' on' : ''}${d === model.today ? ' td' : ''}${hol !== undefined ? ' hol' : ''}`} data-ymd={d}
            tabIndex={d === focus ? 0 : -1} aria-current={d === model.today ? 'date' : undefined} aria-disabled={ok ? undefined : true}
            aria-label={`${dayName(d)} ${fa(jOf(d).d)} ${monthName(d)} ${fa(jOf(d).y)}${hol !== undefined ? `، تعطیل${hol ? ` (${hol})` : ''}` : ''}${reason ? `، ${reason}` : ''}`}
            title={hol !== undefined ? `تعطیل${hol ? `: ${hol}` : ''}` : undefined}
            onClick={() => { setFocus(d); pick(d); }} onFocus={() => setFocus(d)} data-testid={`rct-day-${d}`}>
            {fa(jOf(d).d)}{hol !== undefined ? <small className="rct-hol" aria-hidden="true">تعطیل</small> : null}</button>; })() : null}</td>)}</tr>)}</tbody>
      </table>
      <p className="rct-note">روزهای گذشته خاموش‌اند. جمعه‌ها تعطیل است و در تقویم نیامده؛ تعطیلی رسمی با «تعطیل» علامت خورده و قابل انتخاب است.</p>
    </div>
    <div className={`rct-blk${bad && !val ? ' bad' : ''}`}>
      <span className="rct-bl" id="rct-hl">ساعت <small>ساعت کاری {fa(rules.workStart.split(':')[0].replace(/^0/, ''))} تا {fa(rules.workEnd.split(':')[0])}</small></span>
      <div className="rct-hrs" role="group" aria-labelledby="rct-hl" aria-invalid={bad && !val ? true : undefined} ref={hoursRef} tabIndex={-1} data-testid="rct-hours">{model.hours.map((x) => {
        const ok = Boolean(day && model.hourOk(day, x));
        return <button key={x} type="button" className={`rct-h${h === x ? ' on' : ''}`} aria-pressed={h === x} aria-disabled={ok ? undefined : true} onClick={() => pickH(x)} data-testid={`rct-h-${x}`}>{fa(x)}</button>; })}</div>
      <span className="rct-bl sm" id="rct-ml">دقیقه <small>هر {fa(rules.stepMin)} دقیقه</small></span>
      <div className="rct-mins" role="group" aria-labelledby="rct-ml" data-testid="rct-mins">{model.mins.map((x) => {
        const ok = Boolean(day && h != null && model.slotOk(day, h, x));
        return <button key={x} type="button" className={`rct-m${mi === x && h != null ? ' on' : ''}`} aria-pressed={mi === x && h != null} aria-disabled={ok ? undefined : true}
          onClick={() => { if (ok) setMi(x); }} data-testid={`rct-m-${x}`}>{fa(`:${p2(x)}`)}</button>; })}</div>
    </div>
    <div className="rct-ft">
      {val ? <p className="rct-pv" data-testid="rct-preview">زمان انتخابی: <b>{rctLong(val)}</b>{model.hol.has(val.ymd) ? ' (تعطیل رسمی)' : ''}</p>
        : <p className="rct-pv none" data-testid="rct-preview">هنوز ساعت انتخاب نشده</p>}
      <div className="rct-fb">
        <button type="button" className="btn btn-primary rct-ok" aria-disabled={val ? undefined : true} onClick={() => { if (val) onConfirm(val); }} data-testid="rct-ok"><Check size={16} aria-hidden="true" /> تأیید زمان</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} data-testid="rct-cancel">انصراف</button>
      </div>
      <details className="rct-kb"><summary>راهنمای صفحه‌کلید</summary><ul>
        <li>تقویم: <kbd>←</kbd> روز بعد، <kbd>→</kbd> روز قبل، <kbd>↑</kbd> <kbd>↓</kbd> هفته، <kbd>Home</kbd> <kbd>End</kbd> اول و آخر هفته، <kbd>PageUp</kbd> <kbd>PageDown</kbd> ماه</li>
        <li><kbd>Enter</kbd> روز را انتخاب می‌کند؛ <kbd>Esc</kbd> فقط همین پنل را می‌بندد</li></ul></details>
    </div>
  </div>;
}
export const RctIcon = CalendarClock;
