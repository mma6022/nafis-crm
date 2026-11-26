/**
 * «دسترسی این صفحه» v1 (t942u, Armita v1.1): the page registry. One entry per grantable staff page (58).
 * Source of truth for: page key ↔ dashboard routes, which existing permissions a page grant adds (view / manage),
 * which admin-only endpoints a grant opens (elevate), and which page-local endpoints a «بستن» (block) closes.
 * Static, versioned with the release; the dashboard receives it from GET /api/page-access/me (no copy in the UI).
 * scripts/page-access-drift-fixture.mjs fails when a dashboard route or menu href is not mapped here.
 *
 * phase 1 = enforced (t942u v1: 27 permission pages + 8 admin-only pages incl. 3 never-grantable).
 * phase 2 (t942u r4, Mohammad 2026-11-26 17:12 «۲۲ صفحه‌ی باقی‌مانده همین حالا دکمه بگیرند»): every remaining page has the button.
 *   - «دفتر کل» + 7 manager report/config pages: grant by elevation of their exact endpoints (same as «گزارش فروش»).
 *   - bespoke pages: blockOnly (their own rules give access; the button shows who always has it and can close it for one person).
 *   - «مدیریت فروش» and «ربات‌های بله»: never (admin / sales manager only).
 */
export type PaGrantable = "both" | "view" | "never" | "block";
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
  /** t961: API families a per-user grant opens for a user in «محدودیت کارشناس» (a grant overrides the lockdown for this page only). Elevated endpoints are added automatically. */
  lock?: readonly PaApi[];
  never?: boolean; viewOnly?: boolean; note?: string;
  /** phase 2 (t942u r4): the button only offers «بستن برای یک نفر»; access itself is decided by the page's own rules (paNote says where). */
  blockOnly?: boolean;
  /** Persian line shown in the sheet for block-only / never pages that are not plain admin-only pages. */
  paNote?: string;
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
const X = (key: string, label: string, routes: string[], note: string, paNote: string): PaPage =>
  ({ key, label, routes, kind: "bespoke", phase: 1, view: [], manage: [], note, paNote, blockOnly: true });

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
  P("ledger", "دفتر کل", ["/accounting/ledger"], [], [], { viewOnly: true,
    note: "API requires a finance role (FINANCE_ROLES) → the grant elevates exactly the read-only report endpoints; commission totals stay excluded",
    elevateView: [["GET", /^\/gl\/reports\/(status|trial-balance|journal|accounts|ledger|queue|reconciliation)\/?$/]] }),
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
  // ---- phase 2: manager report / config pages (admin-only route; grant = elevation of exact endpoints) ----
  A("sales-assist-settings", "تنظیمات دستیار فروش", ["/sales-assist-settings"], { viewOnly: true, note: "folded into «مدیریت فروش» for admins (merge v1.2); a granted person sees the standalone page",
    elevateView: [["GET", G("/sales-assist/weights")], ["POST", G("/sales-assist/weights/preview")]] }),
  A("daily-plans", "لیست‌های روزانه", ["/daily-plans", "/daily-plans/report", "/daily-plans/settings", "/daily-plans/expert/:sp/:date", "/daily-plans/capacity/:sp"], { viewOnly: true,
    elevateView: [["GET", G("/daily-plans/board")], ["GET", G("/daily-plans/report")], ["GET", /^\/daily-plans\/\d+\/\d{4}-\d{2}-\d{2}\/?$/], ["GET", /^\/capacity\/\d+\/?$/], ["GET", G("/admin/settings/daily-plan")]] }),
  A("call-queue-events", "گزارش مدیر · صف تماس", ["/call-queue-events"], {
    elevateView: [["GET", G("/call-queue/events")]], elevateManage: [["POST", /^\/call-queue\/events\/\d+\/seen\/?$/]] }),
  A("call-queue-discipline", "نظم پیگیری تیم", ["/call-queue-discipline"], {
    elevateView: [["GET", G("/call-queue/discipline/team")], ["GET", G("/call-queue/discipline/settings")], ["GET", G("/reports/discipline-signals")]],
    elevateManage: [["PUT", G("/call-queue/discipline/settings")]] }),
  A("call-center", "گزارش مرکز تماس", ["/call-center"], { viewOnly: true,
    elevateView: [["GET", /^\/call-transcripts\/report(\/[a-z-]+)?\/?$/], ["GET", /^\/call-transcripts\/calls\/\d+\/?$/]] }),
  A("cs-report", "گزارش مدیر · فیلدهای اجباری", ["/cs-report"], { viewOnly: true,
    elevateView: [["GET", G("/call-summary-fields/report")], ["GET", G("/call-summary-fields/report/detail")], ["GET", G("/call-summary-fields/config")]] }),
  A("default-owner", "قانون ثبت مشتری", ["/settings/default-owner"], { viewOnly: true,
    elevateView: [["GET", G("/admin/default-owner-rule")], ["GET", G("/admin/registered-by")], ["GET", G("/lead-intake/admin/settings")]] }),
  // ---- phase 2: bespoke pages (button = status + «بستن برای یک نفر»; their own rules give access) ----
  X("instagram-inbox", "سرنخ‌های دایرکت اینستاگرام", ["/instagram-inbox"], "role checks inside instagram.ts", "چه کسی این صفحه را ببیند، با نقش کاربر و تنظیمات اینستاگرام تعیین می‌شود."),
  X("customer-segments", "گزارش مشتریان", ["/customer-segments"], "isSegmentsViewer + flag", "بینندگان این گزارش در تنظیمات «گزارش مشتریان» تعیین می‌شوند."),
  X("sales-performance", "گزارش عملکرد فروش", ["/sales-performance", "/sales-performance/expert/:id"], "accessOf() + flag (do not touch sales_performance_v1)", "دسترسی این گزارش با قواعد «گزارش عملکرد فروش» و تیم‌ها تعیین می‌شود."),
  X("sales-kpi", "شاخص‌های فروش", ["/sales-kpi"], "isKpiViewer + flag", "بینندگان این صفحه در تنظیمات «شاخص‌های فروش» تعیین می‌شوند."),
  X("my-work", "عملکرد من", ["/my-work"], "my-performance v1.1 flags", "این صفحه برای هر کارشناس، عملکرد خود اوست؛ دادنِ آن به دیگری معنا ندارد."),
  X("social-hub", "مدیریت فروش شبکه‌های اجتماعی", ["/social-hub", "/social-hub/bots/:id/access"], "shIsManager + flag", "مدیران این صفحه در تنظیمات «شبکه‌های اجتماعی» تعیین می‌شوند."),
  X("links", "صفحه‌ی لینک‌ها", ["/settings/links"], "link-page canManage + flag", "چه کسی لینک‌ها را مدیریت کند، در تنظیمات همین صفحه تعیین می‌شود."),
  X("sales-teams", "تیم‌های فروش", ["/sales-teams"], "multi_team_v1 (do not touch)", "دسترسی این صفحه با تیم‌های فروش تعیین می‌شود."),
  X("bale-workspace", "فضای کار بله", ["/bale-workspace/automation", "/bale-workspace/training"], "bale workspace flag + owner", "این صفحه برای صاحب فضای کار بله است و از تنظیمات بله داده می‌شود."),
  X("bale-bot", "گفتگوهای بله", ["/bale-bot", "/bale-bot/:id"], "bbView all/own + per-user flag", "دیدن گفتگوهای بله در تنظیمات «ربات‌های بله» داده می‌شود."),
  X("bale-connect", "اتصال بله", ["/settings/bale", "/bale/autoreply"], "baleEligible (not 29, not trainee)", "اتصال بله برای همه‌ی کارشناس‌ها باز است، جز کارآموزها."),
  X("lead-annotator", "یادداشت سرنخ (اینستاگرام)", ["/lead-annotator"], "access_capabilities lead_annotator", "این ابزار با قابلیت «یادداشت سرنخ» در تنظیمات کاربر داده می‌شود."),
  X("smart-filing", "ثبت هوشمند", ["/smart-filing", "/smart-filing/jobs/:id"], "sfScope (role + trainee)", "ثبت هوشمند با نقش کاربر باز می‌شود؛ کارآموزها قفل خودشان را دارند."),
  // ---- never (admin / sales manager only) ----
  A("sales-admin", "مدیریت فروش", ["/sales-admin", "/sales-team-admin"], { never: true, note: "sales manager console", paNote: "«مدیریت فروش» فقط برای ادمین و مدیر فروش است و قابل‌اعطا نیست." }),
  A("bale-bot-admin", "ربات‌های بله", ["/bale-bot/admin"], { never: true, note: "bbMe.canManage; folded into «مدیریت فروش»", paNote: "مدیریت ربات‌های بله فقط برای ادمین و مدیر فروش است و قابل‌اعطا نیست." }),
];

