import { useState } from "react";
import { CaseContextPicker, SamePlanBlock, type CaseChoice } from "@/components/multi-case/CaseContextPicker";
import { faCase } from "@/lib/multi-case";
import "@/pages/customers.css";
import "@/pages/loan-requests.css";
import "./multi-case-preview.css";

const CASES = [
  { id: 214, planId: 7, planName: "ترنم", stage: "draft", status: "requested", open: true },
  { id: 386, planId: 21, planName: "ترنم ( بازنشسته ها )", stage: "customer_documents_upload", status: "reviewing", open: true },
];

/** Dev-only walkthrough of the real multi-case controls with synthetic rows. */
export default function MultiCasePreview() {
  const [scene, setScene] = useState<"customer" | "call" | "reminder" | "plan" | "done">("customer");
  const [choice, setChoice] = useState<CaseChoice | null>(null);
  const picked = typeof choice === "number" ? CASES.find((row) => row.id === choice) : null;
  return (
    <div className="mc-preview" dir="rtl" data-testid="multi-case-preview">
      <header className="mc-preview-bar">
        <strong>چند پرونده — دادهٔ آزمایشی</strong>
        <span>طرح‌ها: ترنم و ترنم ( بازنشسته ها )</span>
      </header>
      {scene === "customer" ? (
        <section className="mc-preview-card" data-testid="preview-customer">
          <h1>مشتری آزمایشی <span className="muted">#۹۰۰۱</span></h1>
          <p className="muted">دو پروندهٔ باز هم‌زمان. مبلغ و یادداشت هیچ‌کدام به دیگری کپی نشده است.</p>
          <div className="stack">
            {CASES.map((row) => (
              <article key={row.id} className="csx-loan" data-testid={`preview-case-${row.id}`}>
                <div className="r1"><b>پرونده {faCase(row.id)}</b><span className="csx-st">باز</span></div>
                <div className="muted">{row.planName}</div>
              </article>
            ))}
          </div>
          <div className="mc-acts">
            <button type="button" className="btn btn-primary" data-testid="preview-new-request" onClick={() => setScene("plan")}>درخواست تسهیلات جدید</button>
            <button type="button" className="btn btn-ghost" data-testid="preview-call" onClick={() => setScene("call")}>ثبت تماس</button>
            <button type="button" className="btn btn-ghost" data-testid="preview-reminder" onClick={() => setScene("reminder")}>یادآور جدید</button>
          </div>
        </section>
      ) : null}
      {scene === "call" ? (
        <CaseContextPicker title="این تماس برای کدام پرونده است؟" lead="قبل از ثبت تماس یکی را انتخاب کنید. تماس عمومی به هیچ پرونده‌ای وصل نمی‌شود." generalLabel="تماس عمومی مشتری" cases={CASES} onClose={() => setScene("customer")} onConfirm={(next) => { setChoice(next); setScene("done"); }} />
      ) : null}
      {scene === "reminder" ? (
        <CaseContextPicker title="این یادآور برای کدام پرونده است؟" lead="از داخل یک پرونده، همان پرونده انتخاب می‌شود. اینجا باید خودتان انتخاب کنید." generalLabel="یادآور عمومی مشتری" cases={CASES} onClose={() => setScene("customer")} onConfirm={(next) => { setChoice(next); setScene("done"); }} />
      ) : null}
      {scene === "plan" ? (
        <section className="mc-preview-card" data-testid="preview-plan">
          <p className="mc-step">مرحله ۵ از ۱۰ · طرح و شرط</p>
          <h2>طرح را انتخاب کنید</h2>
          <ul>{CASES.map((row) => <li key={row.id}>پرونده {faCase(row.id)} — {row.planName}</li>)}</ul>
          <SamePlanBlock planName="ترنم" caseId={214} />
          <button type="button" className="btn btn-ghost" onClick={() => setScene("customer")}>بازگشت</button>
        </section>
      ) : null}
      {scene === "done" ? (
        <section className="mc-preview-card" data-testid="preview-chosen">
          <h2>{picked ? `زمینه: پرونده ${faCase(picked.id)} — ${picked.planName}` : "زمینه: عمومی مشتری"}</h2>
          <p>ثبت آزمایشی است و تماسی ذخیره نشده.</p>
          <button type="button" className="btn btn-primary" onClick={() => { setChoice(null); setScene("customer"); }}>بازگشت به مشتری</button>
        </section>
      ) : null}
    </div>
  );
}
