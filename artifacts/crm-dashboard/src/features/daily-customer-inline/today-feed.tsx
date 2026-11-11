/** v1.7 history+result feed, call summary, and mid-card پرونده box. No new server routes. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cqOutcomeFor, emptyCqResult, type CqResultValue, type ManualOutcome } from "@/features/call-queue/ResultFields";
import { ctReq, durText, useCtConfig, useCustomerCtCalls, type CtCall, type CtSummary } from "@/features/call-transcripts/api";
import { fileCardKey, saveFileCard, useFileCard, type FileCard } from "@/features/history/api";
import { firstCallValueText } from "@/features/team-sales/first-call-edit-labels";
import { useVcHistory, useVcMe, vcApi, type VcHistItem } from "@/features/voip-call/api";
import { type DciHist, type DciNote } from "./api";
import { DciIcon } from "./icons";

const FD = "۰۱۲۳۴۵۶۷۸۹";
const fd = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FD[Number(d)]);
/** Persian digits + U+066C thousands separator, e.g. ۳۵٬۰۰۰٬۰۰۰ تومان */
function formatTomanFa(raw: string): string {
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return "—";
  return `${fd(digits.replace(/\B(?=(\d{3})+(?!\d))/g, "٬"))} تومان`;
}

const RES_OPTS: { key: ManualOutcome | "note_only"; label: string }[] = [
  { key: "answered", label: "جواب داد" },
  { key: "no_answer", label: "جواب نداد" },
  { key: "off_or_busy", label: "خاموش یا اشغال" },
];

function isInDir(raw: string | undefined): boolean {
  const d = String(raw || "").toLowerCase();
  return d === "incoming" || d === "inbound" || d === "in" || /ورودی/.test(String(raw || ""));
}

function parseWhen(isoOrFa: string | undefined): number {
  if (!isoOrFa) return 0;
  const n = Date.parse(isoOrFa);
  if (Number.isFinite(n)) return n;
  return 0;
}

export type EnrichedCall = DciHist & {
  dir: "ورودی" | "خروجی";
  duration: string | null;
  auto: boolean;
  eventId: number | null;
  hasSummary: boolean;
};

export function enrichCalls(hist: DciHist[], voip: VcHistItem[] | undefined, ct: { eventId: number; callLogId: number | null; textState: string; hasRecording: boolean }[] | undefined): EnrichedCall[] {
  return hist.map((h) => {
    const v = (voip || []).find((x) => String(x.id) === String(h.id) || (x.at && h.at && Math.abs(Date.parse(x.at) - Date.parse(h.at)) < 120_000));
    const c = (ct || []).find((x) => x.callLogId === h.id);
    const dir: "ورودی" | "خروجی" = isInDir(v?.direction || h.k) ? "ورودی" : "خروجی";
    const sec = v && v.kind !== "manual" ? v.durationSeconds : null;
    const duration = sec && sec > 0 ? durText(sec) : null;
    const auto = Boolean(v && v.kind !== "manual");
    return { ...h, dir, duration, auto, eventId: c?.eventId ?? v?.eventId ?? null, hasSummary: c?.textState === "completed" };
  });
}

export function attachNotes(calls: EnrichedCall[], notes: DciNote[]): { calls: (EnrichedCall & { notes: DciNote[] })[]; leftover: DciNote[] } {
  const out = calls.map((c) => ({ ...c, notes: [] as DciNote[] }));
  const leftover: DciNote[] = [];
  const usedBodies = new Set(calls.map((c) => (c.note || "").trim()).filter(Boolean));
  if (!out.length) return { calls: out, leftover: notes };
  for (const n of notes) {
    const body = n.body.trim();
    if (!body || usedBodies.has(body)) continue; // already on a call row
    const nt = parseWhen((n as { at?: string }).at) || 0;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < out.length; i++) {
      const ct = parseWhen(out[i].at);
      const diff = nt && ct ? Math.abs(nt - ct) : i; // fall back to newest-first index if no date
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    // Prefer same calendar day in the display strings when possible
    const sameDay = out.findIndex((c) => c.t && n.t && (c.t.includes(n.t) || n.t.includes(c.t.replace(/، ساعت.*/, "").trim())));
    out[sameDay >= 0 ? sameDay : best].notes.push(n);
  }
  return { calls: out, leftover: leftover };
}

