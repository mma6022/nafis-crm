import { useState } from "react";
import { faCase, type MultiCaseRow } from "@/lib/multi-case";

export type CaseChoice = number | "general";

/** Step before a customer-page call or reminder: pick one open case, or a general customer record. */
export function CaseContextPicker({
  title, lead, generalLabel, cases, onConfirm, onClose,
}: {
  title: string; lead: string; generalLabel: string; cases: MultiCaseRow[];
  onConfirm: (choice: CaseChoice) => void; onClose: () => void;
}) {
  const open = cases.filter((row) => row.open);
  const [choice, setChoice] = useState<CaseChoice | null>(null);
  const [tried, setTried] = useState(false);
  return (
    <div className="mc-pick" role="dialog" aria-modal="true" aria-labelledby="mc-pick-title" data-testid="case-context-picker">
      <div className="mc-pick-card" dir="rtl">
        <p className="mc-step">گام ۱ از ۲</p>
        <h2 id="mc-pick-title">{title}</h2>
        <p>{lead}</p>
        <div className="mc-opts" role="radiogroup" aria-label={title}>
          {open.map((row) => (
            <label key={row.id} className={choice === row.id ? "on" : ""}>
              <input type="radio" name="mc-case" checked={choice === row.id} onChange={() => setChoice(row.id)} data-testid={`case-choice-${row.id}`} />
              <span><b>پرونده {faCase(row.id)}</b><small>{row.planName || "طرح تسهیلات"}</small></span>
            </label>
          ))}
          <label className={choice === "general" ? "on" : ""}>
            <input type="radio" name="mc-case" checked={choice === "general"} onChange={() => setChoice("general")} data-testid="case-choice-general" />
            <span><b>{generalLabel}</b><small>به هیچ پرونده‌ای وصل نمی‌شود</small></span>
          </label>
        </div>
        {tried && choice == null ? <p className="mc-err" role="alert">یکی را انتخاب کنید.</p> : null}
        <div className="mc-acts">
          <button type="button" className="btn btn-primary" data-testid="case-choice-continue" onClick={() => { setTried(true); if (choice != null) onConfirm(choice); }}>ادامه</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>انصراف</button>
        </div>
      </div>
    </div>
  );
}

export function SamePlanBlock({ planName, caseId }: { planName: string; caseId: number }) {
  return (
    <div className="lwz-note bad" role="alert" data-testid="same-plan-block">
      <p><b>این طرح پروندهٔ باز دارد.</b> پرونده {faCase(caseId)} با طرح «{planName}» هنوز باز است. تا لغو یا تکمیل آن، پروندهٔ تازه با همین طرح ساخته نمی‌شود. طرح دیگر را انتخاب کنید؛ هزینهٔ هر پرونده جدا است.</p>
    </div>
  );
}
