/** Armita daily-customer-inline v1.1 — rendered in the existing sales shell. Flag-on Today page only. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useSearch } from "wouter";
import { getGetAuthSessionQueryKey, getListCustomerTagsQueryKey, useCancelLoanApplication, useGetAuthSession, useListCustomerTags, useUpdateCustomer, type CustomerUpdateStatus } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { STATUS_LABEL } from "@/pages/customers-ui";
import { announceCallSaved, useCqConfig } from "@/features/call-queue/api";
import { emptyCqResult, MANUAL_OUTCOME_OPTIONS, type CqResultValue } from "@/features/call-queue/ResultFields";
import { dpApi } from "@/features/daily-plan/api";
import { promoteToP1 } from "@/features/history/api";
import { InstantCreditCheck } from "@/features/team-sales/InstantCreditCheck";
import { useIccEnabled } from "@/features/team-sales/api";
import { CustomerNameEdit } from "@/features/customer-name-edit/CustomerNameEdit";
import { useVcMe, vcApi, VcError, VC_ME_KEY, type VcMe } from "@/features/voip-call/api";
import { DciError, dciApi, useDciBoard, useDciToday, type DciBoard, type DciCase, type DciDenied, type DciInbound, type DciTask } from "./api";
import { HistFeed } from "./today-feed";
import { FileBox, FileWizard } from "./file-wizard";
import { DciIcon, DciSprites } from "./icons";
import "./dci.css";
import "./today-layout.css";
import { getListRemindersQueryKey, useListReminders, useUpdateReminder } from "@workspace/api-client-react";
import { mergeQueue, queueKindClass, queueKindLabel, type QueueTask } from "./queue";
import { DQ_KEY, DqEarlyBar, DqFileActCard, DqIntBanner, DqPayCard, DqStrip, DqUnknownBoard, KIND_FA, dqApi, dqCurText, useDqArrivals, useDqQueue, type DqItem, type DqKind } from "./queue-v21";

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

function Timeline({ tasks, selected, onPick }: { tasks: QueueTask[]; selected: string | null; onPick: (t: QueueTask) => void }) {
  const rail = useRef<HTMLElement | null>(null);
  const nodeRef = useRef<HTMLAnchorElement | null>(null);
  const [fade, setFade] = useState<"none" | "start" | "end" | "both">("none");
  const [can, setCan] = useState({ start: false, end: false });
  const sync = () => {
    const el = rail.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const abs = Math.abs(el.scrollLeft);
    const has = max > 4;
    const atStart = abs < 8;
    const atEnd = Math.max(0, max - abs) < 8;
    setCan({ start: has && !atStart, end: has && !atEnd });
    setFade(!has ? "none" : atStart ? "end" : atEnd ? "start" : "both");
  };
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    window.addEventListener("resize", sync);
    return () => { el.removeEventListener("scroll", sync); ro?.disconnect(); window.removeEventListener("resize", sync); };
  }, [tasks.length]);
  useEffect(() => { nodeRef.current?.scrollIntoView({ inline: "center", block: "nearest" }); }, [selected]);
  const go = (dir: "start" | "end") => {
    const el = rail.current;
    if (!el) return;
    const step = Math.max(160, el.clientWidth * 0.6);
    // RTL: start (right) is toward scrollLeft ≈ 0; end (left) is away from 0.
    const sign = el.scrollLeft <= 0 ? (dir === "start" ? 1 : -1) : (dir === "start" ? -1 : 1);
    el.scrollBy({ left: sign * step, behavior: "smooth" });
  };
  return <div className="dci-tlw" data-fade={fade === "none" ? undefined : fade} data-testid="dci-tlw">
    <button className="dci-tl-btn" type="button" aria-label="مشتری‌های راست" disabled={!can.start} onClick={() => go("start")}><DciIcon id="i-chev-r" /></button>
    <nav className="dci-tl" ref={rail} aria-label="صف تماس‌های امروز">
      {tasks.map((t) => {
        const kind = queueKindClass(t);
        const typ = queueKindLabel(t);
        const tip = [t.tm, t.overdue ? "عقب‌افتاده" : ""].filter(Boolean).join(" — ");
        const al = ["نوبت " + fd(t.turn), t.name, typ, t.tm, t.overdue ? "عقب‌افتاده" : ""].filter(Boolean).join("، ");
        return <a key={t.id} ref={selected === t.id ? nodeRef : undefined}
          className={`dci-node ${kind}${t.overdue ? " is-late" : ""}`}
          href={`#${t.id}`} aria-current={selected === t.id ? "true" : undefined}
          title={tip} aria-label={al}
          onClick={(e) => { e.preventDefault(); onPick(t); }}>
          <span className="dci-nord" aria-hidden="true">{fd(t.turn)}</span>
          <span className="dci-dot" aria-hidden="true" />
          <b>{t.name}</b>
          <span className="dci-kind">{typ}{t.overdue ? <span className="dci-late-t"> · عقب‌افتاده</span> : null}</span>
        </a>;
      })}
    </nav>
    <button className="dci-tl-btn" type="button" aria-label="مشتری‌های چپ" disabled={!can.end} onClick={() => go("end")}><DciIcon id="i-chev-l" /></button>
  </div>;
}

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
    {state === "start" && iccOn ? <div data-testid="dci-credit-start"><InstantCreditCheck customerId={customerId} embedded /></div> : null}
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
    const pri = <button className="btn pri" type="button" data-voip data-testid="dci-call" onClick={onCall}><DciIcon id="i-phone" />تماس</button>;
    if (place === "sticky") return pri;
    return <div className="dci-acts">{pri}</div>;
  }
  const pri = <button className="btn pri" type="button" data-result data-testid="dci-logged-call" onClick={onResult}>ثبت نتیجه‌ی تماس</button>;
  if (place === "sticky") return pri;
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

function MidCol({ m, ext, narrow, onCopy, onCall, onResult, onPromote, promoting, promo, remBar, userId, wizard, dq }: {
  m: DciBoard; ext: boolean; narrow: boolean; onCopy: (v: string) => void; onCall: () => void; onResult: () => void;
  onPromote: () => void; promoting: boolean;
  promo?: { open: boolean; reason: string; setReason: (v: string) => void; onSave: () => void; onClose: () => void };
  remBar?: { text: string; hint?: string } | null;
  userId: number | undefined;
  /** DCI-QUEUE 440000 (flag.dci_queue_v21): early bar, interrupt banner, payment / file-action card. Absent → v2.0 markup. */
  dq?: { top?: ReactNode; cur?: ReactNode; card?: ReactNode } | null;
  wizard: { open: boolean; onOpen: (mode: "new" | "edit") => void; onClose: () => void };
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
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["dci-board", m.customer.id] });
    void qc.invalidateQueries({ queryKey: ["dci-today"] });
    void qc.invalidateQueries({ queryKey: getListRemindersQueryKey({ done: false }) });
  };
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
  const [stToast, setStToast] = useState(false);
  const [nameOv, setNameOv] = useState<string | null>(null);
  const [nameToast, setNameToast] = useState("");
  const stToastT = useRef(0);
  const curStatus: CustomerUpdateStatus = (PS_STATUSES.includes((m.customer.status || "") as CustomerUpdateStatus) ? m.customer.status : "in_progress") as CustomerUpdateStatus;
  const saveStatus = (value: CustomerUpdateStatus) => {
    if (!canEditPs || value === curStatus || update.isPending) return;
    setPsError(""); setPsOk("");
    update.mutate({ id: m.customer.id, data: { status: value } }, {
      onSuccess: () => {
        setStToast(true);
        window.clearTimeout(stToastT.current);
        stToastT.current = window.setTimeout(() => setStToast(false), 3200);
        refresh();
      },
      onError: (error) => { setPsError(psErrMsg(error, "status")); setStToast(false); },
    });
  };
  useEffect(() => () => window.clearTimeout(stToastT.current), []);
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
  const st = <div className="dci-st">
    <label className="dci-ps-lbl" htmlFor="dci-st">وضعیت مشتری</label>
    <select id="dci-st" className="dci-st-sel" aria-label="وضعیت مشتری" data-testid="dci-st"
      value={curStatus} disabled={!canEditPs || update.isPending}
      title={!canEditPs ? noPermHint : undefined}
      onChange={(e) => saveStatus(e.target.value as CustomerUpdateStatus)}>
      {PS_STATUSES.map((key) => <option key={key} value={key}>{STATUS_LABEL[key]}</option>)}
    </select>
  </div>;
  const shownName = nameOv ?? m.customer.name;
  return <section className="dci-col dci-mid" aria-label="اطلاعات تماس و پرونده‌ها">
    {dq?.top ?? null}
    <div className="dci-head">
    {dq?.cur ?? <p className="dci-cur">{m.call}</p>}
    <div className="dci-head-main">
      <div className="dci-who-row">
        <div className="dci-who">
          <CustomerNameEdit customerId={m.customer.id} name={shownName} toast={(msg) => { setNameToast(msg); window.setTimeout(() => setNameToast(""), 2500); }}
            onSaved={(n) => { setNameOv(n); void qc.invalidateQueries({ queryKey: ["dci-board", m.customer.id] }); }}
            rowClassName="dci-nmr nmr ed-view">
            <h2>{fd(shownName)}</h2> {cidBtn(m.customer.id, onCopy)}
          </CustomerNameEdit>
        </div>
        <CallActs ext={ext} place="head" narrow={narrow} onCall={onCall} onResult={onResult} />
      </div>
      <div className="dci-idrow dci-idrow-phone">{m.customer.phone ? <Phone raw={m.customer.phone} big={!ext} onCopy={onCopy} /> : null}</div>
    </div>
    <div className="dci-prio">
      {ps}
      {st}
    </div>
    {stToast ? <div className="toast on" role="status" data-testid="dci-st-toast">وضعیت مشتری ذخیره شد.</div> : null}
    {nameToast ? <div className="toast on" role="status" data-testid="dci-cne-toast">{nameToast}</div> : null}
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
    </div>
    {remBar ? <div className="dci-rembar" data-testid="dci-rembar" role="status"><p>{remBar.text}</p><span className="dci-hint">{remBar.hint || "با ثبت نتیجه، این یادآور تمام می‌شود."}</span></div> : null}
    {dq?.card ?? null}
    {tags.length ? <div className="dci-tags" data-testid="dci-tags">{tags}</div> : null}
    <section className="dci-filecard" id="dci-filecard" aria-label="پرونده‌ی مشتری" data-testid="dci-filecard">
      <FileBox customerId={m.customer.id} onOpen={wizard.onOpen}
        wizard={wizard.open ? <FileWizard key={`${m.customer.id}-wiz`} customerId={m.customer.id} userId={userId} onDone={wizard.onClose} /> : null} />
    </section>
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
        <p>پروندهٔ {fd(cx.id)}، {fd(m.customer.name)}</p>
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