function DirChip({ dir }: { dir: "ورودی" | "خروجی" }) {
  const inn = dir === "ورودی";
  return <span className={`dci-dir ${inn ? "is-in" : "is-out"}`}>
    <svg className="i" viewBox="0 0 16 16" aria-hidden="true">{inn
      ? <path fill="currentColor" d="M3 8h8.2L8.6 5.4l.8-.8L14 8.4 9.4 13l-.8-.8L11.2 9H3z" />
      : <path fill="currentColor" d="M13 8H4.8l2.6 2.6-.8.8L2 7.6 6.6 3l.8.8L4.8 7H13z" />}</svg>
    {dir}
  </span>;
}

function CallSummary({ eventId, forceOpen }: { eventId: number; forceOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(forceOpen));
  const q = useQuery<CtCall>({
    queryKey: ["call-transcripts", "call", eventId],
    enabled: open,
    retry: false,
    staleTime: 60_000,
    queryFn: () => ctReq<CtCall>("GET", `/call-transcripts/calls/${eventId}`),
  });
  const sum: CtSummary | null = q.data?.summary ?? null;
  const subject = sum?.subject?.trim() || "";
  const req = sum?.request?.trim() || "";
  const has = Boolean(subject || req);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);
  if (q.isFetched && !has && !q.isError) return null;
  return <>
    <button className="dci-sum-btn" type="button" aria-expanded={open} data-testid="dci-sum-btn" onClick={() => setOpen((o) => !o)}>
      <DciIcon id="i-chev-l" /> خلاصه‌ی تماس
    </button>
    <div className="dci-sum" hidden={!open} data-testid="dci-sum">
      <div className="dci-sum-box">
        {q.isLoading ? <p>در حال بارگذاری…</p> : !has ? <p>خلاصه‌ای برای این تماس ثبت نشده است.</p> : <>
          {subject ? <><p className="dci-sum-k">موضوع تماس</p><p>{subject}</p></> : null}
          {req ? <><p className="dci-sum-k">خلاصه درخواست مشتری</p><p>{req}</p></> : null}
        </>}
      </div>
    </div>
  </>;
}

export function ResultBlock({ val, onChange, onSave, busy, err, show, voipNote, autoLabel }: {
  val: CqResultValue; onChange: (v: CqResultValue) => void; onSave: () => void; busy: boolean; err: string; show: boolean;
  voipNote?: boolean; autoLabel?: boolean;
}) {
  const [optNote, setOptNote] = useState(false);
  const needNote = voipNote || val.manual === "answered";
  const showNote = needNote || optNote;
  const missing = (needNote && !val.oneLine.trim()) || (!voipNote && !val.manual);
  return <div className="dci-callres" id="dci-result" data-testid="dci-result">
    <h3>{voipNote ? "ثبت نتیجه‌ی تماس" : "ثبت نتیجه‌ی تماس"}</h3>
    {autoLabel ? <p className="dci-empty">نتیجه از ویپ ثبت شده است؛ فقط یادداشت تماس را بنویسید.</p> : null}
    {voipNote ? null : <div className="dci-res-chips" role="radiogroup" aria-label="نتیجه‌ی تماس">
      {RES_OPTS.map((o) => (
        <button key={o.key} type="button" role="radio" aria-checked={val.manual === o.key} className="dci-res-chip"
          data-testid={`dci-res-${o.key}`} onClick={() => onChange({ ...val, manual: o.key as ManualOutcome, outcome: cqOutcomeFor(o.key as ManualOutcome, false) })}>{o.label}</button>
      ))}
    </div>}
    {!needNote && val.manual && !optNote ? <div className="dci-res-opt"><button className="dci-res-opt-btn" type="button" onClick={() => setOptNote(true)}>یادداشت اختیاری</button></div> : null}
    {showNote ? <div className="dci-res-note">
      <label htmlFor="dci-res-note">یادداشت تماس{needNote ? <span className="dci-req"> *</span> : null}</label>
      <textarea id="dci-res-note" rows={3} value={val.oneLine} placeholder="مثلاً: مدارک را تا فردا می‌فرستد" onChange={(e) => onChange({ ...val, oneLine: e.target.value })} />
    </div> : null}
    {show && missing ? <p className="dci-empty" role="alert">{!voipNote && !val.manual ? "نتیجه‌ی تماس را انتخاب کنید." : "یادداشت تماس را بنویسید."}</p> : null}
    {err ? <p className="dci-empty" role="alert" data-testid="dci-result-err">{err}</p> : null}
    <button className="btn pri" type="button" disabled={busy} onClick={onSave} data-testid="dci-result-save">ثبت</button>
  </div>;
}

