/** «پیشنهاد طرح» in the today middle column (after credit, before facilities). */
import { useQuery } from "@tanstack/react-query";
import { paSuggest } from "./api";
import { usePlanAdvisorOptional } from "./PlanAdvisorContext";
import { faMonths, faToman, PA_STATUS } from "./helpers";
import "./plan-advisor.css";

export function PlanAdvisorBox({ customerId }: { customerId: number }) {
  const pa = usePlanAdvisorOptional();
  const q = useQuery({ queryKey: ["plan-advisor", "suggest", customerId], queryFn: () => paSuggest(customerId), enabled: customerId > 0, retry: 1, staleTime: 15_000 });
  const top = (q.data?.plans ?? []).filter((p) => p.status !== "no").slice(0, 3);
  const rest = (q.data?.plans ?? []).some((p) => p.status === "no");
  return (
    <section className="pa pa-adv" data-testid="pa-box" dir="rtl">
      <div className="pa-adv-hd">
        <h3>پیشنهاد طرح</h3>
        <button type="button" className="pa-btn gh" data-testid="pa-open-assistant" onClick={() => pa?.openSheet({ customerId, step: 1 })}>باز کردن دستیار</button>
      </div>
      {q.isLoading ? <p className="pa-empty">در حال بارگذاری…</p> : q.isError ? <p className="pa-empty">پیشنهاد بارگذاری نشد.</p> : <>
        <div className="pa-cond" data-testid="pa-chips">
          {(q.data?.chips ?? []).map((c) => (
            <button type="button" key={c.key} disabled={!c.editable} data-testid={`pa-chip-${c.key}`}
              onClick={() => { if (c.editable) pa?.openSheet({ customerId, step: 1 }); }}>
              {c.value}
              {c.source === "site" ? <i className="pa-tag site">از سایت</i> : c.source === "inquiry" ? <i className="pa-tag inq">از استعلام</i> : null}
            </button>
          ))}
        </div>
        {top.length ? <div className="pa-plans" data-testid="pa-plans">
          {top.map((p) => (
            <article key={p.planId} className="pa-pcard" data-testid={`pa-plan-${p.planId}`} data-status={p.status}>
              <div className="pa-pcard-hd">
                <h4>{p.name}</h4>
                <span className={`pa-fit${p.status === "depends" ? " dep" : p.status === "no" ? " no" : ""}`}>{PA_STATUS[p.status]}</span>
              </div>
              <p className="pa-amt">سقف {faToman(p.max)}{faMonths(p.installments)}</p>
              <div className="pa-reasons">
                {p.reasons.map((r, i) => <span key={i}>{r}</span>)}
                {p.info.map((r, i) => <span key={`i${i}`} className="warn">{r}</span>)}
              </div>
              <button type="button" className="pa-btn pri pa-calc-btn" data-testid={`pa-calc-${p.planId}`}
                onClick={() => pa?.openSheet({ customerId, planId: p.planId, step: 3 })}>محاسبه</button>
            </article>
          ))}
        </div> : <p className="pa-empty" data-testid="pa-empty">هنوز طرح مناسبی با این شرایط نیست.</p>}
        {rest ? <button type="button" className="pa-more" data-testid="pa-more-plans" onClick={() => pa?.openSheet({ customerId, step: 2 })}>طرح‌های دیگر</button> : null}
      </>}
    </section>
  );
}
