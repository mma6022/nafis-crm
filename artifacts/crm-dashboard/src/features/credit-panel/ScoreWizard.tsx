/**
 * t943 — «اعتبارسنجی سریع» in the Bale chat («اعتبار»): a 4-step wizard that always runs a NEW inquiry the way the call form does.
 * 1 مشخصات (old result with its date, national code if missing) → 2 تأیید و ارسال کد (consent, SMS to the customer) → 3 کد پیامکی (the expert types the code the
 * customer got) → 4 نتیجه (fresh rank with its date, then cheques / colour / loans). The SMS part is the live InstantCreditCheck component (same API, same guards);
 * steps 2–4 follow its phase. When the server answers with a result younger than 24 h (its own reuse rule) no SMS is sent and the step says so, with the date.
 * Needs the per-user «اعتبارسنجی فوری» flag (flag.instant_credit_check.user.<id>); without it step 1 says so instead of silently skipping the code.
 */
import "./credit-panel.css";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InstantCreditCheck, type St } from "@/features/team-sales/InstantCreditCheck";
import { CreditCard } from "./CreditCard";
import { Av } from "./Av";
import { Sep } from "@/features/bale-workspace/Sep";
import { CpError, fa, jalaliDateTime, runInquiry, useCpMe, useCpView } from "./api";
import { useMissingFields } from "./MissingFields";
import { phaseStep, SCORE_STEPS } from "./score-wizard-phase";

export function ScoreWizard({ customer, onClose }: { customer: { id: number; name: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useCpMe();
  const view = useCpView(customer.id);
  const v = view.data;
  const icc = !!me.data?.icc;
  const miss = useMissingFields(customer.id, v?.customer, () => { void view.refetch(); }, false);
  const [started, setStarted] = useState(false);
  const [phaseS, setPhaseS] = useState<2 | 3 | 4>(2);
  const [debt, setDebt] = useState<"idle" | "running" | "done" | "kept" | "fail">("idle");
  const [debtErr, setDebtErr] = useState("");
  const ran = useRef(false);
  const step = started ? phaseS : 1;
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const onPhase = (p: St) => { const s = phaseStep(p); if (s) setPhaseS(s); };
  const runDebt = async () => {
    setDebt("running"); setDebtErr("");
    try { qc.setQueryData(["credit-panel", "view", customer.id], await runInquiry(customer.id, { confirmFresh: false })); setDebt("done"); }
    catch (e) {
      const ex = e as CpError;
      if (ex.code === "still_valid") setDebt("kept");
      else { setDebt("fail"); setDebtErr(ex.message); if (ex.body?.view && v) qc.setQueryData(["credit-panel", "view", customer.id], { ...ex.body.view, customer: v.customer }); }
    }
  };
  // Step 4 reached = the score is saved; the cheques / colour / loans bundle follows once (still-valid result is kept and labelled with its date).
  useEffect(() => { if (step === 4 && !ran.current) { ran.current = true; void runDebt(); } }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => { if (step === 2) setStarted(false); else onClose(); };
  const next = async () => { if (miss.missing) { if (!(await miss.save())) return; } setStarted(true); setPhaseS(2); };
  const rank = v?.customer.rank ?? null;
  const masked = v?.customer.nationalCodeMasked ? fa(v.customer.nationalCodeMasked) : "—";

  let body;
  if (!started) body = <>
    <div className="qcw-who" data-testid="sw-who"><Av name={customer.name} />
      <div><b>{fa(customer.name)}</b><span>#{fa(customer.id)}<Sep />کد ملی <span dir="ltr">{masked}</span></span></div></div>
    <div className="qcw-old" data-testid="sw-old">
      <b>نتیجه‌ی قبلی</b>
      {rank ? <span data-testid="sw-old-rank">رتبه <span dir="ltr">{rank.label}</span>، {rank.at ? jalaliDateTime(rank.at) : "تاریخ ثبت نشده"}؛ <em>قدیمی است و با کد پیامکی مشتری تازه می‌شود</em></span>
        : <span data-testid="sw-old-none">هنوز رتبه‌ای ثبت نشده است.</span>}
    </div>
    {v ? miss.fields : <div className="cpc-sk" />}
    <p className="qcw-hint">در مرحله‌ی بعد برای مشتری پیامک کد فرستاده می‌شود؛ کد را از خود مشتری بگیر.</p>
    {!icc ? <p className="cpc-err" role="alert" data-testid="sw-off">اعتبارسنجی اعتباریتو (اعتبارسنجی فوری) برای شما فعال نیست؛ از مدیر بخواه روشنش کند.</p> : null}
    <div className="qcw-act"><button type="button" className="btn gh" onClick={onClose} data-testid="sw-cancel">انصراف</button>
      <button type="button" className="btn pri" disabled={!v || !icc || (miss.missing && !miss.ready)} onClick={() => void next()} data-testid="sw-next">{miss.busy ? "در حال ذخیره…" : "بعدی"}</button></div>
  </>;
  else body = <>
    <div className="qcw-who" data-testid="sw-who"><Av name={customer.name} />
      <div><b>{fa(customer.name)}</b><span>#{fa(customer.id)}<Sep />کد ملی <span dir="ltr">{masked}</span></span></div></div>
    <div className="cpc-score" data-testid="sw-ic"><InstantCreditCheck customerId={customer.id} embedded hideRecent onPhase={onPhase} onRank={() => { void view.refetch(); }} /></div>
    {step === 4 ? <>
      <p className="qcw-hint" role="status" data-testid="sw-debt">{debt === "running" ? "در حال استعلام چک‌ها و وام‌ها…" : debt === "kept" ? "استعلام چک و وام همین مشتری هنوز معتبر است؛ همان نشان داده می‌شود (تاریخ در کارت پایین)." : debt === "fail" ? "استعلام چک و وام انجام نشد؛ رتبه ذخیره شده است." : debt === "done" ? "چک‌ها و وام‌ها هم به‌روز شد." : ""}</p>
      {debt === "fail" ? <p className="cpc-err" role="alert">{debtErr}<button type="button" className="btn gh" onClick={() => void runDebt()} data-testid="sw-debt-retry">تلاش دوباره</button></p> : null}
      <CreditCard customerId={customer.id} hideRank noNew />
    </> : null}
    <div className="qcw-act">{step === 4 ? <button type="button" className="btn pri" onClick={onClose} data-testid="sw-close">بستن</button>
      : <button type="button" className="btn gh" onClick={back} data-testid="sw-prev">{step === 2 ? "قبلی" : "بستن"}</button>}</div>
  </>;

  return createPortal(<div className="qcw" role="dialog" aria-modal="true" aria-labelledby="swT" data-testid="sw" data-step={step} data-nodnd="true">
    <div className="qcw-in">
      <div className="qcw-hd"><button type="button" className="qcw-back" onClick={back} aria-label="برگشت" data-testid="sw-back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg></button><h2 id="swT">اعتبارسنجی سریع</h2></div>
      <p className="qcw-stp" id="swP">مرحلهٔ {fa(step)} از {fa(4)} — {SCORE_STEPS[step - 1]}</p>
      <div className="qcw-bar" role="progressbar" aria-labelledby="swP" aria-valuemin={1} aria-valuemax={4} aria-valuenow={step}><i style={{ width: `${(step / 4) * 100}%` }} /></div>
      <div className="qcw-card">{body}</div>
    </div>
  </div>, document.body);
}
