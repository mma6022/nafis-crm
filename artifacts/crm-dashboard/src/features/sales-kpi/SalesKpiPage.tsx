/** t886 «شاخص‌های فروش»: چهار گروه KPI + ویزارد تنظیمات. flag.sales_kpi_v1 off → «فعال نیست». */
import { useEffect, useMemo, useRef, useState } from "react";
import { faDigits } from "@/lib/credit-grade";
import { PersianDatePicker } from "@/components/PersianDatePicker";
import { jalaliValueToGregorian } from "@/lib/jalali";
import {
  fetchKpiSettings, fetchSalesKpi, saveKpiSettings, useSalesKpiMe,
  type KpiCell, type SalesKpiReport,
} from "./api";
import "./sales-kpi.css";

const TABS = [
  { id: "sales", label: "فروش فردی" },
  { id: "discipline", label: "پیگیری و نظم" },
  { id: "growth", label: "رشد فردی" },
  { id: "team", label: "عملکرد تیم" },
  { id: "settings", label: "تنظیمات" },
] as const;

const FA = "۰۱۲۳۴۵۶۷۸۹";
const ui = (v: string | number) => faDigits(String(v));
const toFa = (s: string) => String(s).replace(/\d/g, (d) => FA[Number(d)]).replace(/[٠-٩]/g, (d) => FA["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);
const toEn = (s: string) => String(s)
  .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
  .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
  .replace(/[^\d.]/g, "");

function FaNumberInput({ value, onChange, placeholder, testId, label }: { value: string; onChange: (en: string) => void; placeholder?: string; testId?: string; label: string }) {
  return (
    <label>{label}
      <input
        inputMode="numeric"
        value={toFa(value)}
        placeholder={placeholder}
        onChange={(e) => onChange(toEn(e.target.value))}
        data-testid={testId}
      />
    </label>
  );
}

function Card({ kpi, canEdit, onOpenSettings }: { kpi: KpiCell; canEdit: boolean; onOpenSettings?: () => void }) {
  const cls = [
    kpi.status === "missing" ? "missing" : kpi.status === "empty_denom" ? "empty" : kpi.status === "no_baseline" ? "baseline" : "ok",
    kpi.direction === "lower_better" ? "lower" : "",
  ].filter(Boolean).join(" ");
  return (
    <article className={`skpi-card ${cls}`} data-testid={`skpi-card-${kpi.key}`} data-status={kpi.status} data-direction={kpi.direction ?? ""}>
      <h3>{kpi.label}</h3>
      <div className="skpi-val">{ui(kpi.display)}</div>
      {kpi.fractionLabel && kpi.status === "ok" && <p className="skpi-frac">{ui(kpi.fractionLabel)}</p>}
      {kpi.deltaDisplay && kpi.status === "ok" && <p className="skpi-delta">{ui(kpi.deltaDisplay)}</p>}
      {kpi.direction === "lower_better" && kpi.status === "ok" && <p className="skpi-dir">کمتر بهتر است</p>}
      {kpi.incomplete && <p className="skpi-frac">داده‌ی ناقص</p>}
      {kpi.status === "missing" && kpi.missingKind === "setting" && canEdit && onOpenSettings && (
        <button type="button" className="skpi-link" onClick={onOpenSettings}>تعریف در تنظیمات</button>
      )}
      <details className="skpi-tip">
        <summary data-testid="skpi-formula">فرمول</summary>
        <p>{kpi.formula}</p>
        {kpi.assumption && <p>{kpi.assumption}</p>}
        {kpi.missingReason && <p>{kpi.missingReason}</p>}
      </details>
    </article>
  );
}

export default function SalesKpiPage() {
  const me = useSalesKpiMe(true).data;
  useEffect(() => {
    document.documentElement.classList.add("skpi-page");
    return () => { document.documentElement.classList.remove("skpi-page"); };
  }, []);
  if (!me) {
    return <div className="skpi skpi-load" dir="rtl" data-testid="page-sales-kpi-loading"><p>در حال بارگذاری…</p></div>;
  }
  if (!me.enabled) {
    return (
      <div className="skpi skpi-off" dir="rtl" data-testid="skpi-flag-off">
        <div className="skpi-card"><h1>شاخص‌های فروش فعال نیست</h1><p>این گزارش هنوز فعال نیست.</p></div>
      </div>
    );
  }
  if (!me.canView) {
    return (
      <div className="skpi skpi-off" dir="rtl" data-testid="skpi-no-access">
        <h1>دسترسی ندارید</h1>
        <p>این گزارش فقط برای مدیر، مدیر فروش و کارشناس است.</p>
      </div>
    );
  }
  return <Board canEdit={Boolean(me.canEditSettings)} access={me.access} selfId={me.salespersonId} />;
}

function Board({ canEdit, access, selfId }: { canEdit: boolean; access: string | null; selfId: number | null }) {
  const isManager = access === "manager";
  const qs = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("sales");
  const [period, setPeriod] = useState<"month" | "custom">(qs.get("period") === "custom" ? "custom" : "month");
  const [fromJ, setFromJ] = useState(qs.get("from") || "");
  const [toJ, setToJ] = useState(qs.get("to") || "");
  const [teamId, setTeamId] = useState<number | "">("");
  const [expertId, setExpertId] = useState<number | "">(isManager ? "" : (selfId ?? ""));
  const [report, setReport] = useState<SalesKpiReport | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const tabsRef = useRef<HTMLUListElement>(null);

  const load = async (over?: { teamId?: number | "" }) => {
    setLoading(true); setErr("");
    try {
      const t = over?.teamId !== undefined ? over.teamId : teamId;
      const q: Parameters<typeof fetchSalesKpi>[0] = { period };
      if (period === "custom") {
        const from = jalaliValueToGregorian(fromJ);
        const to = jalaliValueToGregorian(toJ);
        if (!from || !to) throw new Error("شروع و پایان بازه را به شمسی انتخاب کنید.");
        q.from = from; q.to = to;
      }
      if (t !== "") q.teamId = Number(t);
      setReport(await fetchSalesKpi(q));
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "خطا"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const expert = useMemo(() => {
    if (!report) return null;
    if (expertId !== "") return report.experts.find((e) => e.salespersonId === expertId) ?? report.experts[0] ?? null;
    return report.experts[0] ?? null;
  }, [report, expertId]);
  const groupKpis = useMemo(() => (expert?.kpis ?? []).filter((k) => k.group === tab), [expert, tab]);

  const goTab = (id: (typeof TABS)[number]["id"]) => {
    setTab(id);
    requestAnimationFrame(() => {
      const el = tabsRef.current?.querySelector<HTMLElement>(`[data-testid=skpi-tab-${id}]`);
      el?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    });
  };

  const showFilters = tab !== "settings";
  const showExpertFilter = isManager && tab !== "settings" && tab !== "team";
  const showRank = tab !== "settings" && tab !== "team";
  const showButtonLabel = loading && !report ? "در حال محاسبه…" : "نمایش";

  return (
    <div className="skpi" dir="rtl" lang="fa" data-testid="page-sales-kpi">
      <header className="skpi-h">
        <h1>شاخص‌های فروش</h1>
        <p className="skpi-lead">
          {isManager ? "عملکرد تیم و کارشناسان در یک دوره." : "عملکرد شما و جمع تیم."}
        </p>
      </header>
      {showFilters && (
        <div className="skpi-period">
          <label>بازه
            <select value={period} onChange={(e) => setPeriod(e.target.value as "month" | "custom")} data-testid="skpi-period">
              <option value="month">ماه جاری شمسی</option>
              <option value="custom">بازه دلخواه</option>
            </select>
          </label>
          {period === "custom" && (
            <>
              <label>از
                <PersianDatePicker value={fromJ} onChange={setFromJ} displayDigits testId="skpi-from" />
              </label>
              <label>تا
                <PersianDatePicker value={toJ} onChange={setToJ} displayDigits testId="skpi-to" />
              </label>
            </>
          )}
          {isManager && (
            <label>تیم
              <select value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")} data-testid="skpi-team">
                <option value="">همه تیم‌ها</option>
                {(report?.filters.teams ?? []).map((t) => <option key={t.teamId} value={t.teamId}>{t.name}</option>)}
              </select>
            </label>
          )}
          {showExpertFilter && (
            <label>کارشناس
              <select value={expertId} onChange={(e) => setExpertId(e.target.value ? Number(e.target.value) : "")} data-testid="skpi-expert">
                <option value="">انتخاب کارشناس</option>
                {(report?.filters.experts ?? []).map((x) => <option key={x.salespersonId} value={x.salespersonId}>{x.name}</option>)}
              </select>
            </label>
          )}
          <button type="button" data-testid="skpi-show" data-loading={loading ? "1" : "0"} onClick={() => void load()} disabled={loading}>{showButtonLabel}</button>
        </div>
      )}
      {err && <p className="skpi-err">{err}</p>}
      {showFilters && report?.callDataIncomplete && <p className="skpi-ban">بخشی از داده‌های تماس این بازه مربوط به قبل از ۳ آبان ۱۴۰۵ است و با برچسب «داده‌ی ناقص» مشخص شده.</p>}
      {showFilters && report && (
        <p className="skpi-lead" style={{ marginBottom: 12 }}>
          دوره: {ui(report.label)}، مقایسه با {ui(report.previousLabel)}، {ui(report.workingDays)} روز کاری
        </p>
      )}
      <ul className="skpi-tabs" ref={tabsRef} data-testid="skpi-tabs">
        {TABS.map((t) => {
          if (t.id === "settings" && !canEdit) return null;
          return (
            <li key={t.id}>
              <button type="button" className={tab === t.id ? "on" : ""} onClick={() => goTab(t.id)} data-testid={`skpi-tab-${t.id}`}>{t.label}</button>
            </li>
          );
        })}
      </ul>
      {showRank && expert && (
        <div className="skpi-rank">
          {expert.name && <span className="skpi-chip">{expert.name}</span>}
          {expert.teamName && <span className="skpi-chip">{expert.teamName}</span>}
          <span className="skpi-chip">{expert.rankInTeam != null ? `رتبه در تیم: ${ui(expert.rankInTeam)}` : "بدون رتبه"}</span>
          {isManager && <span className="skpi-chip">{expert.rankOverall != null ? `رتبه کلی: ${ui(expert.rankOverall)}` : "بدون رتبه"}</span>}
        </div>
      )}
      {tab === "sales" && isManager && report && report.experts.length > 0 && (
        <div className="skpi-experts" data-testid="skpi-expert-list">
          {report.experts.map((e) => {
            const sales = e.kpis.find((k) => k.key === "successful_sales");
            const rank = e.rankInTeam != null ? `، رتبه ${ui(e.rankInTeam)}` : "، بدون رتبه";
            return (
              <button key={e.salespersonId} type="button" className={expertId === e.salespersonId ? "on" : ""} onClick={() => setExpertId(e.salespersonId)}>
                <span>{e.name}</span>
                <span>{sales ? ui(sales.display) : "—"}{rank}</span>
              </button>
            );
          })}
        </div>
      )}
      {tab === "settings" && canEdit && report && (
        <SettingsForm
          periodKey={report.periodKey}
          periodTitle={report.periodTitle || ""}
          teams={report.filters.teams}
          experts={report.filters.experts}
          onSaved={() => void load()}
        />
      )}
      {tab === "team" && (
        <div className="skpi-grid" data-testid="skpi-grid-team">
          {report?.teams.map((tm) => (
            <section key={tm.teamId} className="skpi-team-block">
              <h2 className="skpi-team-title">{tm.name}، {ui(tm.memberCount)} کارشناس فعال</h2>
              <div className="skpi-grid">{tm.kpis.filter((k) => k.group === "team" || k.group === "sales").map((k) => <Card key={k.key} kpi={k} canEdit={canEdit} onOpenSettings={() => goTab("settings")} />)}</div>
            </section>
          ))}
          {report && report.teams.length === 0 && <p>تیمی برای نمایش نیست.</p>}
        </div>
      )}
      {tab !== "team" && tab !== "settings" && (
        <div className="skpi-grid" data-testid={`skpi-grid-${tab}`}>
          {groupKpis.map((k) => <Card key={k.key} kpi={k} canEdit={canEdit} onOpenSettings={() => goTab("settings")} />)}
          {!expert && <p>برای دیدن شاخص‌های فردی، یک کارشناس را انتخاب کنید.</p>}
        </div>
      )}
    </div>
  );
}

function SettingsForm({ periodKey, periodTitle, teams, experts, onSaved }: {
  periodKey: string; periodTitle: string;
  teams: { teamId: number; name: string }[];
  experts: { salespersonId: number; name: string | null; teamId: number | null }[];
  onSaved: () => void;
}) {
  const [step, setStep] = useState(1);
  const [stale, setStale] = useState("");
  const [oldD, setOldD] = useState("");
  const [prevD, setPrevD] = useState("");
  const [inv, setInv] = useState("");
  const [reg, setReg] = useState("");
  const [base, setBase] = useState("");
  const [scopeKind, setScopeKind] = useState<"expert" | "team">("expert");
  const [scopeId, setScopeId] = useState("");
  const [target, setTarget] = useState("");
  const [minT, setMinT] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetchKpiSettings(periodKey).then((s) => {
      setStale(s.staleDays != null ? String(s.staleDays) : "");
      setOldD(s.oldCustomerDays != null ? String(s.oldCustomerDays) : "");
      setPrevD(s.prevBuyerFollowupDays != null ? String(s.prevBuyerFollowupDays) : "");
      setInv(s.invoiceReviewSlaHours != null ? String(s.invoiceReviewSlaHours) : "");
      setReg(s.registrarDeliverySlaHours != null ? String(s.registrarDeliverySlaHours) : "");
      setBase(s.zeroPrevBaseline != null ? String(s.zeroPrevBaseline) : "");
    }).catch((e) => setErr(e instanceof Error ? e.message : "خطا"));
  }, [periodKey]);

  const numOrNull = (s: string) => {
    const t = s.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  const save = async () => {
    setErr(""); setMsg("");
    const fields = [stale, oldD, prevD, inv, reg, base, target, minT];
    if (fields.some((v) => v.trim() && numOrNull(v) == null)) {
      setErr("فقط عدد وارد کنید.");
      return;
    }
    if ([stale, oldD, prevD, inv, reg, base, target, minT].some((v) => {
      const n = numOrNull(v);
      return n != null && n < 0;
    })) {
      setErr("مقدارها نمی‌توانند منفی باشند.");
      return;
    }
    if ((target.trim() || minT.trim()) && !scopeId) {
      setErr("تیم یا کارشناس را از فهرست انتخاب کنید.");
      return;
    }
    try {
      const body: Record<string, unknown> = {
        staleDays: numOrNull(stale),
        oldCustomerDays: numOrNull(oldD),
        prevBuyerFollowupDays: numOrNull(prevD),
        invoiceReviewSlaHours: numOrNull(inv),
        registrarDeliverySlaHours: numOrNull(reg),
        zeroPrevBaseline: numOrNull(base),
        periodKey,
      };
      const sid = Number(scopeId);
      if (scopeId && Number.isInteger(sid) && sid > 0) {
        body.targets = [{ periodKey, scopeKind, scopeId: sid, targetCount: numOrNull(target), minTargetCount: numOrNull(minT) }];
      }
      await saveKpiSettings(body);
      setMsg("تنظیمات ذخیره شد.");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "خطا"); }
  };

  const names = scopeKind === "team"
    ? teams.map((t) => ({ id: t.teamId, name: t.name }))
    : experts.map((x) => ({ id: x.salespersonId, name: x.name || `کارشناس ${x.salespersonId}` }));

  return (
    <div className="skpi-settings skpi-card" data-testid="skpi-settings" data-step={step}>
      <div className="skpi-progress" data-testid="skpi-settings-progress" role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step} aria-label={`گام ${ui(step)} از ۳`}>
        <div className="skpi-progress-head"><strong>{step === 1 ? "روزها" : step === 2 ? "مهلت‌ها" : `هدف فروش${periodTitle ? `، دورهٔ ${periodTitle}` : ""}`}</strong><span>گام {ui(step)} از ۳</span></div>
        <div className="skpi-progress-bar">{[1, 2, 3].map((i) => <span key={i} className={i <= step ? "is-on" : ""} />)}</div>
      </div>
      {step === 1 && (
        <div className="row">
          <FaNumberInput label="روزهای رکود پرونده (روز)" value={stale} onChange={setStale} placeholder="روز" testId="skpi-set-stale" />
          <FaNumberInput label="روز تعریف مشتری قدیمی (روز)" value={oldD} onChange={setOldD} placeholder="روز" testId="skpi-set-old" />
          <FaNumberInput label="فاصله پیگیری خریدار قبلی (روز)" value={prevD} onChange={setPrevD} placeholder="روز" testId="skpi-set-prev" />
        </div>
      )}
      {step === 2 && (
        <div className="row">
          <FaNumberInput label="مهلت بررسی فاکتور (ساعت)" value={inv} onChange={setInv} placeholder="ساعت" testId="skpi-set-inv" />
          <FaNumberInput label="مهلت تحویل به واحد ثبت (ساعت)" value={reg} onChange={setReg} placeholder="ساعت" testId="skpi-set-reg" />
          <FaNumberInput label="مبنای رشد وقتی دورهٔ قبل صفر است (درصد)" value={base} onChange={setBase} placeholder="درصد" testId="skpi-set-base" />
        </div>
      )}
      {step === 3 && (
        <div className="row">
          <label>نوع
            <select value={scopeKind} onChange={(e) => { setScopeKind(e.target.value as "expert" | "team"); setScopeId(""); }} data-testid="skpi-set-kind">
              <option value="expert">کارشناس</option>
              <option value="team">تیم</option>
            </select>
          </label>
          <label>{scopeKind === "team" ? "تیم" : "کارشناس"}
            <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} data-testid="skpi-set-scope">
              <option value="">{scopeKind === "team" ? "انتخاب تیم" : "انتخاب کارشناس"}</option>
              {names.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </label>
          <FaNumberInput label="هدف تعداد فروش (فروش)" value={target} onChange={setTarget} placeholder="فروش" testId="skpi-set-target" />
          <FaNumberInput label="حداقل هدف مشارکت (فروش برای هر کارشناس)" value={minT} onChange={setMinT} placeholder="فروش" testId="skpi-set-min" />
        </div>
      )}
      {err && <p className="skpi-err" data-testid="skpi-settings-err">{err}</p>}
      {msg && <div className="skpi-success" data-testid="skpi-settings-ok" role="status">{msg}</div>}
      <div className="skpi-wiz-actions">
        {step > 1 && <button type="button" className="ghost" onClick={() => { setErr(""); setMsg(""); setStep((s) => s - 1); }} data-testid="skpi-settings-prev">قبلی</button>}
        {step < 3 && <button type="button" onClick={() => { setErr(""); setMsg(""); setStep((s) => s + 1); }} data-testid="skpi-settings-next">ادامه</button>}
        {step === 3 && <button type="button" onClick={() => void save()} data-testid="skpi-settings-save">ذخیره</button>}
      </div>
    </div>
  );
}
