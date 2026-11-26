/* «دسترسی این صفحه» v1 (t942u, Armita v1.1): admin-only top-bar button + status chip + sheet (status, 3-step wizard, block, history).
 * Renders nothing unless flag.page_access_v1 is ON, the viewer is admin / sales manager (not 29) and the page is in phase 1. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, CircleCheck, History as HistoryIcon, Lock, Search, ShieldCheck, TriangleAlert, User, Users, X } from "lucide-react";
import {
  PA_ME_KEY, PaError, paBlock, paGrant, paHistory, paKeyForPath, paRemove, paRevert, paStatus, paSubjects, usePageAccessMe,
  type PaHistoryItem, type PaLevel, type PaPageMeta, type PaStatus, type PaSubjectUser,
} from "./api";
import "./page-access.css";

const fa = (v: number | string) => String(v).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const jDay = (iso?: string) => { try { return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { day: "numeric", month: "long", timeZone: "Asia/Tehran" }).format(new Date(iso!)); } catch { return ""; } };
const jFull = (iso: string) => {
  try {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Tehran" }).format(d);
    const hm = new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Tehran" }).format(d);
    return `${day}، ${hm}`;
  } catch { return ""; }
};
const LEVEL_FA: Record<PaLevel, string> = { view: "فقط دیدن", manage: "دیدن و کار کردن" };
const SCOPE_FA: Record<string, [string, string, string]> = {
  own: ["فقط مشتری‌های خودش", "فقط مشتری‌هایی که مالک‌شان است.", "فقط مشتری‌های خودش"],
  team: ["تیمش", "مشتری‌های تیم فروش خودش.", "مشتری‌های تیمش"],
  all: ["همه", "همه‌ی مشتری‌های سامانه.", "همه‌ی مشتری‌ها"],
};
const Cid = ({ id }: { id: number | null | undefined }) => (id ? <span className="pgac-cid">#{fa(id)}</span> : null);
const OPEN_EVENT = "pa:open";

function chipText(s: PaStatus | undefined, page: PaPageMeta): string | null {
  if (page.grantable === "never") return "قابل‌اعطا نیست";
  if (!s) return null;
  const extra = s.users.some((u) => u.kind === "granted") || s.roles.length > 0;
  if (!extra && page.kind === "admin") return "فقط ادمین و مدیر فروش";
  return s.counts.roles ? `${fa(s.counts.people)} نفر و ${fa(s.counts.roles)} نقش دسترسی دارند` : `${fa(s.counts.people)} نفر دسترسی دارند`;
}

function usePaPage(location: string, enabled: boolean) {
  const me = usePageAccessMe(enabled).data;
  const on = Boolean(me?.enabled && me.canManage);
  const key = on ? paKeyForPath(me!.pages, location) : null;
  const page = key ? me!.pages!.find((p) => p.key === key) ?? null : null;
  return { on, page };
}
const statusKey = (k: string) => ["page-access-status", k] as const;

/** Status chip under the page title (desktop only; hidden while the sheet is open and at 390). */
export function PageAccessChip({ location, enabled }: { location: string; enabled: boolean }) {
  const { on, page } = usePaPage(location, enabled);
  const st = useQuery({ queryKey: statusKey(page?.key ?? "-"), enabled: Boolean(on && page && page.grantable !== "never"), queryFn: () => paStatus(page!.key), staleTime: 30_000, retry: false });
  if (!on || !page) return null;
  const t = chipText(st.data, page); if (!t) return null;
  return <button type="button" className="pgac-root pgac-status-chip" aria-haspopup="dialog" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_EVENT))} data-testid="pa-chip">{t}</button>;
}

