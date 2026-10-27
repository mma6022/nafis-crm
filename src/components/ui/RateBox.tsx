/**
 * «نرخ» box (design site-seo-pages seo-ui.js rateBox; HANDOFF §0 v1.2). Fail-closed: unknown / stale / future / bad
 * qualifier → «از کارشناس بپرسید» (→ /request/ only; never a call or a number). Known → value + type (+ qualifier) +
 * «آخرین به‌روزرسانی». data-rate-exp / data-rate-src let scripts/rate-expiry.ts hide a rate that goes stale after the
 * build, without a new build.
 */
import { RATE_Q_LABEL, RATE_TYPE_LABEL, rateHideOn, ratePct, rateShamsi, rateState, tehranToday, type PlanRate, type RateQualifier } from '../../lib/rates';
import { I } from './I';

export function RateBox({ rate, staleDays, src = 'plan', row = false, today }: { rate?: PlanRate; staleDays?: number; src?: string; row?: boolean; today?: string }) {
  const st = rateState(rate, staleDays, today ?? tehranToday());
  const cls = `rate${row ? ' rate--row' : ''}`;
  if (st.s === 'unknown' || !rate || rate.value == null || !rate.type || !rate.updated_at)
    return (
      <div className={`${cls} rate--ask`} data-why={st.s === 'unknown' ? st.why : 'null'}>
        <span className="rate-l">نرخ</span>
        <a className="rate-ask" href={`/request/?src=${encodeURIComponent(src)}-rate`}>
          از کارشناس بپرسید <I name="arrow" size={18} />
        </a>
      </div>
    );
  return (
    <div className={cls} data-rate-exp={rateHideOn(rate, staleDays) ?? undefined} data-rate-src={src}>
      <span className="rate-l">نرخ</span>
      <span className="rate-m">
        <b className="rate-v">{ratePct(rate.value)}</b>
        <span className="rate-ty">{RATE_TYPE_LABEL[rate.type]}</span>
        {rate.qualifier && <span className="rate-q">{RATE_Q_LABEL[rate.qualifier as RateQualifier]}</span>}
      </span>
      <span className="rate-d">
        آخرین به‌روزرسانی: <time dateTime={rate.updated_at}>{rateShamsi(rate.updated_at)}</time>
      </span>
    </div>
  );
}
