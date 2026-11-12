/**
 * Plan card — ONE rendering everywhere (PM 2026-10-23): hero sample, /plans, PlanCards, finder and calculator results.
 * Name + kind, the «ویژه‌ی بازنشستگان» tag where it applies, then ONLY مبلغ واریزی / مدت بازپرداخت (site-credit-noinst
 * v1.0, Mohammad t337u: no per-payment figure anywhere on the site) and a single «درخواست این طرح» button (Mohammad 2026-10-28: no rate, percentage, principal or other calculation).
 * No review time, method, «جزئیات بیشتر» or explanatory text.
 */import { fa, millionsFa, type Combo } from '../../lib/plans';
import { COMING_SOON_LABEL, type ComingSoonPlan } from '../../lib/loan-plans';
import { I } from '../ui/I';
import { amountParam } from '../../lib/apply';

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
  amount = false,
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
  /** calculator cards: add ?amount= (مبلغ واریزی → amount_range) so /request/ prefills the amount step */
  amount?: boolean;
  /** kept for call-site compatibility: every card now renders the same 2-figure layout */
  variant?: 'full' | 'result';
}) {
  return (
    <article className={`nf-card plan plan--result${featured ? ' nf-card--featured' : ''}`} data-plan-card={c.id}>
      {featured && <span className="nf-badge nf-badge--gold">{badge}</span>}
      <h3>
        <span className="nm">{name ?? c.name}</span>
      </h3>
      {c.retirees && <span className="nf-badge nf-badge--brand plan-tag">ویژه‌ی بازنشستگان</span>}
      {note && <p className="plan-note">{note}</p>}
      <dl className="money">
        <div>
          <dt className="lbl">مبلغ واریزی</dt>
          <dd className="val">حدود {millionsFa(c.payout)}</dd>
          <dd className="unit">میلیون تومان</dd>
        </div>
        <div>
          <dt className="lbl">مدت بازپرداخت</dt>
          <dd className="val sm">{fa(c.term)}</dd>
          <dd className="unit">ماهه</dd>
        </div>
      </dl>
      <a
        className={`nf-btn ${featured ? 'nf-btn--primary' : 'nf-btn--secondary'} nf-btn--block`}
        href={`/request/?plan=${c.id}&term=${c.term}${amount ? `&amount=${amountParam(c.payout)}` : ''}&src=${encodeURIComponent(src)}`}
      >
        {btn}
        {featured && <I name="arrow" />}
      </a>
    </article>
  );
}

/**
 * Card for an active plan the CRM cannot calculate yet (no payout the portal would accept): same layout, «به‌زودی»
 * instead of مبلغ واریزی, the terms as «۱۲، ۲۴ ماهه», no request button (PM 2026-10-28: never a number, never silently hidden).
 */
export function ComingSoonCard({ p, name }: { p: ComingSoonPlan; name: string }) {
  return (
    <article className="nf-card plan plan--result plan--soon" data-plan-card={p.id} data-plan-soon="1">
      <h3>
        <span className="nm">{name}</span>
      </h3>
      {p.retireesOnly && <span className="nf-badge nf-badge--brand plan-tag">ویژه‌ی بازنشستگان</span>}
      <dl className="money">
        <div>
          <dt className="lbl">مبلغ واریزی</dt>
          <dd className="val">{COMING_SOON_LABEL}</dd>
        </div>
        <div>
          <dt className="lbl">مدت بازپرداخت</dt>
          <dd className="val sm">{p.terms.map((t) => fa(t)).join('، ')}</dd>
          <dd className="unit">ماهه</dd>
        </div>
      </dl>
    </article>
  );
}
