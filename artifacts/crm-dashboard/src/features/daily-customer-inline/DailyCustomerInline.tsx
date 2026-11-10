/** Armita daily-customer-inline v1.1 — rendered in the existing sales shell. Flag-on Today page only. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useSearch } from "wouter";
import { getGetAuthSessionQueryKey, getListCustomerTagsQueryKey, useCancelLoanApplication, useGetAuthSession, useListCustomerTags, useUpdateCustomer, type CustomerUpdateStatus } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { STATUS_LABEL } from "@/pages/customers-ui";
import { announceCallSaved, useCqConfig } from "@/features/call-queue/api";
import { CqResultFields, cqFollowUpAt, cqResultError, emptyCqResult, type CqResultValue } from "@/features/call-queue/ResultFields";
import { dpApi } from "@/features/daily-plan/api";
import { promoteToP1 } from "@/features/history/api";
import { InstantCreditCheck } from "@/features/team-sales/InstantCreditCheck";
import { SimpleCallForm } from "@/features/team-sales/SimpleCallForm";
import { saveQuickCreditNationalCode, useIccEnabled } from "@/features/team-sales/api";
import { useVcMe, vcApi } from "@/features/voip-call/api";
import { DciError, dciApi, useDciAddNote, useDciBoard, useDciToday, type DciBoard, type DciCase, type DciDenied, type DciHist, type DciInbound, type DciNote, type DciTask } from "./api";
import { DciIcon, DciSprites } from "./icons";
import "./dci.css";

const FD = "۰۱۲۳۴۵۶۷۸۹";
/** Existing catalog labels (customer_tag_catalog). Fallback if the catalog has not loaded yet. */
const TAG_LABEL_FALLBACK: Record<string, string> = {
  website_lead: "سرنخ سایت",
  repeat_request: "درخواست چند باره",
};
export function dciTagLabel(key: string, catalog?: ReadonlyArray<{ key?: string; tag?: string; label?: string; label_fa?: string }> | null): string {
  const item = Array.isArray(catalog) ? catalog.find((x) => (x.key ?? x.tag) === key) : undefined;
  const label = String(item?.label ?? item?.label_fa ?? "").trim();
  // Prefer the Persian fallback when the catalog is missing, blank, or still stores the raw English key.
  if (label && label !== key) return label;
  return TAG_LABEL_FALLBACK[key] || label || key;
}
const fa = (n: string | number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "٬").replace(/[0-9]/g, (d) => FD[Number(d)]);
const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
const PS_STATUSES: CustomerUpdateStatus[] = ["in_progress", "completed", "cancelled"];
const PS_PRIORITIES: Array<number | null> = [1, 2, 3, null];
function psErrMsg(error: unknown, kind: "status" | "priority" = "status"): string {
  const statusFb = "تغییر وضعیت ذخیره نشد. دوباره تلاش کنید.";
  const prioFb = "تغییر اولویت ذخیره نشد. دوباره تلاش کنید.";
  const fallback = kind === "priority" ? prioFb : statusFb;
  const e = error as { message?: string; data?: { error?: string; message?: string }; response?: { data?: { error?: string; message?: string } } };
  const msg = e?.data?.message || e?.data?.error || e?.response?.data?.message || e?.response?.data?.error || e?.message;
  if (kind === "priority") return fallback;
  return typeof msg === "string" && /[\u0600-\u06FF]/.test(msg) && msg !== prioFb ? msg : fallback;
}
const toLatin = (v: string) => v.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
/** Compact form asks for تومان; the existing first-call draft stores میلیون تومان. */
function tomanToMillion(raw: string): string {
  const n = Number(toLatin(raw).replace(/\D/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 10_000) return String(Math.max(1, Math.round(n / 1e6)));
  return String(n);
}
function prefillFirstCallDraft(userId: number | undefined, customerId: number, patch: { city?: string; amountToman?: string; note?: string; gAvail?: "yes" | "no" | "" }) {
  const key = `nafis-ts-firstcall-draft:${userId ?? 0}:${customerId}`;
  try {
    const cur = JSON.parse(localStorage.getItem(key) || "{}") as Record<string, unknown>;
    const next = { ...cur };
    if (patch.city?.trim()) { next.city = patch.city.trim(); next.cityTouched = true; }
    const million = patch.amountToman ? tomanToMillion(patch.amountToman) : "";
    if (million) next.amount = million;
    if (patch.note?.trim()) next.note = patch.note.trim();
    if (patch.gAvail === "yes" || patch.gAvail === "no") next.gAvail = patch.gAvail;
    localStorage.setItem(key, JSON.stringify(next));
  } catch { /* quota / private mode */ }
}

function useNarrow(q = "(max-width:1023.98px)") {
  const [n, setN] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const f = () => setN(m.matches); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, [q]);
  return n;
}
function useMobile() { return useNarrow("(max-width:699.98px)"); }

function cidBtn(id: number, onCopy: (v: string) => void) {
  return <button className="cid" type="button" aria-label={`شناسه‌ی ${fd(id)}، کپی`} data-cid={id} onClick={() => onCopy(String(id))}>#{fd(id)}</button>;
}

function Phone({ raw, big, onCopy }: { raw: string; big?: boolean; onCopy: (v: string) => void }) {
  const mobile = useMobile();
  const f = fd(raw);
  const vis = mobile
    ? <a className="phn phm" dir="ltr" href={`tel:${raw}`}>{f}</a>
    : <span className="phn phd" dir="ltr">{f}</span>;
  return <span className={`ph${big ? " big" : ""}`}>{vis}
    <button className="phc" type="button" aria-label={`کپی شماره‌ی ${f}`} data-copy={raw} onClick={() => onCopy(raw)}>
      <DciIcon id="i-copy" />{big ? <span>کپی</span> : null}
    </button>
  </span>;
}

