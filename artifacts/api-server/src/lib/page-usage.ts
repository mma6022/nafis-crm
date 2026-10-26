/**
 * v10: lightweight CRM page-usage tracker (PM request). Stores ONLY: user id, role, route PATTERN (ids → ":id", no query
 * string), enter time, active-tab dwell (ms), sidebar menu clicks and the entry source. Never customer data / phones;
 * user 29 is never stored. Admin switch assistant_settings.page_usage_enabled (default ON: a missing row = ON).
 * 90-day retention: a daily prune of page_usage_events only.
 */
import type { DatabaseSync } from "node:sqlite";
import { ensureSchemaObject } from "./schema-objects";

export const PAGE_USAGE_ENABLED_KEY = "page_usage_enabled";
export const PAGE_USAGE_RETENTION_DAYS = 90;
export const PAGE_USAGE_EXCLUDED_USER_IDS = [29];
export const PAGE_USAGE_RANGES = ["day", "week", "month"] as const;
export type PageUsageRange = (typeof PAGE_USAGE_RANGES)[number];
export const PAGE_USAGE_SOURCES = ["menu", "link", "notification", "assistant", "direct", "history"] as const;
const DAY = 86_400_000; const OFFSET = 210 * 60_000;

/** The sidebar (artifacts/crm-dashboard/src/components/CrmShell.tsx allNavItems + navGroups) — labels for the report only. */
export const SIDEBAR_MENU: ReadonlyArray<{ href: string; label: string; group: string }> = [
  ["/", "نمای کلی", "داشبورد"], ["/reminders", "یادآورها", "داشبورد"],
  ["/customers", "مشتریان", "مشتریان و مشاوره"], ["/calls", "تماس‌ها", "مشتریان و مشاوره"], ["/consultations", "مشاوره‌ها", "مشتریان و مشاوره"],
  ["/callback-requests", "درخواست‌های تماس", "مشتریان و مشاوره"], ["/manual-verifications", "بررسی دستی هویت", "مشتریان و مشاوره"],
  ["/loan-applications", "درخواست‌های تسهیلات", "وام و قرارداد"], ["/smart-filing", "ثبت هوشمند", "وام و قرارداد"], ["/loan-plans", "طرح‌های تسهیلاتی", "وام و قرارداد"],
  ["/contracts", "قراردادها", "وام و قرارداد"], ["/credit-rank-overrides", "نادیده گرفتن رتبه", "وام و قرارداد"],
  ["/goods-purchases", "خرید کالا", "خرید کالا"], ["/sales-commissions", "پورسانت فروش", "خرید کالا"], ["/my-wallet", "کیف پول من / کیف پول کارشناس‌ها", "خرید کالا"],
  ["/payment-orders", "دستورهای پرداخت", "مالی و پرداخت"], ["/wallet-management", "مدیریت کیف پول", "مالی و پرداخت"], ["/bank-accounts", "حساب‌های بانکی", "مالی و پرداخت"], ["/accounting", "حسابداری", "مالی و پرداخت"],
  ["/chat", "گفتگو با مشتریان", "پیام‌ها و تلفن"], ["/internal-chat", "گفتگوی داخلی", "پیام‌ها و تلفن"], ["/messengers", "پیام‌رسان‌ها", "پیام‌ها و تلفن"], ["/settings/bale", "اتصال بله", "پیام‌ها و تلفن"],
  ["/instagram-inbox", "سرنخ‌های دایرکت اینستاگرام", "پیام‌ها و تلفن"], ["/mobile-calls", "تماس‌های موبایل", "پیام‌ها و تلفن"], ["/phone", "تلفن شرکت", "پیام‌ها و تلفن"],
  ["/sales-reports", "گزارش فروش", "گزارش‌ها"], ["/social-monitor-reports", "گزارش پیام‌رسان‌ها", "گزارش‌ها"], ["/voice-notes-usage", "مصرف تبدیل صدا به متن", "گزارش‌ها"],
  ["/users", "کاربران CRM", "مدیریت و تنظیمات"], ["/settings/notifications", "تنظیمات", "مدیریت و تنظیمات"], ["/settings/assistants", "دستیارهای هوشمند", "مدیریت و تنظیمات"], ["/settings/releases", "نسخه‌های سایت", "مدیریت و تنظیمات"],
].map(([href, label, group]) => ({ href, label, group }));
const MENU_HREFS = new Set(SIDEBAR_MENU.map(m => m.href));