/** Top-bar button (desktop: secondary button with a shield; ≤700px: 44×44 shield icon next to the bell) + the sheet. */
export function PageAccessButton({ location, enabled }: { location: string; enabled: boolean }) {
  const { on, page } = usePaPage(location, enabled);
  const [open, setOpen] = useState(false);
  useEffect(() => { const f = () => setOpen(true); window.addEventListener(OPEN_EVENT, f); return () => window.removeEventListener(OPEN_EVENT, f); }, []);
  useEffect(() => { setOpen(false); }, [location]);
  useEffect(() => { document.body.classList.toggle("pgac-sheet-on", open); return () => document.body.classList.remove("pgac-sheet-on"); }, [open]);
  if (!on || !page) return null;
  return (
    <span className="pgac-root pgac-ctl">
      <button type="button" className="pgac-access-btn" aria-haspopup="dialog" onClick={() => setOpen(true)} data-testid="pa-button"><ShieldCheck className="pgac-i" aria-hidden="true" />دسترسی این صفحه</button>
      <button type="button" className="pgac-ib" aria-label="دسترسی این صفحه" aria-haspopup="dialog" onClick={() => setOpen(true)} data-testid="pa-icon"><ShieldCheck className="pgac-i" aria-hidden="true" /></button>
      {open ? createPortal(<PageAccessSheet page={page} onClose={() => setOpen(false)} />, document.body) : null}
    </span>
  );
}

type View = "status" | "step1" | "step2" | "step3" | "success" | "history";
type Mode = "role" | "user" | "block";

