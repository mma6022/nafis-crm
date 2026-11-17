/**
 * credit-panel v1 — «اعتبارسنجی» card in the middle column of «کارهای امروز من» (spec §2.2–§2.6, §4).
 * Last saved result first («آخرین استعلام: …», «منقضی» / «معتبر تا …»); «استعلام جدید» runs the debt bundle (cheques, colour, loans) and, for experts with
 * «اعتبارسنجی فوری», opens the ICS24 score step in the same card (consent + SMS code, live component). Still valid → short confirm first.
 */
import "./credit-panel.css";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { InstantCreditCheck } from "@/features/team-sales/InstantCreditCheck";
import { agoFa, compactJalali, CpError, fa, jalaliDateTime, maskAccount, runInquiry, toman, useCpMe, useCpView,
  type Cheque, type CpPart, type CpView } from "./api";
import { useMissingFields } from "./MissingFields";

const GRADES = ["A", "B", "C", "D", "E"];
const COLOURS: Record<string, number> = { "سفید": 1, "زرد": 2, "نارنجی": 3, "قهوه‌ای": 4, "قهوه ای": 4, "قرمز": 5 };
export function colourClass(name?: string, code?: number | string): string {
  const n = Number(code);
  if (n >= 1 && n <= 5) return `c${n}`;
  const k = name ? COLOURS[name.trim()] : undefined;
  return k ? `c${k}` : "c0";
}
const LOAN_ROWS: { k: "totalAmount" | "debtTotalAmount" | "pastExpiredTotalAmount" | "deferredTotalAmount" | "suspiciousTotalAmount" | "dishonored"; label: string; tone: string }[] = [
  { k: "totalAmount", label: "جمع تسهیلات", tone: "" }, { k: "debtTotalAmount", label: "مانده بدهی", tone: "" },
  { k: "pastExpiredTotalAmount", label: "سررسید گذشته", tone: "hot" }, { k: "deferredTotalAmount", label: "معوق", tone: "hot" },
  { k: "suspiciousTotalAmount", label: "مشکوک‌الوصول", tone: "alert" }, { k: "dishonored", label: "نکول‌شده", tone: "alert" },
];

function ChequeItem({ c, open, onToggle }: { c: Cheque; open: boolean; onToggle: () => void }) {
  return <li className="cpc-chq" data-testid="cp-cheque">
    <div className="cpc-chq-hd"><b>چک {fa(String(c.chequeNumber ?? "—"))}</b><span className="amt">{toman(c.bouncedAmount ?? c.amount)} برگشتی</span></div>
    <p>{c.branchDescription || "—"}{c.dishonoringBranchName ? ` · برگشت در ${c.dishonoringBranchName}` : ""}</p>
    {open ? <dl className="cpc-kv" data-testid="cp-cheque-detail">
      <div><dt>مبلغ چک</dt><dd>{toman(c.amount)}</dd></div>
      <div><dt>مبلغ برگشتی</dt><dd>{toman(c.bouncedAmount)}</dd></div>
      <div><dt>دلیل برگشت</dt><dd>{c.dishonorReason || "—"}</dd></div>
      <div><dt>بانک و شعبه</dt><dd>{c.branchDescription || "—"}</dd></div>
      <div><dt>شعبه برگشت</dt><dd>{c.dishonoringBranchName || "—"}</dd></div>
      <div><dt>تاریخ چک</dt><dd>{compactJalali(c.chequeDate)}</dd></div>
      <div><dt>تاریخ برگشت</dt><dd>{compactJalali(c.backDate)}</dd></div>
      <div><dt>شماره حساب</dt><dd dir="ltr">{maskAccount(c.accountNumber)}</dd></div>
    </dl> : <p>تاریخ چک {compactJalali(c.chequeDate)} · برگشت {compactJalali(c.backDate)}</p>}
    <button type="button" className="btn gh cpc-more" aria-expanded={open} onClick={onToggle} data-testid="cp-cheque-toggle">{open ? "بستن جزئیات" : "نمایش جزئیات"}</button>
  </li>;
}

