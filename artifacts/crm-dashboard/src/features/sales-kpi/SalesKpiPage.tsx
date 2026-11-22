/** t886 «شاخص‌های فروش»: شبکهٔ متقارن grid-v1 + ویزارد تنظیمات. flag.sales_kpi_v1 off → «فعال نیست». */
import { useEffect, useMemo, useState } from "react";
import { faDigits } from "@/lib/credit-grade";
import { PersianDatePicker } from "@/components/PersianDatePicker";
import { formatJalaliValue, jalaliValueToGregorian, tehranPersianParts } from "@/lib/jalali";
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
] as const;

type TabId = (typeof TABS)[number]["id"];

const FA = "۰۱۲۳۴۵۶۷۸۹";
const ui = (v: string | number) => faDigits(String(v));
const toFa = (s: string) => String(s).replace(/\d/g, (d) => FA[Number(d)]).replace(/[٠-٩]/g, (d) => FA["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);
const toEn = (s: string) => String(s)
  .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
  .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
  .replace(/[^\d.]/g, "");

const MONTH_NAMES = ["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];
function recentJalaliMonths(count = 6): { anchor: string; label: string }[] {
  const parts = tehranPersianParts(new Date());
  const out: { anchor: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    let m = parts.month - i;
    let y = parts.year;
    while (m < 1) { m += 12; y -= 1; }
    const g = jalaliValueToGregorian(formatJalaliValue(y, m, 1));
    if (!g) continue;
    out.push({ anchor: g, label: `${MONTH_NAMES[m - 1] ?? ""} ${toFa(String(y))}`.trim() });
  }
  return out;
}

function compactFaRange(s: string): string {
  const m = String(s).trim().match(/^(\S+)\s+(\S+)\s+تا\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (m && m[2] === m[4]) return `${m[1]} تا ${m[3]} ${m[4]} ${m[5]}`;
  return s;
}

function groupExperts(experts: SalesKpiReport["experts"], teams: { teamId: number; name: string }[]) {
  const byTeam = new Map<number, typeof experts>();
  const noTeam: typeof experts = [];
  for (const e of experts) {
    if (e.teamId == null) noTeam.push(e);
    else {
      const list = byTeam.get(e.teamId) ?? [];
      list.push(e);
      byTeam.set(e.teamId, list);
    }
  }
  const rankKey = (e: (typeof experts)[number]) => e.rankInTeam == null ? 1e9 : e.rankInTeam;
  const sortMembers = (list: typeof experts) => [...list].sort((a, b) => rankKey(a) - rankKey(b) || (a.name || "").localeCompare(b.name || "", "fa"));
  const groups: { teamId: number; name: string; members: typeof experts }[] = [];
  for (const tm of teams) {
    const members = byTeam.get(tm.teamId);
    if (members?.length) groups.push({ teamId: tm.teamId, name: tm.name, members: sortMembers(members) });
    byTeam.delete(tm.teamId);
  }
  for (const [teamId, members] of byTeam) {
    groups.push({ teamId, name: members[0]?.teamName || "تیم", members: sortMembers(members) });
  }
  if (noTeam.length) groups.push({ teamId: 0, name: "بدون تیم", members: sortMembers(noTeam) });
  return groups;
}

function splitValue(kpi: KpiCell): { num: string; unit: string; muted: boolean } {
  if (kpi.status !== "ok" || kpi.value == null) return { num: "—", unit: "", muted: true };
  const d = kpi.display;
  if (kpi.unit === "count" && d.endsWith(" فروش")) return { num: d.slice(0, -" فروش".length).trim(), unit: "فروش", muted: false };
  if (kpi.unit === "amount" && d.endsWith(" تومان")) return { num: d.slice(0, -" تومان".length).trim(), unit: "تومان", muted: false };
  if (kpi.unit === "percent" && d.endsWith("٪")) return { num: d, unit: "", muted: false };
  if (kpi.unit === "pp" && d.endsWith(" واحد درصد")) return { num: d.slice(0, -" واحد درصد".length).trim(), unit: "واحد درصد", muted: false };
  return { num: d, unit: "", muted: false };
}

function splitDelta(kpi: KpiCell): { value: string } | null {
  if (kpi.status !== "ok" || !kpi.deltaDisplay) return null;
  const p = "نسبت به دورهٔ قبل: ";
  const value = kpi.deltaDisplay.startsWith(p) ? kpi.deltaDisplay.slice(p.length) : kpi.deltaDisplay;
  return { value };
}

function statusKind(kpi: KpiCell): "source" | "setting" | "nobase" | "empty" | "partial" | "lower" | null {
  if (kpi.status === "missing" && kpi.missingKind === "source") return "source";
  if (kpi.status === "missing") return "setting";
  if (kpi.status === "no_baseline") return "nobase";
  if (kpi.status === "empty_denom") return "empty";
  if (kpi.incomplete) return "partial";
  if (kpi.direction === "lower_better" && kpi.status === "ok") return "lower";
  return null;
}

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

function Card({ kpi, canEdit, onOpenSettings, onOpenFormula }: {
  kpi: KpiCell; canEdit: boolean; onOpenSettings?: () => void; onOpenFormula: (kpi: KpiCell) => void;
}) {
  const { num, unit, muted } = splitValue(kpi);
  const delta = splitDelta(kpi);
  const kind = statusKind(kpi);
  return (
    <article className="kc" data-testid={`skpi-card-${kpi.key}`} data-status={kpi.status} data-direction={kpi.direction ?? ""}>
      <header className="s-a">
        <h3>{kpi.label}</h3>
        <button type="button" className="fbtn" data-testid="skpi-formula" onClick={() => onOpenFormula(kpi)}>فرمول</button>
      </header>
      <div className="s-b">
        <span className={`num${muted ? " mute" : ""}`}>{ui(num)}</span>
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      <div className="s-c">{kpi.status === "ok" && kpi.fractionLabel ? ui(kpi.fractionLabel) : null}</div>
      <div className="s-d">
        {delta ? (
          <>
            <span className="cl">نسبت به دورهٔ قبل</span>
            <span className="dv">{ui(delta.value)}</span>
          </>
        ) : null}
      </div>
      <div className="s-e">
        {kind === "setting" && canEdit && onOpenSettings ? (
          <button type="button" className="chipbtn" data-testid="skpi-define-settings" onClick={onOpenSettings}>تعریف در تنظیمات</button>
        ) : kind === "setting" ? <span className="chip tint">نیاز به تنظیم</span>
        : kind === "source" ? <span className="chip neutral">منبع داده ندارد</span>
        : kind === "nobase" ? <span className="chip neutral">مبنا تعریف نشده</span>
        : kind === "empty" ? <span className="chip neutral">بدون مورد در این دوره</span>
        : kind === "partial" ? <span className="chip amber">داده‌ی ناقص</span>
        : kind === "lower" ? <span className="chip neutral">کمتر بهتر است</span>
        : null}
      </div>
      <footer className="s-f">
        <button type="button" className="fbtn" data-testid="skpi-formula" onClick={() => onOpenFormula(kpi)}>فرمول</button>
      </footer>
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
    return <div className="skpi skpi-off" dir="rtl" data-testid="page-sales-kpi-loading"><p>در حال بارگذاری…</p></div>;
  }
  if (!me.enabled) {
    return (
      <div className="skpi skpi-off" dir="rtl" data-testid="skpi-flag-off">
        <div className="kc" style={{ height: "auto", minHeight: 112 }}><h3>شاخص‌های فروش فعال نیست</h3><p className="s-c" style={{ height: "auto" }}>این گزارش هنوز فعال نیست.</p></div>
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
  const monthOptions = useMemo(() => recentJalaliMonths(6), []);
  const initialPeriod = qs.get("period") === "custom" ? "custom" : (qs.get("anchor") || (qs.get("period") === "month" || !qs.get("period") ? "month" : qs.get("period") || "month"));
  const [tab, setTab] = useState<TabId>("sales");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [period, setPeriod] = useState(initialPeriod);
  const [fromJ, setFromJ] = useState(qs.get("from") || "");
  const [toJ, setToJ] = useState(qs.get("to") || "");
  const [teamId, setTeamId] = useState<number | "">("");
  const [expertId, setExpertId] = useState<number | "">(isManager ? "" : (selfId ?? ""));
  const [report, setReport] = useState<SalesKpiReport | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [formula, setFormula] = useState<KpiCell | null>(null);

  const load = async (over?: { teamId?: number | "" }) => {
    setLoading(true); setErr("");
    try {
      const t = over?.teamId !== undefined ? over.teamId : teamId;
      const q: Parameters<typeof fetchSalesKpi>[0] = {};
      if (period === "custom") {
        const from = jalaliValueToGregorian(fromJ);
        const to = jalaliValueToGregorian(toJ);
        if (!from || !to) throw new Error("شروع و پایان بازه را به شمسی انتخاب کنید.");
        q.period = "custom"; q.from = from; q.to = to;
      } else {
        q.period = "month";
        if (period !== "month") q.anchor = period;
      }
      if (t !== "") q.teamId = Number(t);
      setReport(await fetchSalesKpi(q));
    } catch (ex) { setErr(ex instanceof Error ? ex.message : "خطا"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!isManager || !report) return;
    const ids = new Set(report.experts.map((e) => e.salespersonId));
    if (expertId !== "" && ids.has(Number(expertId))) return;
    if (report.experts[0]) setExpertId(report.experts[0].salespersonId);
  }, [report, isManager]);

  const expert = useMemo(() => {
    if (!report) return null;
    if (expertId !== "") return report.experts.find((e) => e.salespersonId === expertId) ?? report.experts[0] ?? null;
    return report.experts[0] ?? null;
  }, [report, expertId]);
  const groupKpis = useMemo(() => (expert?.kpis ?? []).filter((k) => k.group === tab), [expert, tab]);
  const groups = useMemo(() => report ? groupExperts(report.experts, report.filters.teams) : [], [report]);

  const goTab = (id: TabId) => { setSettingsOpen(false); setTab(id); };
  const openSettings = () => { setSettingsOpen(true); };

  const showFilters = !settingsOpen;
  const showExpertFilter = isManager && !settingsOpen && tab !== "team";
  const showButtonLabel = loading && !report ? "در حال محاسبه…" : "نمایش";
  const periodText = report ? `دوره: ${ui(compactFaRange(report.label))}، ${ui(report.workingDays)} روز کاری` : "";
  const compareText = report ? `مقایسه با ${ui(compactFaRange(report.previousLabel))}` : "";

  const maxRows = Math.max(0, ...groups.map((g) => g.members.length));

  return (
    <div className="skpi" dir="rtl" lang="fa" data-testid="page-sales-kpi">
      <header className="ph">
        <div>
          <h1>شاخص‌های فروش</h1>
          <p>{isManager ? "عملکرد تیم و کارشناسان در یک دوره." : "عملکرد شما و جمع تیم."}</p>
        </div>
        {canEdit && (
          <button type="button" className={`setbtn${settingsOpen ? " on" : ""}`} data-testid="skpi-settings-btn" onClick={openSettings}>تنظیمات</button>
        )}
      </header>

      {showFilters && (
        <div className="filters">
          <div className="fc">
            <label>بازه</label>
            <select className="fld sel" value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="skpi-period">
              <option value="month">ماه جاری شمسی</option>
              {monthOptions.map((m) => <option key={m.anchor} value={m.anchor}>{m.label}</option>)}
              <option value="custom">بازه دلخواه</option>
            </select>
          </div>
          {period === "custom" && (
            <>
              <div className="fc">
                <label>از</label>
                <div className="skpi-date">
                  <PersianDatePicker value={fromJ} onChange={setFromJ} displayDigits testId="skpi-from" />
                </div>
              </div>
              <div className="fc">
                <label>تا</label>
                <div className="skpi-date">
                  <PersianDatePicker value={toJ} onChange={setToJ} displayDigits testId="skpi-to" />
                </div>
              </div>
            </>
          )}
          {isManager && (
            <div className="fc">
              <label>تیم</label>
              <select className="fld sel" value={teamId} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")} data-testid="skpi-team">
                <option value="">همهٔ تیم‌ها</option>
                {(report?.filters.teams ?? []).map((t) => <option key={t.teamId} value={t.teamId}>{t.name}</option>)}
              </select>
            </div>
          )}
          {showExpertFilter && (
            <div className="fc">
              <label>کارشناس</label>
              <select className="fld sel" value={expertId} onChange={(e) => setExpertId(e.target.value ? Number(e.target.value) : "")} data-testid="skpi-expert">
                <option value="">انتخاب کارشناس</option>
                {(report?.filters.experts ?? []).map((x) => <option key={x.salespersonId} value={x.salespersonId}>{x.name}</option>)}
              </select>
            </div>
          )}
          <div className="fc fc-show">
            <label className="ghost">&nbsp;</label>
            <button type="button" className="show" data-testid="skpi-show" data-loading={loading ? "1" : "0"} onClick={() => void load()} disabled={loading}>{showButtonLabel}</button>
          </div>
        </div>
      )}

      {err && <p className="skpi-err">{err}</p>}
      {showFilters && report && (
        <p className="period"><span>{periodText}</span><span>{compareText}</span></p>
      )}

      <nav className="tabs" data-testid="skpi-tabs">
        {TABS.map((t) => (
          <button type="button" key={t.id} className={`tab${!settingsOpen && tab === t.id ? " on" : ""}`} onClick={() => goTab(t.id)} data-testid={`skpi-tab-${t.id}`}>{t.label}</button>
        ))}
      </nav>

      {settingsOpen && canEdit && report && (
        <section className="sec">
          <SettingsForm
            periodKey={report.periodKey}
            periodTitle={report.periodTitle || ""}
            teams={report.filters.teams}
            experts={report.filters.experts}
            onSaved={() => void load()}
          />
        </section>
      )}

      {!settingsOpen && tab === "sales" && isManager && report && groups.length > 0 && (
        <section className="sec">
          <div className="sh"><h2>کارشناسان</h2><div className="shm" /></div>
          <div className="tables" data-testid="skpi-expert-list">
            {groups.map((g) => {
              const pad = Math.max(0, maxRows - g.members.length);
              return (
                <div key={g.teamId} className="tt">
                  <div className="tth"><b>{g.name}</b><span>{ui(g.members.length)} کارشناس</span></div>
                  <div className="thead"><span className="c-rank">رتبه در تیم</span><span className="c-name">کارشناس</span><span className="c-val">فروش موفق</span></div>
                  {g.members.map((e) => {
                    const sales = e.kpis.find((k) => k.key === "successful_sales");
                    const salesNum = sales && sales.status === "ok" && sales.value != null ? splitValue(sales).num : "۰";
                    return (
                      <button key={e.salespersonId} type="button" className={`tr${expertId === e.salespersonId ? " sel" : ""}`} onClick={() => setExpertId(e.salespersonId)}>
                        <span className="c-rank">{e.rankInTeam != null ? `رتبه ${ui(e.rankInTeam)}` : "بدون رتبه"}</span>
                        <span className="c-name">{e.name}</span>
                        <span className="c-val">{ui(salesNum)} <small>فروش</small></span>
                      </button>
                    );
                  })}
                  {Array.from({ length: pad }, (_, i) => <div key={`pad-${i}`} className="tr pad" aria-hidden="true" />)}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {!settingsOpen && tab !== "team" && (
        <section className="sec">
          {expert && (
            <div className="sh">
              <h2>{isManager ? `شاخص‌های ${expert.name || "کارشناس"}` : "شاخص‌های شما"}</h2>
              <div className="shm">
                {isManager ? null : (expert.name && <span className="pill">{expert.name}</span>)}
                {expert.teamName && <span className="pill">{expert.teamName}</span>}
                <span className="pill">{`رتبه در تیم: ${expert.rankInTeam != null ? ui(expert.rankInTeam) : "بدون رتبه"}`}</span>
                {isManager && <span className="pill">{`رتبه‌ی کلی: ${expert.rankOverall != null ? ui(expert.rankOverall) : "بدون رتبه"}`}</span>}
              </div>
            </div>
          )}
          <div className="cards" data-testid={`skpi-grid-${tab}`}>
            {groupKpis.map((k) => <Card key={k.key} kpi={k} canEdit={canEdit} onOpenSettings={openSettings} onOpenFormula={setFormula} />)}
            {!expert && <p>برای دیدن شاخص‌های فردی، یک کارشناس را انتخاب کنید.</p>}
          </div>
        </section>
      )}

      {!settingsOpen && tab === "team" && (
        <div className="skpi-teams" data-testid="skpi-grid-team">
          {report?.teams.map((tm, i) => {
            const sales = tm.kpis.filter((k) => k.group === "sales");
            const rest = tm.kpis.filter((k) => k.group === "team");
            const self = report.experts.find((e) => e.salespersonId === selfId && e.teamId === tm.teamId);
            return (
              <section key={tm.teamId} className={`block${i === 0 ? " first" : ""}`}>
                <div className="bh">
                  <h2 className="bh-title">{tm.name}</h2>
                  <div className="shm">
                    <span className="pill">{ui(tm.memberCount)} کارشناس فعال</span>
                    {!isManager && self && (
                      <span className="pill">{`رتبهٔ شما در تیم: ${self.rankInTeam != null ? ui(self.rankInTeam) : "بدون رتبه"}`}</span>
                    )}
                  </div>
                </div>
                <h3 className="sub">فروش تیم</h3>
                <div className="cards">{sales.map((k) => <Card key={k.key} kpi={k} canEdit={canEdit} onOpenSettings={openSettings} onOpenFormula={setFormula} />)}</div>
                <h3 className="sub">نظم و رشد تیم</h3>
                <div className="cards">{rest.map((k) => <Card key={k.key} kpi={k} canEdit={canEdit} onOpenSettings={openSettings} onOpenFormula={setFormula} />)}</div>
              </section>
            );
          })}
          {report && report.teams.length === 0 && <p>تیمی برای نمایش نیست.</p>}
        </div>
      )}

      {formula && (
        <div className="fsheet" data-testid="skpi-formula-sheet" role="presentation">
          <div className="fback" onClick={() => setFormula(null)} />
          <div className="fbox" role="dialog" aria-modal="true" aria-labelledby="skpi-formula-title">
            <h3 id="skpi-formula-title">{formula.label}</h3>
            <p>{formula.formula}</p>
            {formula.assumption && <p>{formula.assumption}</p>}
            {formula.missingReason && <p>{formula.missingReason}</p>}
            <button type="button" className="fclose" data-testid="skpi-formula-close" onClick={() => setFormula(null)}>بستن</button>
          </div>
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
  const [scopeInvalid, setScopeInvalid] = useState(false);

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
    setErr(""); setMsg(""); setScopeInvalid(false);
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
      setScopeInvalid(true);
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
    <div className="skpi-settings" data-testid="skpi-settings" data-step={step}>
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
            <select value={scopeKind} onChange={(e) => { setScopeKind(e.target.value as "expert" | "team"); setScopeId(""); setScopeInvalid(false); }} data-testid="skpi-set-kind">
              <option value="expert">کارشناس</option>
              <option value="team">تیم</option>
            </select>
          </label>
          <label>{scopeKind === "team" ? "تیم" : "کارشناس"}
            <select value={scopeId} className={scopeInvalid ? "is-invalid" : ""} onChange={(e) => { setScopeId(e.target.value); setScopeInvalid(false); }} data-testid="skpi-set-scope">
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
