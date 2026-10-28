/**
 * v82 «جواب‌های فرم سایت» (Armita site-apply-wizard v1.0.1, scenes b1_first / b2_repeat / b3_none).
 * Only the customer's own declared answers. No rate, percentage, offered amount, priority or expert name here.
 * Phones are never repeated in the block (the card header already has #id + the masked mobile).
 */
import { AlertTriangle, Check, Clock, Globe, Lock, RefreshCw, Zap } from 'lucide-react';
import { SA_KEYS, SA_LABELS, faN, saText, saWhen, srcFa, useSiteAnswers, type SiteAnswers, type SiteSubmission } from './api';
import './site-answers.css';

function Val({ k, a }: { k: keyof SiteAnswers; a: SiteAnswers }) {
  const v = a[k];
  if (v == null || (Array.isArray(v) && !v.length)) return <span className="sa-nil">بی‌جواب (اختیاری)</span>;
  const t = saText(k, v);
  if (k === 'has_bounced_or_overdue' && v === 'yes') return <span className="hx-tg td"><AlertTriangle size={13} aria-hidden="true" />{t}</span>;
  if (k === 'can_refer_retiree' && v === 'yes') return <>{t} <span className="hx-tg p1"><Zap size={13} aria-hidden="true" />فرصت معرفی</span></>;
  if (k === 'need_timing' && v === 'this_week') return <span className="hx-tg fs">{t}</span>;
  return <>{t || '—'}</>;
}

const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
const prevLine = (s: SiteSubmission) => `مبلغ: ${saText('amount_range', s.answers.amount_range).replace(' تومان', '')}، زمان: ${saText('need_timing', s.answers.need_timing).replace('فقط دارد بررسی می‌کند', 'فقط بررسی')}`;

export function SiteAnswersBlock({ customerId, showEmpty = false, enabled = true }: { customerId: number; showEmpty?: boolean; enabled?: boolean }) {
  const q = useSiteAnswers(customerId, enabled);
  const d = q.data;
  if (q.isError || !d) return null;
  if (!d.latest) {
    if (!showEmpty) return null;
    return <section className="sa none" aria-labelledby={`sa-t-${customerId}`} data-testid="site-answers-none">
      <div className="sah"><h5 id={`sa-t-${customerId}`}><Globe size={14} aria-hidden="true" />جواب‌های فرم سایت</h5></div>
      <p className="sa0">این مشتری فرم سایت را پر نکرده است.</p></section>;
  }
  const s = d.latest; const before = d.previous[0];
  const chg = new Set(before ? SA_KEYS.filter((k) => !same(s.answers[k], before.answers[k])) : []);
  const rep = d.count > 1;
  return <section className={`sa${rep ? ' rep' : ''}`} aria-labelledby={`sa-t-${customerId}`} data-testid="site-answers">
    <div className="sah"><h5 id={`sa-t-${customerId}`}><Globe size={14} aria-hidden="true" />جواب‌های فرم سایت</h5>
      {rep ? <span className="hx-tg rpt" data-testid="site-answers-repeat"><RefreshCw size={13} aria-hidden="true" />درخواست چندباره ({faN(d.count)} بار)</span>
        : <span className="hx-tg fc">اولین درخواست</span>}</div>
    <p className="sam"><Clock size={14} aria-hidden="true" />{saWhen(s.submittedAt)}، از {srcFa(s.src)}<br /><span>همه‌ی جواب‌ها اعلامی مشتری است</span></p>
    <dl className="fkv sakv">{SA_KEYS.map((k) => <div key={k} className={chg.has(k) ? 'chg' : undefined} data-testid={`sa-${k}`}>
      <dt>{SA_LABELS[k][0]}</dt><dd><Val k={k} a={s.answers} />{chg.has(k) ? <i className="nw">عوض شد</i> : null}</dd></div>)}
      {s.planId ? <div data-testid="sa-plan"><dt>طرح انتخابی</dt><dd>{s.planName ?? `#${faN(s.planId)}`}{s.term ? `، ${faN(s.term)} ماهه` : ''}</dd></div> : null}</dl>
    {d.previous.length ? <div className="saprev"><b>دفعه‌های قبل</b><ol>{d.previous.slice(0, 5).map((p) => <li key={p.id}><span className="cd">{saWhen(p.submittedAt, new Date(), false)}</span><span>{prevLine(p)}</span></li>)}</ol>
      <p className="hint"><Check size={13} aria-hidden="true" />پرونده‌ی تکراری ساخته نشد؛ همه‌ی درخواست‌ها روی همین مشتری است.</p></div> : null}
    <p className="hint sax"><Lock size={13} aria-hidden="true" />فقط جواب‌های خود مشتری در سایت؛ جای فرم تماس اول را نمی‌گیرد.</p>
  </section>;
}
