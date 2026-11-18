/** DCI-QUEUE 440000 — Armita «کارهای امروز من» v2.1–v2.3.1: four blocks, seven kinds, filter chips in the «اکنون» row,
 *  interrupts, number-type auto-detect, «زودتر از نوبت». Behind flag.dci_queue_v21 (server); OFF → GET /queue 404 → v2.0 timeline. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { DciIcon } from "./icons";

const FD = "۰۱۲۳۴۵۶۷۸۹";
const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
const fa = (n: string | number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "٬").replace(/[0-9]/g, (d) => FD[Number(d)]);

export type DqKind = "incoming_call" | "outgoing_call" | "new_lead" | "follow_up" | "reminder" | "file_action" | "payment_order";
export type DqItem = {
  id: string; kind: DqKind; kinds: DqKind[]; block: "actual" | "potential"; blockIdx: number; urgent: boolean; done: boolean; due: boolean;
  due_at: string | null; timed: boolean; done_at: string | null; done_early: boolean; customer_id: number | null; name: string; tm: string;
  overdue: boolean; current: boolean; next: boolean; turn: number; due_ref: string | null;
  /** «فضای کار بله» (flag.bale_workspace_v1): «بی‌پاسخ در بله» on the customer's row after a no-reply hand-off today (new row or one
   *  already on the list); tagAt = «۱۳:۱۰», tagReason = «پیام بله بی‌پاسخ ماند · امروز ۱۳:۱۰». Absent otherwise. */
  tag?: string; tagAt?: string; tagReason?: string;
  itemId: number | null; dpStatus: string | null; reminderId: number | null; remText: string | null; call_id: number | null; live: boolean;
  direction: "in" | "out" | null; detected: "customer" | "lead" | "unknown" | null; payment_order_id: number | null; loan_file_id: number | null;
  pay: { id: number; amountToman: string; planName: string | null; createdAt: string; stage: string } | null;
  fileAct: { fileId: number; stage: string; stageLabel: string; planName: string | null; need: string } | null;
  fileTask: { fileId: number; stage: string; stageLabel: string } | null; phone: string | null;
  /** 450000 B7: `phone` is the full number only when phone_full (viewer may see phones); phone_masked always for an unknown number. */
  phone_masked?: string | null; phone_full?: boolean;
  /** 450000 Q20: early «جواب نداد» / «خاموش یا اشغال» attempts today (the task stayed open). */
  attempts?: number;
};
export type DqBlock = { k: "actual" | "potential"; from: string; to: string; fromIso: string };
export type DqQueue = { enabled: true; hasExtension: boolean; date: string; now: string; nowBlock: number; refBlock: number; inHours: boolean;
  blocks: DqBlock[]; items: DqItem[]; counts: Record<DqKind, number>; openCount: number; currentId: string | null;
  /** 450000 §7: urgent window (min) and grouping threshold; incomingGroup = more than groupOver urgent incoming calls. */
  urgentInMin?: number; groupOver?: number; incomingGroup?: { count: number; ids: string[]; newestId: string } | null };
/** Q20: on an early-opened task these two results record only the attempt; the task stays open until its turn. */
export const DQ_ATTEMPT_RESULTS = ["no_answer", "off_or_busy"] as const;

export const KIND_FA: Record<DqKind, string> = { incoming_call: "تماس ورودی", outgoing_call: "تماس خروجی", new_lead: "لید تازه", follow_up: "پیگیری", reminder: "یادآور", file_action: "اقدام پرونده", payment_order: "دستور پرداخت" };
const KIND_SHORT: Record<DqKind, string> = { incoming_call: "ورودی", outgoing_call: "خروجی", new_lead: "لید", follow_up: "پیگیری", reminder: "یادآور", file_action: "پرونده", payment_order: "پرداخت" };
export const KIND_CLS: Record<DqKind, string> = { incoming_call: "k-in", outgoing_call: "k-out", new_lead: "k-lead", follow_up: "k-fu", reminder: "k-rem", file_action: "k-file", payment_order: "k-pay" };
const KIND_ORDER: DqKind[] = ["incoming_call", "outgoing_call", "new_lead", "follow_up", "reminder", "file_action", "payment_order"];
const BLK_FA = { actual: "بالفعل", potential: "بالقوه" } as const;
const DETECT_FA = { customer: "مشتری موجود", lead: "لید شناخته‌شده", unknown: "شماره‌ی ناشناس" } as const;
const hh = (v: string) => { const [h, m] = v.split(":"); return m === "00" ? fd(Number(h)) : fd(`${Number(h)}:${m}`); };

