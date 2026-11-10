/** Armita daily-customer-inline v1.1 — rendered in the existing sales shell. Flag-on Today page only. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { promoteToP1 } from "@/features/history/api";
import { useVcMe, vcApi } from "@/features/voip-call/api";
import { DciError, dciApi, useDciAddNote, useDciBoard, useDciToday, type DciBoard, type DciCase, type DciDenied, type DciHist, type DciInbound, type DciNote, type DciTask } from "./api";
import { DciIcon, DciSprites } from "./icons";
import "./dci.css";

const FD = "۰۱۲۳۴۵۶۷۸۹";
const fa = (n: string | number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "٬").replace(/[0-9]/g, (d) => FD[Number(d)]);
const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);

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

function CreditBlock({ state, grade, at }: { state: DciBoard["credit"]["state"]; grade: string | null; at: string | null }) {
  if (state === "err") return <div className="dci-consent"><p className="dci-empty">استعلام الآن انجام نشد.</p><button className="btn pri" type="button" disabled>تلاش دوباره</button></div>;
  if (state === "start" || state === "none") return <div className="dci-consent">
    <p className="dci-empty">رتبه هنوز استعلام نشده است.</p>
    {state === "start" ? <CreditStart /> : null}
  </div>;
  return <div className="dci-consent"><span className="dci-grade" dir="ltr">{grade || "—"}</span>
    {at ? <p className="dci-empty">استعلام‌شده در {at.replace(/، ساعت.*/, "")}</p> : <p className="dci-empty">استعلام شده است.</p>}
  </div>;
}
function CreditStart() {
  const [ok, setOk] = useState(false);
  return <>
    <label><input type="checkbox" id="dci-ok" checked={ok} onChange={(e) => setOk(e.target.checked)} />رضایت مشتری برای استعلام اعتبار ثبت شد.</label>
    <button className="btn pri" type="button" id="dci-ics" disabled={!ok}>شروع اعتبارسنجی</button>
  </>;
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

function FirstCall() {
  const [step, setStep] = useState(1);
  const [g, setG] = useState<"yes" | "no" | "">("");
  return <div className="dci-fc" id="dci-fc" data-step={step}>
    <p className="dci-step">مرحله‌ی <span id="dci-sn">{fd(step)}</span> از {fd(3)}</p>
    <div className="dci-fstep" data-n="1" hidden={step !== 1}>
      <label>کد ملی <input dir="ltr" inputMode="numeric" autoComplete="off" placeholder="—" /></label>
      <label>شهر <input autoComplete="off" placeholder="—" /></label>
    </div>
    <div className="dci-fstep" data-n="2" hidden={step !== 2}>
      <label>مبلغ درخواستی، تومان <input dir="ltr" inputMode="numeric" autoComplete="off" placeholder="—" /></label>
      <label>شرح نیاز <input autoComplete="off" placeholder="—" /></label>
    </div>
    <div className="dci-fstep" data-n="3" hidden={step !== 3}>
      <p className="dci-empty" style={{ margin: 0 }}>ضامن</p>
      <div className="dci-choice" role="radiogroup" aria-label="ضامن">
        <button type="button" role="radio" aria-checked={g === "yes"} data-g="yes" onClick={() => setG("yes")}>ضامن دارد</button>
        <button type="button" role="radio" aria-checked={g === "no"} data-g="no" onClick={() => setG("no")}>ضامن ندارد</button>
      </div>
      <label id="dci-gcond" hidden={g !== "yes"}>شرایط ضامن <input autoComplete="off" placeholder="مثلاً چک ضامن" /></label>
    </div>
    <div className="dci-acts">
      <button className="btn gh" type="button" id="dci-prev" hidden={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>قبلی</button>
      <button className="btn pri" type="button" id="dci-next" onClick={() => setStep((s) => Math.min(3, s + 1))}>{step === 3 ? "پایان" : "بعدی"}</button>
    </div>
  </div>;
}

function CaseCard({ f }: { f: DciCase }) {
  return <article className="dci-case" data-case={f.id}>
    <div className="dci-crow"><span className="dci-chip">پرونده #{fd(f.id)}</span><span className="dci-chip">{f.status}</span></div>
    <h3>طرح {f.plan}</h3>
    <p>{f.amount ? <>{fa(f.amount)} تومان {f.months ? <span style={{ color: "var(--nf-ink-muted)" }}>برای {fd(f.months)} ماه</span> : null}</> : null}</p>
    <Link className="btn pri" href={f.href}>{f.act}</Link>
  </article>;
}

function CasesBlock({ rows, href }: { rows: DciCase[]; href: string }) {
  return <>
    {rows.length ? <div className="dci-cases">{rows.map((f) => <CaseCard key={f.id} f={f} />)}</div> : null}
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

function MidCol({ m, ext, narrow, onCopy, onCall, onResult, onPromote, promoting }: {
  m: DciBoard; ext: boolean; narrow: boolean; onCopy: (v: string) => void; onCall: () => void; onResult: () => void;
  onPromote: () => void; promoting: boolean;
}) {
  const tags = (m.customer.tags || []).map((x) => <span key={x}>{x}</span>);
  const prio = m.prio
    ? <div className="dci-prio"><span className="dci-prio-on">اولویت ۱</span></div>
    : (m.canPromote ? <div className="dci-prio"><button className="btn gh" type="button" disabled={promoting} onClick={onPromote}>ارتقا به اولویت ۱</button></div> : null);
  const nid = m.customer.nationalCode
    ? <span><span className="lbl">کد ملی</span> <b dir="ltr">{fd(m.customer.nationalCode)}</b></span>
    : <span><span className="lbl">کد ملی</span> هنوز ثبت نشده است</span>;
  return <section className="dci-col dci-mid" aria-label="اطلاعات تماس و پرونده‌ها">
    <div className="dci-head">
    <p className="dci-cur">{m.call}</p>
    <div className="dci-who"><h2>{m.customer.name}</h2> {cidBtn(m.customer.id, onCopy)}</div>
    <div className="dci-idrow">{m.customer.phone ? <Phone raw={m.customer.phone} big={!ext} onCopy={onCopy} /> : null}{nid}</div>
    <div className="dci-tags">{tags}</div>
    {prio}
    <CallActs ext={ext} place="head" narrow={narrow} onCall={onCall} onResult={onResult} />
    </div>
    <CasesBlock rows={m.cases} href={m.newCaseHref} />
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

function LeftCol({ m }: { m: DciBoard }) {
  const fileInner = m.first
    ? <><div className="dci-block"><h3>رتبه‌ی اعتباری</h3><CreditBlock state={m.credit.state} grade={m.credit.grade} at={m.credit.at} /></div>
        <div className="dci-block"><h3>تکمیل پرونده در تماس اول</h3><FirstCall /></div></>
    : <><div className="dci-block"><h3>رتبه‌ی اعتباری</h3><CreditBlock state={m.credit.state} grade={m.credit.grade} at={m.credit.at} /></div>
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
  const vme = useVcMe().data;
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
  const startCall = () => {
    if (!customerId) return;
    if (ext) void vcApi.start({ customerId }).catch(() => undefined);
  };
  const startResult = () => { /* existing after-call / result form is unchanged; button records intent only on this page */ startCall(); };
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
      <MidCol m={board} ext={ext} narrow={narrow} onCopy={copy} onCall={startCall} onResult={startResult} onPromote={() => setReasonOpen(true)} promoting={promoting} />
      <div className="dci-tabs" role="tablist" aria-label="بخش‌های دیگر">
        <button type="button" role="tab" id="tab-talk" aria-selected={tab === "talk" ? "true" : "false"} data-pane="talk"
          onClick={() => setTab((t) => t === "talk" ? "" : "talk")}>گفت‌وگو</button>
        <button type="button" role="tab" id="tab-file" aria-selected={tab === "file" ? "true" : "false"} data-pane="file"
          onClick={() => setTab((t) => t === "file" ? "" : "file")}>پرونده</button>
      </div>
      <LeftCol m={board} />
    </div>;
  }

  return <div className="dci" data-testid="dci-page">
    <DciSprites />
    <main className="pg dci-page">
      <p className="dci-date">{todayQ.data?.dateLabel ?? ""}</p>
      <h1>کارهای امروز من</h1>
      <Timeline tasks={tasks} selected={selectedTask?.id ?? null} onPick={setSel} />
      {boardEl}
      {sticky && board ? <div className="dci-sticky"><CallActs ext={ext} place="sticky" narrow={narrow} onCall={startCall} onResult={startResult} /></div> : null}
      {reasonOpen && customerId ? <div className="dci-prio" style={{ marginTop: 12 }}>
        <label htmlFor="dci-p1r">دلیل ارتقا</label>
        <textarea id="dci-p1r" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="دلیل ارتقا به اولویت ۱" />
        <button className="btn pri" type="button" disabled={promoting || !reason.trim()} onClick={() => void doPromote()}>ثبت ارتقا</button>
        <button className="btn gh" type="button" onClick={() => setReasonOpen(false)}>انصراف</button>
      </div> : null}
    </main>
    <div className={`toast dci-toast${toast ? " on" : ""}`} id="ph-toast" role="status" aria-live="polite">{toast}</div>
  </div>;
}
