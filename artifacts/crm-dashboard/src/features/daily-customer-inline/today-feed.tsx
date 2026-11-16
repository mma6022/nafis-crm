/** v1.7 history+result feed and call summary. پرونده box is in file-wizard.tsx (v2.0). */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cqOutcomeFor, emptyCqResult, type CqResultValue, type ManualOutcome } from "@/features/call-queue/ResultFields";
import { ctReq, durText, useCtConfig, useCustomerCtCalls, type CtCall, type CtSummary } from "@/features/call-transcripts/api";
import { useVcHistory, useVcMe, vcApi, type VcHistItem } from "@/features/voip-call/api";
import { type DciHist, type DciInbound, type DciNote } from "./api";
import { DciIcon } from "./icons";
import "@/features/sales-fixes/sf480.css";
import { openReminderFor } from "@/components/multi-case/HeaderReminder";

const RES_OPTS: { key: ManualOutcome | "note_only"; label: string }[] = [
  { key: "answered", label: "جواب داد" },
  { key: "no_answer", label: "جواب نداد" },
  { key: "off_or_busy", label: "مشغول بود" }, // SALES-FIXES 480000 (t810u): جواب داد / جواب نداد / مشغول بود (same outcome key)
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
      <DciIcon id="i-chev-l" className="i" /> خلاصه‌ی تماس
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
    <h3>گزارش تماس جدید</h3>
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
    {/* 450000 (Armita REVIEW-v21-build patch 6): «ثبت» looks disabled until a result is chosen; it stays focusable (spec §1) and a press shows the hint. */}
    <button className={`btn pri${!voipNote && !val.manual ? " is-off" : ""}`} type="button" disabled={busy} aria-disabled={!voipNote && !val.manual ? true : undefined}
      onClick={onSave} data-testid="dci-result-save">ثبت</button>
  </div>;
}

/** SALES-FIXES 480000 (t810u item 6): the right call panel, top to bottom —
 *  (a) «گزارش تماس جدید»: جواب داد / جواب نداد / مشغول بود + یادداشت;
 *  (b) «یادداشت‌های قبلی کارشناس»: only past calls that have a note (plus the expert's notes), each as date + note;
 *  (c) «سابقه‌ی تماس‌ها»: every call (date, direction, duration, result), collapsible and collapsed by default. Calls and notes are not mixed. */
