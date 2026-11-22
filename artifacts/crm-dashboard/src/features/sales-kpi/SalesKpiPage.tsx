/** t886 «شاخص‌های فروش»: چهار گروه KPI. flag.sales_kpi_v1 off → «فعال نیست». */
import { useEffect, useMemo, useState } from "react";
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

const ui = (v: string | number) => faDigits(String(v));

function Card({ kpi }: { kpi: KpiCell }) {
  const cls = kpi.status === "missing" ? "missing" : kpi.status === "empty_denom" ? "empty" : kpi.status === "no_baseline" ? "baseline" : "ok";
  return (
    <article className={`skpi-card ${cls}`} data-testid={`skpi-card-${kpi.key}`} data-status={kpi.status}>
      <h3>{kpi.label}</h3>
      <div className="skpi-val">{ui(kpi.display)}</div>
      {kpi.numerator != null && kpi.denominator != null && kpi.status === "ok" && (
        <p className="skpi-frac">{ui(String(kpi.numerator))} از {ui(String(kpi.denominator))}</p>
      )}
      {kpi.incomplete && <p className="skpi-frac">داده‌ی ناقص</p>}
      <details className="skpi-tip">
        <summary>فرمول</summary>
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
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("sales");
  const [period, setPeriod] = useState<"month" | "custom">("month");
  const [fromJ, setFromJ] = useState("");
  const [toJ, setToJ] = useState("");
  const [teamId, setTeamId] = useState<number | "">("");
  const [expertId, setExpertId] = useState<number | "">(isManager ? "" : (selfId ?? ""));
  const [report, setReport] = useState<SalesKpiReport | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async (over?: { teamId?: number | ""; expertId?: number | "" }) => {
    setLoading(true); setErr("");
    try {
      const t = over?.teamId !== undefined ? over.teamId : teamId;
      const e = over?.expertId !== undefined ? over.expertId : expertId;
      const q: Parameters<typeof fetchSalesKpi>[0] = { period };
      if (period === "custom") {
        const from = jalaliValueToGregorian(fromJ);
        const to = jalaliValueToGregorian(toJ);
        if (!from || !to) throw new Error("شروع و پایان بازه را به شمسی انتخاب کنید.");
        q.from = from; q.to = to;
      }
      if (t !== "") q.teamId = Number(t);
      if (e !== "") q.expertId = Number(e);
      setReport(await fetchSalesKpi(q));
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "خطا"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const expert = report?.experts[0] ?? null;
  const groupKpis = useMemo(() => (expert?.kpis ?? []).filter((k) => k.group === tab), [expert, tab]);
  const teamKpis = report?.teams[0]?.kpis ?? [];

  return (
    <div className="skpi" dir="rtl" lang="fa" data-testid="page-sales-kpi">
      <header className="skpi-h">
        <h1>شاخص‌های فروش</h1>
        <p className="skpi-lead">
          {isManager
            ? "عملکرد تیم و هر کارشناس را در یک دوره ببینید. هدف فروش و چند تعریف دیگر از تنظیمات همین صفحه وارد می‌شود."
            : "عملکرد خودتان و جمع تیم‌تان را ببینید. نام دیگر کارشناسان تیم نشان داده نمی‌شود."}
        </p>
      </header>
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
              <PersianDatePicker value={fromJ} onChange={setFromJ} />
            </label>
            <label>تا
              <PersianDatePicker value={toJ} onChange={setToJ} />
            </label>
          </>
        )}
        {isManager && (
          <>
            <label>تیم
              <select value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")} data-testid="skpi-team">
                <option value="">همه تیم‌ها</option>
                {(report?.filters.teams ?? []).map((t) => <option key={t.teamId} value={t.teamId}>{t.name}</option>)}
              </select>
            </label>
            <label>کارشناس
              <select value={expertId} onChange={(e) => setExpertId(e.target.value ? Number(e.target.value) : "")} data-testid="skpi-expert">
                <option value="">انتخاب کارشناس</option>
                {(report?.filters.experts ?? []).map((x) => <option key={x.salespersonId} value={x.salespersonId}>{x.name}</option>)}
              </select>
            </label>
          </>
        )}
        <button type="button" onClick={() => void load()} disabled={loading}>{loading ? "در حال محاسبه…" : "نمایش"}</button>
      </div>
      {err && <p className="skpi-err">{err}</p>}
      {report?.callDataIncomplete && <p className="skpi-ban">بخشی از داده‌های تماس این بازه مربوط به قبل از ۳ آبان ۱۴۰۵ است و با برچسب «داده‌ی ناقص» مشخص شده.</p>}
      {report && (
        <p className="skpi-lead" style={{ marginBottom: 12 }}>
          دوره: {ui(report.label)} · مقایسه با {ui(report.previousLabel)} · {ui(report.workingDays)} روز کاری
        </p>
      )}
      {expert && (
        <div className="skpi-rank">
          {expert.name && <span className="skpi-chip">{expert.name}</span>}
          {expert.teamName && <span className="skpi-chip">{expert.teamName}</span>}
          {expert.rankInTeam != null && <span className="skpi-chip">رتبه در تیم: {ui(expert.rankInTeam)}</span>}
          {isManager && expert.rankOverall != null && <span className="skpi-chip">رتبه کلی: {ui(expert.rankOverall)}</span>}
        </div>
      )}
      {isManager && report && report.experts.length > 1 && tab !== "team" && tab !== "settings" && (
        <div className="skpi-experts" data-testid="skpi-expert-list">
          {report.experts.map((e) => {
            const sales = e.kpis.find((k) => k.key === "successful_sales");
            return (
              <button key={e.salespersonId} type="button" className={expertId === e.salespersonId ? "on" : ""} onClick={() => { setExpertId(e.salespersonId); void load({ expertId: e.salespersonId }); }}>
                <span>{e.name}</span>
                <span>{sales ? ui(sales.display) : "—"}{e.rankInTeam != null ? ` · رتبه ${ui(e.rankInTeam)}` : ""}</span>
              </button>
            );
          })}
        </div>
      )}
      <ul className="skpi-tabs">
        {TABS.map((t) => {
          if (t.id === "settings" && !canEdit) return null;
          return (
            <li key={t.id}>
              <button type="button" className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} data-testid={`skpi-tab-${t.id}`}>{t.label}</button>
            </li>
          );
        })}
      </ul>
      {tab === "settings" && canEdit && report && <SettingsForm periodKey={report.periodKey} onSaved={() => void load()} />}
      {tab === "team" && (
        <div className="skpi-grid" data-testid="skpi-grid-team">
          {report?.teams.map((tm) => (
            <section key={tm.teamId} style={{ gridColumn: "1 / -1" }}>
              <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>{tm.name} · {ui(tm.memberCount)} فروشنده فعال</h2>
              <div className="skpi-grid">{tm.kpis.filter((k) => k.group === "team" || k.group === "sales").map((k) => <Card key={k.key} kpi={k} />)}</div>
            </section>
          ))}
          {report && report.teams.length === 0 && <p>تیمی برای نمایش نیست.</p>}
        </div>
      )}
      {tab !== "team" && tab !== "settings" && (
        <div className="skpi-grid" data-testid={`skpi-grid-${tab}`}>
          {groupKpis.map((k) => <Card key={k.key} kpi={k} />)}
          {!expert && <p>برای دیدن شاخص‌های فردی، یک کارشناس را انتخاب کنید.</p>}
        </div>
      )}
    </div>
  );
}

