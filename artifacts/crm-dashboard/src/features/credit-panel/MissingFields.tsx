/** credit-panel v1: national code + Jalali birth date, only what is missing (spec §2.3 step 2 / §4). A saved value shows masked with «تغییر». */
import { useState } from "react";
import { maskNationalCode, normalizeNid, validNid } from "@/features/team-sales/InstantCreditCheck";
import { saveQuickCreditNationalCode, TeamSalesApiError } from "@/features/team-sales/api";
import { fa, JMONTHS, saveBirthDate, CpError, type CpCustomer } from "./api";

const YEARS = Array.from({ length: 106 }, (_, i) => 1405 - i);
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const MONTH_DAYS = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 30];

export function useMissingFields(customerId: number, customer: CpCustomer | undefined, onSaved: () => void, withBirth = true) {
  const [editNid, setEditNid] = useState(false);
  const [nid, setNid] = useState("");
  const [touched, setTouched] = useState(false);
  const [y, setY] = useState(""); const [m, setM] = useState(""); const [d, setD] = useState("");
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState<"nid" | null>(null);
  const [busy, setBusy] = useState(false);
  const needNid = !customer?.hasNationalCode || editNid;
  const needBirth = withBirth && !customer?.hasBirthDate;
  const code = normalizeNid(nid);
  const nidBad = needNid && (touched || code.length >= 10) && code.length > 0 && !validNid(code);
  const birthOk = !needBirth || (y && m && d && Number(d) <= MONTH_DAYS[Number(m) - 1]);
  const ready = (!needNid || validNid(code)) && Boolean(birthOk) && !busy;
  const save = async (replace = false): Promise<boolean> => {
    if (!ready) { setTouched(true); return false; }
    setBusy(true); setErr("");
    try {
      if (needNid) {
        const r = await saveQuickCreditNationalCode(customerId, code, replace);
        if (r.needsConfirm) { setConfirm("nid"); return false; }
      }
      if (needBirth) await saveBirthDate(customerId, `${y}/${m.padStart(2, "0")}/${d.padStart(2, "0")}`);
      setConfirm(null); setEditNid(false); setNid(""); onSaved();
      return true;
    } catch (e) {
      const ex = e as TeamSalesApiError | CpError;
      setErr(ex.status === 409 ? "این کد ملی در پرونده‌ی مشتری دیگری ثبت است؛ دوباره از مشتری بپرس یا به مدیر خبر بده." : ex.message && /[\u0600-\u06FF]/.test(ex.message) ? ex.message : "ذخیره نشد. دوباره امتحان کنید.");
      return false;
    } finally { setBusy(false); }
  };
  const fields = <div className="cpf" data-testid="cp-missing">
    <label className="cpf-l" htmlFor={`cpN${customerId}`}>کد ملی</label>
    {!needNid && customer?.nationalCodeMasked ? <div className="cpf-ro" data-testid="cp-nid-ro">
      <span dir="ltr">{customer.nationalCodeMasked.replace(/[0-9]/g, (x) => fa(x))}</span>
      <button type="button" className="btn gh" onClick={() => setEditNid(true)} data-testid="cp-nid-change">تغییر</button>
    </div> : <>
      <input id={`cpN${customerId}`} className={`cpf-in${nidBad ? " bad" : ""}`} type="text" inputMode="numeric" autoComplete="off" dir="ltr" maxLength={14}
        placeholder="۱۰ رقم" value={nid} onChange={(e) => setNid(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={nidBad || undefined} data-testid="cp-nid-input" />
      {nidBad ? <p className="cpf-e" role="alert">این کد ملی معتبر نیست.</p> : validNid(code) ? <p className="cpf-ok" dir="ltr">{maskNationalCode(code)}</p> : null}
    </>}
    {needBirth ? <fieldset className="cpf-bd" data-testid="cp-birth">
      <legend className="cpf-l">تاریخ تولد</legend>
      <div className="cpf-bdr">
        <select aria-label="روز" value={d} onChange={(e) => setD(e.target.value)}><option value="">روز</option>{DAYS.map((x) => <option key={x} value={String(x)}>{fa(x)}</option>)}</select>
        <select aria-label="ماه" value={m} onChange={(e) => setM(e.target.value)}><option value="">ماه</option>{JMONTHS.map((x, i) => <option key={x} value={String(i + 1)}>{x}</option>)}</select>
        <select aria-label="سال" value={y} onChange={(e) => setY(e.target.value)}><option value="">سال</option>{YEARS.map((x) => <option key={x} value={String(x)}>{fa(x)}</option>)}</select>
      </div>
      {y && m && d && !birthOk ? <p className="cpf-e" role="alert">{JMONTHS[Number(m) - 1]} {fa(MONTH_DAYS[Number(m) - 1])} روز دارد.</p> : null}
    </fieldset> : null}
    {confirm === "nid" ? <div className="cpf-cf" role="group" aria-label="جایگزینی کد ملی" data-testid="cp-nid-confirm">
      <span>این مشتری کد ملی دیگری دارد؛ جایگزین شود؟</span>
      <button type="button" className="btn pri" onClick={() => void save(true)}>جایگزین شود</button>
    </div> : null}
    {err ? <p className="cpf-e" role="alert">{err}</p> : null}
  </div>;
  return { fields, needNid, needBirth, ready, busy, save, missing: needNid || needBirth };
}