function Timeline({ tasks, selected, onPick }: { tasks: DciTask[]; selected: string | null; onPick: (t: DciTask) => void }) {
  const ref = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => { ref.current?.scrollIntoView({ inline: "center", block: "nearest" }); }, [selected]);
  return <nav className="dci-tl" aria-label="کارهای امروز">{tasks.map((t) => (
    <a key={t.id} ref={selected === t.id ? ref : undefined} className="dci-node" href={`#${t.id}`}
      aria-current={selected === t.id ? "true" : undefined}
      onClick={(e) => { e.preventDefault(); onPick(t); }}>
      <span className="dci-nt"><DciIcon id={t.ic} /><span>{t.tm}؛ {t.typ}</span></span>
      <b>{t.name}</b>
    </a>
  ))}</nav>;
}

function HistList({ rows }: { rows: DciHist[] }) {
  if (!rows.length) return <p className="dci-empty">سابقه‌ی تماسی ثبت نشده است.</p>;
  return <ul className="dci-calls">{rows.map((h) => (
    <li key={h.id}>
      <div className="dci-cmeta"><span>{h.t}</span><span>{h.k}؛ <span className={`dci-res ${h.rc}`}>{h.r}</span></span></div>
      <div className={`dci-cnote${h.note ? "" : " empty"}`}>{h.note || "یادداشتی ثبت نشده است."}</div>
    </li>
  ))}</ul>;
}

function NotesBlock({ rows, customerId }: { rows: DciNote[]; customerId: number }) {
  const add = useDciAddNote(customerId);
  const [text, setText] = useState("");
  return <div className="dci-notes">
    {rows.length ? <ul>{rows.map((n) => <li key={n.id}><b>{n.t}</b>؛ {n.body}</li>)}</ul> : <p className="dci-empty">یادداشت کارشناسی ثبت نشده است.</p>}
    <form className="dci-add" onSubmit={(e) => { e.preventDefault(); const b = text.trim(); if (!b || add.isPending) return; add.mutate(b, { onSuccess: () => setText("") }); }}>
      <label htmlFor="dci-note">یادداشت تازه</label>
      <textarea id="dci-note" rows={3} placeholder="یادداشت را بنویسید" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn pri" type="submit" disabled={add.isPending || !text.trim()}>افزودن یادداشت</button>
    </form>
  </div>;
}

