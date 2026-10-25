import { useState } from 'react';
import { Mic } from 'lucide-react';
import { SkeletonPanel, ErrorState } from '@/components/CrmShell';
import { useVoiceUsage } from './api';
import { faDigits } from './voice-note-text';
import './voice-notes.css';

const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const monthLabel = (m: string) => { const [y, mm] = m.split('-'); return `${MONTHS[Number(mm) - 1] ?? mm} ${faDigits(y)}`; };
const n1 = (v: number) => v.toLocaleString('fa-IR', { maximumFractionDigits: 1 });
const usd = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
const ROLE: Record<string, string> = { admin: 'مدیر', salesperson: 'کارشناس فروش' };

/** Admin-only: monthly voice-to-text usage per user + rough cost (crm-voice-notes). */
export default function VoiceNotesUsage() {
  const [month, setMonth] = useState<string | null>(null);
  const q = useVoiceUsage(month);
  const d = q.data;
  return (
    <section className="data-page" data-testid="voice-usage-page">
      <div className="page-intro">
        <div>
          <div className="eyebrow">گزارش‌ها</div>
          <h2>مصرف تبدیل صدا به متن</h2>
          <p>دقیقه‌های صوتی که کارشناسان برای یادداشت تماس و توضیح مشتری به متن تبدیل کرده‌اند، با هزینه‌ی تقریبی. صدا و متن هیچ‌جا ذخیره نمی‌شود؛ اینجا فقط مدت و تعداد ثبت است.</p>
        </div>
      </div>
      {q.isLoading ? <SkeletonPanel rows={5} /> : q.isError || !d ? <ErrorState onRetry={() => void q.refetch()} /> : (
        <div className="panel vnu">
          <div className="vnu-head">
            <label className="vnu-month">ماه
              <select value={d.month} onChange={(e) => setMonth(e.target.value)} data-testid="voice-usage-month">
                {[...new Set([d.month, ...d.months])].sort().reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
            <span className={`vnu-status${d.config.enabled ? ' on' : ''}`} data-testid="voice-usage-status">
              <Mic size={14} /> {d.config.enabled ? 'فعال' : 'غیرفعال'} · {d.config.provider === 'xai' ? 'xAI' : 'OpenAI'} · <bdi dir="ltr">{d.config.model}</bdi> · سقف روزانه {faDigits(d.config.dailyLimitMinutes)} دقیقه
              {d.config.enabled && !d.config.hasKey ? <b className="vnu-nokey"> · کلید سرویس تنظیم نشده</b> : null}
            </span>
          </div>
          <div className="vnu-cards">
            <div className="vnu-card"><span>کل دقیقه‌ها</span><b data-testid="voice-usage-total-minutes">{n1(d.totals.minutes)}</b></div>
            <div className="vnu-card"><span>تعداد تبدیل</span><b>{n1(d.totals.count)}</b>{d.totals.errorCount ? <small>{faDigits(d.totals.errorCount)} ناموفق</small> : null}</div>
            <div className="vnu-card"><span>هزینه</span><b dir="ltr" data-testid="voice-usage-total-cost">{usd(d.totals.estCostUsd)}</b><small>تقریبی، بر اساس قیمت فهرست</small></div>
          </div>
          {d.providers && d.providers.length ? (
            <div className="vnu-providers" data-testid="voice-usage-providers">
              <span>سرویس‌دهنده:</span>
              {d.providers.map((p) => (
                <span key={`${p.provider}|${p.model}`} className="vnu-chip">
                  {p.provider === 'xai' ? 'xAI' : 'OpenAI'} <bdi dir="ltr">{p.model}</bdi> · {faDigits(p.served)} تبدیل · {n1(p.minutes)} دقیقه
                  {p.fallbacks ? <em> · {faDigits(p.fallbacks)} جایگزین خطای {p.provider === 'xai' ? 'OpenAI' : 'xAI'}</em> : null}
                </span>))}
            </div>) : null}
          {d.users.length === 0 ? <div className="empty-state compact">در این ماه هنوز تبدیلی ثبت نشده است.</div> : (
            <div className="vnu-scroll"><table className="vnu-table">
              <thead><tr><th>کاربر</th><th>نقش</th><th>دقیقه</th><th>تعداد</th><th>ناموفق</th><th>هزینه‌ی تقریبی</th></tr></thead>
              <tbody>{d.users.map((u) => (
                <tr key={u.userId} data-testid={`voice-usage-row-${u.userId}`}>
                  <td>{u.name || `کاربر ${faDigits(u.userId)}`}</td><td>{ROLE[u.role] ?? u.role}</td><td>{n1(u.minutes)}</td>
                  <td>{n1(u.count)}</td><td>{u.errorCount ? faDigits(u.errorCount) : '—'}</td><td dir="ltr">{usd(u.estCostUsd)}</td>
                </tr>))}</tbody>
              <tfoot><tr><td>جمع</td><td /><td>{n1(d.totals.minutes)}</td><td>{n1(d.totals.count)}</td><td>{d.totals.errorCount ? faDigits(d.totals.errorCount) : '—'}</td><td dir="ltr">{usd(d.totals.estCostUsd)}</td></tr></tfoot>
            </table></div>)}
        </div>)}
    </section>
  );
}
