/** v2.0 multi-step «پرونده‌ی مشتری» wizard and filled/partial box. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fileCardKey, saveDossier, useFileCard, type FileCard } from "@/features/history/api";
import {
  AMOUNT_RANGE_OPTS, BOUNCED_OPTS, DOC_OTHER, JOB_OPTS, MILITARY_OPTS, NEED_FA, PURPOSE_OPTS,
  REFER_OPTS, TIMING_OPTS, YN, amountChip, contactChip, fd, fileAskRows, fileComplete, fileKvRows, filePartial,
  formatTomanFa, hasDoc, hasGuarantor, planChip, readDraft, setDocFlag, stateFromDossier, visSteps,
  writeDraft, type FileState, type WizStep,
} from "./file-dossier";

function dossierOf(card: FileCard | undefined, draft: FileState | null): FileState {
  const base = card?.dossier ? stateFromDossier(card.dossier) : stateFromDossier(null);
  if (!draft) return base;
  // Draft wins for keys the expert already touched; empty draft keys keep the server/site values.
  const out = { ...base };
  (Object.keys(draft) as (keyof FileState)[]).forEach((k) => {
    if (k === "documents") {
      if ((draft.documents || []).length) out.documents = draft.documents;
    } else if (draft[k]) out[k] = draft[k] as never;
  });
  return out;
}

function ChipGroup({ name, opts, value, multi, onPick, label }: {
  name: string; opts: [string, string][]; value: string | string[]; multi?: boolean;
  onPick: (v: string) => void; label: string;
}) {
  return <div className="dci-wchips" role={multi ? "group" : "radiogroup"} aria-label={label}>
    {opts.map(([v, t]) => {
      const on = multi ? (value as string[] || []).includes(v) : value === v;
      return <button key={v} type="button" className="dci-wchip" data-k={name} data-v={v}
        {...(multi ? { "aria-pressed": on } : { role: "radio", "aria-checked": on })}
        onClick={() => onPick(v)}>{t}</button>;
    })}
  </div>;
}

function GradeGroup({ name, label, value, onPick }: { name: string; label: string; value: string; onPick: (v: string) => void }) {
  return <div className="dci-fg">
    <p className="dci-flab-t" id={`l-${name}`}>{label}</p>
    <div className="dci-grades" role="radiogroup" aria-labelledby={`l-${name}`}>
      {(["A", "B", "C", "D", "E"] as const).map((L) => (
        <div key={L} className="dci-grade-row">
          <span className="dci-grade-l" aria-hidden="true">{L}</span>
          {[1, 2, 3].map((n) => {
            const v = `${L}${n}`;
            return <button key={v} type="button" className="dci-wchip dci-chip-g" data-k={name} data-v={v}
              role="radio" aria-checked={value === v} onClick={() => onPick(v)}>{v}</button>;
          })}
        </div>
      ))}
      <div className="dci-grade-row">
        <button type="button" className="dci-wchip" data-k={name} data-v="unknown" role="radio"
          aria-checked={value === "unknown"} onClick={() => onPick("unknown")}>نمی‌دونه</button>
      </div>
    </div>
    {/^[A-E]$/.test(value) ? <p className="dci-grade-site" data-testid={`${name}-site-letter`}>
      مشتری در سایت «{value}» زده است؛ زیررتبه را بپرسید و یکی از {value}۱ تا {value}۳ را بزنید.</p> : null}
  </div>;
}

function Field({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <div className="dci-fg">
    <p className="dci-flab-t">{title}</p>
    {children}
    {hint ? <p className="dci-hint">{hint}</p> : null}
  </div>;
}

function stepBody(id: WizStep, st: FileState, set: (patch: Partial<FileState> | FileState) => void) {
  if (id === "city") return <Field title="شهر">
    <input className="dci-inp" id="dci-fcity" autoComplete="off" placeholder="—" value={st.city}
      onChange={(e) => set({ city: e.target.value })} />
  </Field>;
  if (id === "amt") {
    const bandHint = !st.amount && st.amountBand && amountChip({ ...st, amount: "", amount_range: "" })
      ? amountChip({ ...st, amount: "", amount_range: "" }) : "";
    return <>
      <Field title="مبلغ">
        <ChipGroup name="amount_range" opts={AMOUNT_RANGE_OPTS} value={st.amount_range} label="مبلغ"
          onPick={(v) => set({ amount_range: v })} />
      </Field>
      <Field title="مبلغ دقیق، تومان" hint={bandHint || undefined}>
        <input className="dci-inp" id="dci-famt" dir="ltr" inputMode="numeric" autoComplete="off" placeholder="—"
          value={st.amount ? formatTomanFa(st.amount) : ""} onChange={(e) => {
            const digits = e.target.value.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\D/g, "");
            set({ amount: digits });
          }} />
      </Field>
    </>;
  }
  if (id === "purpose") {
    const needHint = !st.loan_purpose && st.need && NEED_FA[st.need]
      ? `نوع نیاز در فرم سایت: ${NEED_FA[st.need]}`
      : "اختیاری است؛ اگر نخواستید خالی بگذارید.";
    return <>
      <Field title="برای" hint={needHint}>
        <ChipGroup name="loan_purpose" opts={PURPOSE_OPTS} value={st.loan_purpose} label="برای"
          onPick={(v) => set({ loan_purpose: st.loan_purpose === v ? "" : v })} />
      </Field>
      <Field title="زمان نیاز">
        <ChipGroup name="need_timing" opts={TIMING_OPTS} value={st.need_timing} label="زمان نیاز"
          onPick={(v) => set({ need_timing: v })} />
      </Field>
    </>;
  }
  if (id === "job") return <Field title="شغل">
    <ChipGroup name="job_status" opts={JOB_OPTS} value={st.job_status} label="شغل" onPick={(v) => set({ job_status: v })} />
  </Field>;
  if (id === "mil") return <>
    <Field title="پایان خدمت">
      <ChipGroup name="has_military_card" opts={MILITARY_OPTS} value={st.has_military_card} label="پایان خدمت"
        onPick={(v) => set({ has_military_card: v })} />
    </Field>
    <Field title="چک برگشتی / معوق">
      <ChipGroup name="has_bounced_or_overdue" opts={BOUNCED_OPTS} value={st.has_bounced_or_overdue} label="چک برگشتی / معوق"
        onPick={(v) => set({ has_bounced_or_overdue: v })} />
    </Field>
  </>;
  if (id === "rank") return <>
    <GradeGroup name="credit_rank" label="رتبه‌ی اعتبارسنجی" value={st.credit_rank} onPick={(v) => set({ credit_rank: v })} />
    <Field title="گواهی کسر از حقوق">
      <ChipGroup name="salary_deduction" opts={YN}
        value={hasDoc(st, "salary_deduction_cert") ? "yes" : (st.documents || []).length ? "no" : ""}
        label="گواهی کسر از حقوق"
        onPick={(v) => set(setDocFlag(st, "salary_deduction_cert", v === "yes"))} />
    </Field>
  </>;
  if (id === "docs") return <>
    <Field title="معرفی بازنشسته">
      <ChipGroup name="can_refer_retiree" opts={REFER_OPTS} value={st.can_refer_retiree} label="معرفی بازنشسته"
        onPick={(v) => set({ can_refer_retiree: v })} />
    </Field>
    <Field title="مدارک">
      <ChipGroup name="docs" opts={DOC_OTHER} value={st.documents} multi label="مدارک"
        onPick={(v) => {
          const on = (st.documents || []).includes(v);
          set(setDocFlag(st, v, !on));
        }} />
    </Field>
  </>;
  if (id === "g") return <Field title="ضامن">
    <ChipGroup name="guarantor" opts={[["yes", "ضامن دارد"], ["no", "ضامن ندارد"]]}
      value={hasGuarantor(st) ? "yes" : ((st.documents || []).length ? "no" : "")} label="ضامن"
      onPick={(v) => set(setDocFlag(st, "guarantor", v === "yes"))} />
  </Field>;
  if (id === "gjr") return <>
    <Field title="شغل ضامن">
      <ChipGroup name="g_job_status" opts={JOB_OPTS} value={st.g_job_status} label="شغل ضامن"
        onPick={(v) => set({ g_job_status: v })} />
    </Field>
    <GradeGroup name="g_credit_rank" label="رتبه‌ی اعتبارسنجی ضامن" value={st.g_credit_rank}
      onPick={(v) => set({ g_credit_rank: v })} />
    <Field title="شرایط ضامن">
      <input className="dci-inp" id="dci-fgcond" autoComplete="off" placeholder="مثلاً چک ضامن" value={st.g_conditions}
        onChange={(e) => set({ g_conditions: e.target.value })} />
    </Field>
  </>;
  if (id === "note") return <Field title="یادداشت کارشناس" hint="اختیاری است.">
    <textarea className="dci-inp" id="dci-fnote" rows={4} placeholder="اختیاری" value={st.note}
      onChange={(e) => set({ note: e.target.value })} />
  </Field>;
  return null;
}

export function FileWizard({ customerId, userId, startStep, onDone }: {
  customerId: number; userId: number | undefined; startStep?: WizStep; onDone: () => void;
}) {
  const qc = useQueryClient();
  const q = useFileCard(customerId);
  const [st, setSt] = useState<FileState>(() => dossierOf(q.data, readDraft(userId, customerId)));
  const [stepId, setStepId] = useState<WizStep>(startStep || "city");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const hydrated = useRef(false);
  useEffect(() => {
    if (!q.data || hydrated.current) return;
    setSt(dossierOf(q.data, readDraft(userId, customerId)));
    hydrated.current = true;
  }, [q.data, userId, customerId]);
  const steps = visSteps(st);
  const idx = Math.max(0, steps.indexOf(stepId));
  const id = steps[idx] ?? "city";
  const n = steps.length;
  const x = idx + 1;
  const patch = (p: Partial<FileState> | FileState) => {
    setSt((cur) => {
      // Keep guarantor answers in state when the toggle is off; they are cleared only on «پایان».
      const next = { ...cur, ...p };
      writeDraft(userId, customerId, next);
      return next;
    });
  };
  const timer = useRef<number>(0);
  const skipSave = useRef(true);
  const failCount = useRef(0);
  const [saveHint, setSaveHint] = useState("");
  useEffect(() => {
    if (skipSave.current) { skipSave.current = false; return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void saveDossier(customerId, st).then(() => {
        failCount.current = 0;
        setSaveHint("");
      }).catch(() => {
        failCount.current += 1;
        if (failCount.current >= 3) setSaveHint("ذخیرهٔ خودکار انجام نشد. اتصال را بررسی کنید.");
      });
    }, 500);
    return () => window.clearTimeout(timer.current);
  }, [st, customerId]);
  const go = async (dir: 1 | -1) => {
    if (dir < 0) {
      const prev = steps[idx - 1];
      if (prev) setStepId(prev);
      return;
    }
    if (idx < n - 1) {
      setStepId(steps[idx + 1]);
      return;
    }
    setBusy(true); setErr("");
    try {
      const payload = hasGuarantor(st) ? st : { ...st, g_job_status: "", g_credit_rank: "", g_conditions: "" };
      const card = await saveDossier(customerId, payload, { final: true });
      qc.setQueryData(fileCardKey(customerId), card);
      void qc.invalidateQueries({ queryKey: fileCardKey(customerId) });
      void qc.invalidateQueries({ queryKey: ["dci-board", customerId] });
      writeDraft(userId, customerId, st);
      onDone();
    } catch (e) {
      setErr(e instanceof Error && /[\u0600-\u06FF]/.test(e.message) ? e.message : "ذخیره انجام نشد. دوباره تلاش کنید.");
    } finally { setBusy(false); }
  };
  // If guarantor was turned off, drop gjr and clamp the step.
  useEffect(() => {
    const next = visSteps(st);
    if (!next.includes(stepId)) setStepId(next[Math.min(idx, next.length - 1)] ?? "note");
  }, [st, stepId, idx]);
  return <div className="dci-fc" id="dci-fc" data-step={id} data-testid="dci-fc">
    <p className="dci-step" id="dci-step-lab">مرحله‌ی <span id="dci-sn">{fd(x)}</span> از {fd(n)}</p>
    <div className="dci-prog" role="progressbar" aria-valuemin={1} aria-valuemax={n} aria-valuenow={x} aria-label="پیشرفت پرونده">
      <span style={{ width: `${(x / n) * 100}%` }} />
    </div>
    <div id="dci-fbody">{stepBody(id, st, patch)}</div>
    {err ? <p className="dci-empty" role="alert" data-testid="dci-fc-err">{err}</p> : saveHint ? <p className="dci-hint" role="status" data-testid="dci-fc-autosave-err">{saveHint}</p> : null}
    <div className="dci-acts">
      <button className="btn gh" type="button" id="dci-prev" hidden={idx === 0} onClick={() => void go(-1)}>قبلی</button>
      <button className="btn pri" type="button" id="dci-next" data-testid="dci-fc-next" disabled={busy} onClick={() => void go(1)}>
        {idx === n - 1 ? (busy ? "در حال ذخیره…" : "پایان") : "بعدی"}
      </button>
    </div>
  </div>;
}

export function FileBox({ customerId, onOpen, wizard, startStep }: {
  customerId: number;
  onOpen: (mode: "new" | "edit") => void;
  wizard?: ReactNode;
  startStep?: WizStep;
}) {
  const q = useFileCard(customerId);
  const [showAll, setShowAll] = useState(false);
  const st = useMemo(() => stateFromDossier(q.data?.dossier), [q.data]);
  const complete = q.data?.dossierComplete ?? fileComplete(st);
  const partial = q.data?.dossierPartial ?? filePartial(st);
  const siteHint = Boolean(q.data?.sitePrefill) && !complete;
  // site-credit-noinst v1.1: a site lead (even name + mobile only) shows every field, «از سایت» / «بپرسید»
  const siteLead = Boolean(q.data?.siteLead);
  const siteFields = q.data?.siteFields ?? [];
  const askRows = fileAskRows(st, siteFields);
  const siteSet = new Set(siteFields);
  const fromSite = (k: string) => siteSet.has(k === "guarantor" || k === "salary_deduction" ? "documents" : k);
  const open = Boolean(wizard);
  const long = complete && fileKvRows(st, true).length > fileKvRows(st, false).length;
  const rows = fileKvRows(st, !complete || showAll);
  const amt = amountChip(st);
  const plan = planChip(st);
  const ctime = contactChip(st);
  return <>
    <div className="dci-filehd">
      <h2>پرونده‌ی مشتری</h2>
      <div className="dci-filetags">
        {amt ? <span className="dci-amt-tag">{amt}</span> : null}
        {plan ? <span className="dci-plan-tag">{plan}</span> : null}
        {ctime ? <span className="dci-ctime-tag">{ctime}</span> : null}
      </div>
    </div>
    <div className="dci-filebox" id="dci-filebox" hidden={open} data-testid="dci-filebox">
      {q.isLoading ? <p className="dci-empty">در حال بارگذاری…</p> : q.isError ? <p className="dci-empty" role="alert">پرونده بارگذاری نشد.</p>
        : !complete && siteLead ? <>
          <p className="dci-site-hint" data-testid="dci-site-hint">{siteFields.length
            ? "بخشی از اطلاعات را مشتری در سایت پر کرده است. فیلدهای خالی را در تماس بپرسید."
            : "مشتری در سایت فقط نام و شماره گذاشته است. فیلدها را در تماس بپرسید."}</p>
          <dl className="dci-kv dci-kv-2" data-testid="dci-ask-kv">{askRows.map((r) => <div key={r.key} className={r.from === "ask" ? "ask" : r.from === "site" ? "from" : undefined}
            data-testid={`dci-kv-${r.key}`} data-from={r.from}>
            <dt>{r.label}</dt>
            <dd>{r.from === "ask" ? <span className="ask-v">بپرسید</span> : <>{r.value}{r.from === "site" ? <i className="fsite">از سایت</i> : null}</>}</dd>
          </div>)}</dl>
          {(st.customer_note || st.note) ? <div className="dci-filenotes">
            {st.customer_note ? <div className="dci-fnote"><span className="dci-fnote-k">یادداشت مشتری</span><p>{st.customer_note}</p></div> : null}
            {st.note ? <div className="dci-fnote"><span className="dci-fnote-k">یادداشت کارشناس</span><p>{st.note}</p></div> : null}
          </div> : null}
          <button className="btn pri" type="button" id="dci-file-open" data-testid="dci-file-open" onClick={() => onOpen("new")}>تکمیل پرونده</button>
        </> : !complete && !partial ? <>
          <p className="dci-empty">پرونده تماس اول هنوز تکمیل نشده است.</p>
          <button className="btn pri" type="button" id="dci-file-open" data-testid="dci-file-open" onClick={() => onOpen("new")}>تکمیل پرونده</button>
        </> : !complete ? <>
          {siteHint ? <p className="dci-site-hint">بخشی از اطلاعات را مشتری در سایت پر کرده است.</p> : null}
          {rows.length ? <dl className="dci-kv dci-kv-2">{rows.map((r) => <div key={r.key}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl> : null}
          {(st.customer_note || st.note) ? <div className="dci-filenotes">
            {st.customer_note ? <div className="dci-fnote"><span className="dci-fnote-k">یادداشت مشتری</span><p>{st.customer_note}</p></div> : null}
            {st.note ? <div className="dci-fnote"><span className="dci-fnote-k">یادداشت کارشناس</span><p>{st.note}</p></div> : null}
          </div> : null}
          <button className="btn pri" type="button" id="dci-file-open" data-testid="dci-file-open" onClick={() => onOpen("new")}>تکمیل پرونده</button>
        </> : <>
          {rows.length ? <dl className="dci-kv dci-kv-2">{rows.map((r) => <div key={r.key}><dt>{r.label}</dt><dd>{r.value}{fromSite(r.key) ? <i className="fsite">از سایت</i> : null}</dd></div>)}</dl> : null}
          {long ? <button type="button" className="btn gh" id="dci-file-more" data-testid="dci-file-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "نمایش کمتر" : "نمایش همه"}
          </button> : null}
          {(st.customer_note || st.note) ? <div className="dci-filenotes">
            {st.customer_note ? <div className="dci-fnote"><span className="dci-fnote-k">یادداشت مشتری</span><p>{st.customer_note}</p></div> : null}
            {st.note ? <div className="dci-fnote"><span className="dci-fnote-k">یادداشت کارشناس</span><p>{st.note}</p></div> : null}
          </div> : null}
          <button className="btn gh" type="button" id="dci-file-edit" data-testid="dci-file-edit" onClick={() => onOpen("edit")}>ویرایش</button>
        </>}
    </div>
    <div className="dci-block" id="dci-filewiz" hidden={!open} data-testid="dci-filewiz">
      <h3>تکمیل پرونده در تماس اول</h3>
      {wizard ?? (open ? <FileWizard customerId={customerId} userId={undefined} startStep={startStep} onDone={() => onOpen("edit")} /> : null)}
    </div>
  </>;
}