export async function dqReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/daily-customer-inline${path}`, { method, credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) { const e: any = new Error((data && data.message) || "انجام نشد. دوباره تلاش کنید."); e.status = res.status; e.body = data; throw e; }
  return data as T;
}
export const DQ_KEY = ["dci-queue"] as const;
/** null = flag OFF (404 dq_off) → the page keeps the v2.0 timeline. */
export function useDqQueue(enabled = true) {
  return useQuery<DqQueue | null>({
    queryKey: DQ_KEY, enabled, retry: false, staleTime: 10_000, refetchInterval: 15_000,
    queryFn: () => dqReq<DqQueue>("GET", "/queue").catch((e) => { if (e?.status === 404) return null; throw e; }),
  });
}
export const dqApi = {
  done: (taskId: string, dueRef: string | null, outcome?: string | null) => dqReq<{ ok: true; done_early: boolean }>("POST", "/queue/done", { taskId, dueRef, outcome }),
  outgoing: (customerId: number) => dqReq<{ ok: true; taskId: string; created: boolean }>("POST", "/queue/outgoing", { customerId }),
  nameUnknown: (eventId: number, firstName: string, lastName: string) => dqReq<{ ok: true; customerId: number; taskId: string; name: string }>("POST", `/queue/unknown/${eventId}/name`, { firstName, lastName }),
};

export function kindLabel(it: Pick<DqItem, "kind" | "kinds">): string {
  const ks = it.kinds?.length ? it.kinds : [it.kind];
  const main = KIND_FA[it.kind];
  const rest = ks.filter((k) => k !== it.kind).map((k) => KIND_FA[k]);
  return rest.length ? `${main} و ${rest.join(" و ")}` : main;
}

function Funnel() { return <svg className="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>; }
export function ClockI() { return <svg className="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>; }
export function AlertI() { return <svg className="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.8 2.6 20.2h18.8L12 3.8z" /><path d="M12 9.5v5.2M12 17.4v.6" /></svg>; }

function FChip({ k, q, flt, sheet, onPick }: { k: DqKind | ""; q: DqQueue; flt: DqKind | ""; sheet?: boolean; onPick: (k: DqKind | "") => void }) {
  const on = k ? flt === k : !flt;
  const lab = k ? KIND_FA[k] : "همه";
  const vis = k && !sheet ? KIND_SHORT[k] : lab;
  const n = k ? (q.counts[k] ?? 0) : q.openCount;
  return <button type="button" className={`dci-fchip ${k ? KIND_CLS[k] : "is-all"}`} aria-pressed={on} aria-label={`${lab}، ${fd(n)} کار باز`}
    title={sheet ? undefined : lab} data-flt={k} data-testid={`dq-f-${k || "all"}${sheet ? "-s" : ""}`} onClick={() => onPick(on && k ? "" : k)}>
    {k ? <span className="dci-ldot" aria-hidden="true" /> : null}<span>{vis}</span><span className="dci-fn" aria-hidden="true">{fd(n)}</span>
  </button>;
}

/** Block separators + coloured nodes. «جاری» / «بعدی» / «زودتر از نوبت» per §0.13. */
export function DqStrip({ q, openId, flt, setFlt, onPick }: { q: DqQueue; openId: string | null; flt: DqKind | ""; setFlt: (k: DqKind | "") => void; onPick: (it: DqItem) => void }) {
  const rail = useRef<HTMLElement | null>(null);
  const nodeRef = useRef<HTMLAnchorElement | null>(null);
  const [fade, setFade] = useState<"none" | "start" | "end" | "both">("none");
  const [can, setCan] = useState({ start: false, end: false });
  const [sheet, setSheet] = useState(false);
  const sheetBtn = useRef<HTMLButtonElement | null>(null);
  const sync = () => {
    const el = rail.current; if (!el) return;
    const max = el.scrollWidth - el.clientWidth, abs = Math.abs(el.scrollLeft), has = max > 4, atStart = abs < 8, atEnd = Math.max(0, max - abs) < 8;
    setCan({ start: has && !atStart, end: has && !atEnd }); setFade(!has ? "none" : atStart ? "end" : atEnd ? "start" : "both");
  };
  useEffect(() => {
    const el = rail.current; if (!el) return; sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null; ro?.observe(el);
    window.addEventListener("resize", sync);
    return () => { el.removeEventListener("scroll", sync); ro?.disconnect(); window.removeEventListener("resize", sync); };
  }, [q.items.length, flt]);
  useEffect(() => { nodeRef.current?.scrollIntoView({ inline: "center", block: "nearest" }); }, [openId]);
  useEffect(() => {
    document.body.classList.toggle("fs-open", sheet);
    if (!sheet) return () => document.body.classList.remove("fs-open");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setSheet(false); sheetBtn.current?.focus(); } };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); document.body.classList.remove("fs-open"); };
  }, [sheet]);
  const go = (dir: "start" | "end") => {
    const el = rail.current; if (!el) return;
    const step = Math.max(160, el.clientWidth * 0.6);
    const sign = el.scrollLeft <= 0 ? (dir === "start" ? 1 : -1) : (dir === "start" ? -1 : 1);
    el.scrollBy({ left: sign * step, behavior: "smooth" });
  };
  const cur = q.items.find((x) => x.current) ?? null;
  const earlyMode = Boolean(openId && cur && openId !== cur.id);
  const ref = q.blocks[q.refBlock];
  const nx = q.inHours ? q.blocks[q.refBlock + 1] : null;
  const urgOut = flt ? q.items.filter((x) => x.urgent && !x.done && x.kind !== flt).length : 0;
  const nodes: ReactNode[] = [];
  let last = -1;
  // 450000 §7: more than groupOver urgent incoming calls → one «تماس‌های ورودی (n)» node where the first of them sits (no filter only;
  // the «ورودی» filter chip still counts and lists every call). Tapping it opens the newest.
  const grp = !flt && q.incomingGroup && q.incomingGroup.count > (q.groupOver ?? 2) ? q.incomingGroup : null;
  const inGrp = new Set(grp?.ids ?? []);
  let grpDone = false;
  for (const t of q.items) {
    if (flt && t.kind !== flt) continue;
    if (grp && inGrp.has(t.id)) {
      if (grpDone) continue;
      grpDone = true;
      const newest = q.items.find((x) => x.id === grp.newestId) ?? t;
      if (t.blockIdx !== last) {
        const b = q.blocks[t.blockIdx]; const now = q.inHours && t.blockIdx === q.nowBlock;
        nodes.push(<span key={`b-${t.blockIdx}`} className={`dci-blk${now ? " is-now" : ""}`} role="presentation" data-testid={`dq-blk-${t.blockIdx}`}>
          <b>{now ? "اکنون" : BLK_FA[b.k]}</b><span>{now ? `${BLK_FA[b.k]}، ` : ""}{hh(b.from)} تا {hh(b.to)}</span></span>);
        last = t.blockIdx;
      }
      const isOpenG = Boolean(openId && inGrp.has(openId));
      const nextG = q.items.some((x) => inGrp.has(x.id) && x.next);
      nodes.push(<a key="dq-ingroup" ref={isOpenG ? nodeRef : undefined} data-id={newest.id} data-testid="dq-node-ingroup"
        className="dci-node k-in is-urgent dci-ingroup" href={`#${newest.id}`} aria-current={isOpenG ? "true" : undefined}
        aria-label={`تماس‌های ورودی، ${fd(grp.count)} تماس فوری؛ باز کردن تازه‌ترین: ${newest.name}`}
        onClick={(e) => { e.preventDefault(); onPick(newest); }}>
        <span className="dci-nord" aria-hidden="true">{nextG ? "بعدی" : fd(newest.turn)}</span>
        <span className="dci-dot" aria-hidden="true" />
        <b>تماس‌های ورودی ({fd(grp.count)})</b>
        <span className="dci-kind">فوری · تازه‌ترین: {fd(newest.name)}</span>
      </a>);
      continue;
    }
    if (t.blockIdx !== last) {
      const b = q.blocks[t.blockIdx]; const now = q.inHours && t.blockIdx === q.nowBlock;
      nodes.push(<span key={`b-${t.blockIdx}`} className={`dci-blk${now ? " is-now" : ""}`} role="presentation" data-testid={`dq-blk-${t.blockIdx}`}>
        <b>{now ? "اکنون" : BLK_FA[b.k]}</b><span>{now ? `${BLK_FA[b.k]}، ` : ""}{hh(b.from)} تا {hh(b.to)}</span></span>);
      last = t.blockIdx;
    }
    const isOpen = openId === t.id;
    const early = earlyMode && isOpen && !t.done && !t.urgent;
    const curMark = t.current && !t.done;
    const bits = [kindLabel(t)];
    if (t.tag) bits.push(t.tag); // «فضای کار بله»: «بی‌پاسخ در بله» (flag.bale_workspace_v1 hand-off only)
    if (t.overdue) bits.push("عقب‌افتاده");
    if (t.done) bits.push(t.done_early ? "زودتر انجام شد" : "انجام شد");
    else if (early) bits.push("زودتر از نوبت");
    else if (t.urgent) bits.push("فوری");
    const typ = bits.join(" · ");
    const nord = curMark ? "جاری" : (t.next && !t.done) ? "بعدی" : fd(t.turn);
    const al = ["نوبت " + fd(t.turn), t.name, typ, curMark ? "کار جاری" : "", t.next ? "بعدی" : "", t.tm].filter(Boolean).join("، ");
    nodes.push(<a key={t.id} ref={isOpen ? nodeRef : undefined} data-id={t.id} data-testid={`dq-node-${t.id}`}
      className={`dci-node ${KIND_CLS[t.kind]}${t.overdue ? " is-late" : ""}${t.done ? " is-done" : ""}${t.urgent && !t.done ? " is-urgent" : ""}${curMark && !isOpen ? " is-cur" : ""}${early ? " is-early" : ""}`}
      href={`#${t.id}`} aria-current={isOpen ? "true" : undefined} title={[t.tm, t.remText, t.tagReason].filter(Boolean).join(" — ") || undefined} aria-label={al}
      onClick={(e) => { e.preventDefault(); onPick(t); }}>
      <span className="dci-nord" aria-hidden="true">{nord}</span>
      <span className="dci-dot" aria-hidden="true" />
      <b>{fd(t.name)}</b>
      <span className="dci-kind">{typ}</span>
    </a>);
  }
  const fstate = flt ? <p className="dci-fstate" role="status" data-testid="dq-fstate"><span>فقط <b className={KIND_CLS[flt]}>{KIND_FA[flt]}</b>، {fd(q.counts[flt] ?? 0)} کار باز</span>
    {urgOut ? <span className="dci-furg">{fd(urgOut)} کار فوری از نوع دیگر پنهان است</span> : null}
    <button type="button" className="dci-fclear" onClick={() => setFlt("")} data-testid="dq-fclear">پاک کردن فیلتر</button></p> : null;
  return <div className="dci-q21" data-testid="dq-strip">
    <div className="dci-qhead" id="dci-qhead">
      <p className="dci-blknow" data-testid="dq-now">
        {q.inHours ? <span className="dci-blk-k">اکنون</span> : <span className="dci-blk-k">خارج از ساعت کاری</span>}
        {ref ? <><b>کارهای {BLK_FA[ref.k]}</b><span>ساعت {hh(ref.from)} تا {hh(ref.to)}</span></> : null}
        {nx ? <span className="dci-blk-nx">بعد: {BLK_FA[nx.k]} از ساعت {hh(nx.from)}</span> : null}
      </p>
      <button ref={sheetBtn} type="button" className={`dci-lg-btn${flt ? ` is-on ${KIND_CLS[flt]}` : ""}`} aria-haspopup="dialog" aria-expanded={sheet} aria-controls="dci-fsheet"
        onClick={() => setSheet(true)} data-testid="dq-kind-btn"><Funnel />{flt ? <><span className="dci-ldot" aria-hidden="true" />{KIND_FA[flt]}</> : "نوع کار"}</button>
      <div className="dci-lg" id="dci-lg" role="group" aria-label="فیلتر صف بر اساس نوع کار؛ رنگ هر نوع">
        {([""] as (DqKind | "")[]).concat(KIND_ORDER).map((k) => <FChip key={k || "all"} k={k} q={q} flt={flt} onPick={setFlt} />)}
      </div>
      <div id="dci-fst">{fstate}</div>
    </div>
    <div className="dci-tlw" data-fade={fade === "none" ? undefined : fade} data-testid="dci-tlw">
      <button className="dci-tl-btn" type="button" aria-label="کارهای راست" disabled={!can.start} onClick={() => go("start")}><DciIcon id="i-chev-r" /></button>
      <nav className="dci-tl" ref={rail} aria-label="صف کارهای امروز">
        {nodes.length ? nodes : flt
          ? <p className="dci-tl-empty">امروز کار «{KIND_FA[flt]}» در صف نیست. <button type="button" className="dci-fclear" onClick={() => setFlt("")}>نمایش همه</button></p>
          : <p className="dci-tl-empty">امروز کاری در صف نیست.</p>}
      </nav>
      <button className="dci-tl-btn" type="button" aria-label="کارهای چپ" disabled={!can.end} onClick={() => go("end")}><DciIcon id="i-chev-l" /></button>
    </div>
    <div className="dci-fscrim" onClick={() => setSheet(false)} />
    {/* 450000 §8: a filter sheet, not a form — data-nodnd keeps the assistant «مزاحم نشو» bar off (same marker as the VoIP sheets). */}
    <div className="dci-fsheet" id="dci-fsheet" role="dialog" aria-modal="true" aria-labelledby="dci-fs-t" hidden={!sheet} data-testid="dq-sheet" data-nodnd="">
      <div className="grab" aria-hidden="true" />
      <h3 id="dci-fs-t">نوع کار</h3>
      <p className="dci-fs-sub">با زدن هر نوع، فقط همان کارها در صف می‌ماند.</p>
      <div className="dci-fs-grid" role="group" aria-label="فیلتر نوع کار">
        {([""] as (DqKind | "")[]).concat(KIND_ORDER).map((k) => <FChip key={k || "all"} k={k} q={q} flt={flt} sheet onPick={(v) => { setFlt(v); setSheet(false); sheetBtn.current?.focus(); }} />)}
      </div>
      <button type="button" className="btn gh dci-fs-x" onClick={() => { setSheet(false); sheetBtn.current?.focus(); }}>بستن</button>
    </div>
  </div>;
}

