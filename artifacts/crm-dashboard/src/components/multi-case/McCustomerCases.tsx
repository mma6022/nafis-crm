import { multiCasePlanLabel } from "@/lib/multi-case-plan-label";
import { loanBusinessStatus } from "@/lib/loan-labels";
import type { LoanApplication } from "@workspace/api-client-react";
import type { MultiCaseRow } from "./types";
import { CidChip, faCaseStage, faId, PhoneChip } from "./CaseContextPicker";

const toman = (value: string | null | undefined) => { try { return BigInt(value || "0").toLocaleString("fa-IR"); } catch { return value || "—"; } };

export function weekdayJalali(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("fa-IR-u-ca-persian", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Tehran" });
}

export function McCustomerCases({
  customer, loans, cases, sample, canOpen, canNew, onOpen, onNew,
}: {
  customer: { id: number; name: string };
  loans: LoanApplication[];
  cases: MultiCaseRow[];
  sample?: boolean;
  canOpen: boolean;
  canNew: boolean;
  onOpen: (id: number) => void;
  onNew: () => void;
}) {
  const bankOf = (id: number) => cases.find((row) => row.id === id);
  return (
    <section className="mc-section" data-testid="mc-cases" aria-labelledby="mc-cases-h">
      <h2 id="mc-cases-h">پرونده‌های تسهیلات</h2>
      {loans.length ? <div className="mc-cases" data-testid="mc-cases">{loans.map((loan) => {
        const meta = bankOf(loan.id);
        const label = multiCasePlanLabel({ planId: meta?.planId ?? loan.planId, bankName: meta?.bankName });
        const bs = loanBusinessStatus(loan);
        const status = bs === "completed" ? "تکمیل" : bs === "canceled" ? "لغو" : faCaseStage(loan.stage);
        const stage = bs !== "canceled" && bs !== "completed" ? faCaseStage(loan.stage) : "";
        const months = loan.durationMonths ?? loan.requestedDurationMonths;
        return (
          <article key={loan.id} className="card mc-case" data-case={loan.id} data-testid={`mc-case-${loan.id}`}>
            <div className="mc-row">
              <span className="mc-caseid">پرونده <b dir="ltr">#{faId(loan.id)}</b></span>
              <span className={`chip ${loan.stage === "draft" ? "g" : "b"}`}>{status}</span>
            </div>
            <span className="mc-customer"><b>{customer.name}</b><CidChip id={customer.id} />{sample ? <span className="smp">نمونه</span> : null}</span>
            <h3 data-testid={`mc-plan-label-${loan.id}`}>طرح {label}</h3>
            <p>{toman(loan.approvedAmount || loan.requestedAmount)} تومان {months ? <span className="mc-muted">برای {Number(months).toLocaleString("fa-IR")} ماه</span> : null}</p>
            {stage ? <p className="mc-muted">مرحله: {stage}</p> : null}
            <p className="mc-muted">ثبت: {weekdayJalali(loan.createdAt)}</p>
            <div className="mc-row">
              {canOpen ? <button type="button" className="btn gh sm" onClick={() => onOpen(loan.id)}>باز کردن پرونده</button> : null}
              {canNew ? <button type="button" className="btn gh sm" onClick={onNew}>پرونده‌ی جدید</button> : null}
            </div>
          </article>
        );
      })}</div> : <p className="mc-muted">برای این مشتری هنوز درخواست تسهیلاتی ثبت نشده است.</p>}
    </section>
  );
}

export function McFlagPage({
  customer, loans, cases, sample, registrar, otherOwner, canNew, canCall, onNew, onCall, onOpen,
}: {
  customer: { id: number; name: string; phone?: string | null; salespersonName?: string | null };
  loans: LoanApplication[];
  cases: MultiCaseRow[];
  sample?: boolean;
  registrar?: boolean;
  otherOwner?: boolean;
  canNew: boolean;
  canCall: boolean;
  onNew: () => void;
  onCall: () => void;
  onOpen: (id: number) => void;
}) {
  const owner = customer.salespersonName || "بدون تخصیص";
  if (otherOwner && !registrar) {
    return (
      <section className="card mc-picker" data-testid="mc-other-owner">
        <span className="chip">مشتری کارشناس دیگر</span>
        <h2>این مشتری در دسترس شما نیست</h2>
        <p>کارشناس: {owner}</p>
      </section>
    );
  }
  if (registrar) {
    const first = loans[0];
    return (
      <>
        <section className="card mc-picker" data-testid="mc-support-view">
          <span className="chip b">پشتیبانی</span>
          <h2>نمای ثبت‌نام</h2>
          <span className="mc-customer"><b>{customer.name}</b><CidChip id={customer.id} />{sample ? <span className="smp">نمونه</span> : null}</span>
          <p>کارشناس: {owner} (فقط برای اطلاع)</p>
          <p>{otherOwner ? "مشتری شما نیست" : "پرونده‌ی ثبت‌نام اکنون با شماست"}</p>
          {customer.phone && !otherOwner ? <PhoneChip phone={customer.phone} sample={sample} /> : <p className="mc-muted">شماره نمایش داده نمی‌شود</p>}
          <div className="mc-row">
            {!otherOwner && canCall ? <button type="button" className="btn pri" onClick={onCall}>تماس</button> : null}
            {first ? <button type="button" className="btn gh" onClick={() => onOpen(first.id)}>باز کردن پرونده (نمای ثبت‌نام)</button> : null}
          </div>
          <span className="chip">فقط‌خواندنی</span>
        </section>
        <McCustomerCases customer={customer} loans={loans} cases={cases} sample={sample} canOpen canNew={false} onOpen={onOpen} onNew={onNew} />
      </>
    );
  }
  return (
    <>
      <section className="card fhd" data-testid="mc-hero">
        <span className="eyb">مشتری؛ اطلاعات هویتی و تماس مشترک</span>
        <div className="mc-row">
          <h2 data-testid="text-customer-name">{customer.name}</h2>
          <CidChip id={customer.id} />
          {sample ? <span className="smp">نمونه</span> : null}
        </div>
        {customer.phone ? <span data-testid="text-customer-phone"><PhoneChip phone={customer.phone} big sample={sample} /></span> : null}
        <div className="mc-row mc-hero-actions">
          <span className="chip">کارشناس: {owner}</span>
          {canNew ? <button type="button" className="btn pri" data-testid="button-new-loan-from-customer" onClick={onNew}>پرونده‌ی جدید</button> : null}
          {canCall ? <button type="button" className="btn gh" data-testid="link-call-customer" onClick={onCall}>تماس</button> : null}
        </div>
      </section>
      <McCustomerCases customer={customer} loans={loans} cases={cases} sample={sample} canOpen canNew={canNew} onOpen={onOpen} onNew={onNew} />
    </>
  );
}
