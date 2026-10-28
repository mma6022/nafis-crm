/** Swap build-time plan facts ([data-plan-fact], [data-plan-count]) for the live CRM export. Silent on failure. */
import { fetchLoanPlans } from '../lib/loan-plans';
import { fa, planFactValue, planFacts } from '../lib/plans';

export async function refreshLiveFacts() {
  const facts = document.querySelectorAll<HTMLElement>('[data-plan-fact],[data-plan-count]');
  const title = document.querySelector<HTMLTitleElement>('title[data-bind-title]');
  if (!facts.length && !title) return;
  const plans = await fetchLoanPlans([]);
  if (!plans.length) return;
  const counts = planFacts(plans) as unknown as Record<string, number | string>;
  // home <title data-bind-title="وام با {planCount} طرح فعال …"> (Armita v1.0.1): same template, live count
  const tpl = title?.dataset.bindTitle;
  if (tpl && typeof counts.planCount === 'number' && counts.planCount > 0) document.title = tpl.replace(/\{planCount\}/g, fa(counts.planCount));
  facts.forEach((el) => {
    const count = el.dataset.planCount;
    if (count) {
      const v = counts[count];
      if (typeof v === 'number') el.textContent = fa(v);
      else if (typeof v === 'string' && v) el.textContent = v;
      return;
    }
    const [id, field, term] = (el.dataset.planFact ?? '').split(':');
    const v = planFactValue(plans, Number(id), field ?? '', term ? Number(term) : undefined);
    if (v) el.textContent = v;
  });
}

const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
/** First-touch UTM for the session, sent with the lead (lib/lead.ts readUtm). */
export function captureUtm() {
  try {
    const q = new URLSearchParams(location.search);
    const found = Object.fromEntries(UTM.flatMap((k) => (q.get(k) ? [[k, q.get(k)!.slice(0, 100)]] : [])));
    if (Object.keys(found).length && !sessionStorage.getItem('nf-utm')) sessionStorage.setItem('nf-utm', JSON.stringify(found));
  } catch {
    /* storage blocked */
  }
}
