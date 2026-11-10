import { useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { toPersianDigits } from "@/lib/customer-id";
import { loanStageLabel } from "@/lib/loan-labels";
import { multiCasePlanLabel } from "@/lib/multi-case-plan-label";
import type { MultiCaseRow } from "./types";

/** Never show a raw English stage code on a multi-case surface. */
export function faCaseStage(stage?: string | null): string {
  const label = loanStageLabel(stage);
  if (!label || /[A-Za-z]/.test(label)) return "باز";
  return label;
}

function faAmount(value?: string | null): string {
  if (!value) return "";
  try { return `${BigInt(value).toLocaleString("fa-IR")} تومان`; } catch { return ""; }
}

export type CaseChoice = number | "general";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", "");
    area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    const ok = document.execCommand("copy"); area.remove(); return ok;
  } catch { return false; }
}

export function CidChip({ id }: { id: number }) {
  const fa = id.toLocaleString("fa-IR");
  return (
    <button type="button" className="cid" data-cid={id} data-testid={`cid-${id}`} aria-label={`شناسه‌ی ${fa}، کپی`}
      onClick={() => { void copyText(String(id)).then((ok) => toast(ok ? { title: "کپی شد", duration: 1600 } : { title: "کپی نشد", duration: 2500 })); }}>
      #{fa}
    </button>
  );
}

export function PhoneChip({ phone, sample, big }: { phone: string; sample?: boolean; big?: boolean }) {
  const shown = toPersianDigits(phone);
  return (
    <span className={`ph${big ? " big" : ""}`}>
      <a className="phn" dir="ltr" href={`tel:${phone}`}>{shown}</a>
      {sample ? <span className="phs">نمونه</span> : null}
      <button type="button" className="phc" aria-label={`کپی شماره‌ی ${shown}`} data-copy={phone}
        onClick={() => { void copyText(phone).then((ok) => toast(ok ? { title: "کپی شد", duration: 1600 } : { title: "کپی نشد", duration: 2500 })); }}>
        <Copy size={18} aria-hidden />
        {big ? <span>کپی</span> : null}
      </button>
    </span>
  );
}

export function isSampleCustomer(customer: { name?: string | null; description?: string | null; phone?: string | null }) {
  return /multi-case-sample|آزمایشی/.test(`${customer.description || ""} ${customer.name || ""}`) || /^09120000\d{3}$/.test(customer.phone || "");
}

export function CaseContextPicker({
  mode, customerName, customerId, phone, sample, cases, onConfirm, onClose,
}: {
  mode: "call" | "reminder";
  customerName: string;
  customerId: number;
  phone?: string | null;
  sample?: boolean;
  cases: MultiCaseRow[];
  onConfirm: (choice: CaseChoice) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<CaseChoice>("general");
  const title = mode === "reminder" ? "این یادآور برای کدام پرونده است؟" : "این تماس برای کدام پرونده است؟";
  const general = mode === "reminder" ? "یادآور عمومی مشتری" : "تماس عمومی مشتری";
  const open = cases.filter((row) => row.open);
  return (
    <div className="mc-overlay mc-host" data-testid="case-context-picker" data-mode={mode}>
      <section className="card mc-picker" role="dialog" aria-modal="true" aria-labelledby="mc-picker-title">
        <button type="button" className="mc-close" data-testid="mc-picker-close" onClick={onClose}>بستن</button>
        <span className="mc-muted">{mode === "reminder" ? "یادآور جدید" : "تماس از صفحه‌ی مشتری"}</span>
        <h2 id="mc-picker-title">{title}</h2>
        <span className="mc-customer"><b>{customerName}</b><CidChip id={customerId} />{sample ? <span className="smp">نمونه</span> : null}</span>
        {phone ? <PhoneChip phone={phone} sample={sample} /> : null}
        <div className="mc-choice" role="radiogroup" aria-label="پرونده‌ی مرتبط">
          <button type="button" role="radio" aria-checked={choice === "general"} onClick={() => setChoice("general")}>
            <b>{general}</b>
            <span>بدون اتصال به یک پرونده‌ی تسهیلات</span>
          </button>
          {open.map((row) => {
            const money = faAmount(row.requestedAmount);
            const stage = faCaseStage(row.stage);
            return (
            <button key={row.id} type="button" role="radio" aria-checked={choice === row.id} onClick={() => setChoice(row.id)}>
              <b><span className="mc-caseid">پرونده <b dir="ltr">#{row.id.toLocaleString("fa-IR")}</b></span>، طرح {multiCasePlanLabel(row)}</b>
              <span>{money ? `${stage}؛ ${money}` : stage}</span>
            </button>
            );
          })}
        </div>
        <button type="button" className="btn pri" data-testid="mc-picker-confirm" onClick={() => onConfirm(choice)}>
          {mode === "reminder" ? "ثبت یادآور" : "ثبت تماس"}
        </button>
        <button type="button" className="btn gh" data-testid="mc-picker-back" onClick={onClose}>بازگشت به مشتری</button>
      </section>
    </div>
  );
}

/** v1.1: gold block, primary «انتخاب طرح دیگر», ghost «مشاهده‌ی پرونده». ادامه stays outside, disabled. */
export function SamePlanBlock({ caseId, onChooseOther, onOpenCase }: { caseId: number; onChooseOther: () => void; onOpenCase: () => void }) {
  const fa = caseId.toLocaleString("fa-IR");
  return (
    <div className="mc-warning" role="alert" data-testid="same-plan-block">
      <p>این مشتری از قبل پرونده‌ی باز با همین طرح دارد (پرونده <b dir="ltr">#{fa}</b>). تا لغو یا تکمیل آن، پرونده‌ی تازه با همین طرح ساخته نمی‌شود.</p>
      <div className="mc-row">
        <button type="button" className="btn pri" data-testid="button-choose-other-plan" onClick={onChooseOther}>انتخاب طرح دیگر</button>
        <button type="button" className="btn gh" data-testid="button-open-blocked-case" onClick={onOpenCase}>مشاهده‌ی پرونده</button>
      </div>
    </div>
  );
}
