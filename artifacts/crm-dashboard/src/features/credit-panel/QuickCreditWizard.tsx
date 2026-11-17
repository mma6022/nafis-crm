/**
 * credit-panel v1 — «اعتبارسنجی سریع» (spec §2.3): 3 steps with a progress bar, few fields per step.
 * 1 انتخاب مشتری (the expert's own customers; skipped when opened from a customer) → 2 تکمیل نواقص (only missing national code / Jalali birth date, saved on the
 * customer) → 3 تأیید و اجرا (masked summary; consent tick for the score when «اعتبارسنجی فوری» is on; «استعلام» runs the debt bundle).
 */
import "./credit-panel.css";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getListCustomersQueryKey, useListCustomers } from "@workspace/api-client-react";
import { InstantCreditCheck } from "@/features/team-sales/InstantCreditCheck";
import { CreditCard } from "./CreditCard";
import { CpError, fa, runInquiry, useCpMe, useCpView } from "./api";
import { useMissingFields } from "./MissingFields";

const STEPS = ["انتخاب مشتری", "تکمیل نواقص", "تأیید و اجرا"];
const initials = (name: string) => name.replace(/^(آقای|خانم)\s+/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("‌");

function Pick({ onPick }: { onPick: (c: { id: number; name: string }) => void }) {
  const [search, setSearch] = useState("");
  const [deb, setDeb] = useState("");
  useEffect(() => { const t = window.setTimeout(() => setDeb(search.trim()), 250); return () => window.clearTimeout(t); }, [search]);
  const params = { search: deb || undefined, limit: 8 };
  const list = useListCustomers(params, { query: { queryKey: getListCustomersQueryKey(params), staleTime: 10_000 } });
  const items = (list.data?.items ?? []) as { id: number; name: string }[];
  return <div className="qcw-pick">
    <label className="cpf-l" htmlFor="qcwS">مشتری</label>
    <input id="qcwS" className="cpf-in" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="نام یا شناسه (#۱۲۳۴)" autoComplete="off" data-testid="qcw-search" />
    <ul className="qcw-list" aria-busy={list.isFetching || undefined}>
      {items.map((c) => <li key={c.id}><button type="button" className="qcw-item" onClick={() => onPick(c)} data-testid="qcw-item">
        <span className="qcw-av" aria-hidden="true">{initials(c.name)}</span><b>{fa(c.name)}</b><span className="qcw-id">#{fa(c.id)}</span></button></li>)}
      {!list.isFetching && !items.length ? <li className="cpc-empty">مشتری‌ای پیدا نشد.</li> : null}
    </ul>
  </div>;
}

export function QuickCreditWizard({ onClose, customer: fixed }: { onClose: () => void; customer?: { id: number; name: string } }) {
  const qc = useQueryClient();
  const me = useCpMe();
  const [step, setStep] = useState(fixed ? 2 : 1);
  const [cust, setCust] = useState<{ id: number; name: string } | null>(fixed ?? null);
  const view = useCpView(cust?.id ?? null);
  const v = view.data;
  const miss = useMissingFields(cust?.id ?? 0, v?.customer, () => { void view.refetch(); });
  const [consent, setConsent] = useState(false);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const back = () => { if (done) { setDone(false); return; } if (step === 1 || (fixed && step === 2)) onClose(); else setStep(step - 1); };
  const next2 = async () => { if (miss.missing) { if (!(await miss.save())) return; } setStep(3); };
  const go = async (confirmFresh = false) => {
    if (!cust) return;
    setAsk(false); setErr(""); setBusy(true);
    try { const r = await runInquiry(cust.id, { confirmFresh }); qc.setQueryData(["credit-panel", "view", cust.id], r); setDone(true); }
    catch (e) { const ex = e as CpError; if (ex.code === "still_valid") setAsk(true); else setErr(ex.message); }
    finally { setBusy(false); }
  };
  const masked = v?.customer.nationalCodeMasked ? fa(v.customer.nationalCodeMasked) : "—";
  const who = cust ? <div className="qcw-who" data-testid="qcw-who"><span className="qcw-av" aria-hidden="true">{initials(cust.name)}</span>
    <div><b>{fa(cust.name)}</b><span>#{fa(cust.id)} · کد ملی <span dir="ltr">{masked}</span></span></div></div> : null;

  let body;
  if (done && cust) body = <>
    <CreditCard customerId={cust.id} />
    {consent && me.data?.icc ? <div className="cpc-score" data-testid="qcw-score"><InstantCreditCheck customerId={cust.id} embedded hideRecent initialConsent autoStart /></div> : null}
    <div className="qcw-act"><button type="button" className="btn pri" onClick={onClose} data-testid="qcw-close">بستن</button></div>
  </>;
  else if (step === 1) body = <Pick onPick={(c) => { setCust(c); setStep(2); }} />;
  else if (step === 2) body = <>
    {who}
    {v ? miss.fields : <div className="cpc-sk" />}
    <div className="qcw-act"><button type="button" className="btn gh" onClick={back} data-testid="qcw-prev">قبلی</button>
      <button type="button" className="btn pri" disabled={!v || (miss.missing && !miss.ready)} onClick={() => void next2()} data-testid="qcw-next">{miss.busy ? "در حال ذخیره…" : "بعدی"}</button></div>
  </>;
  else body = <>
    {who}
    <dl className="qcw-sum">
      <div><dt>استعلام</dt><dd>چک برگشتی، رنگ چک، وام‌های فعال{me.data?.icc ? (consent ? "، رتبه‌ی اعتباری" : "") : ""}</dd></div>
      {v?.lastAt ? <div><dt>آخرین استعلام</dt><dd>{v.valid ? "هنوز معتبر" : "منقضی"}</dd></div> : null}
    </dl>
    {me.data?.icc ? <label className="qcw-cns" data-testid="qcw-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
      <span>مشتری با استعلام اعتبار موافقت کرد</span></label> : null}
    {ask ? <div className="cpc-ask" role="group" aria-label="استعلام تازه" data-testid="cp-ask"><span>استعلام قبلی هنوز معتبر است. استعلام تازه گرفته شود؟</span>
      <div className="cpc-ask-b"><button type="button" className="btn gh" onClick={() => setAsk(false)}>انصراف</button>
        <button type="button" className="btn pri" onClick={() => void go(true)}>استعلام تازه</button></div></div> : null}
    {err ? <p className="cpc-err" role="alert">{err}</p> : null}
    <div className="qcw-act"><button type="button" className="btn gh" onClick={back} data-testid="qcw-prev">قبلی</button>
      <button type="button" className="btn pri" disabled={busy || !v?.customer.hasNationalCode} onClick={() => void go(false)} data-testid="qcw-run">{busy ? "در حال استعلام…" : "استعلام"}</button></div>
  </>;

  const shown = done ? 3 : step;
  return createPortal(<div className="qcw" role="dialog" aria-modal="true" aria-labelledby="qcwT" data-testid="qcw" data-step={shown} data-nodnd="true">
    <div className="qcw-in">
      <div className="qcw-hd"><button type="button" className="qcw-back" onClick={back} aria-label="برگشت" data-testid="qcw-back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg></button><h2 id="qcwT">اعتبارسنجی سریع</h2></div>
      <p className="qcw-stp" id="qcwP">مرحلهٔ {fa(shown)} از {fa(3)} — {STEPS[shown - 1]}</p>
      <div className="qcw-bar" role="progressbar" aria-labelledby="qcwP" aria-valuemin={1} aria-valuemax={3} aria-valuenow={shown}><i style={{ width: `${(shown / 3) * 100}%` }} /></div>
      <div className="qcw-card">{body}</div>
    </div>
  </div>, document.body);
}