/** §0.13 dashed bar above the mid card while a later task is open. */
export function DqEarlyBar({ q, it, cur, onBack }: { q: DqQueue; it: DqItem; cur: DqItem | null; onBack: () => void }) {
  const b = q.blocks[it.blockIdx];
  const other = it.blockIdx !== q.refBlock;
  return <div className={`dci-early ${KIND_CLS[it.kind]}`} id="dci-early" role="region" aria-label="کار زودتر از نوبت" data-testid="dq-early">
    <span className="dci-early-chip"><ClockI />زودتر از نوبت</span>
    <p>{it.timed && it.tm ? <><b>نوبت: ساعت {it.tm}</b>، بازه‌ی </> : <><b>نوبت: بازه‌ی </b></>}{BLK_FA[b.k]} {hh(b.from)} تا {hh(b.to)}{other ? " (بازه‌ی دیگر)" : ""}.
      {cur ? <> کار جاری سر جایش است: <b>{fd(cur.name)}</b>.</> : null}
      {it.attempts ? <> <span className="dci-att" data-testid="dq-attempts">{fd(it.attempts)} تلاش بی‌پاسخ ثبت شد؛ کار سر نوبت باز می‌ماند.</span></> : null}</p>
    <button type="button" className="btn gh dci-back" id="dci-back" onClick={onBack} data-testid="dq-back">
      <svg className="i dci-back-i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>برگشت به کار جاری</button>
  </div>;
}