export function HistFeed({ hist, notes, customerId, result, sumOpen }: {
  hist: DciHist[]; notes: DciNote[]; customerId: number;
  result: { val: CqResultValue; onChange: (v: CqResultValue) => void; onSave: () => void; busy: boolean; err: string; show: boolean; voipNote?: boolean };
  sumOpen?: boolean;
}) {
  const vme = useVcMe();
  const voipQ = useVcHistory(customerId, Boolean(vme.data?.on));
  const ctCfg = useCtConfig(true);
  const ctQ = useCustomerCtCalls(customerId, Boolean(ctCfg.data?.enabled));
  const enriched = useMemo(() => enrichCalls(hist, voipQ.data?.items, ctQ.data?.calls), [hist, voipQ.data, ctQ.data]);
  const { calls, leftover } = useMemo(() => attachNotes(enriched, notes), [enriched, notes]);
  const [prevOpen, setPrevOpen] = useState(false);
  const pending = vme.data?.s132?.last;
  const voipPending = Boolean(pending && pending.customerId === customerId && pending.noteState === "pending" && pending.status === "answered");
  return <section className="dci-hist-box" aria-label="تاریخچه و یادداشت‌ها">
    <h2>تاریخچه و یادداشت‌ها</h2>
    {voipPending && pending?.durationSeconds ? <p className="dci-empty"><span className="dci-vtag">ثبت خودکار ویپ</span> {durText(pending.durationSeconds)}</p> : null}
    {calls.length ? <ul className="dci-hist">
      {calls.map((c) => (
        <li key={c.id} className="dci-hist-item" data-testid={`dci-hist-${c.id}`}>
          <div className="dci-hist-meta">
            <span>{c.t}</span>
            <DirChip dir={c.dir} />
            {c.duration ? <span className="dci-dur">{c.duration}</span> : null}
            {c.auto ? <span className="dci-vtag">ثبت خودکار ویپ</span> : null}
          </div>
          {c.r ? <p className="dci-hist-res"><span className={`dci-res ${c.rc}`}>{c.r}</span></p> : null}
          {c.note ? <div className="dci-call-note"><DciIcon id="i-copy" /><span>{c.note}</span></div> : null}
          {c.notes.map((n) => <div key={n.id} className="dci-call-note"><span>{n.body}</span></div>)}
          {c.hasSummary && c.eventId ? <CallSummary eventId={c.eventId} forceOpen={sumOpen} /> : null}
        </li>
      ))}
    </ul> : <p className="dci-empty dci-hist-empty">سابقه‌ی تماسی ثبت نشده است.</p>}
    {leftover.length ? <div className="dci-prev">
      <button type="button" aria-expanded={prevOpen} onClick={() => setPrevOpen((o) => !o)} data-testid="dci-prev-notes">یادداشت‌های قبلی</button>
      {prevOpen ? <ul className="dci-prev-list">{leftover.map((n) => <li key={n.id} className="dci-call-note">{n.body}</li>)}</ul> : null}
    </div> : null}
    <ResultBlock val={result.val} onChange={result.onChange} onSave={result.onSave} busy={result.busy} err={result.err} show={result.show} voipNote={result.voipNote || voipPending} autoLabel={voipPending} />
  </section>;
}

export type FileInitials = { nid: string; city: string; amount: string; need: string; g: "yes" | "no" | ""; gcond: string };

function splitNeed(note: string): { need: string; gcond: string } {
  const raw = String(note || "");
  const m = raw.match(/^(.*?)(?:\n)?شرایط ضامن:\s*(.*)$/s);
  if (m) return { need: m[1].trim(), gcond: m[2].trim() };
  return { need: raw.trim(), gcond: "" };
}

