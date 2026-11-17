/** Dock «دستیار» sheet: 1280 side, 390 bottom. 3-step wizard; customer picker first when no customer is in context. */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { paQuote, paSaveChips, paSearchCustomers, paSuggest } from "./api";
import { usePlanAdvisor } from "./PlanAdvisorContext";
import { faMonths, faNum, faToman, formatPrincipalInput, parsePrincipalInput, paStepLabel, PA_STATUS } from "./helpers";
import "./plan-advisor.css";

const JOBS: Array<{ v: string; l: string }> = [
  { v: "employee_with_insurance", l: "کارمند با لیست بیمه" },
  { v: "employee_no_insurance", l: "کارمند بدون لیست بیمه" },
  { v: "business", l: "آزاد با جواز کسب" },
  { v: "no_doc", l: "آزاد بدون مدرک شغلی" },
  { v: "retired", l: "بازنشسته" },
  { v: "unemployed", l: "بدون شغل" },
];
const PREFS: Array<{ v: string; l: string }> = [
  { v: "goods", l: "خرید کالا" }, { v: "score", l: "نقدی" }, { v: "both", l: "کالا یا نقدی" },
];
const colorFa: Record<string, string> = { yellow: "زرد", red: "قرمز", orange: "نارنجی", green: "سبز", white: "سفید", brown: "قهوه‌ای", black: "سیاه" };

