// «مدیریت فروش» v1.3 §10 — تبدیل تماس به متن (bale-voice-v1.3.md §4; t358s1326: default «ذخیره و تبدیل خودکار»). /call-center stays where it is.
import { useMemo, useState } from 'react';
import { useVoicePage, type BaleState, type VoiceMode } from '../api';
import { c, Chip, Seg, I, hasPair, safeClock, safeDur, safeN, safeText } from '../ui';
import type { BaleAct } from './Bale';

const MODES: [VoiceMode, string][] = [['auto', 'ذخیره و تبدیل خودکار'], ['manual', 'فقط ذخیره؛ تبدیل دستی'], ['off', 'غیرفعال']];
export const voiceModeFa = (m: VoiceMode) => MODES.find((x) => x[0] === m)![1];
const tz = 'Asia/Tehran';
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
const hm = (d: Date) => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).split(':').map(Number); return safeClock(h! % 24, m!); };
const WD = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
export function whenCall(iso: string, now = new Date()) {
  const d = new Date(iso); const t = ymd(d); const today = ymd(now); const y = ymd(new Date(now.getTime() - 86_400_000));
  if (t === today) return hm(d);
  if (t === y) return `دیروز ${hm(d)}`;
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${t}T12:00:00Z`)) / 86_400_000);
  if (days > 1 && days < 7) return `${WD[new Date(`${t}T12:00:00Z`).getUTCDay()]} ${hm(d)}`;
  try { const j = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', timeZone: tz }).format(d); return `${hasPair(j) ? `${safeN(days)} روز پیش` : j} ${hm(d)}`; } catch { return hm(d); }
}
/** «صفحه‌ی ۲ از ۲۸»; a number with the forbidden pair is never printed («صفحه‌ی آخر» / «صفحه‌ی بعد از ۲۸»). */
const pageFa = (p: number, n: number) => {
  const one = (x: number) => (hasPair(String(x)) ? null : safeN(x));
  const cur = one(p) ?? (p === n ? 'آخر' : `بعد از ${safeN(p - 1)}`);
  const all = one(n);
  return all && p !== n ? `صفحه‌ی ${cur} از ${all}` : p === n ? `صفحه‌ی ${hasPair(String(p)) ? 'آخر' : `${cur} (آخر)`}` : `صفحه‌ی ${cur}`;
};
const STATE: Record<string, [string, 'g' | 'b' | 'r' | undefined] | null> = { none: null, failed: ['ناموفق قبلی', 'r'], waiting: ['در نوبت', 'b'], queued: ['در صف', 'b'], processing: ['در حال تبدیل', 'b'] };

export function VoiceSection({ bs, act }: { bs: BaleState; act: BaleAct }) {
  const can = bs.canWrite;
  const [page, setPage] = useState(1);
  const pq = useVoicePage(page, bs.voice);
  const v = page > 1 && pq.data ? { ...pq.data, mode: bs.voice.mode, total: bs.voice.total, pending: bs.voice.pending } : bs.voice;
  const pages = Math.max(1, Math.ceil(bs.voice.total / (bs.voice.per || 20)));
  const [sel, setSel] = useState<Set<number>>(new Set());
  const selectable = useMemo(() => v.rows.filter((r) => r.state === 'none' || r.state === 'failed'), [v.rows]);
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const run = async (body: unknown, msg: string) => { if (await act('/bale/voice/transcribe', 'POST', body, msg)) setSel(new Set()); };
  return (
    <div className={c('voice')} data-testid="sab-voice">
      <h3 className={c('bh3')}>ضبط و تبدیل</h3>
      <Seg label="ضبط و تبدیل تماس" value={v.mode} options={MODES} onChange={(m) => { if (can && m !== v.mode) void act('/bale/voice/mode', 'PUT', { mode: m }, `ضبط و تبدیل: ${voiceModeFa(m)}`); }} />
      {v.mode === 'off' ? <Chip k="g">تبدیل غیرفعال است</Chip> : (
        <>
          <div className={c('vhd')}>
            <h3 className={c('bh3')}>تماس‌های دارای صدا، بدون متن <span className={c('hint')} data-testid="sab-voice-total">{safeN(v.total)} مورد</span></h3>
            {v.pending ? <Chip k="b">{safeN(v.pending)} تماس در نوبت تبدیل</Chip> : null}
            <span className={c('sp')} />
            {can ? <>
              <button className={c('btn pri')} type="button" data-testid="sab-voice-sel" disabled={!sel.size} onClick={() => void run({ ids: [...sel] }, `${safeN(sel.size)} تماس به صف تبدیل رفت.`)}>تبدیل انتخاب‌شده ({safeN(sel.size)})</button>
              <button className={c('btn gh')} type="button" data-testid="sab-voice-all" disabled={!v.total} onClick={() => void run({ all: true }, `همه‌ی ${safeN(v.total)} تماس به نوبت تبدیل رفت؛ هر بار ۱۰ تماس تبدیل می‌شود.`)}>تبدیل همه</button>
            </> : null}
          </div>
          <div className={c('vlist')} role="table" aria-label="تماس‌های دارای صدا، بدون متن">
            <div className={c('vline vlh')} role="row"><span /><span>زمان</span><span>جهت</span><span>کارشناس</span><span>مشتری</span><span>مدت</span></div>
            {v.rows.map((r) => {
              const st = STATE[r.state]; const on = sel.has(r.id); const ok = selectable.includes(r);
              return (
                <div key={r.id} className={c('vline', on && 'on')} role="row" data-testid={`sab-call-${r.id}`}>
                  <span><button type="button" className={c('ck', on && 'on')} role="checkbox" aria-checked={on} aria-label={`انتخاب تماس ${safeText(r.customer)}`} disabled={!can || !ok} onClick={() => toggle(r.id)}>
                    <svg className={c('i')} viewBox="0 0 24 24" aria-hidden="true">{on ? <path d="M5 13l4 4L19 7" /> : null}</svg></button></span>
                  <span className={c('vt')}>{whenCall(r.at)}</span>
                  <span className={c('vd')}>{r.direction === 'in' ? 'ورودی' : 'خروجی'}</span>
                  <span className={c('ve')}>{r.expert ? safeText(r.expert) : '—'}</span>
                  <span className={c('vc')}><b>{safeText(r.customer)}</b>{st ? <Chip k={st[1]}>{st[0]}</Chip> : null}</span>
                  <span className={c('vu')}>{safeDur(r.durationS)}</span>
                </div>
              );
            })}
          </div>
          {pages > 1 ? (
            <nav className={c('pager')} aria-label="صفحه‌های فهرست تماس" data-testid="sab-voice-pager">
              <button className={c('ib')} type="button" aria-label="صفحه‌ی قبل" disabled={page <= 1} onClick={() => setPage(page - 1)}><I n="up" style={{ transform: 'rotate(90deg)' }} /></button>
              <span className={c('pgn')} aria-live="polite">{pageFa(page, pages)}</span>
              <button className={c('ib')} type="button" aria-label="صفحه‌ی بعد" disabled={page >= pages} onClick={() => setPage(page + 1)}><I n="down" style={{ transform: 'rotate(90deg)' }} /></button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