function PartFail({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  return <div className="cpc-fail" role="alert" data-testid="cp-part-fail"><span>استعلام این بخش انجام نشد</span>
    <button type="button" className="btn gh" disabled={busy} onClick={onRetry}>تلاش دوباره</button></div>;
}

export function CreditCard({ customerId, detailOpen }: { customerId: number; detailOpen?: boolean }) {
  const qc = useQueryClient();
  const me = useCpMe();
  const q = useCpView(customerId);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState<false | "all" | CpPart>(false);
  const [err, setErr] = useState("");
  const [scoreOpen, setScoreOpen] = useState(false);
  const [openCheques, setOpenCheques] = useState<Record<number, boolean>>(() => (detailOpen ? { 0: true } : {}) as Record<number, boolean>);
  const [showAll, setShowAll] = useState(Boolean(detailOpen));
  const v = q.data;
  const miss = useMissingFields(customerId, v?.customer, () => { void q.refetch(); }, false);
  const put = (next: CpView) => qc.setQueryData(["credit-panel", "view", customerId], next);

  const run = async (opts: { confirmFresh?: boolean; only?: CpPart[] } = {}) => {
    setAsk(false); setErr(""); setBusy(opts.only?.[0] ?? "all");
    if (!opts.only && me.data?.icc) setScoreOpen(true);
    try { put(await runInquiry(customerId, opts)); }
    catch (e) {
      const ex = e as CpError;
      if (ex.code === "still_valid") setAsk(true);
      else { setErr(ex.message); if (ex.body?.view) put({ ...ex.body.view, customer: v!.customer }); }
    } finally { setBusy(false); }
  };
  const onNew = () => { if (v?.valid) setAsk(true); else void run({ confirmFresh: false }); };

  if (q.isLoading || !v) {
    return <section className="cpc" aria-busy="true" aria-label="اعتبارسنجی" data-testid="cp-card"><div className="cpc-hd"><h3>اعتبارسنجی</h3></div>
      <div className="cpc-sk" /><div className="cpc-sk w" /></section>;
  }
  const unpaid = v.parts.unpaidChequePro, colour = v.parts.chequeColor, loans = v.parts.activeLoans;
  const cheques = unpaid.data?.chequeList ?? [];
  const nCheques = Number(unpaid.data?.count ?? cheques.length) || 0;
  const nLoans = Number(loans.data?.count ?? 0) || 0;
  const rank = v.customer.rank?.label ?? null;
  const any = Boolean(v.lastAt);
  const visible = showAll ? cheques : cheques.slice(0, 2);

  return <section className="cpc" aria-labelledby={`cpcT${customerId}`} data-testid="cp-card" data-valid={v.valid || undefined}>
    <div className="cpc-hd">
      <h3 id={`cpcT${customerId}`}>اعتبارسنجی</h3>
      {any ? <span className="cpc-meta" data-testid="cp-last">آخرین استعلام: {agoFa(v.lastAt!)}</span> : null}
      {any ? (v.valid
        ? <span className="cpc-badge ok" data-testid="cp-valid">{v.validUntil ? `معتبر تا ${jalaliDateTime(v.validUntil)}` : "همیشه معتبر"}</span>
        : <span className="cpc-badge exp" data-testid="cp-expired">منقضی</span>) : null}
      {v.customer.hasNationalCode ? <button type="button" className="btn pri cpc-new" disabled={Boolean(busy)} onClick={onNew} data-testid="cp-new">
        {busy === "all" ? "در حال استعلام…" : any ? "استعلام جدید" : "استعلام"}</button> : null}
    </div>
    {ask ? <div className="cpc-ask" role="group" aria-label="استعلام تازه" data-testid="cp-ask">
      <span>استعلام قبلی هنوز معتبر است. استعلام تازه گرفته شود؟</span>
      <div className="cpc-ask-b"><button type="button" className="btn gh" onClick={() => setAsk(false)} data-testid="cp-ask-no">انصراف</button>
        <button type="button" className="btn pri" onClick={() => void run({ confirmFresh: true })} data-testid="cp-ask-yes">استعلام تازه</button></div>
    </div> : null}
    {err ? <p className="cpc-err" role="alert" data-testid="cp-err">{err}</p> : null}
    {!v.customer.hasNationalCode ? <div className="cpc-miss">
      {miss.fields}
      <button type="button" className="btn pri" disabled={!miss.ready} onClick={() => void miss.save()} data-testid="cp-miss-save">{miss.busy ? "در حال ذخیره…" : "ذخیره"}</button>
    </div> : null}

    {!any ? <p className="cpc-empty" data-testid="cp-empty">هنوز استعلامی ثبت نشده است</p> : <>
      <div className="cpc-sum">
        <div className="cpc-rank" aria-label={rank ? `رتبه ${rank}` : "بدون رتبه"} data-testid="cp-rank"><small>رتبه‌ی اعتباری</small><b dir="ltr">{rank ?? "—"}</b>
          <span className="gsc" aria-hidden="true">{GRADES.map((g) => <i key={g} className={rank?.[0] === g ? "on" : ""} />)}</span></div>
        <div className="cpc-chips">
          {colour.data?.chequeColor ? <span className={`cpc-color ${colourClass(colour.data.chequeColor, colour.data.chequeColorCode)}`} data-testid="cp-colour">
            <span className="sw" aria-hidden="true" />رنگ چک: {colour.data.chequeColor}</span> : null}
          {unpaid.data ? <span className={`cpc-stat${nCheques ? " warn" : ""}`} data-testid="cp-cheques-n">{nCheques ? `${fa(nCheques)} چک برگشتی` : "چک برگشتی نیست"}</span> : null}
          {loans.data ? <span className={`cpc-stat${nLoans ? "" : " ok"}`} data-testid="cp-loans-n">{nLoans ? `${fa(nLoans)} وام فعال` : "وام فعال نیست"}</span> : null}
        </div>
      </div>
      {colour.error ? <PartFail busy={Boolean(busy)} onRetry={() => void run({ only: ["chequeColor"] })} /> : null}

      {loans.error ? <PartFail busy={Boolean(busy)} onRetry={() => void run({ only: ["activeLoans"] })} /> : null}
      {loans.data ? <dl className="cpc-loans" data-testid="cp-loans">
        {LOAN_ROWS.map((r) => <div key={r.k} className={`cpc-loan ${r.tone}`}><dt>{r.label}</dt><dd>{toman(loans.data?.info?.[r.k] ?? 0)}</dd></div>)}
      </dl> : null}

      {unpaid.error ? <PartFail busy={Boolean(busy)} onRetry={() => void run({ only: ["unpaidChequePro"] })} /> : null}
      {cheques.length ? <ul className="cpc-chqs" data-testid="cp-cheques">
        {visible.map((c, i) => <ChequeItem key={`${c.chequeNumber}-${i}`} c={c} open={Boolean(openCheques[i])} onToggle={() => setOpenCheques((o) => ({ ...o, [i]: !o[i] }))} />)}
      </ul> : null}
      {cheques.length > 2 ? <button type="button" className="btn gh cpc-all" onClick={() => setShowAll((x) => !x)}>{showAll ? "نمایش کمتر" : `همه‌ی ${fa(cheques.length)} چک`}</button> : null}
    </>}

    {scoreOpen && me.data?.icc && v.customer.hasNationalCode ? <div className="cpc-score" data-testid="cp-score">
      <InstantCreditCheck customerId={customerId} embedded hideRecent onRank={() => { void q.refetch(); }} />
    </div> : null}
  </section>;
}