/** Jalali inquiry date with weekday and Persian digits. Formats a leftover ISO string; already-Persian values keep their weekday/date (time is dropped, as before). */
export function creditAtLabel(at: string): string {
  const raw = at.trim();
  if (!raw) return "";
  const fd = (v: string) => v.replace(/[0-9]/g, (d) => FD[Number(d)]);
  const dateOnly = (v: string) => v.replace(/، ساعت.*/, "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) && /[\u0600-\u06FF]/.test(raw)) return fd(dateOnly(raw));
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return fd(dateOnly(raw));
  return fd(new Intl.DateTimeFormat("fa-IR-u-ca-persian", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Tehran" }).format(d));
}

function CreditBlock({ customerId, state, grade, at }: { customerId: number; state: DciBoard["credit"]["state"]; grade: string | null; at: string | null }) {
  const iccOn = useIccEnabled();
  if (state === "err") return <div className="dci-consent"><p className="dci-empty">استعلام الآن انجام نشد.</p></div>;
  if (state === "ok") return <div className="dci-consent"><span className="dci-grade" dir="ltr">{grade || "—"}</span>
    {at ? <p className="dci-empty">استعلام‌شده در {creditAtLabel(at)}</p> : <p className="dci-empty">استعلام شده است.</p>}
  </div>;
  return <div className="dci-consent">
    <p className="dci-empty">رتبه هنوز استعلام نشده است.</p>
    {state === "start" && iccOn ? <div data-testid="dci-credit-start"><InstantCreditCheck customerId={customerId} /></div> : null}
  </div>;
}

function GuarBlock({ v, cond }: { v: "yes" | "no" | "unknown"; cond: string | null }) {
  if (v === "yes") return <><p className="dci-gstat">ضامن دارد</p>{cond ? <p className="dci-cond">{cond}</p> : null}</>;
  if (v === "no") return <p className="dci-gstat">ضامن ندارد</p>;
  return <p className="dci-empty">هنوز مشخص نشده است.</p>;
}

function WalletBlock({ wallet }: { wallet: DciBoard["wallet"] }) {
  if (!wallet) return null;
  if (!wallet.tx.length && (wallet.balance == null || wallet.balance === "0")) {
    return <p className="dci-empty">کیف پولی ساخته نشده یا تراکنشی ندارد.</p>;
  }
  return <>
    <p className="dci-wal-bal">{fa(wallet.balance ?? "0")} تومان</p>
    <ul className="dci-tx">{wallet.tx.map((x, i) => (
      <li key={i}><span>{x.t}؛ {x.ti}</span><span className={x.in ? "in" : "out"}>{x.in ? "واریز" : "برداشت"} {fa(x.a)} تومان</span></li>
    ))}</ul>
  </>;
}

function FirstCall({ customerId, userId, onOpenForm }: { customerId: number; userId: number | undefined; onOpenForm: () => void }) {
  const [step, setStep] = useState(1);
  const [g, setG] = useState<"yes" | "no" | "">("");
  const [nid, setNid] = useState("");
  const [city, setCity] = useState("");
  const [amount, setAmount] = useState("");
  const [need, setNeed] = useState("");
  const [gcond, setGcond] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [needConfirm, setNeedConfirm] = useState(false);
  const finish = async (confirmReplace = false) => {
    setBusy(true); setErr("");
    try {
      if (nid.trim()) {
        const r = await saveQuickCreditNationalCode(customerId, toLatin(nid).replace(/\D/g, ""), confirmReplace);
        if (r.needsConfirm) { setNeedConfirm(true); return; }
      }
      prefillFirstCallDraft(userId, customerId, { city, amountToman: amount, note: [need.trim(), g === "yes" && gcond.trim() ? `شرایط ضامن: ${gcond.trim()}` : ""].filter(Boolean).join("\n"), gAvail: g });
      setNeedConfirm(false);
      onOpenForm();
    } catch (e) {
      setErr(e instanceof Error && /[\u0600-\u06FF]/.test(e.message) ? e.message : "ذخیره انجام نشد. دوباره تلاش کنید.");
    } finally { setBusy(false); }
  };
  const goNext = () => {
    if (step < 3) { setStep((s) => s + 1); return; }
    void finish(needConfirm);
  };
  return <div className="dci-fc" id="dci-fc" data-step={step}>
    <p className="dci-step">مرحله‌ی <span id="dci-sn">{fd(step)}</span> از {fd(3)}</p>
    <div className="dci-fstep" data-n="1" hidden={step !== 1}>
      <label>کد ملی <input dir="ltr" inputMode="numeric" autoComplete="off" placeholder="—" value={nid} onChange={(e) => { setNid(e.target.value); setNeedConfirm(false); }} /></label>
      <label>شهر <input autoComplete="off" placeholder="—" value={city} onChange={(e) => setCity(e.target.value)} /></label>
    </div>
    <div className="dci-fstep" data-n="2" hidden={step !== 2}>
      <label>مبلغ درخواستی، تومان <input dir="ltr" inputMode="numeric" autoComplete="off" placeholder="—" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>شرح نیاز <input autoComplete="off" placeholder="—" value={need} onChange={(e) => setNeed(e.target.value)} /></label>
    </div>
    <div className="dci-fstep" data-n="3" hidden={step !== 3}>
      <p className="dci-empty" style={{ margin: 0 }}>ضامن</p>
      <div className="dci-choice" role="radiogroup" aria-label="ضامن">
        <button type="button" role="radio" aria-checked={g === "yes"} data-g="yes" onClick={() => setG("yes")}>ضامن دارد</button>
        <button type="button" role="radio" aria-checked={g === "no"} data-g="no" onClick={() => setG("no")}>ضامن ندارد</button>
      </div>
      <label id="dci-gcond" hidden={g !== "yes"}>شرایط ضامن <input autoComplete="off" placeholder="مثلاً چک ضامن" value={gcond} onChange={(e) => setGcond(e.target.value)} /></label>
    </div>
    {err ? <p className="dci-empty" role="alert" data-testid="dci-fc-err">{err}</p> : null}
    {needConfirm ? <p className="dci-empty" role="status">کد ملی با مقدار قبلی فرق دارد؛ برای جایگزینی دوباره «پایان» را بزنید.</p> : null}
    <div className="dci-acts">
      <button className="btn gh" type="button" id="dci-prev" hidden={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>قبلی</button>
      <button className="btn pri" type="button" id="dci-next" data-testid="dci-fc-next" disabled={busy} onClick={goNext}>{step === 3 ? (needConfirm ? "تأیید و پایان" : "پایان") : "بعدی"}</button>
    </div>
  </div>;
}

function ChipGroup({ label, aria, testId, kind, children }: { label: string; aria: string; testId: string; kind: "status" | "priority"; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const check = () => {
      const last = el.lastElementChild as HTMLElement | null;
      if (!last || el.scrollWidth <= el.clientWidth + 1) { setAtEnd(true); return; }
      const er = last.getBoundingClientRect();
      const cr = el.getBoundingClientRect();
      setAtEnd(er.left >= cr.left - 1 && er.right <= cr.right + 1);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", check); ro.disconnect(); };
  }, [children]);
  return <div className={`dci-ps dci-ps-${kind}`} data-testid={testId}>
    <span className="dci-ps-lbl">{label}</span>
    <div ref={row} className={`csx-chips${atEnd ? " scroll-end" : ""}`} role="radiogroup" aria-label={aria}>{children}</div>
  </div>;
}

function CaseCard({ f, canEdit, locked, busy, onCancel }: { f: DciCase; canEdit: boolean; locked?: boolean; busy: boolean; onCancel: (f: DciCase) => void }) {
  const life = f.life ?? "in_progress";
  const show = canEdit || !!locked;
  const chips = show ? <ChipGroup label="وضعیت پرونده" aria="وضعیت پرونده" testId={`dci-ps-case-${f.id}`} kind="status">
    {PS_STATUSES.map((key) => {
      const checked = life === key;
      const disable = !canEdit || busy || (key === "completed" && !checked) || (key === "in_progress" && life === "cancelled") || (key === "cancelled" && !f.canCancel && !checked);
      return <button key={key} type="button" className={`csx-chip${!canEdit ? " is-inert" : ""}`} role="radio" aria-checked={checked} data-s={key}
        aria-disabled={!canEdit ? true : undefined}
        disabled={canEdit && disable} onClick={() => canEdit && key === "cancelled" && f.canCancel && !checked && onCancel(f)}
        data-testid={`chip-status-${key}-${f.id}`}>{STATUS_LABEL[key]}</button>;
    })}
  </ChipGroup> : null;
  return <article className="dci-case" data-case={f.id}>
    <div className="dci-crow"><span className="dci-chip">پرونده #{fd(f.id)}</span><span className="dci-chip">{f.status}</span></div>
    {chips}
    <h3>طرح {f.plan}</h3>
    <p>{f.amount ? <>{fa(f.amount)} تومان {f.months ? <span style={{ color: "var(--nf-ink-muted)" }}>برای {fd(f.months)} ماه</span> : null}</> : null}</p>
    <Link className="btn pri" href={f.href}>{f.act}</Link>
  </article>;
}

function CasesBlock({ rows, href, canEdit, locked, busy, onCancel }: { rows: DciCase[]; href: string; canEdit: boolean; locked?: boolean; busy: boolean; onCancel: (f: DciCase) => void }) {
  return <>
    {rows.length ? <div className="dci-cases">{rows.map((f) => <CaseCard key={f.id} f={f} canEdit={canEdit} locked={locked} busy={busy} onCancel={onCancel} />)}</div> : null}
    <div className="dci-new"><Link className="btn pri" href={href}>درخواست تسهیلات جدید</Link></div>
  </>;
}

function CallActs({ ext, place, narrow, onCall, onResult }: { ext: boolean; place: "head" | "sticky"; narrow: boolean; onCall: () => void; onResult: () => void }) {
  if (ext) {
    const pri = <button className="btn pri" type="button" data-voip onClick={onCall}><DciIcon id="i-phone" />تماس</button>;
    if (place === "sticky") return pri;
    if (narrow) return null;
    return <div className="dci-acts">{pri}</div>;
  }
  const pri = <button className="btn pri" type="button" data-result onClick={onResult}>تماس گرفتم، ثبت نتیجه</button>;
  if (place === "sticky") return pri;
  if (narrow) return null;
  return <div className="dci-acts">{pri}</div>;
}

function InBoundBlock({ rows, ext, onCall }: { rows: DciInbound[]; ext: boolean; onCall: () => void }) {
  const [notes, setNotes] = useState<Record<number, string>>(() => Object.fromEntries(rows.map((x) => [x.id, x.note ?? ""])));
  const timers = useRef<Record<number, number>>({});
  useEffect(() => { setNotes((n) => ({ ...Object.fromEntries(rows.map((x) => [x.id, x.note ?? ""])), ...n })); }, [rows]);
  const save = (id: number, body: string) => {
    window.clearTimeout(timers.current[id]);
    timers.current[id] = window.setTimeout(() => { void dciApi.inboundNote(id, body).catch(() => undefined); }, 500);
  };
  if (!rows.length) return null;
  return <>
    <h2>تماس‌های ورودی</h2>
    <ul className="dci-in">{rows.map((x, i) => (
      <li key={x.id} className="dci-incall">
        <div className="dci-cmeta"><span>{x.t}</span><span>ورودی؛ <span className={`dci-res ${x.rc}`}>{x.r}</span></span></div>
        {x.text ? <p className="dci-intext">{x.text}</p> : <p className="dci-empty">متنی برای این تماس ثبت نشده است.</p>}
        <div className="dci-inopt">
          <label htmlFor={`dci-innote-${i}`}>یادداشت اختیاری</label>
          <textarea id={`dci-innote-${i}`} rows={2} placeholder="اگر لازم بود بنویسید" value={notes[x.id] ?? ""}
            onChange={(e) => { const v = e.target.value; setNotes((n) => ({ ...n, [x.id]: v })); save(x.id, v); }} />
        </div>
        {x.missed ? <button className="btn pri" type="button" data-voip onClick={onCall}>{ext ? <><DciIcon id="i-phone" />تماس دوباره</> : "تماس دوباره"}</button> : null}
      </li>
    ))}</ul>
  </>;
}

function MidCol({ m, ext, narrow, onCopy, onCall, onResult, onPromote, promoting, result, promo }: {
  m: DciBoard; ext: boolean; narrow: boolean; onCopy: (v: string) => void; onCall: () => void; onResult: () => void;
  onPromote: () => void; promoting: boolean;
  promo?: { open: boolean; reason: string; setReason: (v: string) => void; onSave: () => void; onClose: () => void };
  result?: {
    open: boolean; val: CqResultValue; show: boolean; busy: boolean; err: string;
    onChange: (v: CqResultValue) => void; onSave: () => void; onClose: () => void;
  };
}) {
  const tagCatalog = useListCustomerTags({ query: { queryKey: getListCustomerTagsQueryKey() } });
  const tags = (m.customer.tags || []).map((x) => <span key={x}>{dciTagLabel(x, tagCatalog.data)}</span>);
  const qc = useQueryClient();
  const update = useUpdateCustomer();
  const cancelCase = useCancelLoanApplication();
  const [psError, setPsError] = useState("");
  const [psOk, setPsOk] = useState("");
  const [pendingPriority, setPendingPriority] = useState<number | null | undefined>(undefined);
  const [failedPriority, setFailedPriority] = useState<number | null | undefined>(undefined);
  const [cx, setCx] = useState<DciCase | null>(null);
  const [cxReason, setCxReason] = useState("");
  const [cxErr, setCxErr] = useState("");
  const curPriority = m.customer.priority ?? null;
  const transferName = m.priorityDemoteTransfer?.expertName ?? "";
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["dci-board", m.customer.id] }); };
  const savePriority = (value: number | null) => {
    setPsError(""); setPsOk("");
    update.mutate({ id: m.customer.id, data: { priority: value } }, {
      onSuccess: () => {
        setPendingPriority(undefined);
        setFailedPriority(undefined);
        setPsOk(transferName && curPriority === 1 && value !== 1 ? `مشتری به ${transferName} منتقل شد.` : "اولویت ذخیره شد.");
        refresh();
      },
      onError: (error) => { setPendingPriority(undefined); setFailedPriority(value); setPsError(psErrMsg(error, "priority")); },
    });
  };
  const p1ChipRef = useRef<HTMLButtonElement>(null);
  const p1BtnRef = useRef<HTMLButtonElement>(null);
  const promoFrom = useRef<"chip" | "button">("button");
  const canEditPs = !!m.canEditPriorityStatus && !m.priorityStatusLocked;
  const showPs = canEditPs || !!m.priorityStatusLocked;
  const noPermHint = "اجازهٔ تغییر اولویت در این حساب نیست.";
  const openPromo = (from: "chip" | "button") => {
    if (!canEditPs || curPriority === 1) return;
    promoFrom.current = from;
    onPromote();
  };
  const closePromo = () => { promo?.onClose(); };
  const promoWasOpen = useRef(false);
  useEffect(() => {
    if (promo?.open) { promoWasOpen.current = true; return; }
    if (!promoWasOpen.current) return;
    promoWasOpen.current = false;
    const from = promoFrom.current;
    let tries = 0;
    let id = 0;
    const focusOpener = () => {
      const el = from === "chip" ? p1ChipRef.current : p1BtnRef.current;
      if (el && !el.closest("[inert]")) { el.focus(); return; }
      if (tries++ < 20) id = window.setTimeout(focusOpener, 16);
    };
    id = window.setTimeout(focusOpener, 0);
    return () => window.clearTimeout(id);
  }, [promo?.open]);
  const askPriority = (value: number | null) => {
    if (!canEditPs || curPriority === value || update.isPending) return;
    // P1 is never a form-less patch: the chip and the button open the same promote form.
    if (value === 1 && curPriority !== 1) { openPromo("chip"); return; }
    if (curPriority === 1 && value !== 1 && transferName) { setPendingPriority(value); return; }
    savePriority(value);
  };
  useEffect(() => {
    if (!promo?.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closePromo(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [promo?.open]);
  const openCancel = (f: DciCase) => { setCx(f); setCxReason(""); setCxErr(""); setPsError(""); setPsOk(""); };
  const submitCancel = () => {
    if (!cx) return;
    if (!cxReason.trim()) { setCxErr("دلیل لغو را بنویس؛ بدون دلیل، پرونده لغو نمی‌شود."); document.getElementById("dci-cx-reason")?.focus(); return; }
    setCxErr("");
    cancelCase.mutate({ id: cx.id, data: { reason: cxReason.trim() } }, {
      onSuccess: () => { setPsOk("پرونده لغو شد."); setCx(null); setCxReason(""); refresh(); },
      onError: (error) => setCxErr(psErrMsg(error)),
    });
  };
  const ps = showPs ? <div className="csx dci-ps" data-testid="dci-ps">
    <ChipGroup label="اولویت" aria="اولویت" testId="dci-ps-priority" kind="priority">
      {PS_PRIORITIES.map((value) => {
        const isP1 = value === 1;
        const alreadyP1 = isP1 && curPriority === 1;
        const canOpenPromo = canEditPs && isP1 && curPriority !== 1;
        const inert = !canEditPs || alreadyP1;
        const cls = `csx-chip${canOpenPromo ? " p1-up" : ""}${inert ? " is-inert" : ""}`;
        return <button key={String(value)} ref={isP1 ? p1ChipRef : undefined} type="button" className={cls}
          role={canOpenPromo ? "button" : "radio"}
          aria-checked={canOpenPromo ? undefined : curPriority === value}
          aria-haspopup={canOpenPromo ? "dialog" : undefined}
          aria-label={canOpenPromo ? "ارتقا به اولویت ۱" : undefined}
          aria-disabled={inert ? true : undefined}
          title={!canEditPs ? noPermHint : undefined}
          data-p={value ?? undefined}
          disabled={update.isPending && !inert}
          onClick={() => { if (inert) return; if (canOpenPromo) openPromo("chip"); else askPriority(value); }}
          data-testid={`chip-priority-${value ?? "none"}`}>{value ? `اولویت ${fd(value)}` : "بدون اولویت"}</button>;
      })}
    </ChipGroup>
    {!canEditPs ? <p className="csx-hint dci-ps-hint" data-testid="dci-ps-noperm">{noPermHint}</p> : null}
    {psOk ? <p className="dci-ps-ok" role="status" data-testid="dci-ps-ok">{psOk}</p> : null}
    {psError ? <div className="dci-ps-err" role="alert" data-testid="dci-ps-err">
      <svg className="dci-ps-err-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8 2.6 20.2h18.8L12 3.8z" /><path d="M12 9.5v5.2M12 17.4v.6" /></svg>
      <p>{psError}</p>
      <button type="button" className="btn gh" data-testid="dci-ps-retry" disabled={update.isPending || failedPriority === undefined} onClick={() => { if (failedPriority !== undefined) savePriority(failedPriority); }}>تلاش دوباره</button>
    </div> : null}
  </div> : null;
  const prio = m.prio
    ? <div className="dci-prio"><span className="dci-prio-on ps-p1on">اولویت ۱</span></div>
    : (m.canPromote && canEditPs ? <div className="dci-prio"><button ref={p1BtnRef} className="btn gh" type="button" disabled={promoting} onClick={() => openPromo("button")} data-testid="dci-upgrade-p1">ارتقا به اولویت ۱</button></div> : null);
  const nid = m.customer.nationalCode
    ? <span><span className="lbl">کد ملی</span> <b dir="ltr">{fd(m.customer.nationalCode)}</b></span>
    : <span><span className="lbl">کد ملی</span> هنوز ثبت نشده است</span>;
  return <section className="dci-col dci-mid" aria-label="اطلاعات تماس و پرونده‌ها">
    <div className="dci-head">
    <p className="dci-cur">{m.call}</p>
    <div className="dci-who"><h2>{m.customer.name}</h2> {cidBtn(m.customer.id, onCopy)}</div>
    <div className="dci-idrow">{m.customer.phone ? <Phone raw={m.customer.phone} big={!ext} onCopy={onCopy} /> : null}{nid}</div>
    <div className="dci-tags">{tags}</div>
    {ps}
    {prio}
    {promo?.open ? createPortal(<div className="dci-dlgw" data-testid="dci-promote-wrap" data-nodnd="true">
      <div className="dci-dlg dci-dlg-promo" role="dialog" aria-modal="true" aria-labelledby="dci-p1-t" data-testid="dci-promote">
        <h2 id="dci-p1-t">ارتقا به اولویت ۱</h2>
        <label className="dci-cxl" htmlFor="dci-p1r">دلیل ارتقا<span className="req" aria-hidden="true">*</span></label>
        <textarea id="dci-p1r" className="dci-cx-inp" rows={4} value={promo.reason} onChange={(e) => promo.setReason(e.target.value)} placeholder="دلیل ارتقا به اولویت ۱" autoFocus />
        <div className="dci-dlg-acts">
          <button className="btn pri" type="button" disabled={promoting || !promo.reason.trim()} onClick={promo.onSave} data-testid="dci-promote-save">ثبت ارتقا</button>
          <button className="btn gh" type="button" onClick={closePromo} data-testid="dci-promote-close">انصراف</button>
        </div>
      </div>
    </div>, document.body) : null}
    <CallActs ext={ext} place="head" narrow={narrow} onCall={onCall} onResult={onResult} />
    </div>
    {result?.open ? <div className="dci-result dp-result" data-testid="dci-result">
      <p className="dci-empty">نتیجه‌ی تماس را ثبت کنید.</p>
      <CqResultFields value={result.val} onChange={result.onChange} showErrors={result.show} idPrefix="dci" submitLabel="ثبت نتیجه" creditCustomerId={m.customer.id} />
      <div className="dci-acts">
        <button className="btn pri" type="button" disabled={result.busy} onClick={result.onSave} data-testid="dci-result-save">ثبت نتیجه</button>
        <button className="btn gh" type="button" disabled={result.busy} onClick={result.onClose}>انصراف</button>
      </div>
      {result.err ? <p className="dci-empty" role="alert" data-testid="dci-result-err">{result.err}</p> : null}
    </div> : null}
    <CasesBlock rows={m.cases} href={m.newCaseHref} canEdit={canEditPs} locked={!!m.priorityStatusLocked} busy={cancelCase.isPending} onCancel={openCancel} />
    {pendingPriority !== undefined ? createPortal(<div className="dci-dlgw" data-testid="dci-xfer-wrap" data-nodnd="true">
      <div className="dci-dlg" role="alertdialog" aria-modal="true" aria-labelledby="dci-xfer-t" data-testid="dci-xfer-dialog">
        <h2 id="dci-xfer-t">تغییر اولویت</h2>
        <p data-testid="dci-xfer-msg">با این تغییر، مشتری به {transferName} منتقل می‌شود.</p>
        <div className="dci-dlg-acts">
          <button type="button" className="btn gh" autoFocus data-testid="dci-xfer-back" onClick={() => setPendingPriority(undefined)}>برگشت</button>
          <button type="button" className="btn pri" data-testid="dci-xfer-yes" disabled={update.isPending} onClick={() => pendingPriority !== undefined && savePriority(pendingPriority)}>تأیید</button>
        </div>
      </div>
    </div>, document.body) : null}
    {cx ? createPortal(<div className="dci-dlgw" data-testid="dci-cx-wrap" data-nodnd="true">
      <div className="dci-dlg dci-dlg-cx" role="alertdialog" aria-modal="true" aria-labelledby="dci-cx-t" data-testid="dci-cx-dialog">
        <div className="dci-cxhd"><h2 id="dci-cx-t">پرونده لغو شود؟</h2></div>
        <p>پروندهٔ {fd(cx.id)}، {m.customer.name}</p>
        <label className="dci-cxl" htmlFor="dci-cx-reason"><b>دلیل لغو<span className="req" aria-hidden="true">*</span></b></label>
        <textarea id="dci-cx-reason" className={`dci-cx-inp${cxErr ? " bad" : ""}`} rows={3} maxLength={1000} value={cxReason}
          aria-required="true" aria-invalid={cxErr ? true : undefined}
          placeholder="دلیل لغو این پرونده را بنویسید…"
          onChange={(e) => { setCxReason(e.target.value); if (cxErr && e.target.value.trim()) setCxErr(""); }}
          data-testid="dci-cx-reason" />
        {cxErr ? <p className="dci-cx-err" role="alert" data-testid="dci-cx-err">{cxErr}</p> : null}
        <p className="dci-cxn" data-testid="dci-cx-info">برگرداندن لغو فقط با ادمین است.</p>
        <div className="dci-dlg-acts">
          <button type="button" className="btn gh" autoFocus data-testid="dci-cx-back" disabled={cancelCase.isPending} onClick={() => { if (!cancelCase.isPending) setCx(null); }}>برگشت</button>
          <button type="button" className="btn dci-cx-yes" data-testid="dci-cx-yes" disabled={cancelCase.isPending || !cxReason.trim()} onClick={submitCancel}>{cancelCase.isPending ? "در حال لغو…" : "بله، لغو شود"}</button>
        </div>
      </div>
    </div>, document.body) : null}
  </section>;
}

function RightCol({ m, ext, onCall }: { m: DciBoard; ext: boolean; onCall: () => void }) {
  return <section className="dci-col dci-right" aria-label="تماس‌های ورودی، تاریخچه و یادداشت‌ها">
    <InBoundBlock rows={m.inbounds} ext={ext} onCall={onCall} />
    <h2>تاریخچه‌ی تماس‌ها</h2>
    <HistList rows={m.hist} />
    <h2>یادداشت‌ها</h2>
    <NotesBlock rows={m.notes} customerId={m.customer.id} />
  </section>;
}

function LeftCol({ m, userId, onOpenFirstCall }: { m: DciBoard; userId: number | undefined; onOpenFirstCall: () => void }) {
  const fileInner = m.first
    ? <><div className="dci-block"><h3>رتبه‌ی اعتباری</h3><CreditBlock customerId={m.customer.id} state={m.credit.state} grade={m.credit.grade} at={m.credit.at} /></div>
        <div className="dci-block"><h3>تکمیل پرونده در تماس اول</h3><FirstCall customerId={m.customer.id} userId={userId} onOpenForm={onOpenFirstCall} /></div></>
    : <><div className="dci-block"><h3>رتبه‌ی اعتباری</h3><CreditBlock customerId={m.customer.id} state={m.credit.state} grade={m.credit.grade} at={m.credit.at} /></div>
        <div className="dci-block"><h3>ضامن</h3><GuarBlock v={m.guar.v} cond={m.guar.cond} /></div></>;
  return <section className="dci-col dci-left" aria-label="پرونده‌ی مشتری">
    <h2>پرونده‌ی مشتری</h2>
    {fileInner}
    {m.wallet ? <div className="dci-wal"><h3>کیف پول</h3><WalletBlock wallet={m.wallet} /></div> : null}
  </section>;
}

function SkCol({ cls, title }: { cls: string; title: string }) {
  return <section className={`dci-col ${cls}`} aria-busy="true" aria-label={title}><h2>{title}</h2><div className="dci-sk h" /><div className="dci-sk w" /><div className="dci-sk w" /><div className="dci-sk" /></section>;
}

function queryParam(search: string, key: string): string | null {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return q.get(key);
}

export default function DailyCustomerInline() {
  const [loc, setLoc] = useLocation();
  const search = useSearch();
  const narrow = useNarrow();
  const todayQ = useDciToday(true);
  const tasks = todayQ.data?.tasks ?? [];
  const qCust = Number(queryParam(search, "customer") || "");
  const selectedTask = useMemo(() => {
    const id = queryParam(search, "task");
    if (id && tasks.some((t) => t.id === id)) return tasks.find((t) => t.id === id)!;
    if (qCust) return tasks.find((t) => t.customerId === qCust) ?? null;
    return tasks[0] ?? null;
  }, [tasks, search, qCust]);
  const customerId = selectedTask?.customerId ?? (Number.isFinite(qCust) && qCust > 0 ? qCust : null);
  const boardQ = useDciBoard(customerId, customerId != null, selectedTask?.id ?? null);
  const [toast, setToast] = useState("");
  const [promoting, setPromoting] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [fcOpen, setFcOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [resultVal, setResultVal] = useState<CqResultValue>(emptyCqResult());
  const [resultShow, setResultShow] = useState(false);
  const [resultBusy, setResultBusy] = useState(false);
  const [resultErr, setResultErr] = useState("");
  const vme = useVcMe().data;
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const userId = session.data?.user?.id != null ? Number(session.data.user.id) : undefined;
  const cq = useCqConfig().data;
  const copy = (v: string) => {
    if (v && navigator.clipboard) navigator.clipboard.writeText(v).catch(() => {});
    setToast("کپی شد");
    window.setTimeout(() => setToast(""), 1600);
  };
  const setSel = (t: DciTask) => setLoc(`/today?customer=${t.customerId}&task=${encodeURIComponent(t.id)}`, { replace: true } as any);
  useEffect(() => {
    if (customerId && !queryParam(search, "customer")) {
      const t = selectedTask;
      if (t) setLoc(`/today?customer=${t.customerId}&task=${encodeURIComponent(t.id)}`, { replace: true } as any);
    }
  }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const denied = boardQ.error instanceof DciError && boardQ.error.status === 403 ? (boardQ.error.body as DciDenied) : null;
  const board = boardQ.data && boardQ.data.access !== undefined ? boardQ.data : null;
  const ext = Boolean((board?.hasExtension ?? todayQ.data?.hasExtension) || vme?.on);
  useEffect(() => {
    setFcOpen(false); setResultOpen(false); setResultVal(emptyCqResult()); setResultShow(false); setResultErr("");
  }, [customerId]);
  const startCall = () => {
    if (!customerId) return;
    if (ext) void vcApi.start({ customerId }).catch(() => undefined);
  };
  const startResult = async () => {
    if (!customerId || !board) return;
    setResultErr("");
    if (selectedTask?.kind === "plan" && selectedTask.itemId) {
      try { await dpApi.start(selectedTask.itemId); }
      catch (e) { setResultErr(e instanceof Error && /[\u0600-\u06FF]/.test(e.message) ? e.message : "شروع ثبت نتیجه انجام نشد."); }
    }
    if (board.first) { setFcOpen(true); setResultOpen(false); return; }
    setResultOpen(true);
  };
  const saveResult = async () => {
    if (!customerId) return;
    setResultShow(true);
    if (cqResultError(resultVal)) { setResultErr(""); return; }
    setResultBusy(true); setResultErr("");
    try {
      const one = resultVal.oneLine.trim();
      const isPlan = selectedTask?.kind === "plan" && selectedTask.itemId;
      const r = await dpApi.saveCall({
        customerId,
        salespersonId: cq?.salespersonId ?? undefined,
        subject: isPlan ? "کارهای امروز" : "تماس ورودی",
        customerRequest: "",
        expertNotes: one,
        outcome: resultVal.outcome,
        call_result: resultVal.manual,
        oneLineNote: one,
        followUpAt: cqFollowUpAt(resultVal),
        ...(isPlan ? { planItemId: selectedTask.itemId } : { outOfList: true, context: "out_of_list" }),
      });
      announceCallSaved(r.id, customerId);
      setResultOpen(false); setResultVal(emptyCqResult()); setResultShow(false);
      await Promise.all([boardQ.refetch(), todayQ.refetch()]);
    } catch (e) {
      setResultErr(e instanceof Error && /[\u0600-\u06FF]/.test(e.message) ? e.message : "ثبت نشد. دوباره تلاش کنید.");
    } finally { setResultBusy(false); }
  };
  const doPromote = async () => {
    if (!customerId || !reason.trim()) return;
    setPromoting(true);
    try { await promoteToP1(customerId, reason.trim()); setReasonOpen(false); setReason(""); await boardQ.refetch(); }
    catch { /* keep open */ }
    finally { setPromoting(false); }
  };

  const loadingBoard = Boolean(customerId) && (boardQ.isLoading || todayQ.isLoading);
  const errorBoard = todayQ.isError || (customerId != null && boardQ.isError && !denied);

  const openFile = narrow && Boolean(board?.first);
  const openTalk = narrow && Boolean(board && board.inbounds.some((x) => !x.missed) && !board.first);
  const [tab, setTab] = useState<"talk" | "file" | "">(openFile ? "file" : openTalk ? "talk" : "");
  useEffect(() => { setTab(openFile ? "file" : openTalk ? "talk" : ""); }, [openFile, openTalk, customerId]);

  const sticky = narrow && board && !denied && !loadingBoard && !errorBoard;
  useEffect(() => { if (sticky) document.body.classList.add("dci-stick"); else document.body.classList.remove("dci-stick"); return () => document.body.classList.remove("dci-stick"); }, [sticky]);
  useEffect(() => {
    if (!resultOpen && !reasonOpen) return;
    const sel = resultOpen ? "[data-testid=dci-result]" : "[data-testid=dci-promote]";
    const align: "start" | "end" = resultOpen ? "start" : "end";
    const run = () => {
      const el = document.querySelector(sel);
      if (!el) return;
      const col = el.closest(".dci-col") as HTMLElement | null;
      const canCol = Boolean(col && col.scrollHeight > col.clientHeight + 4 && getComputedStyle(col).overflowY !== "visible");
      if (canCol && col) {
        const er = el.getBoundingClientRect();
        const cr = col.getBoundingClientRect();
        col.scrollTop += align === "start" ? er.top - cr.top - 8 : er.bottom - cr.bottom + 8;
      } else {
        el.scrollIntoView({ block: align, inline: "nearest" });
      }
    };
    const id = window.setTimeout(run, 50);
    return () => window.clearTimeout(id);
  }, [resultOpen, reasonOpen]);

  let boardEl: JSX.Element;
  if (todayQ.isLoading && !todayQ.data) {
    boardEl = <div className="dci-board"><SkCol cls="dci-right" title="تاریخچه‌ی تماس‌ها" /><SkCol cls="dci-mid" title="اطلاعات مشتری" /><SkCol cls="dci-left" title="پرونده‌ی مشتری" /></div>;
  } else if (errorBoard) {
    boardEl = <div className="dci-board"><section className="dci-col dci-mid" style={{ gridColumn: "1 / -1" }}><div className="dci-err"><p>اطلاعات مشتری الآن در دسترس نیست.</p>
      <button className="btn pri" type="button" onClick={() => { void todayQ.refetch(); void boardQ.refetch(); }}>تلاش دوباره</button></div></section></div>;
  } else if (denied) {
    boardEl = <div className="dci-board"><section className="dci-col dci-mid" style={{ gridColumn: "1 / -1" }}><div className="dci-lock">
      <p>مشتری شما نیست</p>
      <p className="dci-empty">این مشتری با کارشناس دیگری است{denied.expertName ? ` (${denied.expertName})` : ""}. شماره، کیف پول و پرونده‌ها نشان داده نمی‌شوند.</p>
      <h2>{denied.name}</h2> {cidBtn(denied.customerId, copy)}
      <Link className="btn pri" href="/today">رفتن به کارهای امروز</Link>
    </div></section></div>;
  } else if (loadingBoard || !board) {
    boardEl = <div className="dci-board"><SkCol cls="dci-right" title="تاریخچه‌ی تماس‌ها" /><SkCol cls="dci-mid" title="اطلاعات مشتری" /><SkCol cls="dci-left" title="پرونده‌ی مشتری" /></div>;
  } else {
    const show = tab === "talk" ? " show-talk" : tab === "file" ? " show-file" : (openFile ? " show-file" : openTalk ? " show-talk" : "");
    boardEl = <div className={`dci-board${show}`} id="dci-board">
      <RightCol m={board} ext={ext} onCall={startCall} />
      <MidCol m={board} ext={ext} narrow={narrow} onCopy={copy} onCall={startCall} onResult={() => void startResult()} onPromote={() => setReasonOpen(true)} promoting={promoting}
        promo={{ open: reasonOpen, reason, setReason, onSave: () => void doPromote(), onClose: () => setReasonOpen(false) }}
        result={{ open: resultOpen, val: resultVal, show: resultShow, busy: resultBusy, err: resultErr, onChange: setResultVal, onSave: () => void saveResult(), onClose: () => { setResultOpen(false); setResultErr(""); } }} />
      <div className="dci-tabs" role="tablist" aria-label="بخش‌های دیگر">
        <button type="button" role="tab" id="tab-talk" aria-selected={tab === "talk" ? "true" : "false"} data-pane="talk"
          onClick={() => setTab((t) => t === "talk" ? "" : "talk")}>گفت‌وگو</button>
        <button type="button" role="tab" id="tab-file" aria-selected={tab === "file" ? "true" : "false"} data-pane="file"
          onClick={() => setTab((t) => t === "file" ? "" : "file")}>پرونده</button>
      </div>
      <LeftCol m={board} userId={userId} onOpenFirstCall={() => setFcOpen(true)} />
    </div>;
  }

  return <div className="dci" data-testid="dci-page">
    <DciSprites />
    <main className="pg dci-page">
      <p className="dci-date">{todayQ.data?.dateLabel ?? ""}</p>
      <h1>کارهای امروز من</h1>
      <Timeline tasks={tasks} selected={selectedTask?.id ?? null} onPick={setSel} />
      {boardEl}
      {sticky && board && !resultOpen && !reasonOpen ? <div className="dci-sticky"><CallActs ext={ext} place="sticky" narrow={narrow} onCall={startCall} onResult={() => void startResult()} /></div> : null}
    </main>
    {fcOpen && board ? <SimpleCallForm
      customer={{ id: board.customer.id, name: board.customer.name, phone: board.customer.phone ?? "", priority: board.customer.priority }}
      userId={userId}
      onClose={() => setFcOpen(false)}
      onDone={() => { setFcOpen(false); void boardQ.refetch(); void todayQ.refetch(); }}
      onNext={() => setFcOpen(false)}
    /> : null}
    <div className={`toast dci-toast${toast ? " on" : ""}`} id="ph-toast" role="status" aria-live="polite">{toast}</div>
  </div>;
}