function amountToman(a: Record<string, unknown>): string {
  const n = Number(a.amountMillion ?? a.amount ?? "");
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(n >= 10_000 ? Math.round(n) : Math.round(n * 1e6));
}

export function fileInitials(card: FileCard | undefined, nationalCode: string | null): FileInitials {
  const a = card?.answers ?? {};
  const g = a.guarantorAvailable === "yes" || a.guarantorAvailable === "no" ? a.guarantorAvailable : "";
  const fromNote = splitNeed(String(a.note || ""));
  const gcond = fromNote.gcond
    || [a.guarantorCheque ? firstCallValueText("guarantorCheque", a.guarantorCheque) : "", a.gRank ? firstCallValueText("gRank", a.gRank) : ""].filter(Boolean).join("، ");
  return { nid: nationalCode || "", city: String(card?.city || a.city || ""), amount: amountToman(a), need: fromNote.need, g, gcond };
}

export function FileBox({ customerId, nationalCode, onOpen, wizard }: {
  customerId: number; nationalCode: string | null;
  onOpen: (mode: "new" | "edit", initial: FileInitials) => void;
  wizard?: ReactNode;
}) {
  const q = useFileCard(customerId);
  const f = q.data;
  const filled = Boolean(f?.answers);
  const init = fileInitials(f, nationalCode);
  const open = Boolean(wizard);
  const gLabel = init.g === "no" ? "ضامن ندارد" : init.g === "yes" ? "ضامن دارد" : (f?.answers?.guarantorAvailable ? firstCallValueText("guarantorAvailable", f.answers.guarantorAvailable) : "—");
  const rows: { label: string; value: string; ltr?: boolean }[] = [
    { label: "شهر", value: init.city || "—" },
    { label: "مبلغ درخواستی", value: init.amount ? formatTomanFa(init.amount) : "—" },
    { label: "شرح نیاز", value: init.need || "—" },
    { label: "ضامن", value: gLabel },
  ];
  if (init.g === "yes") rows.push({ label: "شرایط ضامن", value: init.gcond || "—" });
  return <>
    <div className="dci-filebox" id="dci-filebox" hidden={open} data-testid="dci-filebox">
      {q.isLoading ? <p className="dci-empty">در حال بارگذاری…</p> : q.isError ? <p className="dci-empty" role="alert">پرونده بارگذاری نشد.</p> : !filled ? <>
        <p className="dci-empty">پرونده تماس اول هنوز تکمیل نشده است.</p>
        <button className="btn pri" type="button" id="dci-file-open" data-testid="dci-file-open" onClick={() => onOpen("new", init)}>تکمیل پرونده</button>
      </> : <>
        <dl className="dci-kv">
          {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd dir={r.ltr ? "ltr" : undefined}>{r.value}</dd></div>)}
        </dl>
        <button className="btn gh" type="button" id="dci-file-edit" data-testid="dci-file-edit" onClick={() => onOpen("edit", init)}>ویرایش</button>
      </>}
    </div>
    <div className="dci-block" id="dci-filewiz" hidden={!open} data-testid="dci-filewiz">
      <h3>تکمیل پرونده در تماس اول</h3>
      {wizard}
    </div>
  </>;
}

export async function saveWizardFile(customerId: number, d: { city: string; amountToman: string; need: string; g: "yes" | "no" | ""; gcond: string }) {
  const million = Number(String(d.amountToman).replace(/\D/g, ""));
  const amountMillion = Number.isFinite(million) && million >= 10_000 ? Math.max(1, Math.round(million / 1e6)) : (Number.isFinite(million) && million > 0 ? million : undefined);
  const answers: Record<string, unknown> = {
    city: d.city.trim() || undefined,
    amountMillion,
    note: [d.need.trim(), d.g === "yes" && d.gcond.trim() ? `شرایط ضامن: ${d.gcond.trim()}` : ""].filter(Boolean).join("\n") || undefined,
    guarantorAvailable: d.g || undefined,
  };
  return saveFileCard(customerId, answers);
}

export { emptyCqResult };
