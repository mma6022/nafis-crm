import { multiCasePlanLabel } from "@/lib/multi-case-plan-label";
import { loanBusinessStatus, loanStageLabel } from "@/lib/loan-labels";
import type { LoanApplication } from "@workspace/api-client-react";
import type { MultiCaseRow } from "./types";
import { CidChip } from "./CaseContextPicker";

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
      {loans.length ? <div className="mc-cases">{loans.map((loan) => {
        const meta = bankOf(loan.id);
        const label = multiCasePlanLabel({ planId: meta?.planId ?? loan.planId, bankName: meta?.bankName });
        const bs = loanBusinessStatus(loan);
        const status = bs === "completed" ? "تکمیل" : bs === "canceled" ? "لغو" : "باز";
        const stage = bs !== "canceled" && bs !== "completed" ? loanStageLabel(loan.stage) : "";
        const months = loan.durationMonths ?? loan.requestedDurationMonths;
        return (
          <article key={loan.id} className="card mc-case" data-case={loan.id} data-testid={`mc-case-${loan.id}`}>
            <div className="mc-row">
              <span className="mc-caseid">پرونده <b dir="ltr">#{loan.id.toLocaleString("fa-IR")}</b></span>
              <span className="mc-muted">{status}</span>
            </div>
            <span className="mc-customer"><b>{customer.name}</b><CidChip id={customer.id} />{sample ? <span className="smp">نمونه</span> : null}</span>
            <h3 data-testid={`mc-plan-label-${loan.id}`}>{label}</h3>
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
