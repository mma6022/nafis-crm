/* t886 sales KPI client. flag.sales_kpi_v1 off → enabled:false / 404. */
import { useQuery } from "@tanstack/react-query";

const base = () => (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export type KpiStatus = "ok" | "missing" | "empty_denom" | "no_baseline";
export type KpiUnit = "count" | "percent" | "amount" | "pp" | "hours";
export type KpiGroup = "sales" | "discipline" | "growth" | "team";
export type KpiCell = {
  key: string; group: KpiGroup; label: string; formula: string;
  status: KpiStatus; value: number | null; display: string;
  numerator: number | null; denominator: number | null; unit: KpiUnit;
  assumption: string | null; missingReason: string | null; incomplete: boolean;
  missingKind?: "setting" | "source" | null;
  direction?: "higher_better" | "lower_better" | null;
  fractionLabel?: string | null;
  previousValue?: number | null;
  deltaDisplay?: string | null;
};
export type ExpertKpi = {
  salespersonId: number; name: string | null; userId: number | null; trainee: boolean;
  teamId: number | null; teamName: string | null;
  rankInTeam: number | null; rankOverall: number | null; kpis: KpiCell[];
};
export type TeamKpi = { teamId: number; name: string; memberCount: number; kpis: KpiCell[] };
export type SalesKpiMe = {
  enabled: boolean; flag: string; canView: boolean; canEditSettings: boolean;
  access: "manager" | "expert" | "trainee" | null;
  salespersonId: number | null; teamId: number | null; teamName: string | null;
  name: string | null; visibility: "all" | "self_and_team_totals" | null;
};
export type SalesKpiReport = {
  period: string; periodKey: string; periodTitle?: string; label: string; previousLabel: string;
  from: string; to: string; workingDays: number;
  incompleteFrom: string; callDataIncomplete: boolean;
  access: string; visibility: string;
  settings: Record<string, number | boolean | null>;
  teams: TeamKpi[]; experts: ExpertKpi[];
  filters: { teams: { teamId: number; name: string }[]; experts: { salespersonId: number; name: string | null; teamId: number | null }[] };
};
export type KpiSettings = {
  periodKey: string;
  staleDays: number | null; oldCustomerDays: number | null;
  prevBuyerFollowupDays: number | null; invoiceReviewSlaHours: number | null;
  registrarDeliverySlaHours: number | null; zeroPrevBaseline: number | null;
  targets: Array<{ periodKey: string; scopeKind: "expert" | "team"; scopeId: number; targetCount: number | null; minTargetCount: number | null }>;
};

export function useSalesKpiMe(enabled: boolean) {
  return useQuery<SalesKpiMe>({
    queryKey: ["sales-kpi-me"], enabled, retry: false, staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch(`${base()}/api/sales-kpi/me`, { credentials: "include" });
      if (!r.ok) return { enabled: false, flag: "flag.sales_kpi_v1", canView: false, canEditSettings: false, access: null, salespersonId: null, teamId: null, teamName: null, name: null, visibility: null };
      return (await r.json()) as SalesKpiMe;
    },
  });
}

export async function fetchSalesKpi(q: { period?: string; from?: string; to?: string; teamId?: number | null; expertId?: number | null }): Promise<SalesKpiReport> {
  const p = new URLSearchParams();
  if (q.period) p.set("period", q.period);
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  if (q.teamId) p.set("teamId", String(q.teamId));
  if (q.expertId) p.set("expertId", String(q.expertId));
  const r = await fetch(`${base()}/api/sales-kpi?${p.toString()}`, { credentials: "include" });
  if (!r.ok) throw new Error(r.status === 404 ? "این گزارش فعلاً فعال نیست." : r.status === 403 ? "دسترسی به این گزارش ندارید." : "خواندن شاخص‌ها ممکن نشد.");
  return r.json() as Promise<SalesKpiReport>;
}

export async function fetchKpiSettings(periodKey?: string): Promise<KpiSettings> {
  const q = periodKey ? `?periodKey=${encodeURIComponent(periodKey)}` : "";
  const r = await fetch(`${base()}/api/sales-kpi/settings${q}`, { credentials: "include" });
  if (!r.ok) throw new Error(r.status === 403 ? "تنظیمات فقط برای مدیر و مدیر فروش است." : "خواندن تنظیمات ممکن نشد.");
  return r.json() as Promise<KpiSettings>;
}

export async function saveKpiSettings(body: Record<string, unknown>): Promise<KpiSettings> {
  const r = await fetch(`${base()}/api/sales-kpi/settings`, {
    method: "PUT", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status === 403 ? "تنظیمات فقط برای مدیر و مدیر فروش است." : "ذخیرهٔ تنظیمات ممکن نشد.");
  return r.json() as Promise<KpiSettings>;
}