export function HistFeed({ hist, notes, inbounds = [], customerId, result, sumOpen }: {
  hist: DciHist[]; notes: DciNote[]; inbounds?: DciInbound[]; customerId: number;
  result: { val: CqResultValue; onChange: (v: CqResultValue) => void; onSave: () => void; busy: boolean; err: string; show: boolean; voipNote?: boolean };
  sumOpen?: boolean;
}) {
  const vme = useVcMe();
  const voipQ = useVcHistory(customerId, Boolean(vme.data?.on));
  const ctCfg = useCtConfig(true);
  const ctQ = useCustomerCtCalls(customerId, Boolean(ctCfg.data?.enabled));
  const calls = useMemo(() => {
    const base = enrichCalls(hist, voipQ.data?.items, ctQ.data?.calls);
    // inbound VoIP calls without their own call row (e.g. missed) are calls too: date, «ورودی», result — their notes go to (b)
    const have = new Set(base.map((c) => c.id));
    const extra: EnrichedCall[] = inbounds.filter((x) => x.callLogId == null || !have.has(x.callLogId)).map((x) => ({
      id: -x.id, t: x.t, at: x.at, k: "incoming", r: x.r, rc: x.rc, note: "", dir: "ورودی" as const, duration: null, auto: true, eventId: x.id, hasSummary: false }));
    return [...base, ...extra].sort((a, b) => parseWhen(b.at) - parseWhen(a.at));
  }, [hist, inbounds, voipQ.data, ctQ.data]);
  const noteRows = useMemo(() => {
    const seen = new Set<string>();
    const out: { key: string; t: string; body: string; at: number }[] = [];
    for (const c of calls) { const b = (c.note || "").trim(); if (!b) continue; seen.add(b); out.push({ key: `c${c.id}`, t: c.t, body: b, at: parseWhen(c.at) }); }
    for (const n of notes) { const b = (n.body || "").trim(); if (!b || seen.has(b)) continue; seen.add(b); out.push({ key: `n${n.id}`, t: n.t, body: b, at: parseWhen((n as { at?: string }).at) }); }
    for (const x of inbounds) { const b = (x.note || "").trim(); if (!b || seen.has(b)) continue; seen.add(b); out.push({ key: `i${x.id}`, t: x.t, body: b, at: parseWhen(x.at) }); }
    return out.sort((a, b) => (b.at || 0) - (a.at || 0));
  }, [calls, notes, inbounds]);
  const [histOpen, setHistOpen] = useState(false);
  useEffect(() => { setHistOpen(false); }, [customerId]);
  const pending = vme.data?.s132?.last;
  const voipPending = Boolean(pending && pending.customerId === customerId && pending.noteState === "pending" && pending.status === "answered");
  return <section className="dci-hist-box sf-rp" aria-label="گزارش تماس، یادداشت‌ها و سابقه">
    {voipPending && pending?.durationSeconds ? <p className="dci-empty"><span className="dci-vtag">ثبت خودکار ویپ</span> {durText(pending.durationSeconds)}</p> : null}
    <ResultBlock val={result.val} onChange={result.onChange} onSave={result.onSave} busy={result.busy} err={result.err} show={result.show} voipNote={result.voipNote || voipPending} autoLabel={voipPending} />
    <button type="button" className="btn gh sf-rp-rem" onClick={() => openReminderFor(customerId)} data-testid="sf-rem-open">ثبت یادآور برای این مشتری</button>
    <div className="sf-rp-notes" data-testid="sf-prev-notes">
      <h2>یادداشت‌های قبلی کارشناس</h2>
      {noteRows.length ? <ul className="sf-rp-nl">{noteRows.map((n) => <li key={n.key} data-testid="sf-prev-note"><span className="sf-rp-d">{n.t}</span><p>{n.body}</p></li>)}</ul>
        : <p className="dci-empty">هنوز یادداشتی ثبت نشده است.</p>}
    </div>
    <div className="dci-prev sf-rp-hist">
      <button type="button" aria-expanded={histOpen} aria-controls="sf-rp-hl" onClick={() => setHistOpen((o) => !o)} data-testid="sf-call-hist-toggle">
        <span>سابقه‌ی تماس‌ها <span className="sf-rp-n">{calls.length.toLocaleString("fa-IR")}</span></span><DciIcon id="i-chev-l" className={`i sf-rp-chev${histOpen ? " on" : ""}`} /></button>
      {histOpen ? calls.length ? <ul className="dci-hist" id="sf-rp-hl" data-testid="sf-call-hist">
        {calls.map((c) => (
          <li key={c.id} className="dci-hist-item" data-testid={`dci-hist-${c.id}`}>
            <div className="dci-hist-meta">
              <span>{c.t}</span>
              <DirChip dir={c.dir} />
              {c.duration ? <span className="dci-dur">{c.duration}</span> : null}
              {c.auto ? <span className="dci-vtag">ثبت خودکار ویپ</span> : null}
              {c.r ? <span className={`dci-res ${c.rc}`}>{c.r}</span> : null}
            </div>
            {c.hasSummary && c.eventId ? <CallSummary eventId={c.eventId} forceOpen={sumOpen} /> : null}
          </li>
        ))}
      </ul> : <p className="dci-empty dci-hist-empty" id="sf-rp-hl">سابقه‌ی تماسی ثبت نشده است.</p> : null}
    </div>
  </section>;
}

export { FileBox, FileWizard } from "./file-wizard";
export { fileComplete, filePartial, stateFromDossier as fileInitials, type FileState } from "./file-dossier";
export { saveDossier as saveWizardFile } from "@/features/history/api";