function SettingsForm({ periodKey, onSaved }: { periodKey: string; onSaved: () => void }) {
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
    try {
      const body: Record<string, unknown> = {
        staleDays: numOrNull(stale),
        oldCustomerDays: numOrNull(oldD),
        prevBuyerFollowupDays: numOrNull(prevD),
        invoiceReviewSlaHours: numOrNull(inv),
        registrarDeliverySlaHours: numOrNull(reg),
        zeroPrevBaseline: numOrNull(base),
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

  return (
    <div className="skpi-settings skpi-card" data-testid="skpi-settings">
      <p className="skpi-lead">این مقدارها پیش‌فرض ندارند. تا وقتی خالی باشند، شاخص وابسته با «داده ندارد» نشان داده می‌شود. کلید دوره: {ui(periodKey)}</p>
      <div className="row">
        <label>روزهای رکود پرونده<input value={stale} onChange={(e) => setStale(e.target.value)} inputMode="numeric" /></label>
        <label>روز تعریف مشتری قدیمی<input value={oldD} onChange={(e) => setOldD(e.target.value)} inputMode="numeric" /></label>
        <label>فاصله پیگیری خریدار قبلی (روز)<input value={prevD} onChange={(e) => setPrevD(e.target.value)} inputMode="numeric" /></label>
        <label>مهلت بررسی فاکتور (ساعت)<input value={inv} onChange={(e) => setInv(e.target.value)} inputMode="numeric" /></label>
        <label>مهلت تحویل به واحد ثبت (ساعت)<input value={reg} onChange={(e) => setReg(e.target.value)} inputMode="numeric" /></label>
        <label>مبنا وقتی دوره قبل صفر است<input value={base} onChange={(e) => setBase(e.target.value)} inputMode="numeric" /></label>
      </div>
      <h3>هدف فروش این دوره</h3>
      <div className="row">
        <label>نوع
          <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as "expert" | "team")}>
            <option value="expert">کارشناس</option>
            <option value="team">تیم</option>
          </select>
        </label>
        <label>شناسه تیم یا کارشناس<input value={scopeId} onChange={(e) => setScopeId(e.target.value)} inputMode="numeric" /></label>
        <label>هدف تعداد فروش<input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="numeric" /></label>
        <label>حداقل هدف مشارکت<input value={minT} onChange={(e) => setMinT(e.target.value)} inputMode="numeric" /></label>
      </div>
      {err && <p className="skpi-err">{err}</p>}
      {msg && <p className="skpi-lead">{msg}</p>}
      <button type="button" onClick={() => void save()}>ذخیره تنظیمات</button>
    </div>
  );
}

