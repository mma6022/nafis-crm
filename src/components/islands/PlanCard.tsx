/**
 * Plan card — ONE rendering everywhere (PM 2026-10-23): hero sample, /plans, PlanCards, finder and calculator results.
 * Name + kind, the «ویژه‌ی بازنشستگان» tag where it applies, then ONLY مبلغ دریافتی / مبلغ هر قسط / تعداد اقساط and a
 * single «درخواست این طرح» button. No review time, method, «جزئیات بیشتر» or explanatory text.
 */import { fa, millionsFa, type Combo } from '../../lib/plans';
import { I } from '../ui/I';

/** QA-only stress label (designer `?longname=1`); enabled in dev or with PUBLIC_QA=1, never in a normal build. */
export const QA = import.meta.env.DEV || import.meta.env.PUBLIC_QA === '1';
export const LONG_NAME = 'بانک ملت | لندتک';

export function PlanCard({
  c,
  featured = false,
  src = 'finder',
  badge = '★ پیشنهاد ما برای شما',
  btn = 'درخواست این طرح',
  name,
  note,
}: {
  c: Combo;
  featured?: boolean;
  src?: string;
  badge?: string;
  btn?: string;
  /** display-name override (QA long-name test) */
  name?: string;
  /** short line under the title, e.g. a relaxed page preset (never under the button) */
  note?: string;
  /** kept for call-site compatibility: every card now renders the same 3-figure layout */
  variant?: 'full' | 'result';
}) {
  return (
    <article className={`nf-card plan plan--result${featured ? ' nf-card--featured' : ''}`} data-plan-card={c.id}>
      {featured && <span className="nf-badge nf-badge--gold">{badge}</span>}
      <h3>
        <span className="nm">{name ?? c.name}</span>
        <span className="kind">{c.type === 'goods' ? 'خرید کالا قسطی' : 'وام نقدی'}</span>
      </h3>
      {c.retirees && <span className="nf-badge nf-badge--brand plan-tag">ویژه‌ی بازنشستگان</span>}
      {note && <p className="plan-note">{note}</p>}
      <dl className="money money--3">
        <div>
          <dt className="lbl">مبلغ دریافتی</dt>
          <dd className="val">حدود {millionsFa(c.payout)}</dd>
          <dd className="unit">میلیون تومان</dd>
        </div>
        <div>
          <dt className="lbl">مبلغ هر قسط</dt>
          <dd className="val sm">حدود {millionsFa(c.inst)}</dd>
          <dd className="unit">میلیون تومان</dd>
        </div>
        <div>
          <dt className="lbl">تعداد اقساط</dt>
          <dd className="val sm">{fa(c.term)}</dd>
          <dd className="unit">قسط ماهانه</dd>
        </div>
      </dl>
      <a
        className={`nf-btn ${featured ? 'nf-btn--primary' : 'nf-btn--secondary'} nf-btn--block`}
        href={`/request?plan=${c.id}&term=${c.term}&src=${encodeURIComponent(src)}`}
      >
        {btn}
        {featured && <I name="arrow" />}
      </a>
    </article>
  );
}
