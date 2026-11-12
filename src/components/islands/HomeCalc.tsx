/**
 * Compact home calculator (designer home.html inline script, UX-SPEC §4.6): pick a received-amount band and a term;
 * shows the closest active plan (band match first, then nearest term; internal tie-break unchanged) with ONLY مبلغ واریزی
 * and مدت بازپرداخت (site-credit-noinst v1.0). The request link carries ?amount= so /request/ can prefill amount_range.
 */
import { useMemo, useState } from 'react';
import type { LoanPlan } from '../../lib/loan-plans';
import { FINDER_LABEL, bandOf, combos, fa, millionsFa, type FinderBand } from '../../lib/plans';
import { amountParam } from '../../lib/apply';
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
            <h2 id="calc-h">مبلغ و مدت را انتخاب کنید</h2>
            <p>نزدیک‌ترین طرح فعال را با مبلغ واریزی و مدت بازپرداخت نشان می‌دهیم.</p>
          </div>
        </div>
        <div className="calc">
          <div className="grp">
            <span id="cb-l">مبلغ موردنیاز (واریزی)</span>
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
              <dl className="money" style={{ marginBottom: 16 }}>
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
              <a className="nf-btn nf-btn--primary nf-btn--block" href={`/request/?plan=${c.id}&term=${c.term}&amount=${amountParam(c.payout)}&src=home-calc`}>
                درخواست این طرح <I name="arrow" />
              </a>
              <div style={{ textAlign: 'center' }}>
                <a className="nf-btn nf-btn--text" href="/calculator/">
                  همه‌ی مبلغ‌ها و مدت‌ها
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