export function DirChip({ dir }: { dir: "in" | "out" }) {
  const inn = dir === "in";
  return <span className={`dci-dir ${inn ? "is-in" : "is-out"}`}>
    <svg className="i" viewBox="0 0 16 16" aria-hidden="true">{inn
      ? <path fill="currentColor" d="M3 8h8.2L8.6 5.4l.8-.8L14 8.4 9.4 13l-.8-.8L11.2 9H3z" />
      : <path fill="currentColor" d="M13 8H4.8l2.6 2.6-.8.8L2 7.6 6.6 3l.8.8L4.8 7H13z" />}</svg>
    {inn ? "ورودی" : "خروجی"}
  </span>;
}

/** Interrupt / call banner that replaces the «dci-cur» line (§0.11, §0.12). */
export function DqIntBanner({ it, text }: { it: DqItem; text: string }) {
  const call = it.kind === "incoming_call" || it.kind === "outgoing_call";
  return <p className={`dci-cur dci-cur-int ${KIND_CLS[it.kind]}`} data-testid="dq-int">
    <span className="dci-kchip"><span className="dci-ldot" aria-hidden="true" />{KIND_FA[it.kind]}</span>
    {call && it.direction ? <DirChip dir={it.direction} /> : null}
    {call && it.detected ? <span className="dci-detect" data-testid="dq-detect">تشخیص خودکار: {DETECT_FA[it.detected]}</span> : null}
    <span>{text}</span>
  </p>;
}
export function dqCurText(it: DqItem): string {
  if (it.kind === "incoming_call") return it.detected === "unknown" ? "این شماره در مشتری‌ها نبود؛ اول نام را ثبت کنید." : it.live ? "در حال تماس ورودی." : "تماس ورودی امروز؛ نتیجه را ثبت کنید.";
  if (it.kind === "outgoing_call") return it.detected === "customer" ? "تماس خروجی بیرون از صف امروز؛ چیدمان پیگیری باز شد." : it.detected === "lead" ? "تماس خروجی بیرون از صف امروز؛ چیدمان لید تازه باز شد." : "تماس خروجی بیرون از صف امروز.";
  if (it.kind === "payment_order") return "دستور پرداخت تازه منتظر تأیید شماست.";
  if (it.kind === "file_action") return "پرونده‌ای به کارتابل شما آمد؛ اقدام لازم است.";
  return "";
}

