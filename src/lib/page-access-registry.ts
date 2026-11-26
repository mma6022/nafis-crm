/**
 * «دسترسی این صفحه» v1 (t942u, Armita v1.1): the page registry. One entry per grantable staff page (58).
 * Source of truth for: page key ↔ dashboard routes, which existing permissions a page grant adds (view / manage),
 * which admin-only endpoints a grant opens (elevate), and which page-local endpoints a «بستن» (block) closes.
 * Static, versioned with the release; the dashboard receives it from GET /api/page-access/me (no copy in the UI).
 * scripts/page-access-drift-fixture.mjs fails when a dashboard route or menu href is not mapped here.
 *
 * phase 1 = enforced now (28 permission pages minus «دفتر کل» + 8 admin-only pages incl. 3 never-grantable).
 * phase 2 = no button yet: bespoke pages (own /me eligibility), pages folded into «مدیریت فروش» on live (merge v1.2),
 *           manager-config pages and «دفتر کل» (API also requires a finance role).
 */
export type PaGrantable = "both" | "view" | "never";
export type PaKind = "permission" | "admin" | "bespoke";
export type PaApi = readonly [method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*", path: RegExp];
export type PaPage = {
  key: string; label: string; routes: readonly string[]; kind: PaKind; phase: 1 | 2;
  /** permissions added by a «فقط دیدن» grant / additionally by «دیدن و کار کردن» */
  view: readonly string[]; manage: readonly string[];
  /** customers / loan_files: scope picker writes the existing «دسترسی کارشناس‌ها» policy (smc_settings.access) */
  scope?: "customers" | "loan_files";
  /** admin-only pages: endpoints served as if the granted user were an admin (exact list; nothing else) */
  elevateView?: readonly PaApi[]; elevateManage?: readonly PaApi[];
  /** page-local endpoints a «بستن» closes (403 page_access_blocked). Shared endpoints are never listed. */
  block?: readonly PaApi[];
  never?: boolean; viewOnly?: boolean; note?: string;
};

/** Approval-class permissions: never added by a page grant, whatever the registry says. */
export const PA_NEVER_PERMISSIONS: ReadonlySet<string> = new Set([
  "customers.delete", "loan_applications.approve", "loan_applications.delete", "wallets.transfer",
  "payment_orders.admin_approve", "payment_orders.pay", "accounting.opening", "database.manage", "users.manage", "users.view",
  "callbacks.assign", "notifications.manage", "gl.manual_voucher.approve", "gl.manual_voucher.draft", "gl.commission_totals.view",
]);

const G = (p: string): RegExp => new RegExp(`^${p}/?$`);
const P = (key: string, label: string, routes: string[], view: string[], manage: string[] = [], extra: Partial<PaPage> = {}): PaPage =>
  ({ key, label, routes, kind: "permission", phase: 1, view, manage, ...extra });
const A = (key: string, label: string, routes: string[], extra: Partial<PaPage> = {}): PaPage =>
  ({ key, label, routes, kind: "admin", phase: 1, view: [], manage: [], ...extra });
const B = (key: string, label: string, routes: string[], note: string, kind: PaKind = "bespoke"): PaPage =>
  ({ key, label, routes, kind, phase: 2, view: [], manage: [], note });

export const PA_PAGES: readonly PaPage[] = [
  // ---- permission pages (role_permissions) ----
  P("dashboard", "نمای کلی", ["/"], ["dashboard.view"]),
  P("today", "کارهای امروز من", ["/today"], ["customers.view"], ["calls.create", "reminders.manage"]),
  P("my-queue", "صف تماس من", ["/my-queue"], ["customers.view"], ["calls.create", "reminders.manage"]),
  P("reminders", "یادآورها", ["/reminders"], ["reminders.view"], ["reminders.manage"]),
  P("customers", "مشتریان", ["/customers", "/customers/:id"], ["customers.view"], ["customers.update", "customers.create", "calls.create"], { scope: "customers" }),
  P("consultations", "مشاوره‌ها", ["/consultations"], ["consultations.view"], ["consultations.create", "consultations.update"]),
  P("callbacks", "درخواست‌های تماس", ["/callback-requests"], ["callbacks.view"], ["callbacks.manage"]),
  P("loan-applications", "درخواست‌های تسهیلات", ["/loan-applications", "/loan-applications/:id"], ["loan_applications.view"], ["loan_applications.create", "loan_applications.update"], { scope: "loan_files" }),
  P("loan-plans", "طرح‌های تسهیلاتی", ["/loan-plans"], ["loan_plans.view"], ["loan_plans.manage"]),
  P("contracts", "قراردادها", ["/contracts"], ["contracts.view"], [], { viewOnly: true, note: "فقط دیدن؛ قالب و ردیف قرارداد از این شیت تغییر نمی‌کند" }),
  P("goods-purchases", "خرید کالا", ["/goods-purchases", "/goods-purchases/:id"], ["goods_purchases.view"], ["goods_purchases.manage"]),
  P("payment-orders", "دستورهای پرداخت", ["/payment-orders", "/payment-orders/:id"], ["payment_orders.view"], ["payment_orders.create"]),
  P("sales-commissions", "پورسانت فروش", ["/sales-commissions"], ["goods_finance.view"]),
  P("my-wallet", "کیف پول من", ["/my-wallet"], ["goods_finance.view"]),
  P("wallet-management", "مدیریت کیف پول", ["/wallet-management"], ["wallets.view"]),
  P("bank-accounts", "حساب‌های بانکی", ["/bank-accounts"], ["bank_accounts.view"], ["bank_accounts.manage"]),
  P("accounting", "حسابداری", ["/accounting"], ["accounting.view"], ["accounting.manage"]),
  P("chat", "گفتگو با مشتریان", ["/chat"], ["customers.view"]),
  P("internal-chat", "گفتگوی داخلی", ["/internal-chat"], ["internal_chat.use"]),
  P("messengers", "پیام‌رسان‌ها", ["/messengers"], ["internal_chat.use"]),
  P("calls", "تماس‌ها", ["/calls", "/call-view/:id"], ["calls.view"], ["calls.create"]),
  P("mobile-calls", "تماس‌های موبایل", ["/mobile-calls"], ["calls.view"], [], { block: [["GET", G("/mobile-calls")]] }),
  P("phone", "تلفن شرکت", ["/phone"], ["calls.view"], ["calls.create"]),
  P("my-transfers", "انتقال‌های من", ["/my-transfers"], ["customers.view"]),
  P("my-performance", "عملکرد و پورسانت من", ["/my-performance"], ["customers.view"]),
  P("users", "کاربران سامانه", ["/users"], [], [], { never: true }),
  P("notifications-settings", "تنظیمات", ["/settings/notifications"], ["notifications.view"]),
  P("ledger", "دفتر کل", ["/accounting/ledger"], ["accounting.view"], [], { phase: 2, viewOnly: true, note: "API also requires a finance role (FINANCE_ROLES) — needs its own decision" }),
  // ---- admin-only pages ----
  A("sales-reports", "گزارش فروش", ["/sales-reports"], {
    elevateView: [["GET", G("/manager/sales-report")], ["GET", G("/manager/sales-report/settings")]],
    elevateManage: [["PUT", G("/manager/sales-report/settings")]],
  }),
  A("manual-verifications", "بررسی دستی هویت", ["/manual-verifications"], { viewOnly: true,
    elevateView: [["GET", G("/manual-verifications")], ["GET", G("/manual-verifications/\\d+")]] }),
  A("credit-rank-overrides", "نادیده گرفتن رتبه", ["/credit-rank-overrides"], { viewOnly: true, view: ["loan_applications.view"] }),
  A("voice-notes-usage", "مصرف تبدیل صدا به متن", ["/voice-notes-usage"], { viewOnly: true, elevateView: [["GET", G("/voice-notes/usage")]] }),
  A("social-monitor-reports", "گزارش پیام‌رسان‌ها", ["/social-monitor-reports"], { viewOnly: true,
    elevateView: [["GET", G("/social-monitor/reports")], ["GET", G("/social-monitor/customers")], ["GET", /^\/social-monitor\/threads\/\d+(\/messages)?\/?$/]] }),
  A("call-queue-settings", "تنظیمات صف تماس", ["/settings/call-queue"], { never: true }),
  A("assistants-settings", "دستیارهای هوشمند", ["/settings/assistants"], { never: true }),
  A("releases", "نسخه‌های سایت", ["/settings/releases"], { never: true }),
  B("sales-assist-settings", "تنظیمات دستیار فروش", ["/sales-assist-settings"], "folded into «مدیریت فروش» (merge v1.2)", "admin"),
  B("daily-plans", "لیست‌های روزانه", ["/daily-plans", "/daily-plans/report", "/daily-plans/settings", "/daily-plans/expert/:sp/:date", "/daily-plans/capacity/:sp"], "manager config (dpManager) + folded", "admin"),
  B("call-queue-events", "گزارش مدیر · صف تماس", ["/call-queue-events"], "manager config (cqManager) shared with the expert queue", "admin"),
  B("call-queue-discipline", "نظم پیگیری تیم", ["/call-queue-discipline"], "folded into «مدیریت فروش» (merge v1.2)", "admin"),
  B("call-center", "گزارش مرکز تماس", ["/call-center"], "manager/viewer config (ctCfg)", "admin"),
  B("cs-report", "گزارش مدیر · فیلدهای اجباری", ["/cs-report"], "manager config (csCfg)", "admin"),
  B("default-owner", "قانون ثبت مشتری", ["/settings/default-owner"], "folded into «مدیریت فروش» (merge v1.2)", "admin"),
  // ---- bespoke pages (phase 2) ----
  B("instagram-inbox", "سرنخ‌های دایرکت اینستاگرام", ["/instagram-inbox"], "role checks inside instagram.ts"),
  B("customer-segments", "گزارش مشتریان", ["/customer-segments"], "isSegmentsViewer + flag"),
  B("sales-performance", "گزارش عملکرد فروش", ["/sales-performance", "/sales-performance/expert/:id"], "accessOf() + flag (do not touch sales_performance_v1)"),
  B("sales-kpi", "شاخص‌های فروش", ["/sales-kpi"], "isKpiViewer + flag"),
  B("my-work", "عملکرد من", ["/my-work"], "my-performance v1.1 flags"),
  B("social-hub", "مدیریت فروش شبکه‌های اجتماعی", ["/social-hub", "/social-hub/bots/:id/access"], "shIsManager + flag"),
  B("links", "صفحه‌ی لینک‌ها", ["/settings/links"], "link-page canManage + flag"),
  B("sales-teams", "تیم‌های فروش", ["/sales-teams"], "multi_team_v1 (do not touch)"),
  B("sales-admin", "مدیریت فروش", ["/sales-admin", "/sales-team-admin"], "sales manager console"),
  B("bale-workspace", "فضای کار بله", ["/bale-workspace/automation", "/bale-workspace/training"], "bale workspace flag + owner"),
  B("bale-bot", "گفتگوهای بله", ["/bale-bot", "/bale-bot/:id"], "bbView all/own + per-user flag"),
  B("bale-bot-admin", "ربات‌های بله", ["/bale-bot/admin"], "bbMe.canManage"),
  B("bale-connect", "اتصال بله", ["/settings/bale", "/bale/autoreply"], "baleEligible (not 29, not trainee)"),
  B("lead-annotator", "یادداشت سرنخ (اینستاگرام)", ["/lead-annotator"], "access_capabilities lead_annotator"),
  B("smart-filing", "ثبت هوشمند", ["/smart-filing", "/smart-filing/jobs/:id"], "sfScope (role + trainee)"),
];

/** Dashboard routes that are not staff pages (public / auth / wallet top-up) — exempt from the drift test. */
export const PA_ROUTE_EXEMPT: readonly string[] = ["/login", "/wallet/top-up/result", "/wallet/top-up"];

export const PA_BY_KEY: ReadonlyMap<string, PaPage> = new Map(PA_PAGES.map((p) => [p.key, p]));
export const paGrantable = (p: PaPage | undefined): PaGrantable =>
  !p || p.never ? "never" : p.viewOnly || !p.manage.filter((x) => !PA_NEVER_PERMISSIONS.has(x)).length && !(p.elevateManage?.length) ? "view" : "both";
export const paPhase1 = (p: PaPage | undefined): boolean => Boolean(p && p.phase === 1);
/** Permissions a grant of `level` on page `p` adds (approval-class permissions filtered out). */
export function paPermissionsFor(p: PaPage, level: "view" | "manage"): string[] {
  const list = level === "manage" && paGrantable(p) === "both" ? [...p.view, ...p.manage] : [...p.view];
  return [...new Set(list)].filter((x) => !PA_NEVER_PERMISSIONS.has(x));
}
export const paMatch = (apis: readonly PaApi[] | undefined, method: string, path: string): boolean =>
  Boolean(apis?.some(([m, re]) => (m === "*" || m === method) && re.test(path)));
/** Route pattern → page key: exact pattern match (":x" = one segment), longest pattern first. */
export function paKeyForPath(pathname: string): string | null {
  const path = (pathname.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  let best: { key: string; len: number } | null = null;
  for (const p of PA_PAGES) for (const r of p.routes) {
    const re = new RegExp("^" + r.replace(/:[^/]+/g, "[^/]+") + "$");
    if (re.test(path) && (!best || r.length > best.len)) best = { key: p.key, len: r.length };
  }
  return best?.key ?? null;
}