export function ensurePageUsageSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS page_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, role TEXT, salesperson_id INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('visit','dwell','menu_click')), route TEXT NOT NULL, source TEXT,
    entered_at TEXT NOT NULL, dwell_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
  ensureSchemaObject(db, "index", "idx_page_usage_events_entered", "CREATE INDEX idx_page_usage_events_entered ON page_usage_events(entered_at)");
  ensureSchemaObject(db, "index", "idx_page_usage_events_created", "CREATE INDEX idx_page_usage_events_created ON page_usage_events(created_at)");
}
export function pageUsageOn(db: DatabaseSync): boolean {
  try { const r = db.prepare("SELECT value FROM assistant_settings WHERE key=?").get(PAGE_USAGE_ENABLED_KEY) as { value?: string } | undefined; return r?.value !== "0"; }
  catch { return true; }
}
/** Route pattern only: no query/hash, any segment with a digit (ids, phones, dates) or non [a-z_-] chars → ":id". */
export function normRoute(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let r = v.split(/[?#]/)[0].trim().toLowerCase();
  if (!r.startsWith("/")) return null;
  r = r.replace(/\/{2,}/g, "/");
  const segs = r.split("/").slice(1).filter((x, i, a) => x !== "" || i < a.length - 1).slice(0, 8)
    .map(x => /^:[a-z]{1,12}$/.test(x) ? x : /^[a-z][a-z_-]{0,39}$/.test(x) ? x : ":id");
  const out = "/" + segs.join("/");
  return out.length > 120 ? out.slice(0, 120) : out;
}
type Ev = { kind: "visit" | "dwell" | "menu_click"; route: string; source: string | null; enteredAt: string; dwellMs: number };
export function cleanEvents(body: any, now: Date): Ev[] {
  const list = Array.isArray(body?.events) ? body.events.slice(0, 50) : [];
  const t = now.getTime(); const out: Ev[] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const kind = e.kind === "visit" || e.kind === "dwell" || e.kind === "menu_click" ? e.kind : null; if (!kind) continue;
    const route = normRoute(e.route); if (!route) continue;
    if (kind === "menu_click" && !MENU_HREFS.has(route)) continue;
    const source = (PAGE_USAGE_SOURCES as readonly string[]).includes(e.source) ? String(e.source) : kind === "menu_click" ? "menu" : null;
    const at = Date.parse(String(e.enteredAt ?? "")); const enteredAt = new Date(Number.isFinite(at) && at > t - 2 * DAY && at < t + 5 * 60_000 ? at : t).toISOString();
    const d = Math.round(Number(e.dwellMs)); const dwellMs = kind === "menu_click" ? 0 : Number.isFinite(d) ? Math.max(0, Math.min(d, 4 * 3600_000)) : 0;
    out.push({ kind, route, source, enteredAt, dwellMs });
  }
  return out;
}
const perUser = new Map<number, { hour: number; n: number }>();
/** Returns how many events were stored (0 when the switch is off, user 29, or anything is wrong). Never throws. */
export function recordPageUsage(db: DatabaseSync, user: { id: number; role?: string | null; salespersonId?: number | null } | null | undefined, body: any, now = new Date()): number {
  try {
    if (!user || !Number.isSafeInteger(Number(user.id)) || PAGE_USAGE_EXCLUDED_USER_IDS.includes(Number(user.id))) return 0;
    if (!pageUsageOn(db)) return 0;
    const ev = cleanEvents(body, now); if (!ev.length) return 0;
    const h = Math.floor(now.getTime() / 3600_000); const c = perUser.get(user.id);
    const used = c && c.hour === h ? c.n : 0; const room = Math.max(0, 600 - used); const keep = ev.slice(0, room);
    perUser.set(user.id, { hour: h, n: used + keep.length }); if (!keep.length) return 0;
    const st = db.prepare("INSERT INTO page_usage_events(user_id,role,salesperson_id,kind,route,source,entered_at,dwell_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
    const iso = now.toISOString(); db.exec("BEGIN");
    try { for (const e of keep) st.run(user.id, user.role ? String(user.role).slice(0, 30) : null, user.salespersonId ?? null, e.kind, e.route, e.source, e.enteredAt, e.dwellMs, iso); db.exec("COMMIT"); }
    catch (err) { db.exec("ROLLBACK"); throw err; }
    return keep.length;
  } catch { return 0; }
}
export function prunePageUsage(db: DatabaseSync, now = new Date()): number {
  try { return Number(db.prepare("DELETE FROM page_usage_events WHERE julianday(created_at) < julianday(?)").run(new Date(now.getTime() - PAGE_USAGE_RETENTION_DAYS * DAY).toISOString()).changes); }
  catch { return 0; }
}
let pruneTimer: ReturnType<typeof setInterval> | null = null;
export function startPageUsagePrune(db: DatabaseSync): void {
  if (pruneTimer) return;
  setTimeout(() => prunePageUsage(db), 60_000).unref?.();
  pruneTimer = setInterval(() => prunePageUsage(db), DAY); pruneTimer.unref?.();
}

export function pageUsageBounds(range: PageUsageRange, now: Date) {
  const t = now.getTime(); const today = Math.floor((t + OFFSET) / DAY) * DAY - OFFSET; const wd = new Date(t + OFFSET).getUTCDay();
  const start = range === "day" ? today : range === "week" ? today - ((wd + 1) % 7) * DAY : today - 29 * DAY;
  return { range, from: new Date(start).toISOString(), to: now.toISOString(), label: range === "day" ? "امروز" : range === "week" ? "این هفته (از شنبه)" : "۳۰ روز اخیر" };
}
type Agg = { visits: number; dwellMs: number; users: Set<number> };
const agg = () => ({ visits: 0, dwellMs: 0, users: new Set<number>() } as Agg);
const pagesOut = (m: Map<string, Agg>, top = 50) => [...m.entries()].map(([route, a]) => ({ route, visits: a.visits, dwellMs: a.dwellMs, avgDwellMs: a.visits ? Math.round(a.dwellMs / a.visits) : null, users: a.users.size }))
  .sort((x, y) => y.dwellMs - x.dwellMs || y.visits - x.visits).slice(0, top);
const menuLabel = (href: string) => SIDEBAR_MENU.find(m => m.href === href);
/** Read-only report for «احمد» (/manager/page-usage) and the admin. User 29 is never in it. */
export function pageUsageReport(db: DatabaseSync, range: PageUsageRange, now = new Date()) {
  const b = pageUsageBounds(range, now);
  const has = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='page_usage_events'").get());
  const evs = has ? (db.prepare(`SELECT p.user_id, p.role, p.salesperson_id, p.kind, p.route, p.source, p.dwell_ms, u.full_name, u.username, u.role urole, s.name sp_name
      FROM page_usage_events p LEFT JOIN users u ON u.id=p.user_id LEFT JOIN salespersons s ON s.id=COALESCE(p.salesperson_id,u.salesperson_id)
      WHERE julianday(p.entered_at)>=julianday(?) AND julianday(p.entered_at)<=julianday(?) AND p.user_id NOT IN (${PAGE_USAGE_EXCLUDED_USER_IDS.join(",")})`).all(b.from, b.to) as any[]) : [];
  const pages = new Map<string, Agg>(); const menu = new Map<string, { clicks: number; users: Set<number> }>(); const sources: Record<string, number> = {};
  type Who = { userId: number; name: string | null; salespersonId: number | null; role: string | null; visits: number; dwellMs: number; menuClicks: number; pages: Map<string, Agg>; menu: Map<string, number> };
  const byUser = new Map<number, Who>(); const byRole = new Map<string, { role: string; users: Set<number>; visits: number; dwellMs: number; menuClicks: number; pages: Map<string, Agg>; menu: Map<string, number> }>();
  for (const e of evs) {
    const uid = Number(e.user_id); const role = String(e.role ?? e.urole ?? "unknown");
    const w = byUser.get(uid) ?? { userId: uid, name: e.full_name || e.username || null, salespersonId: e.salesperson_id == null ? null : Number(e.salesperson_id), role, visits: 0, dwellMs: 0, menuClicks: 0, pages: new Map(), menu: new Map() };
    const r = byRole.get(role) ?? { role, users: new Set<number>(), visits: 0, dwellMs: 0, menuClicks: 0, pages: new Map(), menu: new Map() };
    r.users.add(uid);
    if (e.kind === "menu_click") {
      const m = menu.get(e.route) ?? { clicks: 0, users: new Set<number>() }; m.clicks++; m.users.add(uid); menu.set(e.route, m);
      w.menuClicks++; r.menuClicks++; w.menu.set(e.route, (w.menu.get(e.route) ?? 0) + 1); r.menu.set(e.route, (r.menu.get(e.route) ?? 0) + 1);
    } else {
      const v = e.kind === "visit" ? 1 : 0; const d = Number(e.dwell_ms) || 0;
      for (const mp of [pages, w.pages, r.pages]) { const a = mp.get(e.route) ?? agg(); a.visits += v; a.dwellMs += d; a.users.add(uid); mp.set(e.route, a); }
      w.visits += v; w.dwellMs += d; r.visits += v; r.dwellMs += d;
      if (v && e.source) sources[e.source] = (sources[e.source] ?? 0) + 1;
    }
    byUser.set(uid, w); byRole.set(role, r);
  }
  const menuOut = (m: Map<string, number>) => [...m.entries()].map(([href, clicks]) => ({ href, label: menuLabel(href)?.label ?? href, clicks })).sort((x, y) => y.clicks - x.clicks);
  return { ...b, timezone: "Asia/Tehran", generatedAt: now.toISOString(), enabled: pageUsageOn(db), retentionDays: PAGE_USAGE_RETENTION_DAYS,
    totals: { visits: [...pages.values()].reduce((s, a) => s + a.visits, 0), dwellMs: [...pages.values()].reduce((s, a) => s + a.dwellMs, 0),
      menuClicks: [...menu.values()].reduce((s, a) => s + a.clicks, 0), users: byUser.size },
    entrySources: sources,
    pages: pagesOut(pages),
    menu: SIDEBAR_MENU.map(m => ({ href: m.href, label: m.label, group: m.group, clicks: menu.get(m.href)?.clicks ?? 0, users: menu.get(m.href)?.users.size ?? 0 })).filter(m => m.clicks > 0).sort((x, y) => y.clicks - x.clicks),
    neverClickedMenu: SIDEBAR_MENU.filter(m => !menu.has(m.href)).map(m => ({ href: m.href, label: m.label, group: m.group })),
    byExpert: [...byUser.values()].sort((x, y) => y.dwellMs - x.dwellMs).map(w => ({ userId: w.userId, name: w.name, salespersonId: w.salespersonId, role: w.role,
      visits: w.visits, dwellMs: w.dwellMs, menuClicks: w.menuClicks, pages: pagesOut(w.pages, 10).map(({ users, ...p }) => p), menu: menuOut(w.menu) })),
    byRole: [...byRole.values()].sort((x, y) => y.dwellMs - x.dwellMs).map(r => ({ role: r.role, users: r.users.size, visits: r.visits, dwellMs: r.dwellMs, menuClicks: r.menuClicks,
      pages: pagesOut(r.pages, 15), menu: menuOut(r.menu) })),
    definition: "visits = page entries; dwell = time the tab was visible on that page (ms); routes are patterns (ids → :id, no query strings); user 29 never stored" };
}