/** Dashboard routes that are not staff pages (public / auth / wallet top-up) — exempt from the drift test. */
export const PA_ROUTE_EXEMPT: readonly string[] = ["/login", "/wallet/top-up/result", "/wallet/top-up"];

export const PA_BY_KEY: ReadonlyMap<string, PaPage> = new Map(PA_PAGES.map((p) => [p.key, p]));
export const paGrantable = (p: PaPage | undefined): PaGrantable =>
  !p || p.never ? "never" : p.blockOnly ? "block" : p.viewOnly || !p.manage.filter((x) => !PA_NEVER_PERMISSIONS.has(x)).length && !(p.elevateManage?.length) ? "view" : "both";
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

/* ---------------- t961 (Mohammad 2026-11-26 08:02): a per-user grant overrides expert_lockdown ---------------- */
const F = (...names: string[]): PaApi => ["*", new RegExp(`^/(${names.join("|")})(/|$)`)];
/** API families each permission page needs while its user is locked. Pages not listed here are either already open to locked experts
 *  (today, loan applications, goods purchases, payment orders, messengers, internal chat) or have no family that is safe to name
 *  (contracts, notification settings): for those a grant changes nothing inside the lockdown. */
const PA_LOCK_FAMILIES: Readonly<Record<string, readonly PaApi[]>> = {
  customers: [F("customers", "team-sales", "customer-tags", "customer-phones", "allocation-programs", "calls", "call-transcripts", "multi-case")],
  chat: [F("customers", "customer-chat")], "my-queue": [F("customers")], "my-transfers": [F("customers")], "my-performance": [F("customers", "goods-finance", "my-work")],
  reminders: [F("reminders")], consultations: [F("consultations")], callbacks: [F("callback-requests")],
  "sales-commissions": [F("goods-finance")], "my-wallet": [F("goods-finance")],
  "wallet-management": [F("wallet-management", "company-wallet", "wallet")], "bank-accounts": [F("bank-accounts")],
  accounting: [F("accounting", "gl")],
  calls: [F("calls", "call-transcripts", "voip")], phone: [F("calls", "voip", "voip-call")], "mobile-calls": [F("mobile-calls", "mobile-call-devices", "mobile-call-experts")],
  dashboard: [F("dashboard")],
};
/** Endpoints a user-level grant of this page opens inside the lockdown, as [method, regexp] pairs (view level = GET only). */
export function paLockApi(p: PaPage, level: "view" | "manage"): readonly PaApi[] {
  const fam = [...(p.lock ?? []), ...(PA_LOCK_FAMILIES[p.key] ?? [])];
  const ro = level === "view" ? fam.filter(([m]) => m === "*" || m === "GET").map(([, r]) => ["GET", r] as PaApi) : fam;
  return [...ro, ...(p.elevateView ?? []), ...(level === "manage" ? p.elevateManage ?? [] : [])];
}
