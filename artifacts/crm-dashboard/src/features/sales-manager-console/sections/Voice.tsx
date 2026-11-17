// «مدیریت فروش» v1.3 §10 — تبدیل تماس به متن (bale-voice-v1.3.md §4; t358s1326: default «ذخیره و تبدیل خودکار»). /call-center stays where it is.
import { useMemo, useState } from 'react';
import type { BaleState, VoiceMode } from '../api';
import { c, fa, Chip, Seg } from '../ui';
import type { BaleAct } from './Bale';

const MODES: [VoiceMode, string][] = [['auto', 'ذخیره و تبدیل خودکار'], ['manual', 'فقط ذخیره؛ تبدیل دستی'], ['off', 'غیرفعال']];
export const voiceModeFa = (m: VoiceMode) => MODES.find((x) => x[0] === m)![1];
const tz = 'Asia/Tehran';
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
const hm = (d: Date) => fa(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: false }).format(d).replace(/^0(\d)/, '$1'));
export function whenCall(iso: string, now = new Date()) {
  const d = new Date(iso); const t = ymd(d); const today = ymd(now); const y = ymd(new Date(now.getTime() - 86_400_000));
  if (t === today) return hm(d);
  if (t === y) return `دیروز ${hm(d)}`;
  try { return `${new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', timeZone: tz }).format(d)} ${hm(d)}`; } catch { return hm(d); }
}
const dur = (s: number) => `${fa(Math.floor(s / 60))}:${fa(String(s % 60).padStart(2, '0'))}`;
const STATE: Record<string, [string, 'g' | 'b' | 'r' | undefined] | null> = { none: null, failed: ['ناموفق قبلی', 'r'], waiting: ['در نوبت', 'b'], queued: ['در صف', 'b'], processing: ['در حال تبدیل', 'b'] };

export function VoiceSection({ bs, act }: { bs: BaleState; act: BaleAct }) {
  const v = bs.voice; const can = bs.canWrite;
  const [sel, setSel] = useState<Set<number>>(new Set());
  const selectable = useMemo(() => v.rows.filter((r) => r.state === 'none' || r.state === 'failed'), [v.rows]);
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const run = async (body: unknown, msg: string) => { if (await act('/bale/voice/transcribe', 'POST', body, msg)) setSel(new Set()); };
  return (
    <div className={c('voice')} data-testid="sab-voice">
      <h3 className={c('bh3')}>ضبط و تبدیل</h3>
      <Seg label="ضبط و تبدیل تماس" value={v.mode} options={MODES} onChange={(m) => { if (can && m !== v.mode) void act('/bale/voice/mode', 'PUT', { mode: m }, `ضبط و تبدیل: ${voiceModeFa(m)}`); }} />
      <p className={c('hint')}>متن بعد از تبدیل در تاریخچه‌ی همان تماس در پرونده‌ی مشتری می‌نشیند. گزارش ضبط‌ها در «مرکز تماس» می‌ماند.</p>
      {v.mode === 'off' ? <p className={c('hint')}>تبدیل غیرفعال است؛ فهرست تماس‌های بدون متن تا روشن شدن دوباره پنهان است.</p> : (
        <>
          <div className={c('vhd')}>
            <h3 className={c('bh3')}>تماس‌های دارای صدا، بدون متن <span className={c('hint')}>{fa(v.total)} مورد</span></h3>
            {v.pending ? <Chip k="b">{fa(v.pending)} تماس در نوبت تبدیل</Chip> : null}
            <span className={c('sp')} />
            {can ? <>
              <button className={c('btn pri')} type="button" data-testid="sab-voice-sel" disabled={!sel.size} onClick={() => void run({ ids: [...sel] }, `${fa(sel.size)} تماس به صف تبدیل رفت.`)}>تبدیل انتخاب‌شده ({fa(sel.size)})</button>
              <button className={c('btn gh')} type="button" data-testid="sab-voice-all" disabled={!v.total} onClick={() => void run({ all: true }, `${fa(v.total)} تماس به نوبت تبدیل رفت.`)}>تبدیل همه</button>
            </> : null}
          </div>
          <div className={c('vlist')} role="table" aria-label="تماس‌های دارای صدا، بدون متن">
            <div className={c('vline vlh')} role="row"><span /><span>زمان</span><span>جهت</span><span>کارشناس</span><span>مشتری</span><span>مدت</span></div>
            {v.rows.map((r) => {
              const st = STATE[r.state]; const on = sel.has(r.id); const ok = selectable.includes(r);
              return (
                <div key={r.id} className={c('vline', on && 'on')} role="row" data-testid={`sab-call-${r.id}`}>
                  <span><button type="button" className={c('ck', on && 'on')} role="checkbox" aria-checked={on} aria-label={`انتخاب تماس ${fa(r.customer)}`} disabled={!can || !ok} onClick={() => toggle(r.id)}>
                    <svg className={c('i')} viewBox="0 0 24 24" aria-hidden="true">{on ? <path d="M5 13l4 4L19 7" /> : null}</svg></button></span>
                  <span className={c('vt')}>{whenCall(r.at)}</span>
                  <span className={c('vd')}>{r.direction === 'in' ? 'ورودی' : 'خروجی'}</span>
                  <span className={c('ve')}>{r.expert ?? '—'}</span>
                  <span className={c('vc')}><b>{fa(r.customer)}</b>{st ? <Chip k={st[1]}>{st[0]}</Chip> : null}</span>
                  <span className={c('vu')}>{dur(r.durationS)}</span>
                </div>
              );
            })}
          </div>
          {v.total > v.rows.length ? <p className={c('hint')}>{fa(v.rows.length)} تماس تازه‌تر نشان داده شده؛ «تبدیل همه» هر {fa(v.total)} تماس را می‌گیرد.</p> : null}
        </>
      )}
    </div>
  );
}