function RightCol({ m, ext, onCall, result, sumOpen }: {
  m: DciBoard; ext: boolean; onCall: () => void;
  result: { val: CqResultValue; onChange: (v: CqResultValue) => void; onSave: () => void; busy: boolean; err: string; show: boolean; voipNote?: boolean };
  sumOpen?: boolean;
}) {
  return <section className="dci-col dci-right" aria-label="تاریخچه و یادداشت‌ها">
    <InBoundBlock rows={m.inbounds} ext={ext} onCall={onCall} />
    <HistFeed hist={m.hist} notes={m.notes} customerId={m.customer.id} result={result} sumOpen={sumOpen} />
  </section>;
}

function LeftCol({ m }: { m: DciBoard }) {
  return <section className="dci-col dci-left" aria-label="اعتبارسنجی فوری" data-testid="dci-left">
    <div className="dci-block" data-testid="dci-credit">
      <div className="dci-cvh"><h3>اعتبارسنجی فوری</h3><span className="dci-opt">اختیاری</span></div>
      <CreditBlock customerId={m.customer.id} state={m.credit.state} grade={m.credit.grade} at={m.credit.at} /></div>
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
  const sessionEarly = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const remUserId = sessionEarly.data?.user?.id != null ? Number(sessionEarly.data.user.id) : undefined;
  const remQ = useListReminders({ done: false }, {
    query: { queryKey: getListRemindersQueryKey({ done: false }), enabled: remUserId != null, retry: false, staleTime: 15_000, refetchInterval: 15_000 },
  });
  const [droppedIds, setDroppedIds] = useState<number[]>([]);
  const tasks = useMemo(
    () => mergeQueue(todayQ.data?.tasks ?? [], remQ.data).filter((t) => !droppedIds.includes(t.customerId)),
    [todayQ.data?.tasks, remQ.data, droppedIds],
  );
  // DCI-QUEUE 440000: GET /queue 404 (flag.dci_queue_v21 off) → null → everything below stays v2.0.
  const dqQ = useDqQueue(true);
  const dq = dqQ.data ?? null;
  const dqTasks = useMemo<QueueTask[] | null>(() => dq ? dq.items.map((it) => ({
    id: it.id, kind: it.itemId ? "plan" : "inbound", itemId: it.itemId, customerId: it.customer_id ?? 0, name: it.name,
    typ: KIND_FA[it.kind], ic: "i-phone", tm: it.tm, at: it.due_at, status: it.dpStatus, turn: it.turn, overdue: it.overdue,
    remText: it.remText ?? undefined, reminderId: it.reminderId ?? undefined, types: it.kinds.map((k) => KIND_FA[k]),
  })) : null, [dq]);
  // While GET /queue is in flight nothing is picked, so the v2.0 list never rewrites ?customer= before the queue decides (Q: current first).
  const allTasks = dqTasks ?? (dqQ.isLoading ? [] : tasks);
  const qCust = Number(queryParam(search, "customer") || "");
  const selectedTask = useMemo(() => {
    const id = queryParam(search, "task");
    if (id && allTasks.some((t) => t.id === id)) return allTasks.find((t) => t.id === id)!;
    if (qCust) return allTasks.find((t) => t.customerId === qCust) ?? null;
    if (dq) return allTasks.find((t) => t.id === dq.currentId) ?? allTasks.find((t, i) => !dq.items[i].done) ?? null;
    return allTasks[0] ?? null;
  }, [allTasks, search, qCust, dq]);
  const dqItem: DqItem | null = dq && selectedTask ? dq.items.find((x) => x.id === selectedTask.id) ?? null : null;
  const dqCur: DqItem | null = dq ? dq.items.find((x) => x.current) ?? null : null;
  const dqEarly = Boolean(dqItem && dqCur && dqItem.id !== dqCur.id && !dqItem.done && !dqItem.urgent);
  const [dqFlt, setDqFlt] = useState<DqKind | "">("");
  const [dqToast, setDqToast] = useState<DqItem | null>(null);
  useDqArrivals(dq, (it) => { setDqToast(it); window.setTimeout(() => setDqToast((t) => (t && t.id === it.id ? null : t)), 8000); });
  const customerId = (selectedTask?.customerId || null) ?? (Number.isFinite(qCust) && qCust > 0 ? qCust : null);
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
  const vcQc = useQueryClient();
  const session = sessionEarly;
  const userId = remUserId;
  const updateRem = useUpdateReminder();
  const cq = useCqConfig().data;
  const copy = (v: string) => {
    if (v && navigator.clipboard) navigator.clipboard.writeText(v).catch(() => {});
    setToast("کپی شد");
    window.setTimeout(() => setToast(""), 1600);
  };
  const setSel = (t: DciTask) => setLoc(`/today?customer=${t.customerId}&task=${encodeURIComponent(t.id)}`, { replace: true } as any);
  const pickDq = (it: DqItem) => setLoc(it.customer_id ? `/today?customer=${it.customer_id}&task=${encodeURIComponent(it.id)}` : `/today?task=${encodeURIComponent(it.id)}`, { replace: true } as any);
  const flash = (msg: string, ms = 3000) => { setToast(msg); window.setTimeout(() => setToast((t) => (t === msg ? "" : t)), ms); };
  /** Q14: a customer opened/called outside today's queue becomes an «تماس خروجی» task (or the existing task is reused). */
  const dqEnsure = async (cid: number): Promise<string | null> => {
    if (!dq) return null;
    const hit = dq.items.find((x) => x.customer_id === cid);
    if (hit) return hit.id;
    try { const r = await dqApi.outgoing(cid); void vcQc.invalidateQueries({ queryKey: DQ_KEY }); return r.taskId; } catch { return null; }
  };
  useEffect(() => {
    if (customerId && !queryParam(search, "customer")) {
      const t = selectedTask;
      if (t) setLoc(`/today?customer=${t.customerId}&task=${encodeURIComponent(t.id)}`, { replace: true } as any);
    }
  }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const denied = boardQ.error instanceof DciError && boardQ.error.status === 403 ? (boardQ.error.body as DciDenied) : null;
  useEffect(() => {
    const id = denied?.error === "not_owner" ? denied.customerId : 0;
    if (id) setDroppedIds((ids) => ids.includes(id) ? ids : [...ids, id]);
  }, [denied]);
  const board = boardQ.data && boardQ.data.access !== undefined ? boardQ.data : null;
  const ext = Boolean((board?.hasExtension ?? todayQ.data?.hasExtension) || vme?.on);
  useEffect(() => {
    document.body.classList.toggle("dci-noext", !ext);
    return () => document.body.classList.remove("dci-noext");
  }, [ext]);
  useEffect(() => {
    setFcOpen(false); setResultOpen(false); setResultVal(emptyCqResult()); setResultShow(false); setResultErr("");
  }, [customerId]);
  // CALLVOIP-410000: «تماس» buttons pass onClick={onCall} → React called startCall(clickEvent), so `id ?? customerId` sent the click
  // EVENT as customerId; JSON.stringify of the event threw before any request and the .catch hid it (no /voip-call/start since 390000).
  // Only a real numeric id overrides the page customer; a failure is shown instead of swallowed.
  const callBusy = useRef(false);
  const startCall = (id?: unknown) => {
    const cid = typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : customerId;
    if (!cid || !ext || callBusy.current) return;
    callBusy.current = true;
    void dqEnsure(cid);
    vcApi.start({ customerId: cid })
      .then((r) => { vcQc.setQueryData<VcMe>(VC_ME_KEY, (o) => ({ ...(o ?? { on: true }), on: true, call: r.call })); })
      .catch((e) => {
        setToast(e instanceof VcError ? e.message : "شروع تماس ناموفق بود.");
        window.setTimeout(() => setToast(""), 3500);
        void vcQc.invalidateQueries({ queryKey: VC_ME_KEY });
      })
      .finally(() => { callBusy.current = false; });
  };
  const startResult = async () => {
    if (!customerId || !board) return;
    setResultErr("");
    // CALLRESULT-410000: only the CURRENT plan item can be «started» (server 409 otherwise); any other task just opens the box.
    if (selectedTask?.kind === "plan" && selectedTask.itemId && selectedTask.status === "current") {
      try { await dpApi.start(selectedTask.itemId); }
      catch (e) { setResultErr(e instanceof Error && /[\u0600-\u06FF]/.test(e.message) ? e.message : "شروع ثبت نتیجه انجام نشد."); }
    }
    setResultOpen(true);
    window.setTimeout(() => {
      document.getElementById("dci-result")?.scrollIntoView({ block: "start", inline: "nearest" });
      (document.getElementById("dci-res-note") as HTMLElement | null)?.focus();
    }, 50);
  };
  const lastVoip = vme?.s132?.last;
  const voipPendingNote = Boolean(lastVoip && lastVoip.customerId === customerId && lastVoip.noteState === "pending" && lastVoip.status === "answered");
  const saveResult = async () => {
    if (!customerId) return;
    setResultShow(true);
    const one = resultVal.oneLine.trim();
    if (voipPendingNote) {
      if (!one) { setResultErr("یادداشت تماس را بنویسید."); return; }
    } else if (!resultVal.manual) {
      setResultErr("نتیجه‌ی تماس را انتخاب کنید."); return;
    } else if (resultVal.manual === "answered" && !one) {
      setResultErr("یادداشت تماس را بنویسید."); return;
    }
    setResultBusy(true); setResultErr("");
    try {
      if (voipPendingNote && lastVoip) {
        await vcApi.note(lastVoip.callId, one);
      } else {
        const isPlan = selectedTask?.kind === "plan" && selectedTask.itemId;
        const r = await dpApi.saveCall({
          customerId,
          salespersonId: cq?.salespersonId ?? undefined,
          subject: isPlan ? "کارهای امروز" : "تماس ورودی",
          customerRequest: "",
          expertNotes: one || MANUAL_OUTCOME_OPTIONS.find((o) => o.key === resultVal.manual)?.label || "",
          outcome: resultVal.outcome,
          call_result: resultVal.manual,
          // CALLRESULT-410000: the note is optional for «جواب نداد» / «خاموش یا اشغال» in this box, but the daily-plan API needs a
          // one-line note — send the chosen result as the note instead of failing with «یادداشت یک‌خطی را بنویس».
          oneLineNote: one || MANUAL_OUTCOME_OPTIONS.find((o) => o.key === resultVal.manual)?.label || "",
          ...(isPlan ? { planItemId: selectedTask.itemId } : { outOfList: true, context: "out_of_list" }),
        });
        announceCallSaved(r.id, customerId);
      }
      if (selectedTask?.reminderId) {
        try { await new Promise<void>((resolve, reject) => updateRem.mutate({ data: { id: selectedTask.reminderId!, done: true } }, { onSuccess: () => resolve(), onError: (e) => reject(e) })); }
        catch { /* result already saved; reminder list will refresh */ }
      }
      // DCI-QUEUE 440000: record done_at / done_early (side table only; dp item + reminder were closed above as in 410000).
      let backTo: DqItem | null = null;
      if (dq) {
        const taskId = dqItem?.id ?? await dqEnsure(customerId);
        if (taskId) {
          try {
            const r = await dqApi.done(taskId, dqItem?.due_ref ?? null, resultVal.manual || null);
            if (dqEarly && dqCur) { backTo = dqCur; flash("زودتر از نوبت انجام شد و در جای خودش علامت خورد. برگشت به کار جاری…", 3500); }
            else if (r.done_early) flash("زودتر از نوبت انجام شد و در جای خودش علامت خورد.", 3000);
          } catch { /* the call result is saved; the mark is cosmetic */ }
        }
      }
      setResultOpen(false); setResultVal(emptyCqResult()); setResultShow(false);
      await Promise.all([boardQ.refetch(), todayQ.refetch(), remQ.refetch(), dq ? dqQ.refetch() : Promise.resolve()]);
      if (backTo) pickDq(backTo);
    } catch (e) {
      setResultErr(e instanceof Error && /[\u0600-\u06FF]/.test(e.message) ? e.message : "ثبت نشد. دوباره تلاش کنید.");
    } finally { setResultBusy(false); }
  };
  const openWizard = (_mode: "new" | "edit") => {
    setFcOpen(true);
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

  const sticky = false;
  useEffect(() => { document.body.classList.remove("dci-stick"); return () => document.body.classList.remove("dci-stick"); }, []);
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

  let boardEl: ReactNode;
  const dqBanner = dqItem && ["incoming_call", "outgoing_call", "payment_order", "file_action"].includes(dqItem.kind) && !dqItem.done
    ? <DqIntBanner it={dqItem} text={dqCurText(dqItem) || board?.call || ""} /> : null;
  if (dq && dqItem && dqItem.customer_id == null) {
    boardEl = <DqUnknownBoard key={dqItem.id} it={dqItem} banner={dqBanner}
      onNamed={(cid, taskId, name) => { flash(`نام «${name}» ثبت شد.`, 2500); void dqQ.refetch(); setLoc(`/today?customer=${cid}&task=${encodeURIComponent(taskId)}`, { replace: true } as any); }} />;
  } else if ((todayQ.isLoading && !todayQ.data) || dqQ.isLoading) {
    boardEl = <div className="dci-board"><div className="dci-side"><SkCol cls="dci-right" title="تاریخچه‌ی تماس‌ها" /><SkCol cls="dci-left" title="اعتبارسنجی فوری" /></div><SkCol cls="dci-mid" title="اطلاعات مشتری" /></div>;
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
    boardEl = <div className="dci-board"><div className="dci-side"><SkCol cls="dci-right" title="تاریخچه‌ی تماس‌ها" /><SkCol cls="dci-left" title="اعتبارسنجی فوری" /></div><SkCol cls="dci-mid" title="اطلاعات مشتری" /></div>;
  } else {
    const show = tab === "talk" ? " show-talk" : tab === "file" ? " show-file" : (openFile ? " show-file" : openTalk ? " show-talk" : "");
    const remBar = selectedTask && (selectedTask.reminderId || selectedTask.types.includes("یادآور"))
      ? { text: selectedTask.remText || "یادآور سررسید", hint: dqItem && !dqItem.due && !dqItem.done ? "ثبت نتیجه، این یادآور را زودتر از ساعتش تمام می‌کند و ساعت انجام ثبت می‌شود." : undefined } : null;
    const dqMid = dq && dqItem ? {
      top: dqEarly && dq ? <DqEarlyBar q={dq} it={dqItem} cur={dqCur} onBack={() => dqCur && pickDq(dqCur)} /> : null,
      cur: dqBanner,
      card: dqItem.pay && !dqItem.done ? <DqPayCard it={dqItem} customerId={board.customer.id} onDone={(msg) => { flash(msg); void dqQ.refetch(); }} />
        : dqItem.fileAct && !dqItem.done ? <DqFileActCard it={dqItem} customerId={board.customer.id} /> : null,
    } : null;
    boardEl = <div className={`dci-board${show}`} id="dci-board">
      <div className="dci-side">
        <RightCol m={board} ext={ext} onCall={startCall} sumOpen={queryParam(search, "shot") === "sum"}
          result={{ val: resultVal, onChange: setResultVal, onSave: () => void saveResult(), busy: resultBusy, err: resultErr, show: resultShow, voipNote: voipPendingNote }} />
        <LeftCol m={board} />
      </div>
      <MidCol m={board} ext={ext} narrow={narrow} onCopy={copy} onCall={startCall} onResult={() => void startResult()} onPromote={() => setReasonOpen(true)} promoting={promoting}
        promo={{ open: reasonOpen, reason, setReason, onSave: () => void doPromote(), onClose: () => setReasonOpen(false) }}
        remBar={remBar} userId={userId} wizard={{ open: fcOpen, onOpen: openWizard, onClose: () => setFcOpen(false) }} dq={dqMid} />
      <div className="dci-tabs" role="tablist" aria-label="بخش‌های دیگر">
        <button type="button" role="tab" id="tab-talk" aria-selected={tab === "talk" ? "true" : "false"} data-pane="talk"
          onClick={() => setTab((t) => t === "talk" ? "" : "talk")}>گفت‌وگو</button>
        <button type="button" role="tab" id="tab-file" aria-selected={tab === "file" ? "true" : "false"} data-pane="file"
          onClick={() => setTab((t) => t === "file" ? "" : "file")}>پرونده</button>
      </div>
    </div>;
  }

  return <div className="dci" data-testid="dci-page">
    <DciSprites />
    <main className="pg dci-page">
      {dq ? <DqStrip q={dq} openId={selectedTask?.id ?? null} flt={dqFlt} setFlt={setDqFlt} onPick={pickDq} />
        : dqQ.isLoading ? <div className="dci-tlw" aria-busy="true" /> : <Timeline tasks={tasks} selected={selectedTask?.id ?? null} onPick={setSel} />}
      {boardEl}
    </main>
    <div className={`toast dci-toast${toast ? " on" : ""}`} id="ph-toast" role="status" aria-live="polite">{toast}</div>
    {dqToast ? <div className="toast dci-toast on k-in dq-arrive" role="status" aria-live="polite" data-testid="dq-arrive">
      <span>تماس ورودی تازه: {fd(dqToast.name)}</span>
      <button type="button" className="btn gh" onClick={() => { pickDq(dqToast); setDqToast(null); }}>باز کردن</button></div> : null}
  </div>;
}
