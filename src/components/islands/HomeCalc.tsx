/**
 * Compact home calculator (designer home.html inline script, UX-SPEC §4.6): pick a received-amount band and a term;
 * shows the closest active plan (band match first, then nearest term, then lowest installment).
 */
import { useMemo, useState } from 'react';
import type { LoanPlan } from '../../lib/loan-plans';
import { FINDER_LABEL, bandOf, combos, fa, millionsFa, type FinderBand } from '../../lib/plans';
import { useLoanPlans } from './useLoanPlans';
import { I } from '../ui/I';

export default function HomeCalc({ snapshot }: { snapshot: LoanPlan[] }) {
  const { plans } = useLoanPlans(snapshot);
  // retiree-only plans (21) are never the home sample: the finder/calculator offer them behind «بازنشسته هستم»
  const all = useMemo(() => combos(plans).filter((c) => !c.retirees), [plans]);
  const terms = useMemo(() => [...new Set(all.map((c) => c.term))].sort((a, b) => a - b), [all]);
  const [band, setBand] = useState<FinderBand>(2);
  const [term, setTerm] = useState(24);
  const c = useMemo(
    () =>
      [...all].sort(
        (x, y) =>
          Number(bandOf(y.payout) === band) - Number(bandOf(x.payout) === band) ||
          Math.abs(x.term - term) - Math.abs(y.term - term) ||
          x.inst - y.inst,
      )[0],
    [all, band, term],
  );
  return (
    <div className="split">
      <div>
        <div className="sec-head">
          <div>
            <h2 id="calc-h">قسط ماهانه‌تان را از همین حالا بدانید</h2>
            <p>مبلغ و مدت را انتخاب کنید؛ نزدیک‌ترین طرح فعال را نشان می‌دهیم.</p>
          </div>
        </div>
        <div className="calc">
          <div className="grp">
            <span id="cb-l">مبلغ موردنیاز (قابل دریافت)</span>
            <div className="seg" role="group" aria-labelledby="cb-l">
              {FINDER_LABEL.band.map((l, i) => (
                <button type="button" key={l} aria-pressed={band === i} onClick={() => setBand(i as FinderBand)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="grp">
            <span id="ct-l">مدت بازپرداخت</span>
            <div className="seg" id="ct" role="group" aria-labelledby="ct-l" style={{ ['--n' as string]: terms.length }}>
              {terms.map((t) => (
                <button type="button" key={t} aria-pressed={term === t} onClick={() => setTerm(t)}>
                  {fa(t)} ماه
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div>
        <div className="nf-card calc-out" aria-live="polite">
          {c && (
            <>
              <p className="who">
                نزدیک‌ترین طرح فعال: <b>{c.name}</b>
                {c.term !== term ? ` (این طرح ${fa(c.term)} ماهه است)` : ''}
              </p>
              <dl className="money money--3" style={{ marginBottom: 16 }}>
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
              <a className="nf-btn nf-btn--primary nf-btn--block" href={`/request?plan=${c.id}&term=${c.term}&src=home-calc`}>
                درخواست همین طرح <I name="arrow" />
              </a>
              <div style={{ textAlign: 'center' }}>
                <a className="nf-btn nf-btn--text" href="/calculator">
                  محاسبه دقیق‌تر
                </a>
              </div>
            </>
          )}
        </div>
        <p className="note" style={{ textAlign: 'start' }}>
          مبالغ برآوردی است و مبلغ قطعی پس از اعتبارسنجی اعلام می‌شود.
        </p>
      </div>
    </div>
  );
}
