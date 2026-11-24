/** Extra customer phones (t853u): list, add, delete, and a click-to-call picker. */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatPhoneForDisplay } from "@/lib/phone";
import { cphApi, CphError, useCphInvalidate, useCustomerPhones, type ExtraPhone, type PhoneList } from "./api";
import "./customer-phones.css";

function faPhone(raw: string) {
  try { return formatPhoneForDisplay(raw); } catch { return raw; }
}

function Dialog({ title, testId, children, onClose }: { title: string; testId: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="cph-dlgw" data-testid={`${testId}-wrap`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cph-dlg" role="dialog" aria-modal="true" aria-labelledby={`${testId}-t`} data-testid={testId}>
        <h2 id={`${testId}-t`}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function AddDialog({ customerId, onClose, onSaved }: { customerId: number; onClose: () => void; onSaved: (view: PhoneList) => void }) {
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr(""); setBusy(true);
    void cphApi.add(customerId, phone.trim(), label.trim() || undefined)
      .then((view) => { onSaved(view); onClose(); })
      .catch((e) => { setErr(e instanceof CphError ? e.message : "ذخیره انجام نشد. دوباره تلاش کنید."); })
      .finally(() => setBusy(false));
  };
  return <Dialog title="افزودن شماره" testId="cph-add-dlg" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <p className="cph-hint">شماره‌ی دوم یا سوم همین مشتری را بنویس. شماره‌ی اصلی عوض نمی‌شود.</p>
      <div className="cph-field">
        <label htmlFor="cph-new-phone">شماره موبایل</label>
        <input id="cph-new-phone" dir="ltr" inputMode="tel" autoComplete="off" placeholder="09xxxxxxxxx"
          value={phone} disabled={busy} onChange={(e) => { setPhone(e.target.value); setErr(""); }}
          data-testid="cph-new-phone" autoFocus />
      </div>
      <div className="cph-field">
        <label htmlFor="cph-new-label">برچسب (اختیاری)</label>
        <input id="cph-new-label" value={label} disabled={busy} maxLength={20}
          placeholder="مثلاً همسر یا محل کار" onChange={(e) => setLabel(e.target.value)} data-testid="cph-new-label" />
      </div>
      {err ? <p className="cph-err" role="alert" data-testid="cph-add-err">{err}</p> : null}
      <div className="cph-dlg-acts">
        <button type="submit" className="pri" disabled={busy} data-testid="cph-add-save">{busy ? "در حال ذخیره…" : "افزودن"}</button>
        <button type="button" disabled={busy} onClick={onClose} data-testid="cph-add-cancel">انصراف</button>
      </div>
    </form>
  </Dialog>;
}

function DeleteDialog({ customerId, item, onClose, onSaved }: { customerId: number; item: ExtraPhone; onClose: () => void; onSaved: (view: PhoneList) => void }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = () => {
    if (busy) return;
    setErr(""); setBusy(true);
    void cphApi.remove(customerId, item.id)
      .then((view) => { onSaved(view); onClose(); })
      .catch((e) => { setErr(e instanceof CphError ? e.message : "حذف انجام نشد. دوباره تلاش کنید."); })
      .finally(() => setBusy(false));
  };
  return <Dialog title="حذف شماره" testId="cph-del-dlg" onClose={() => { if (!busy) onClose(); }}>
    <p data-testid="cph-del-msg">شماره‌ی {faPhone(item.phone)} از پرونده‌ی مشتری حذف شود؟ شماره‌ی اصلی سر جایش می‌ماند.</p>
    {err ? <p className="cph-err" role="alert">{err}</p> : null}
    <div className="cph-dlg-acts">
      <button type="button" className="pri" disabled={busy} onClick={go} data-testid="cph-del-yes">{busy ? "در حال حذف…" : "بله، حذف شود"}</button>
      <button type="button" disabled={busy} onClick={onClose} data-testid="cph-del-cancel">انصراف</button>
    </div>
  </Dialog>;
}

export function PhonePickDialog({ numbers, onPick, onClose }: {
  numbers: { phone: string; label: string }[];
  onPick: (phone: string) => void;
  onClose: () => void;
}) {
  return <Dialog title="انتخاب شماره برای تماس" testId="cph-pick-dlg" onClose={onClose}>
    <p className="cph-hint">با کدام شماره تماس گرفته شود؟</p>
    <div className="cph-pick" data-testid="cph-pick">
      {numbers.map((n) => (
        <button type="button" className="pri" key={n.phone} data-testid={`cph-pick-${n.phone}`} onClick={() => { onPick(n.phone); onClose(); }}>
          <span>{n.label}</span>
          <b dir="ltr">{faPhone(n.phone)}</b>
        </button>
      ))}
    </div>
    <div className="cph-dlg-acts">
      <button type="button" onClick={onClose} data-testid="cph-pick-cancel">انصراف</button>
    </div>
  </Dialog>;
}

export function numbersOf(view: PhoneList | undefined, fallbackPrimary: string): { phone: string; label: string }[] {
  const primary = view?.primary.phone || fallbackPrimary;
  const out: { phone: string; label: string }[] = [];
  if (primary) out.push({ phone: primary, label: "شماره اصلی" });
  for (const x of view?.extras ?? []) out.push({ phone: x.phone, label: x.label?.trim() || "شماره دیگر" });
  return out;
}

export function CustomerPhonesBlock({ customerId, primary, onCopy, onCall, renderPrimary, testPrefix = "cph" }: {
  customerId: number;
  primary: string;
  onCopy?: (phone: string) => void;
  onCall?: (phone: string) => void;
  renderPrimary?: (phone: string) => ReactNode;
  testPrefix?: string;
}) {
  const q = useCustomerPhones(customerId);
  const invalidate = useCphInvalidate();
  const [add, setAdd] = useState(false);
  const [del, setDel] = useState<ExtraPhone | null>(null);
  const view = q.data;
  const extras = view?.extras ?? [];
  const canAdd = view?.canAdd === true;
  const canDelete = view?.canDelete === true;
  const onSaved = (next: PhoneList) => { invalidate(customerId); void next; };

  return <div className="cph-row" data-testid={`${testPrefix}-row`}>
    <div className="cph-item" data-testid={`${testPrefix}-primary`}>
      <span className="cph-lab">شماره اصلی</span>
      {renderPrimary ? renderPrimary(view?.primary.phone || primary) : <b dir="ltr">{faPhone(view?.primary.phone || primary)}</b>}
      {onCopy && (view?.primary.phone || primary) ? <button type="button" className="cph-del" data-testid={`${testPrefix}-copy-primary`} onClick={() => onCopy(view?.primary.phone || primary)}>کپی</button> : null}
    </div>
    {extras.map((x) => (
      <div className="cph-item" key={x.id} data-testid={`${testPrefix}-extra-${x.id}`}>
        <span className="cph-lab">{x.label?.trim() || "شماره دیگر"}</span>
        <b dir="ltr">{faPhone(x.phone)}</b>
        {onCopy ? <button type="button" className="cph-del" onClick={() => onCopy(x.phone)} data-testid={`${testPrefix}-copy-${x.id}`}>کپی</button> : null}
        {onCall ? <button type="button" className="cph-add" onClick={() => onCall(x.phone)} data-testid={`${testPrefix}-call-${x.id}`}>تماس</button> : null}
        {canDelete ? <button type="button" className="cph-del" onClick={() => setDel(x)} data-testid={`${testPrefix}-del-${x.id}`}>حذف</button> : null}
      </div>
    ))}
    {canAdd ? <button type="button" className="cph-add" onClick={() => setAdd(true)} data-testid={`${testPrefix}-add`}>افزودن شماره</button> : null}
    {add ? <AddDialog customerId={customerId} onClose={() => setAdd(false)} onSaved={onSaved} /> : null}
    {del ? <DeleteDialog customerId={customerId} item={del} onClose={() => setDel(null)} onSaved={onSaved} /> : null}
  </div>;
}

export function useCallPhonePicker(customerId: number | null, primary: string | null, startCall: (phone?: string) => void) {
  const q = useCustomerPhones(customerId, Boolean(customerId));
  const [open, setOpen] = useState(false);
  const nums = numbersOf(q.data, primary ?? "");
  const requestCall = () => {
    if (nums.length <= 1) { startCall(nums[0]?.phone); return; }
    setOpen(true);
  };
  const ui = open ? <PhonePickDialog numbers={nums} onPick={(phone) => startCall(phone)} onClose={() => setOpen(false)} /> : null;
  return { requestCall, ui, nums, query: q };
}