export function PlanAdvisorSheet() {
  const pa = usePlanAdvisor();
  const qc = useQueryClient();
  const cid = pa.customerId;
  const suggest = useQuery({ queryKey: ["plan-advisor", "suggest", cid], queryFn: () => paSuggest(cid!), enabled: pa.open && cid != null && cid > 0, retry: 1 });
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => { const t = window.setTimeout(() => setDq(q.trim()), 250); return () => window.clearTimeout(t); }, [q]);
  const hits = useQuery({ queryKey: ["plan-advisor", "customers", dq], queryFn: () => paSearchCustomers(dq), enabled: pa.open && pa.step === 0, retry: 1 });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => paSaveChips(cid!, patch),
    onSuccess: (data) => { void qc.setQueryData(["plan-advisor", "suggest", cid], data); },
  });

  const plans = suggest.data?.plans ?? [];
  const visible = pa.step === 2 ? plans : plans.filter((p) => p.status !== "no");
  const selected = plans.find((p) => p.planId === pa.planId) ?? visible.find((p) => p.status !== "no") ?? plans[0];
  const defaultPrincipal = useMemo(() => {
    const mil = Number(suggest.data?.chips.find((c) => c.key === "amountMillion")?.raw);
    const want = Number.isFinite(mil) && mil > 0 ? mil * 1_000_000 : null;
    const cap = selected?.max ?? null;
    if (want && cap) return Math.min(want, cap);
    return want ?? cap ?? null;
  }, [suggest.data, selected?.max]);
  const defaultTerm = selected?.installments.includes(18) ? 18 : (selected?.installments[0] ?? 12);
  const [prinText, setPrinText] = useState("");
  const [term, setTerm] = useState<number>(defaultTerm);
  useEffect(() => {
    if (defaultPrincipal && !prinText) setPrinText(formatPrincipalInput(String(defaultPrincipal)));
  }, [defaultPrincipal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (selected) setTerm(selected.installments.includes(term) ? term : (selected.installments.includes(18) ? 18 : selected.installments[0] ?? term)); }, [selected?.planId]); // eslint-disable-line
  const principal = parsePrincipalInput(prinText);
  const quoteQ = useQuery({
    queryKey: ["plan-advisor", "quote", selected?.planId, principal, term, cid],
    queryFn: () => paQuote(selected!.planId, principal!, term, cid),
    enabled: pa.open && pa.step === 3 && selected != null && principal != null && term > 0,
    retry: 1,
  });
  const quote = quoteQ.data;

  if (!pa.open) return null;
  const close = () => pa.closeSheet();
  const credit = suggest.data?.credit;
  const widthPct = pa.step <= 0 ? "8%" : pa.step === 1 ? "33%" : pa.step === 2 ? "66%" : "100%";

  return (
    <div className="pa pa-mask" data-testid="pa-sheet" role="dialog" aria-modal="true" aria-labelledby="pa-sheet-title" dir="rtl" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="pa-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="pa-sheet-hd">
          <h2 id="pa-sheet-title">دستیار مشاوره</h2>
          <button type="button" className="pa-btn gh" aria-label="بستن" data-testid="pa-sheet-close" onClick={close}>×</button>
        </div>
        <div className="pa-prog">
          <p>{paStepLabel(pa.step)}</p>
          <div className="bar" aria-hidden="true"><i style={{ width: widthPct }} /></div>
        </div>

        {pa.step === 0 ? (
          <div data-testid="pa-step-pick">
            <p className="pa-empty">اول مشتری را انتخاب کنید.</p>
            <input className="pa-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جست‌وجو با نام یا شناسه…" aria-label="جستجوی مشتری" data-testid="pa-cust-q" />
            <ul className="pa-hits">
              {(hits.data?.items ?? []).map((c) => (
                <li key={c.id}><button type="button" data-testid={`pa-cust-${c.id}`} onClick={() => { pa.setCustomerId(c.id); pa.setStep(1); }}>{c.name} <span>#{faNum(c.id)}</span></button></li>
              ))}
            </ul>
          </div>
        ) : null}

        {cid && pa.step >= 1 ? (
          <div className="pa-picked" data-testid="pa-picked">
            <div>
              <b>{suggest.data?.customer.name ?? "…"}</b>
              <span>#{faNum(cid)}{credit?.rank ? ` · رتبه ${credit.rank}` : ""}{credit?.chequeColor ? ` · رنگ چک ${colorFa[credit.chequeColor] ?? credit.chequeColor}` : ""}</span>
            </div>
          </div>
        ) : null}

        {pa.step === 1 && cid ? (
          <div data-testid="pa-step-conds">
            {credit && (credit.rank || credit.chequeColor || credit.bouncedCount != null || credit.loanDebtToman != null) ? (
              <div className="pa-credit" data-testid="pa-credit">
                {credit.rank ? <span>رتبه {credit.rank}</span> : null}
                {credit.chequeColor ? <span>رنگ چک {colorFa[credit.chequeColor] ?? credit.chequeColor}</span> : null}
                {credit.bouncedCount != null ? <span>{faNum(credit.bouncedCount)} چک برگشتی</span> : null}
                {credit.loanDebtToman != null ? <span>مانده بدهی {faToman(credit.loanDebtToman)}</span> : null}
              </div>
            ) : null}
            <div className="pa-cond">
              {(suggest.data?.chips ?? []).map((c) => (
                <button type="button" key={c.key} data-testid={`pa-sheet-chip-${c.key}`}
                  onClick={() => { /* inline editors below */ }}>
                  {c.value}
                  {c.source === "site" ? <i className="pa-tag site">از سایت</i> : c.source === "inquiry" ? <i className="pa-tag inq">از استعلام</i> : null}
                </button>
              ))}
            </div>
            <div className="pa-edit">
              <label className="pa-field"><span>شغل</span>
                <select className="pa-search" value={String(suggest.data?.chips.find((c) => c.key === "jobType")?.raw ?? "")} data-testid="pa-edit-job"
                  onChange={(e) => save.mutate({ jobType: e.target.value || null })}>
                  <option value="">نامشخص</option>
                  {JOBS.map((j) => <option key={j.v} value={j.v}>{j.l}</option>)}
                </select>
              </label>
              <label className="pa-field"><span>ضامن</span>
                <select className="pa-search" value={String(suggest.data?.chips.find((c) => c.key === "guarantorAvailable")?.raw ?? "")} data-testid="pa-edit-guarantor"
                  onChange={(e) => save.mutate({ guarantorAvailable: e.target.value || null })}>
                  <option value="">نامشخص</option>
                  <option value="yes">ضامن دارد</option>
                  <option value="no">بدون ضامن</option>
                  <option value="unknown">نمی‌دونه</option>
                </select>
              </label>
              <label className="pa-field"><span>برای</span>
                <select className="pa-search" value={String(suggest.data?.chips.find((c) => c.key === "loanPref")?.raw ?? "")} data-testid="pa-edit-pref"
                  onChange={(e) => save.mutate({ loanPref: e.target.value || null })}>
                  <option value="">نامشخص</option>
                  {PREFS.map((j) => <option key={j.v} value={j.v}>{j.l}</option>)}
                </select>
              </label>
              <label className="pa-field"><span>مبلغ درخواستی (میلیون تومان)</span>
                <input inputMode="numeric" data-testid="pa-edit-amount" defaultValue={String(suggest.data?.chips.find((c) => c.key === "amountMillion")?.raw ?? "")}
                  onBlur={(e) => { const n = Number(e.target.value.replace(/[^\d]/g, "")); if (n > 0) save.mutate({ amountMillion: n }); }} />
              </label>
            </div>
            <div className="pa-sheet-acts">
              <button type="button" className="pa-btn gh" onClick={() => pa.setStep(0)}>انتخاب مشتری</button>
              <button type="button" className="pa-btn pri" data-testid="pa-next-plans" onClick={() => pa.setStep(2)}>بعدی</button>
            </div>
          </div>
        ) : null}

        {pa.step === 2 && cid ? (
          <div data-testid="pa-step-plans">
            <div className="pa-plans">
              {visible.map((p) => (
                <article key={p.planId} className="pa-pcard" data-testid={`pa-sheet-plan-${p.planId}`}>
                  <div className="pa-pcard-hd">
                    <h4>{p.name}</h4>
                    <span className={`pa-fit${p.status === "depends" ? " dep" : p.status === "no" ? " no" : ""}`}>{PA_STATUS[p.status]}</span>
                  </div>
                  <p className="pa-amt">سقف {faToman(p.max)}{faMonths(p.installments)}</p>
                  <div className="pa-reasons">{p.reasons.map((r, i) => <span key={i}>{r}</span>)}{p.info.map((r, i) => <span key={`i${i}`} className="warn">{r}</span>)}</div>
                  {p.status !== "no" ? <button type="button" className="pa-btn pri pa-calc-btn" data-testid={`pa-sheet-calc-${p.planId}`}
                    onClick={() => { pa.setPlanId(p.planId); pa.setStep(3); }}>محاسبه</button> : null}
                </article>
              ))}
            </div>
            <div className="pa-sheet-acts">
              <button type="button" className="pa-btn gh" data-testid="pa-prev-conds" onClick={() => pa.setStep(1)}>قبلی</button>
              <button type="button" className="pa-btn pri" disabled={!selected || selected.status === "no"} data-testid="pa-next-calc"
                onClick={() => { if (selected) { pa.setPlanId(selected.planId); pa.setStep(3); } }}>محاسبه</button>
            </div>
          </div>
        ) : null}

        {pa.step === 3 && cid ? (
          <div data-testid="pa-step-calc">
            <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 800, color: "var(--nf-ink, #0B1450)" }}>{selected?.name ?? quote?.planName ?? "طرح"}</h3>
            <label className="pa-field">
              <span>اصل مبلغ (تومان)</span>
              <input inputMode="numeric" className={quote?.overCeiling ? "bad" : undefined} value={prinText} data-testid="pa-principal"
                onChange={(e) => setPrinText(formatPrincipalInput(e.target.value))} />
            </label>
            {quote?.overCeiling ? <p className="pa-err" data-testid="pa-over-ceiling">اصل از سقف مسیر ({faToman(quote.ceiling)}) بیشتر است. رقم خروجی نشان داده نمی‌شود تا اصل اصلاح شود.</p> : null}
            <div className="pa-field">
              <span>تعداد اقساط</span>
              <div className="pa-terms" role="group" aria-label="تعداد اقساط">
                {(selected?.installments ?? []).map((n) => (
                  <button type="button" key={n} aria-pressed={term === n} data-testid={`pa-term-${n}`} onClick={() => setTerm(n)}>{faNum(n)} ماه</button>
                ))}
              </div>
            </div>
            {quote && !quote.overCeiling ? (
              <dl className="pa-facts" data-testid="pa-facts">
                <div className="pa-fact big"><dt>مبلغ واریزی</dt><dd>{faToman(quote.depositAmount)}</dd></div>
                <div className="pa-fact"><dt>مبلغ قسط</dt><dd>{faToman(quote.installment)}</dd></div>
                <div className="pa-fact"><dt>تعداد اقساط</dt><dd>{faNum(quote.count)} قسط ماهانه</dd></div>
                <div className="pa-fact"><dt>سود سالانه</dt><dd>{quote.annualInterest != null ? `${faNum(quote.annualInterest)}٪` : "—"}</dd></div>
                <div className="pa-fact"><dt>درصد واریزی</dt><dd>{quote.depositPercent != null ? `${faNum(quote.depositPercent)}٪` : "—"}</dd></div>
                {quote.deduction != null ? <div className="pa-fact"><dt>کسر از مشتری</dt><dd>{faToman(quote.deduction)}</dd></div> : null}
                <div className="pa-fact"><dt>هزینه تشکیل پرونده</dt><dd>{faToman(quote.filingFee)}</dd></div>
                {quote.downPayment ? <div className="pa-fact"><dt>پیش‌پرداخت</dt><dd>{faToman(quote.downPayment)}</dd></div> : null}
                {quote.commission != null ? <div className="pa-fact"><dt>حق‌العمل طرح کالایی</dt><dd>{faToman(quote.commission)}</dd></div> : null}
                <div className="pa-fact"><dt>جمع اقساط</dt><dd>{faToman(quote.installmentsTotal)}</dd></div>
                <div className="pa-fact big"><dt>جمع قابل پرداخت</dt><dd>{faToman(quote.totalPayable)}</dd></div>
              </dl>
            ) : quoteQ.isLoading ? <p className="pa-empty">در حال محاسبه…</p> : null}
            <div className="pa-sheet-acts">
              <button type="button" className="pa-btn gh" data-testid="pa-prev-plans" onClick={() => pa.setStep(2)}>قبلی</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