type Acct = { id: number; bankName: string; ownerName: string; iban: string };
const ibanMask = (iban: string) => { const s = String(iban || "").replace(/\s+/g, ""); return s.length > 10 ? `${s.slice(0, 4)} ${s.slice(4, 8)} •••• •••• ${s.slice(-4)}` : s; };
/** #dci-pay: «دستور پرداخت منتظر تأیید شما» → the live POST /payment-orders/:id/sales-approve with a verified account. */
export function DqPayCard({ it, customerId, onDone }: { it: DqItem; customerId: number; onDone: (msg: string) => void }) {
  const pay = it.pay!;
  const qc = useQueryClient();
  const accts = useQuery<{ items: Acct[] }>({ queryKey: ["dq-accts", customerId], retry: false, staleTime: 30_000,
    queryFn: async () => { const r = await fetch(`/api/customers/${customerId}/bank-accounts`, { credentials: "include" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); } });
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const rows = accts.data?.items ?? [];
  useEffect(() => { if (sel == null && rows.length) setSel(rows[0].id); }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const approve = async () => {
    if (!sel) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/payment-orders/${pay.id}/sales-approve`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customerBankAccountId: sel }) });
      if (!r.ok) { const b = await r.json().catch(() => null); throw new Error(b?.error === "verified_customer_bank_account_required" ? "حساب تأییدشده‌ای با کد ملی مشتری انتخاب کنید." : "تأیید دستور پرداخت انجام نشد."); }
      onDone("دستور پرداخت تأیید شد و برای تأیید مدیر رفت.");
      void qc.invalidateQueries({ queryKey: DQ_KEY });
    } catch (e) { setErr(e instanceof Error ? e.message : "تأیید دستور پرداخت انجام نشد."); }
    finally { setBusy(false); }
  };
  const created = new Date(pay.createdAt);
  const tehDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(d);
  const clock = Number.isNaN(created.getTime()) ? "" : fd(new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tehran" }).format(created));
  const when = !clock ? "" : tehDay(created) === tehDay(new Date()) ? `امروز، ساعت ${clock}`
    : `${new Intl.DateTimeFormat("fa-IR", { day: "numeric", month: "long", timeZone: "Asia/Tehran" }).format(created)}، ساعت ${clock}`;
  return <section className="dci-pay" id="dci-pay" aria-labelledby="dci-pay-t" data-testid="dq-pay">
    <div className="dci-payhd"><h2 id="dci-pay-t">دستور پرداخت منتظر تأیید شما</h2><span className="dci-paytag">#{fd(pay.id)}</span></div>
    <dl className="dci-kv dci-kv-2">
      <div><dt>مبلغ</dt><dd>{fa(pay.amountToman)} تومان</dd></div>
      {pay.planName ? <div><dt>طرح</dt><dd>{pay.planName}</dd></div> : null}
      <div><dt>ثبت</dt><dd>{when || "—"}</dd></div>
    </dl>
    <fieldset className="dci-acct">
      <legend>حساب مقصد (تأییدشده با کد ملی مشتری)</legend>
      {accts.isLoading ? <p className="dci-empty">در حال بارگذاری…</p> : rows.length ? rows.map((a) => (
        <label key={a.id} className="dci-acct-row"><input type="radio" name="dq-acct" value={a.id} checked={sel === a.id} onChange={() => setSel(a.id)} />
          <span><b>{a.bankName}</b><span className="dci-iban" dir="ltr">{fd(ibanMask(a.iban))}</span><span className="dci-own">به نام {a.ownerName}</span></span></label>
      )) : <p className="dci-empty">هنوز حساب تأییدشده‌ای برای این مشتری نیست.</p>}
    </fieldset>
    <p className="dci-hint">با تأیید شما، دستور برای تأیید مدیر می‌رود و از کارهای امروز برداشته می‌شود.</p>
    {err ? <p className="dci-empty" role="alert">{err}</p> : null}
    <div className="dci-acts">
      <button type="button" className={`btn ${rows.length ? "pri" : "gh"}`} disabled={busy || !sel} onClick={() => void approve()} data-testid="dq-pay-ok">تأیید دستور پرداخت</button>
      <Link className={`btn ${rows.length ? "gh" : "pri"}`} href="/payment-orders">تأیید حساب تازه</Link>
    </div>
  </section>;
}
/** #dci-fact: «اقدام پرونده» (no call needed). */
export function DqFileActCard({ it, customerId }: { it: DqItem; customerId: number }) {
  const f = it.fileAct!;
  const href = `/loan-applications/${f.fileId}?customerId=${customerId}`;
  return <section className="dci-fact" id="dci-fact" aria-labelledby="dci-fact-t" data-testid="dq-fact">
    <div className="dci-payhd"><h2 id="dci-fact-t">اقدام پرونده</h2><span className="dci-nocall">بدون تماس</span></div>
    <dl className="dci-kv dci-kv-2">
      <div><dt>پرونده</dt><dd>{f.planName ? `${f.planName} ` : ""}#{fd(f.fileId)}</dd></div>
      <div><dt>مرحله</dt><dd>{f.stageLabel}</dd></div>
    </dl>
    <div className="dci-fact-do"><p className="dci-flab-t">کار لازم</p><p>{fd(f.need)}</p></div>
    <p className="dci-hint">این کار تماس لازم ندارد. با بارگذاری یا تغییر مرحله، از کارهای امروز برداشته می‌شود.</p>
    <div className="dci-acts"><Link className="btn pri" href={href}>بارگذاری دوباره‌ی مدرک</Link><Link className="btn gh" href={href}>باز کردن پرونده</Link></div>
  </section>;
}

/** Unknown number (no customer yet): «بدون نام», name first, «تکمیل پرونده» locked until the name is saved (§0.11). */
export function DqUnknownBoard({ it, banner, onNamed, onCopy }: { it: DqItem; banner: ReactNode; onNamed: (customerId: number, taskId: string, name: string) => void; onCopy?: (v: string) => void }) {
  const [first, setFirst] = useState(""); const [last, setLast] = useState("");
  const [err, setErr] = useState<{ first?: string; last?: string; serv?: string }>({});
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { firstRef.current?.focus({ preventScroll: true }); }, [it.id]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const er: typeof err = {};
    if (!first.trim()) er.first = "نام را بنویسید."; if (!last.trim()) er.last = "نام خانوادگی را بنویسید.";
    setErr(er); if (er.first || er.last || !it.call_id) return;
    setBusy(true);
    try { const r = await dqApi.nameUnknown(it.call_id, first.trim(), last.trim()); onNamed(r.customerId, r.taskId, r.name); }
    catch (x: any) { const f = x?.body?.fields || {}; setErr({ first: f.firstName, last: f.lastName, serv: f.firstName || f.lastName ? undefined : (x?.message || "ذخیره نشد.") }); }
    finally { setBusy(false); }
  };
  return <div className="dci-board" id="dci-board" data-testid="dq-unknown">
    <div className="dci-side">
      <section className="dci-col dci-right" aria-label="تاریخچه و یادداشت‌ها">
        <section className="dci-hist-box" aria-label="تاریخچه و یادداشت‌ها"><h2>تاریخچه و یادداشت‌ها</h2>
          <ul className="dci-hist"><li className="dci-hist-item"><div className="dci-hist-meta"><span>امروز، ساعت {it.tm}</span>{it.direction ? <DirChip dir={it.direction} /> : null}<span className="dci-vtag">ویپ</span></div>
            <p className="dci-hist-res"><span className="dci-res">{it.live ? "در حال تماس" : "تماس امروز"}</span></p></li></ul>
        </section>
      </section>
    </div>
    <section className="dci-col dci-mid" aria-label="اطلاعات تماس">
      <div className="dci-head">
        {banner}
        <div className="dci-head-main">
          <div className="dci-who-row"><div className="dci-who"><h2>{it.name}</h2></div>
            {it.live ? <span className="dci-detect" data-testid="dq-live">در حال تماس {it.direction === "out" ? "خروجی" : "ورودی"}</span> : null}</div>
          {/* 450000 B7: the responsible expert (customers.view, the CRM's phone rule) sees the caller's full number LTR with «کپی»; otherwise masked, nothing to copy. */}
          {it.phone && it.phone_full !== false ? <div className="dci-idrow dci-idrow-phone" data-testid="dq-unknown-phone"><span className="ph big">
            <span className="phn phd" dir="ltr" data-testid="dq-unknown-phone-full">{fd(it.phone)}</span>
            <button className="phc" type="button" aria-label={`کپی شماره‌ی ${fd(it.phone)}`} data-copy={it.phone} onClick={() => onCopy?.(it.phone!)} data-testid="dq-unknown-phone-copy">
              <DciIcon id="i-copy" /><span>کپی</span></button></span></div>
            : it.phone_masked ? <div className="dci-idrow dci-idrow-phone" data-testid="dq-unknown-phone"><span className="ph"><span className="phn phd" dir="ltr" data-testid="dq-unknown-phone-masked">{fd(it.phone_masked)}</span></span></div> : null}
        </div>
      </div>
      <form className="ed-form ed-desk dq-nameform" onSubmit={(e) => void save(e)} noValidate data-testid="dq-nameform">
        <p className="ed-intro"><AlertI />این شماره در مشتری‌ها نیست. اول نام و نام خانوادگی را بنویسید.</p>
        {err.serv ? <div className="ed-serv" role="alert"><span>{err.serv}</span></div> : null}
        <div className="ed-row">
          <div className="ed-f"><label htmlFor="dq-fn">نام</label>
            <input id="dq-fn" ref={firstRef} type="text" maxLength={30} autoComplete="off" value={first} aria-invalid={err.first ? true : undefined} onChange={(e) => setFirst(e.target.value)} data-testid="dq-fn" />
            {err.first ? <div className="ed-err" role="alert">{err.first}</div> : null}</div>
          <div className="ed-f"><label htmlFor="dq-ln">نام خانوادگی</label>
            <input id="dq-ln" type="text" maxLength={30} autoComplete="off" value={last} aria-invalid={err.last ? true : undefined} onChange={(e) => setLast(e.target.value)} data-testid="dq-ln" />
            {err.last ? <div className="ed-err" role="alert">{err.last}</div> : null}</div>
          <div className="ed-acts"><button className="btn pri" type="submit" disabled={busy} data-testid="dq-name-save">ذخیره</button></div>
        </div>
      </form>
      <section className="dci-filecard" aria-label="پرونده‌ی مشتری">
        <div className="dci-block"><h3>پرونده‌ی مشتری</h3>
          <button type="button" className="btn pri" id="dci-file-open" disabled aria-describedby="dq-file-hint">تکمیل پرونده</button>
          <p className="dci-hint" id="dq-file-hint">اول نام مشتری را ثبت کنید.</p></div>
      </section>
    </section>
  </div>;
}

/** Q3/Q22: a new incoming call never swaps the open card; a short toast with «باز کردن». */
export function useDqArrivals(q: DqQueue | null | undefined, onArrive: (it: DqItem) => void) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!q) return;
    const ids = q.items.filter((x) => x.kind === "incoming_call" && !x.done).map((x) => `${x.id}:${x.call_id}`);
    if (seen.current == null) { seen.current = new Set(ids); return; }
    for (const it of q.items) { const k = `${it.id}:${it.call_id}`; if (it.kind === "incoming_call" && !it.done && !seen.current.has(k)) { seen.current.add(k); onArrive(it); } }
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
}
export function useDqMemo(q: DqQueue | null | undefined) { return useMemo(() => q?.items ?? [], [q]); }

/** SALES-FIXES 480000 (t810u bug 4): an open incoming call (live, or inside its urgent window) shows in «اکنون» as an alert row with ONE action:
 *  own / registered customer → «باز کردن صفحه‌ی مشتری» (that customer's page in this list, like any other task);
 *  new number → «ثبت نام و شروع تماس اول» (the name step, then the first-call form). No popup, no overlay. */
export function DqNowIncoming({ q, openId, onPick }: { q: DqQueue; openId: string | null; onPick: (it: DqItem) => void }) {
  const rows = q.items.filter((x) => x.kind === "incoming_call" && !x.done && (x.live || x.urgent))
    .sort((a, b) => Number(b.live) - Number(a.live) || String(b.due_at ?? "").localeCompare(String(a.due_at ?? "")));
  // Same threshold as the 450000 queue strip (§7): more than groupOver (default 2) → one grouped card with an expand toggle.
  const grouped = rows.length > (q.groupOver ?? 2);
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return null;
  const hm = (iso: string | null) => { if (!iso) return ""; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d); };
  const showRows = !grouped || expanded;
  return <section className="sf-now" aria-label="اکنون، تماس ورودی" data-testid="sf-now-incoming">
    {grouped ? <div className={`sf-now-row sf-now-group${rows.some((x) => x.live) ? " live" : ""}`} data-testid="sf-now-group">
      <span className="sf-now-k"><i className="sf-now-dot" aria-hidden="true" />اکنون</span>
      <span className="sf-now-t"><b>{fd(rows.length)} تماس ورودی</b><span>{rows.some((x) => x.live) ? "در حال تماس" : "فوری"}</span></span>
      <button type="button" className="btn pri sf-now-btn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} data-testid="sf-now-expand">{expanded ? "بستن" : "باز کردن"}</button>
    </div> : null}
    {showRows ? rows.map((it) => { const unknown = it.customer_id == null; const open = openId === it.id;
      return <div key={it.id} className={`sf-now-row${it.live ? " live" : ""}${open ? " open" : ""}`} data-testid="sf-now-row" data-unknown={unknown ? "1" : "0"}>
        <span className="sf-now-k"><i className="sf-now-dot" aria-hidden="true" />اکنون</span>
        <span className="sf-now-t"><b>{unknown ? "شماره‌ی ناشناس" : fd(it.name)}</b>
          <span>تماس ورودی{it.live ? "، در حال تماس" : `، ساعت ${hm(it.due_at)}`}{unknown && it.phone_masked ? <> · <bdi dir="ltr">{fd(it.phone_masked)}</bdi></> : null}{!unknown && it.customer_id ? <> · #{fd(it.customer_id)}</> : null}</span></span>
        {open ? <span className="sf-now-open" data-testid="sf-now-opened">{unknown ? "نام را پایین ثبت کن" : "صفحه‌ی مشتری باز است"}</span>
          : <button type="button" className="btn pri sf-now-btn" onClick={() => onPick(it)} data-testid="sf-now-open">{unknown ? "ثبت نام و شروع تماس اول" : "باز کردن صفحه‌ی مشتری"}</button>}
      </div>; }) : null}
  </section>;
}
