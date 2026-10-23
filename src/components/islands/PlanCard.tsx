/**
 * Plan card (designer site.js `card()`): name + kind, received amount, installment, nominal amount, review time,
 * method, and a <details> with bank/platform, prepayment and rate. Pure: rendered statically by Astro (PlanCards,
 * hero sample, blog mini) and inside islands (finder, calculator).
 */
import { DAYS_LABEL, MODE_LABEL, fa, millionsFa, type Combo } from '../../lib/plans';
import { I } from '../ui/I';

/** QA-only stress label (designer `?longname=1`); enabled in dev or with PUBLIC_QA=1, never in a normal build. */
export const QA = import.meta.env.DEV || import.meta.env.PUBLIC_QA === '1';
export const LONG_NAME = 'بانک ملت | لندتک';

export function PlanCard({
  c,
  featured = false,
  src = 'finder',
  badge = '★ پیشنهاد ما برای شما',
  btn = 'درخواست همین طرح',
  name,
  note,
  variant = 'full',
}: {
  c: Combo;
  featured?: boolean;
  src?: string;
  badge?: string;
  btn?: string;
  /** display-name override (QA long-name test) */
  name?: string;
  /** short line under the title, e.g. a relaxed page preset */
  note?: string;
  /**
   * 'result' = calculator / finder result card: ONLY مبلغ دریافتی, مبلغ هر قسط, تعداد اقساط (no nominal amount,
   * costs/fees, instalment total, explanatory text or extra facts). 'full' = everywhere else (unchanged).
   */
  variant?: 'full' | 'result';
}) {
  const fast = c.days === 'under_7';
  if (variant === 'result') {
    return (
      <article className={`nf-card plan plan--result${featured ? ' nf-card--featured' : ''}`}>
        {featured && <span className="nf-badge nf-badge--gold">{badge}</span>}
        <h3>
          <span className="nm">{name ?? c.name}</span>
          <span className="kind">{c.type === 'goods' ? 'خرید کالا قسطی' : 'وام نقدی'}</span>
        </h3>
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
  return (
    <article className={`nf-card plan${featured ? ' nf-card--featured' : ''}`}>
      {featured && <span className="nf-badge nf-badge--gold">{badge}</span>}
      <h3>
        <span className="nm">{name ?? c.name}</span>
        <span className="kind">{c.type === 'goods' ? 'خرید کالا قسطی' : 'وام نقدی'}</span>
      </h3>
      {note && <p className="plan-note">{note}</p>}
      <div className="money">
        <div>
          <span className="lbl">مبلغ قابل دریافت</span>
          <span className="val">حدود {millionsFa(c.payout)}</span>
          <span className="unit">میلیون تومان</span>
        </div>
        <div>
          <span className="lbl">قسط {fa(c.term)} ماهه</span>
          <span className="val sm">حدود {millionsFa(c.inst)}</span>
          <span className="unit">میلیون تومان</span>
        </div>
        <span className="nominal">مبلغ اسمی وام: {millionsFa(c.principal)} میلیون تومان</span>
      </div>
      <ul className="facts">
        <li>
          <span className="k">
            <I name="clock" />
            زمان بررسی
          </span>
          <span className="v">{fast ? <span className="nf-badge nf-badge--success">{DAYS_LABEL[c.days]}</span> : (DAYS_LABEL[c.days] ?? c.days)}</span>
        </li>
        <li>
          <span className="k">
            <I name="pin" />
            روش
          </span>
          <span className="v">{MODE_LABEL[c.mode] ?? c.mode}</span>
        </li>
      </ul>
      <details className="more">
        <summary>
          جزئیات بیشتر <I name="down" size={18} />
        </summary>
        <div className="body">
          <ul className="facts">
            <li>
              <span className="k">بانک / پلتفرم</span>
              <span className="v">
                {c.bank} / {c.platform}
              </span>
            </li>
            <li>
              <span className="k">پیش‌پرداخت</span>
              <span className="v">{fa(String(c.prepay).replace('.', '٫'))}٪</span>
            </li>
            <li>
              <span className="k">سود سالانه</span>
              <span className="v">{fa(String(c.rate).replace('.', '٫'))}٪</span>
            </li>
          </ul>
        </div>
      </details>
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