export function PageAccessSheet({ page, onClose, initial }: { page: PaPageMeta; onClose: () => void; initial?: { view?: View } }) {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: statusKey(page.key), queryFn: () => paStatus(page.key), retry: false, enabled: page.grantable !== "never" });
  const [view, setView] = useState<View>(initial?.view ?? "status");
  const [mode, setMode] = useState<Mode | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [users, setUsers] = useState<number[]>([]);
  const [level, setLevel] = useState<PaLevel>("view");
  const [scope, setScope] = useState<"own" | "team" | "all">("own");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmRow, setConfirmRow] = useState<number | null>(null);
  const [undo, setUndo] = useState<{ batch: string; text: string } | null>(null);
  const [histConfirm, setHistConfirm] = useState(false);
  const [done, setDone] = useState<string>("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const subj = useQuery({ queryKey: ["page-access-subjects", page.key], queryFn: () => paSubjects(page.key), enabled: view === "step2" || view === "step3", retry: false });
  const hist = useQuery({ queryKey: ["page-access-history", page.key], queryFn: () => paHistory(page.key), enabled: view === "history", retry: false });

  useEffect(() => { closeRef.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  useEffect(() => { if (!undo) return; const t = window.setTimeout(() => setUndo(null), 8000); return () => window.clearTimeout(t); }, [undo]);

  const refresh = useCallback((s?: PaStatus) => {
    if (s) qc.setQueryData(statusKey(page.key), s); else void qc.invalidateQueries({ queryKey: statusKey(page.key) });
    void qc.invalidateQueries({ queryKey: ["page-access-subjects", page.key] });
    void qc.invalidateQueries({ queryKey: ["page-access-history", page.key] });
    void qc.invalidateQueries({ queryKey: PA_ME_KEY });
  }, [qc, page.key]);
  const onConflict = (e: unknown) => {
    if (e instanceof PaError && e.status === 409 && e.code === "changed") { setConflict(true); refresh(); setView("status"); return true; }
    return false;
  };
  const reset = () => { setMode(null); setRole(null); setUsers([]); setLevel("view"); setScope("own"); setQ(""); setSaveErr(null); };

  const s = st.data;
  const title = `دسترسی صفحه‌ی ${page.label}`;
  const selUsers: PaSubjectUser[] = (subj.data?.users ?? []).filter((u) => users.includes(u.id));
  const selRole = subj.data?.roles.find((r) => r.slug === role) ?? null;
  const scopeOn = Boolean(s?.scopeEnabled && mode === "user" && selUsers.some((u) => u.scopeAvailable));
  const viewOnly = page.grantable === "view";

  // Step 3 defaults: an existing grant's level is editable (one person / one role) — preselect it; otherwise «فقط دیدن».
  const enterStep3 = () => {
    const one = mode === "user" && selUsers.length === 1 ? selUsers[0]! : null;
    setLevel(viewOnly ? "view" : one?.has ?? (mode === "role" ? selRole?.grant?.level ?? "view" : "view"));
    setScope(one?.scope ?? "own"); setSaveErr(null); setView("step3");
  };

  const who = (): ReactNode => mode === "role" ? <>{selRole?.name}</>
    : selUsers.length === 1 ? <>{selUsers[0]!.name} <Cid id={selUsers[0]!.id} /></> : <>{fa(selUsers.length)} نفر</>;
  const summary = (): ReactNode => {
    if (mode === "block") { const u = selUsers[0]; return u ? <>صفحه‌ی {page.label} برای {u.name} <Cid id={u.id} /> بسته شود؟ نقش {u.roleName} برای بقیه سر جایش می‌ماند.</> : null; }
    const verb = level === "view" ? "را فقط می‌بیند" : "را می‌بیند و با آن کار می‌کند";
    const plural = mode === "user" && selUsers.length > 1;
    const v = plural ? verb.replace("می‌بیند", "می‌بینند").replace("می‌کند", "می‌کنند") : verb;
    return <>{who()} صفحه‌ی {page.label} {v}{scopeOn ? `؛ ${SCOPE_FA[scope]![2]}.` : "."}{viewOnly && page.key === "contracts" ? " محتوا و قالب‌ها تغییر نمی‌کنند." : ""}</>;
  };
  const summaryText = (): string => {
    const w = mode === "role" ? selRole?.name ?? "" : selUsers.length === 1 ? `${selUsers[0]!.name} #${fa(selUsers[0]!.id)}` : `${fa(selUsers.length)} نفر`;
    if (mode === "block") return `صفحه‌ی ${page.label} برای ${w} بسته شد.`;
    const plural = mode === "user" && selUsers.length > 1;
    const v = level === "view" ? (plural ? "را فقط می‌بینند" : "را فقط می‌بیند") : (plural ? "را می‌بینند و با آن کار می‌کنند" : "را می‌بیند و با آن کار می‌کند");
    return `${w} صفحه‌ی ${page.label} ${v}${scopeOn ? `؛ ${SCOPE_FA[scope]![2]}.` : "."}`;
  };

  const apply = async () => {
    if (!s) return; setSaving(true); setSaveErr(null);
    try {
      const text = summaryText();
      const r = mode === "block" ? await paBlock(page.key, users[0]!, s.version)
        : mode === "role" ? await paGrant(page.key, { subjectKind: "role", roleSlug: role!, level, baseVersion: s.version })
        : await paGrant(page.key, { subjectKind: "user", userIds: users, level, scope: scopeOn ? scope : null, baseVersion: s.version });
      refresh(r.status); setDone(text); setView("success");
    } catch (e) {
      if (!onConflict(e)) setSaveErr(e instanceof PaError && e.message ? e.message : "دسترسی ذخیره نشد. چیزی تغییر نکرد.");
    } finally { setSaving(false); }
  };
  const removeRow = async (rowId: number, name: string, blocked: boolean) => {
    if (!s) return; setSaving(true);
    try {
      const r = await paRemove(page.key, rowId, s.version); refresh(r.status); setConfirmRow(null);
      setUndo({ batch: r.batch, text: blocked ? `صفحه برای ${name} باز شد.` : `دسترسی ${name} از این صفحه برداشته شد.` });
    } catch (e) { if (!onConflict(e)) setSaveErr("دسترسی ذخیره نشد. چیزی تغییر نکرد."); } finally { setSaving(false); }
  };
  const revert = async (batch: string) => {
    setSaving(true);
    try { const r = await paRevert(page.key, batch); refresh(r.status); setUndo(null); setHistConfirm(false); }
    catch (e) { if (!onConflict(e)) setSaveErr("دسترسی ذخیره نشد. چیزی تغییر نکرد."); } finally { setSaving(false); }
  };

  const step = view === "step1" ? 1 : view === "step2" ? 2 : view === "step3" ? 3 : 0;
  const Steps = step ? (
    <div className="pgac-steps" aria-hidden="true">
      <div className="pgac-labs">{["نوع", "چه کسی", "چه سطحی"].map((l, i) => <span key={l} className={i + 1 === step ? "on" : i + 1 < step ? "done" : ""}>{l}</span>)}</div>
      <div className="pgac-segs">{[1, 2, 3].map((n) => <i key={n} className={n === step ? "on" : n < step ? "done" : ""} />)}</div>
    </div>
  ) : null;

  let body: ReactNode = null; let foot: ReactNode = null;
  if (page.grantable === "never") {
    body = <div className="pgac-never"><div className="ico"><Lock className="pgac-i" aria-hidden="true" /></div><p>دسترسی این صفحه فقط برای ادمین است و قابل‌اعطا نیست. ادمین و مدیر فروش همیشه این صفحه را می‌بینند و نمی‌توان آن را به نقش یا فرد دیگری داد.</p></div>;
    foot = <button type="button" className="pgac-btn gh" onClick={onClose}>فهمیدم</button>;
  } else if (view === "status") {
    if (st.isLoading) body = <div aria-busy="true"><div className="pgac-sk" /><div className="pgac-sk" /><div className="pgac-sk" /></div>;
    else if (st.isError || !s) body = <div><div className="pgac-errbar" role="alert"><TriangleAlert className="pgac-i" aria-hidden="true" /><span>لیست را نتوانستیم بیاوریم.</span></div><button type="button" className="pgac-btn pri block" onClick={() => void st.refetch()}>دوباره امتحان کن</button></div>;
    else {
      const anyExtra = s.users.length > 0 || s.roles.some((r) => r.grant);
      body = (
        <div>
          {conflict ? <div className="pgac-conflict" role="status"><TriangleAlert className="pgac-i" aria-hidden="true" /><span>این لیست تغییر کرده، دوباره بارگذاری شد.</span></div> : null}
          {saveErr ? <div className="pgac-errbar" role="alert"><TriangleAlert className="pgac-i" aria-hidden="true" /><span>{saveErr}</span></div> : null}
          {s.roles.length ? (
            <div className="pgac-sec"><h3>نقش‌ها</h3>
              {s.roles.map((r) => (
                <div className="pgac-row" key={r.slug} data-testid={`pa-role-${r.slug}`}>
                  <div className="pgac-who"><b>{r.name} <span className={`pgac-src ${r.grant ? "direct" : "role"}`}>{r.grant ? "اعطا شده" : "پیش‌فرض نقش"}</span></b>
                    <p>{fa(r.members)} نفر · برای تغییر، یک نفر را مستثنا کن</p></div>
                  {r.grant ? (confirmRow === r.grant.id ? null : <div className="pgac-row-acts"><span className="pgac-lvl">{LEVEL_FA[r.grant.level]}</span><button type="button" className="pgac-btn danger" onClick={() => setConfirmRow(r.grant!.id)}>برداشتن دسترسی</button></div>)
                    : <div className="pgac-lvl">{LEVEL_FA[r.default ?? "view"]}</div>}
                  {r.grant && confirmRow === r.grant.id ? <ConfirmLine text={`برداشتن دسترسی ${r.name} از این صفحه؟`} busy={saving} onNo={() => setConfirmRow(null)} onYes={() => void removeRow(r.grant!.id, r.name, false)} yes="برداشتن" /> : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="pgac-sec"><h3>کاربران</h3>
            {s.always.map((u) => (
              <div className="pgac-row locked" key={`a${u.id}`}>
                <div className="pgac-who"><b>{u.name} <Cid id={u.id} /><span className="pgac-src">همیشه</span></b><p>{u.role === "sales_manager" ? "مدیر فروش" : "ادمین"} · این دسترسی برداشته نمی‌شود</p></div>
                <div className="pgac-lvl">{viewOnly ? LEVEL_FA.view : LEVEL_FA.manage}</div>
              </div>
            ))}
            {s.users.map((u) => u.kind === "granted" ? (
              <div className="pgac-row" key={`g${u.id}`} data-testid={`pa-user-${u.id}`}>
                <div className="pgac-who"><b>{u.name} <Cid id={u.id} /><span className="pgac-src direct">اعطا شده</span></b>
                  <p>اعطا شده توسط {u.by}، {jDay(u.at)} · {u.roleName} · {LEVEL_FA[u.level ?? "view"]}{u.scope ? ` · ${SCOPE_FA[u.scope]?.[2] ?? ""}` : ""}</p></div>
                {confirmRow === u.rowId ? <ConfirmLine text={`برداشتن دسترسی ${u.name} از این صفحه؟`} busy={saving} onNo={() => setConfirmRow(null)} onYes={() => void removeRow(u.rowId!, u.name, false)} yes="برداشتن" />
                  : <div className="pgac-row-acts"><button type="button" className="pgac-btn danger" onClick={() => setConfirmRow(u.rowId!)}>برداشتن دسترسی</button></div>}
              </div>
            ) : (
              <div className="pgac-row blocked" key={`b${u.id}`} data-testid={`pa-user-${u.id}`}>
                <div className="pgac-who"><b>{u.name} <Cid id={u.id} /><span className="pgac-src block">بسته شده</span></b><p>بسته شده توسط {u.by}، {jDay(u.at)} · این بستن، نقش را هم کنار می‌زند</p></div>
                <div className="pgac-row-acts"><button type="button" className="pgac-btn gh" disabled={saving} onClick={() => void removeRow(u.rowId!, u.name, true)}>باز کردن</button></div>
              </div>
            ))}
          </div>
          {!anyExtra ? <div className="pgac-empty"><div className="ico"><ShieldCheck className="pgac-i" aria-hidden="true" /></div><h3>هنوز دسترسی ویژه‌ای ندادی</h3><p>ادمین و مدیر فروش همیشه این صفحه را می‌بینند. بقیه از طریق نقش‌شان می‌بینند.</p></div> : null}
        </div>
      );
      foot = <><button type="button" className="pgac-btn gh" onClick={() => { setConflict(false); setView("history"); }}>سابقه‌ی تغییرات</button><button type="button" className="pgac-btn pri" onClick={() => { setConflict(false); reset(); setView("step1"); }} data-testid="pa-grant">دسترسی دادن</button></>;
    }
  } else if (view === "step1") {
    body = (
      <div>
        <div className="pgac-tiles">
          <button type="button" className="pgac-tile" aria-pressed={mode === "role"} onClick={() => { setMode("role"); setUsers([]); setView("step2"); }}><span className="ic"><Users className="pgac-i" aria-hidden="true" /></span><span className="tx"><b>یک نقش</b><span>همه‌ی افراد این نقش، مثلاً ۶ کارشناس</span></span></button>
          <button type="button" className="pgac-tile" aria-pressed={mode === "user"} onClick={() => { setMode("user"); setRole(null); setView("step2"); }} data-testid="pa-tile-user"><span className="ic"><User className="pgac-i" aria-hidden="true" /></span><span className="tx"><b>یک کاربر</b><span>فقط همان یک نفر، یا چند نفر با هم</span></span></button>
        </div>
        <button type="button" className="pgac-block-link" onClick={() => { setMode("block"); setUsers([]); setView("step2"); }}><Ban className="pgac-i" aria-hidden="true" />بستن این صفحه برای یک نفر</button>
      </div>
    );
    foot = <button type="button" className="pgac-btn gh" onClick={() => setView("status")}>قبلی</button>;
  } else if (view === "step2") {
    const note = <p className="pgac-note">ادمین‌ها و مدیر فروش در این فهرست نیستند؛ آن‌ها همیشه به همه‌ی صفحه‌ها دسترسی دارند.</p>;
    if (subj.isLoading) body = <div aria-busy="true">{note}<div className="pgac-sk" /><div className="pgac-sk" /><div className="pgac-sk" /></div>;
    else if (subj.isError || !subj.data) body = <div><div className="pgac-errbar" role="alert"><TriangleAlert className="pgac-i" aria-hidden="true" /><span>لیست را نتوانستیم بیاوریم.</span></div><button type="button" className="pgac-btn pri block" onClick={() => void subj.refetch()}>دوباره امتحان کن</button></div>;
    else if (mode === "role") {
      body = <div>{note}<div className="pgac-pick" role="radiogroup">
        {subj.data.roles.map((r) => (
          <button type="button" key={r.slug} role="radio" aria-checked={role === r.slug} className={`pgac-pick-item${role === r.slug ? " on" : ""}${r.has ? " has" : ""}`} onClick={() => setRole(r.slug)}>
            <span className="pgac-ava" aria-hidden="true">{r.name.slice(0, 1)}</span>
            <span className="tx"><b>{r.name}</b><span className="sub">{fa(r.members)} نفر</span></span>
            {r.has ? <span className="pgac-mark">از قبل دارد</span> : null}
          </button>
        ))}</div></div>;
    } else {
      const single = mode === "block";
      const list = subj.data.users.filter((u) => !q.trim() || u.name.includes(q.trim()) || fa(u.id).includes(fa(q.trim())) || String(u.id) === q.trim());
      body = <div>{note}
        <div className="pgac-srch"><Search className="pgac-i" aria-hidden="true" /><input type="search" placeholder="جست‌وجوی نام" value={q} onChange={(e) => setQ(e.target.value)} aria-label="جست‌وجوی نام" /></div>
        <div className="pgac-pick" role={single ? "radiogroup" : "group"}>
          {list.map((u) => {
            const on = users.includes(u.id);
            return (
              <div key={u.id} style={{ display: "contents" }}>
                <button type="button" role={single ? "radio" : "checkbox"} aria-checked={on} className={`pgac-pick-item${on ? " on" : ""}${u.has ? " has" : ""}`} data-testid={`pa-pick-${u.id}`}
                  onClick={() => setUsers(single ? [u.id] : on ? users.filter((x) => x !== u.id) : [...users, u.id])}>
                  <span className="pgac-check" aria-hidden="true">{on ? <Check size={14} /> : null}</span>
                  <span className="pgac-ava" aria-hidden="true">{u.name.slice(0, 1)}</span>
                  <span className="tx"><b>{u.name} <Cid id={u.id} /></b><span className="sub">{u.roleName}{u.trainee ? " · کارآموز" : ""}</span></span>
                  {u.blocked ? <span className="pgac-mark">بسته شده</span> : u.has ? <span className="pgac-mark">از قبل دارد</span> : u.fromRole ? <span className="pgac-mark">از نقش</span> : null}
                </button>
                {u.locked && on && !single ? <div className="pgac-warn lock"><Lock className="pgac-i" aria-hidden="true" /><span>این فرد الان در «محدودیت کارشناس» است. تا وقتی این محدودیت روشن است، این دسترسی برای او باز نمی‌شود و همه‌ی محدودیت‌ها سر جایشان می‌مانند.</span></div> : null}
                {u.trainee && !single ? <div className="pgac-warn"><TriangleAlert className="pgac-i" aria-hidden="true" /><span>کارآموز را فقط با انتخاب خودش می‌شود به این صفحه راه داد؛ با انتخاب نقش کارشناس فروش برای او باز نمی‌شود.</span></div> : null}
              </div>
            );
          })}
        </div></div>;
    }
    const can = mode === "role" ? Boolean(role) : users.length > 0;
    foot = <><button type="button" className="pgac-btn gh" onClick={() => setView("step1")}>قبلی</button><button type="button" className="pgac-btn pri" disabled={!can} onClick={() => (mode === "block" ? (setSaveErr(null), setView("step3")) : enterStep3())} data-testid="pa-next">ادامه</button></>;
  } else if (view === "step3") {
    if (mode === "block") {
      body = <div>
        {saveErr ? <div className="pgac-errbar" role="alert"><TriangleAlert className="pgac-i" aria-hidden="true" /><span>{saveErr}</span></div> : null}
        <div className="pgac-errbar"><Ban className="pgac-i" aria-hidden="true" /><span>با بستن صفحه، حتی اگر نقشش آن را باز کند، برای او بسته می‌ماند. این کار نقش بقیه را عوض نمی‌کند.</span></div>
        <div className="pgac-summary" data-pa-summary>{summary()}</div></div>;
      foot = <><button type="button" className="pgac-btn gh" disabled={saving} onClick={() => setView("step2")}>قبلی</button><button type="button" className="pgac-btn danger" disabled={saving} onClick={() => void apply()}>{saving ? <><span className="pgac-spinner" aria-hidden="true" />در حال اعمال…</> : "بستن صفحه"}</button></>;
    } else {
      body = <div>
        {saveErr ? <div className="pgac-errbar" role="alert"><TriangleAlert className="pgac-i" aria-hidden="true" /><span>{saveErr}</span></div> : null}
        <div className="pgac-levels" role="radiogroup" aria-label="چه سطحی">
          <LevelBtn on={level === "view"} onClick={() => setLevel("view")} title="فقط دیدن" text={viewOnly ? "محتوا و قالب‌ها تغییر نمی‌کنند. این صفحه فقط برای مشاهده است." : "صفحه باز می‌شود؛ چیزی را تغییر نمی‌دهد."} />
          {viewOnly ? null : <LevelBtn on={level === "manage"} onClick={() => setLevel("manage")} title="دیدن و کار کردن" text="همان کارهایی که این صفحه برای کارشناس‌ها دارد." testid="pa-level-manage" />}
        </div>
        {scopeOn ? <><h3 className="pgac-scope-h">کدام مشتری‌ها؟</h3><div className="pgac-levels" role="radiogroup" aria-label="کدام مشتری‌ها؟">
          {(["own", "team", "all"] as const).map((k) => <LevelBtn key={k} on={scope === k} onClick={() => setScope(k)} title={SCOPE_FA[k]![0]} text={SCOPE_FA[k]![1]} />)}
        </div></> : null}
        <div className="pgac-summary" data-pa-summary>{summary()}</div></div>;
      foot = <><button type="button" className="pgac-btn gh" disabled={saving} onClick={() => setView("step2")}>قبلی</button><button type="button" className="pgac-btn pri" disabled={saving} onClick={() => void apply()} data-testid="pa-apply">{saving ? <><span className="pgac-spinner" aria-hidden="true" />در حال اعمال…</> : "تأیید و اعمال"}</button></>;
    }
  } else if (view === "success") {
    body = <div className="pgac-ok" role="status"><div className="big"><CircleCheck size={32} aria-hidden="true" /></div><h3>{mode === "block" ? "صفحه بسته شد" : "دسترسی داده شد"}</h3><p>{done}</p></div>;
    foot = <button type="button" className="pgac-btn pri" onClick={() => { reset(); setView("status"); }}>بستن</button>;
  } else if (view === "history") {
    const items = hist.data?.items ?? [];
    if (hist.isLoading) body = <div aria-busy="true"><div className="pgac-sk" /><div className="pgac-sk" /></div>;
    else if (hist.isError) body = <div><div className="pgac-errbar" role="alert"><TriangleAlert className="pgac-i" aria-hidden="true" /><span>لیست را نتوانستیم بیاوریم.</span></div><button type="button" className="pgac-btn pri block" onClick={() => void hist.refetch()}>دوباره امتحان کن</button></div>;
    else if (!items.length) body = <div className="pgac-empty"><div className="ico"><HistoryIcon className="pgac-i" aria-hidden="true" /></div><h3>هنوز تغییری ثبت نشده</h3></div>;
    else {
      const rb = hist.data!.revertBatch; const firstIdx = items.findIndex((x) => x.batch === rb);
      body = <div className="pgac-hist">
        {saveErr ? <div className="pgac-errbar" role="alert"><TriangleAlert className="pgac-i" aria-hidden="true" /><span>{saveErr}</span></div> : null}
        {items.map((it, i) => (
          <div className="pgac-hitem" key={it.id}>
            <div className="dotcol"><i className="dot" /><i className="line" /></div>
            <div className="body">
              <b>{histHead(it)}</b>
              <span>{page.label} · {histWhat(it)} · {jFull(it.at)}{it.reverted ? " · برگردانده شد" : ""}</span>
              {rb && i === firstIdx ? (histConfirm
                ? <div className="pgac-confirm"><p>آخرین تغییر برگردانده شود؟ {revertText(it)}</p><div className="pgac-rowbtns"><button type="button" className="pgac-btn gh" onClick={() => setHistConfirm(false)}>انصراف</button><button type="button" className="pgac-btn danger" disabled={saving} onClick={() => void revert(rb)} data-testid="pa-revert-yes">برگردان</button></div></div>
                : <div className="hist-act"><button type="button" className="pgac-btn gh" onClick={() => setHistConfirm(true)} data-testid="pa-revert">برگرداندن این تغییر</button></div>) : null}
            </div>
          </div>
        ))}</div>;
    }
    foot = <button type="button" className="pgac-btn gh" onClick={() => { setHistConfirm(false); setSaveErr(null); setView("status"); }}>بازگشت</button>;
  }

  return (
    <div className="pgac-root pgac-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pgac-sheet" role="dialog" aria-modal="true" aria-labelledby="pgac-title" data-testid="pa-sheet">
        <div className="pgac-hd"><h2 id="pgac-title">{title}</h2><button type="button" ref={closeRef} className="pgac-close" aria-label="بستن" onClick={onClose}><X className="pgac-i" aria-hidden="true" /></button></div>
        {Steps}
        <div className="pgac-bd">{body}</div>
        {undo && view === "status" ? <div className="pgac-undo" role="status"><span>{undo.text}</span><button type="button" onClick={() => void revert(undo.batch)}>برگردان</button></div> : null}
        {foot ? <div className="pgac-ft">{foot}</div> : null}
      </div>
    </div>
  );
}

function ConfirmLine({ text, onNo, onYes, yes, busy }: { text: string; onNo: () => void; onYes: () => void; yes: string; busy: boolean }) {
  return <div className="pgac-confirm"><p>{text}</p><div className="pgac-rowbtns"><button type="button" className="pgac-btn gh" onClick={onNo}>انصراف</button><button type="button" className="pgac-btn danger" disabled={busy} onClick={onYes}>{yes}</button></div></div>;
}
function LevelBtn({ on, onClick, title, text, testid }: { on: boolean; onClick: () => void; title: string; text: string; testid?: string }) {
  return <button type="button" className="pgac-level" role="radio" aria-checked={on} aria-pressed={on} onClick={onClick} data-testid={testid}><span className="pgac-radio" aria-hidden="true" /><span className="tx"><b>{title}</b><span>{text}</span></span></button>;
}
const subjectNode = (it: PaHistoryItem) => <>{it.subjectName} {it.subjectKind === "user" ? <Cid id={it.subjectId} /> : null}</>;
function histHead(it: PaHistoryItem): ReactNode {
  switch (it.action) {
    case "grant": case "update": return <>{it.actor} · به {subjectNode(it)}</>;
    case "revoke": return <>{it.actor} · برداشتن دسترسی {subjectNode(it)}</>;
    case "block": return <>{it.actor} · بستن صفحه برای {subjectNode(it)}</>;
    case "unblock": return <>{it.actor} · باز کردن صفحه برای {subjectNode(it)}</>;
    default: return <>{it.actor} · برگرداندن تغییر {subjectNode(it)}</>;
  }
}
function histWhat(it: PaHistoryItem): string {
  if (it.action === "revoke") return "دسترسی برداشته شد";
  if (it.action === "block") return "بسته شد";
  if (it.action === "unblock") return "باز شد";
  if (it.action === "revert") return "تغییر قبلی برگشت";
  return `${it.levelFa ?? ""}${it.scope ? ` · ${SCOPE_FA[it.scope]?.[2] ?? ""}` : ""}`;
}
function revertText(it: PaHistoryItem): string {
  switch (it.action) {
    case "block": return `بستن صفحه برای ${it.subjectName} برداشته می‌شود و او دوباره از راه نقشش این صفحه را می‌بیند.`;
    case "grant": return `دسترسی ${it.subjectName} از این صفحه برداشته می‌شود.`;
    case "update": return `سطح دسترسی ${it.subjectName} به حالت قبل برمی‌گردد.`;
    case "revoke": return `دسترسی ${it.subjectName} دوباره برقرار می‌شود.`;
    case "unblock": return `صفحه دوباره برای ${it.subjectName} بسته می‌شود.`;
    default: return "";
  }
}
