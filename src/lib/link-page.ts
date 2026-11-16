/**
 * links v1.0 — «صفحه‌ی لینک‌ها» (nafisvam.com/links) and its CRM admin (design screens/links v1.0, spec §۱–§۵.۲).
 *
 * Behind flag.links_page (call_queue_settings, absent/≠'1' = OFF). While OFF every route in routes/link-page.ts calls next()
 * (responses identical to the build before), and nothing here touches the database: the schema is created lazily on the
 * first ON request only.
 *
 * Access: admin + sales_manager (AuthUser.role === 'admin' — the effective role); the header (name, intro, logo) only for a
 * real admin (baseRole === 'admin'). Experts: nothing, enforced here and in the routes, not only in the menu.
 * Data model is multi-business (businesses → link_pages → links); v1.0 has one business and one page (slug 'links').
 */
import type { AuthUser } from "./auth";
import { execute, executeChanges, queryRow, queryRows, crmDb } from "./crm-db";
import { sanitizeSvg, SvgRejected } from "./svg-sanitize";

export const LINKS_FLAG = "flag.links_page";
export const LINKS_SRC = "links";
export const LINKS_SRC_FA = "صفحه لینک‌ها";
export const LEAD_URL = "https://nafisvam.com/request/?src=links";
export const MAX_UPLOAD = 200 * 1024;
const PAGE_SLUG = "links";

export function linksOn(): boolean {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key = ?", [LINKS_FLAG])?.value === "1"; }
  catch { return false; }
}

type U = Pick<AuthUser, "id" | "role"> & { baseRole?: string | null };
export const canManage = (u: U | undefined | null) => !!u && u.role === "admin";
export const canEditHeader = (u: U | undefined | null) => !!u && u.role === "admin" && (u.baseRole ?? "admin") === "admin";

/* ---------------- schema (lazy, flag ON only) ---------------- */
let schemaReady = false;
export function ensureSchema() {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS businesses (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS link_logos (
      id INTEGER PRIMARY KEY, business_id INTEGER REFERENCES businesses(id), kind TEXT NOT NULL CHECK (kind IN ('builtin','upload')),
      file TEXT NOT NULL, name TEXT, mime TEXT, bytes INTEGER, data BLOB, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE UNIQUE INDEX IF NOT EXISTS ux_link_logos_builtin ON link_logos(file) WHERE kind = 'builtin';
    CREATE TABLE IF NOT EXISTS link_pages (
      id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id), slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, intro TEXT NOT NULL DEFAULT '', logo_id INTEGER REFERENCES link_logos(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), updated_by INTEGER);
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES link_pages(id), type TEXT NOT NULL, title TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, logo_id INTEGER REFERENCES link_logos(id), position INTEGER NOT NULL,
      visible INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER, updated_by INTEGER);
    CREATE INDEX IF NOT EXISTS ix_links_page ON links(page_id, position);
    CREATE TABLE IF NOT EXISTS link_clicks (link_id INTEGER NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (link_id, day));
    CREATE TABLE IF NOT EXISTS link_page_log (
      id INTEGER PRIMARY KEY, page_id INTEGER, link_id INTEGER, user_id INTEGER, action TEXT NOT NULL, detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  for (const [k] of LOGOS) execute("INSERT OR IGNORE INTO link_logos (kind, file, name) VALUES ('builtin', ?, ?)", [k, LOGO_FA[k]]);
  if (!queryRow("SELECT id FROM link_pages WHERE slug = ?", [PAGE_SLUG])) {
    const biz = queryRow<{ id: number }>("SELECT id FROM businesses ORDER BY id LIMIT 1")?.id ?? execute("INSERT INTO businesses (name) VALUES (?)", ["نفیس وام"]);
    const pageId = execute("INSERT INTO link_pages (business_id, slug, name, intro, logo_id) VALUES (?, ?, ?, ?, ?)",
      [biz, PAGE_SLUG, "نفیس وام", "درخواست وام آنلاین و مشاوره با کارشناس‌های نفیس", builtinLogoId("nafis")]);
    execute("INSERT INTO links (page_id, type, title, value, url, logo_id, position, visible) VALUES (?, 'lead', ?, '', ?, ?, 1, 1)",
      [pageId, "درخواست وام آنلاین", LEAD_URL, builtinLogoId("nafis")]);
    execute("INSERT INTO link_page_log (page_id, action, detail) VALUES (?, 'seed', ?)", [pageId, JSON.stringify({ v: "1.0" })]);
  }
  schemaReady = true;
}
/** test hook: a fresh DB in the same process */
export function _resetSchemaFlag() { schemaReady = false; bump(); }

/* ---------------- logos ---------------- */
export const LOGOS: [string, string][] = [["nafis", "نفیس وام"], ["ig", "اینستاگرام"], ["wa", "واتساپ"], ["bale", "بله"], ["tg", "تلگرام"], ["eitaa", "ایتا"],
  ["rubika", "روبیکا"], ["li", "لینکدین"], ["aparat", "آپارات"], ["tel", "تلفن"], ["sms", "پیامک"], ["mail", "ایمیل"], ["map", "نقشه"], ["web", "وب‌سایت"]];
const LOGO_FA: Record<string, string> = Object.fromEntries(LOGOS);
function builtinLogoId(file: string): number {
  return queryRow<{ id: number }>("SELECT id FROM link_logos WHERE kind = 'builtin' AND file = ?", [file])!.id;
}

/* ---------------- types & URL rules (spec §۴, §۵.۲) ---------------- */
type Ask = "user" | "mob" | "url" | "phone" | "email" | "page" | "lead";
export const TYPES: Record<string, { n: string; lg: string; ask: Ask; base?: string }> = {
  ig: { n: "اینستاگرام", lg: "ig", ask: "user", base: "https://instagram.com/" },
  wa: { n: "واتساپ", lg: "wa", ask: "mob", base: "https://wa.me/98" },
  bale: { n: "بله", lg: "bale", ask: "user", base: "https://ble.ir/" },
  tg: { n: "تلگرام", lg: "tg", ask: "user", base: "https://t.me/" },
  eitaa: { n: "ایتا", lg: "eitaa", ask: "user", base: "https://eitaa.com/" },
  rubika: { n: "روبیکا", lg: "rubika", ask: "user", base: "https://rubika.ir/" },
  li: { n: "لینکدین", lg: "li", ask: "url" },
  aparat: { n: "آپارات", lg: "aparat", ask: "user", base: "https://aparat.com/" },
  tel: { n: "تماس تلفنی", lg: "tel", ask: "phone", base: "tel:" },
  sms: { n: "پیامک", lg: "sms", ask: "phone", base: "sms:" },
  mail: { n: "ایمیل", lg: "mail", ask: "email", base: "mailto:" },
  map: { n: "آدرس روی نقشه", lg: "map", ask: "url" },
  site: { n: "صفحه‌ی سایت", lg: "nafis", ask: "page" },
  lead: { n: "فرم درخواست وام", lg: "nafis", ask: "lead" },
  web: { n: "لینک دلخواه", lg: "web", ask: "url" },
};
export const SITE_PAGES: [string, string][] = [["صفحه‌ی اصلی", "/"], ["طرح‌ها", "/plans"], ["مراحل دریافت وام", "/how-it-works"], ["خدمات نفیس وام", "/services"],
  ["محاسبه قسط وام", "/calculator"], ["سوالات متداول", "/faq"], ["درباره نفیس وام", "/about"], ["تماس با نفیس وام", "/contact"], ["وبلاگ", "/blog"]];
const USER_HOSTS: Record<string, RegExp> = {
  ig: /^(?:www\.)?instagram\.com$/i, bale: /^(?:www\.)?ble\.ir$/i, tg: /^(?:www\.)?(?:t\.me|telegram\.me)$/i, eitaa: /^(?:www\.)?eitaa\.com$/i,
  rubika: /^(?:www\.)?rubika\.ir$/i, aparat: /^(?:www\.)?aparat\.com$/i,
};
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹", AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
export const toLatinDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

export const MSG = {
  user: "نام کاربری فقط حرف انگلیسی، عدد، نقطه و زیرخط دارد؛ فاصله ندارد.",
  mob: "شماره‌ی موبایل ۱۱ رقم است و با ۰۹ شروع می‌شود.",
  phone: "شماره‌ی تلفن را با کد شهر یا به شکل موبایل بنویس؛ فقط رقم.",
  email: "نشانی ایمیل درست نیست؛ مثل name@example.com.",
  url: "آدرس کامل با https:// بنویس؛ لینک‌های دیگر پذیرفته نمی‌شوند.",
  page: "یکی از صفحه‌های سایت را انتخاب کن.",
  title: "عنوان دکمه را بنویس (تا ۴۰ نویسه).",
  type: "نوع لینک را انتخاب کن.",
  logo: "لوگو پیدا نشد؛ دوباره انتخاب کن.",
  numbers: "روی صفحه‌ی لینک‌ها عدد، نرخ و درصد نمی‌آید؛ متن را بدون عدد بنویس.",
  word: "این واژه روی صفحه‌ی عمومی نمی‌آید؛ متن را عوض کن.",
};
const FORBIDDEN = ["سپرده", "برآورد", "تخمینی"]; // «برآوردی» contains «برآورد»
const charLen = (s: string) => [...s].filter((c) => c !== "\u200c").length;
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim() : "");
/** public copy rule (t779u): no numbers / rates on the page, no forbidden words */
function publicTextError(s: string): string | null {
  if (/[0-9۰-۹٠-٩%٪]/.test(s)) return MSG.numbers;
  if (FORBIDDEN.some((w) => s.includes(w))) return MSG.word;
  return null;
}

export function parseUsername(raw: string, type: string): string | null {
  let v = toLatinDigits(raw.trim());
  const m = /^(?:https?:\/\/)?([^/?#\s]+)\/+([^?#\s]*)/i.exec(v);
  if (m && USER_HOSTS[type]?.test(m[1])) v = m[2].split("/").filter(Boolean)[0] ?? "";
  v = v.replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._]{0,30}[A-Za-z0-9_])?$/.test(v) || v.includes("..")) return null;
  return v;
}
export function parseMobile(raw: string): string | null {
  let v = toLatinDigits(raw).replace(/[\s\-()]/g, "");
  if (v.startsWith("+98")) v = "0" + v.slice(3); else if (/^0098/.test(v)) v = "0" + v.slice(4); else if (/^98\d{10}$/.test(v)) v = "0" + v.slice(2); else if (/^9\d{9}$/.test(v)) v = "0" + v;
  return /^09\d{9}$/.test(v) ? v : null;
}
export function parsePhone(raw: string): string | null {
  const mob = parseMobile(raw); if (mob) return mob;
  let v = toLatinDigits(raw).replace(/[\s\-()]/g, "");
  if (v.startsWith("+98")) v = "0" + v.slice(3);
  if (/^0[1-8]\d{9}$/.test(v)) return v; // landline with city code
  if (/^[1-9]\d{3,7}$/.test(v)) return v; // short service numbers (e.g. 1xxx, 3000xxxx)
  return null;
}
export function parseHttps(raw: string): string | null {
  const v = raw.trim();
  if (v.length > 500 || /\s/.test(v)) return null;
  let u: URL; try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
  return u.href;
}
export function parseEmail(raw: string): string | null {
  const v = raw.trim();
  return v.length <= 120 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(v) ? v : null;
}
/** type + raw value → { value, url } or a field error. The browser shows the same rules; the server is the gate. */
export function buildUrl(type: string, raw: unknown): { ok: true; value: string; url: string } | { ok: false; error: string } {
  const t = TYPES[type]; if (!t) return { ok: false, error: MSG.type };
  const r = typeof raw === "string" ? raw : "";
  switch (t.ask) {
    case "user": { const u = parseUsername(r, type); return u ? { ok: true, value: u, url: t.base + u } : { ok: false, error: MSG.user }; }
    case "mob": { const m = parseMobile(r); return m ? { ok: true, value: m, url: t.base + m.slice(1) } : { ok: false, error: MSG.mob }; }
    case "phone": { const p = parsePhone(r); return p ? { ok: true, value: p, url: t.base + p } : { ok: false, error: MSG.phone }; }
    case "email": { const e = parseEmail(r); return e ? { ok: true, value: e, url: t.base + e } : { ok: false, error: MSG.email }; }
    case "url": { const u = parseHttps(r); return u ? { ok: true, value: u, url: u } : { ok: false, error: MSG.url }; }
    case "page": {
      const p = SITE_PAGES.find(([, path]) => path === r.trim());
      return p ? { ok: true, value: p[1], url: "https://nafisvam.com" + (p[1] === "/" ? "/" : p[1] + "/") } : { ok: false, error: MSG.page };
    }
    case "lead": return { ok: true, value: "", url: LEAD_URL };
  }
}

/* ---------------- reads ---------------- */
type PageRow = { id: number; business_id: number; slug: string; name: string; intro: string; logo_id: number | null; updated_at: string; updated_by: number | null };
type LinkRow = { id: number; page_id: number; type: string; title: string; value: string; url: string; logo_id: number | null; position: number; visible: number; created_at: string; updated_at: string; created_by: number | null };
type LogoRow = { id: number; kind: string; file: string; name: string | null; mime: string | null; bytes: number | null };
const page = () => queryRow<PageRow>("SELECT * FROM link_pages WHERE slug = ?", [PAGE_SLUG])!;
const logoRef = (l: LogoRow | undefined) => !l ? { kind: "builtin", key: "web" } : l.kind === "builtin" ? { kind: "builtin", key: l.file } : { kind: "upload", id: l.id, mime: l.mime, name: l.name };
const logoById = (id: number | null) => (id == null ? undefined : queryRow<LogoRow>("SELECT id, kind, file, name, mime, bytes FROM link_logos WHERE id = ?", [id]));

export function tehranDay(d = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value; return `${g("year")}-${g("month")}-${g("day")}`;
}
/** clicks of the last 30 Tehran days, today included */
export function windowDays(now = new Date()) { return { from: tehranDay(new Date(now.getTime() - 29 * 86400000)), to: tehranDay(now) }; }

export function adminState(u: U) {
  ensureSchema();
  const p = page(); const w = windowDays();
  const clicks = new Map(queryRows<{ link_id: number; n: number }>("SELECT link_id, SUM(count) AS n FROM link_clicks WHERE day >= ? AND day <= ? GROUP BY link_id", [w.from, w.to]).map((r) => [r.link_id, r.n]));
  const links = queryRows<LinkRow>("SELECT * FROM links WHERE page_id = ? ORDER BY position, id", [p.id]).map((l) => ({
    id: l.id, type: l.type, title: l.title, value: l.value, url: l.url, visible: !!l.visible, position: l.position, logo: logoRef(logoById(l.logo_id)),
    logoId: l.logo_id, clicks: clicks.get(l.id) ?? 0, createdAt: l.created_at, isNew: l.created_by != null && Date.now() - Date.parse(l.created_at.replace(" ", "T") + "Z") < 24 * 3600 * 1000,
  }));
  const uploads = queryRows<LogoRow>("SELECT id, kind, file, name, mime, bytes FROM link_logos WHERE kind = 'upload' ORDER BY id DESC LIMIT 24").map((l) => logoRef(l));
  return {
    enabled: true, canManage: true, canEditHeader: canEditHeader(u), window: w,
    page: { id: p.id, slug: p.slug, name: p.name, intro: p.intro, logo: logoRef(logoById(p.logo_id)), logoId: p.logo_id, url: "https://nafisvam.com/links" },
    links, builtinLogos: LOGOS.map(([k, n]) => ({ id: builtinLogoId(k), key: k, name: n })), uploads, sitePages: SITE_PAGES, leadUrl: LEAD_URL,
  };
}

/* public payload, cached in memory and cleared on every save (spec §۵.۲: «همان لحظه») */
let version = 1; let cache: { v: number; body: string; etag: string } | null = null;
function bump() { version++; cache = null; }
export const peekPublic = () => (cache && cache.v === version ? cache : null);
export function publicPayload(): { body: string; etag: string } {
  if (cache && cache.v === version) return cache;
  ensureSchema();
  const p = page();
  const links = queryRows<LinkRow>("SELECT * FROM links WHERE page_id = ? AND visible = 1 ORDER BY position, id", [p.id])
    .map((l) => ({ id: l.id, type: l.type, title: l.title, url: l.url, lead: l.type === "lead", logo: logoRef(logoById(l.logo_id)) }));
  const body = JSON.stringify({ name: p.name, intro: p.intro, logo: logoRef(logoById(p.logo_id)), links });
  cache = { v: version, body, etag: `"lp${version}-${body.length}"` };
  return cache;
}
export function publicLogo(id: number): { mime: string; data: Uint8Array } | null {
  ensureSchema();
  const r = queryRow<{ mime: string; data: Uint8Array }>("SELECT mime, data FROM link_logos WHERE id = ? AND kind = 'upload'", [id]);
  return r && r.data ? r : null;
}

/* ---------------- writes (all logged, all bump the cache) ---------------- */
const log = (u: U, action: string, linkId: number | null, detail: unknown) =>
  execute("INSERT INTO link_page_log (page_id, link_id, user_id, action, detail) VALUES (?, ?, ?, ?, ?)", [page().id, linkId, u.id, action, JSON.stringify(detail)]);
type Fail = { ok: false; status: number; error: string; message: string; field?: string };
const fail = (status: number, error: string, message: string, field?: string): Fail => ({ ok: false, status, error, message, field });

function validLogoId(v: unknown): number | null | "bad" {
  if (v == null || v === "") return null;
  const id = Number(v); if (!Number.isInteger(id) || id <= 0) return "bad";
  return queryRow("SELECT id FROM link_logos WHERE id = ?", [id]) ? id : "bad";
}
function checkTitle(raw: unknown): string | Fail {
  const t = clean(raw);
  if (!t || charLen(t) > 40) return fail(422, "title", MSG.title, "title");
  const e = publicTextError(t); if (e) return fail(422, "title", e, "title");
  return t;
}

export function addLink(u: U, body: any) {
  ensureSchema();
  const type = String(body?.type ?? ""); if (!TYPES[type]) return fail(422, "type", MSG.type, "type");
  const title = checkTitle(body?.title); if (typeof title !== "string") return title;
  const b = buildUrl(type, body?.value); if (!b.ok) return fail(422, "value", b.error, "value");
  const logo = validLogoId(body?.logoId); if (logo === "bad") return fail(422, "logo", MSG.logo, "logo");
  const logoId = logo ?? builtinLogoId(TYPES[type].lg);
  const p = page();
  const pos = (queryRow<{ m: number | null }>("SELECT MAX(position) AS m FROM links WHERE page_id = ?", [p.id])?.m ?? 0) + 1;
  const id = execute("INSERT INTO links (page_id, type, title, value, url, logo_id, position, visible, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    [p.id, type, title, b.value, b.url, logoId, pos, u.id, u.id]);
  log(u, "add", id, { type, title, url: b.url, logoId });
  bump();
  return { ok: true as const, id };
}

export function editLink(u: U, id: number, body: any) {
  ensureSchema();
  const l = queryRow<LinkRow>("SELECT * FROM links WHERE id = ? AND page_id = ?", [id, page().id]);
  if (!l) return fail(404, "not_found", "این لینک پیدا نشد؛ شاید حذف شده باشد.");
  const sets: string[] = []; const vals: (string | number | null)[] = []; const detail: Record<string, unknown> = {};
  if ("visible" in (body ?? {})) { const v = body.visible ? 1 : 0; sets.push("visible = ?"); vals.push(v); detail.visible = !!v; }
  if ("title" in (body ?? {})) { const t = checkTitle(body.title); if (typeof t !== "string") return t; sets.push("title = ?"); vals.push(t); detail.title = t; }
  let type = l.type;
  if ("type" in (body ?? {})) { if (!TYPES[String(body.type)]) return fail(422, "type", MSG.type, "type"); type = String(body.type); }
  if ("value" in (body ?? {}) || type !== l.type) {
    const b = buildUrl(type, "value" in body ? body.value : l.value); if (!b.ok) return fail(422, "value", b.error, "value");
    sets.push("type = ?", "value = ?", "url = ?"); vals.push(type, b.value, b.url); detail.type = type; detail.url = b.url;
  }
  if ("logoId" in (body ?? {})) {
    const lg = validLogoId(body.logoId); if (lg === "bad") return fail(422, "logo", MSG.logo, "logo");
    sets.push("logo_id = ?"); vals.push(lg ?? builtinLogoId(TYPES[type].lg)); detail.logoId = lg;
  }
  if (!sets.length) return { ok: true as const, id };
  executeChanges(`UPDATE links SET ${sets.join(", ")}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`, [...vals, u.id, id]);
  log(u, "visible" in detail && Object.keys(detail).length === 1 ? (detail.visible ? "show" : "hide") : "edit", id, detail);
  bump();
  return { ok: true as const, id };
}

/** delete is final (spec §۲ / پرسش ۲): the link and its click counts go; nothing to restore */
export function deleteLink(u: U, id: number) {
  ensureSchema();
  const l = queryRow<LinkRow>("SELECT * FROM links WHERE id = ? AND page_id = ?", [id, page().id]);
  if (!l) return fail(404, "not_found", "این لینک پیدا نشد؛ شاید حذف شده باشد.");
  executeChanges("DELETE FROM link_clicks WHERE link_id = ?", [id]);
  executeChanges("DELETE FROM links WHERE id = ?", [id]);
  log(u, "delete", id, { type: l.type, title: l.title, url: l.url });
  bump();
  return { ok: true as const };
}

export function reorder(u: U, ids: unknown) {
  ensureSchema();
  const p = page();
  const have = queryRows<{ id: number }>("SELECT id FROM links WHERE page_id = ? ORDER BY position, id", [p.id]).map((r) => r.id);
  if (!Array.isArray(ids) || ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((x) => have.includes(Number(x))))
    return fail(409, "stale", "فهرست عوض شده است؛ صفحه را تازه کن و دوباره جابه‌جا کن.");
  ids.forEach((x, i) => executeChanges("UPDATE links SET position = ? WHERE id = ?", [i + 1, Number(x)]));
  log(u, "reorder", null, { order: ids.map(Number) });
  bump();
  return { ok: true as const };
}

export function saveHeader(u: U, body: any) {
  ensureSchema();
  if (!canEditHeader(u)) return fail(403, "header_admin_only", "سربرگ را فقط مدیر سیستم عوض می‌کند.");
  const name = clean(body?.name), intro = clean(body?.intro);
  if (!name || charLen(name) > 30) return fail(422, "name", "نام را بنویس (تا ۳۰ نویسه).", "name");
  if (charLen(intro) > 80) return fail(422, "intro", "معرفی کوتاه تا ۸۰ نویسه است.", "intro");
  for (const [f, s] of [["name", name], ["intro", intro]] as const) { const e = publicTextError(s); if (e) return fail(422, f, e, f); }
  const lg = validLogoId(body?.logoId); if (lg === "bad") return fail(422, "logo", MSG.logo, "logo");
  const p = page();
  executeChanges("UPDATE link_pages SET name = ?, intro = ?, logo_id = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?", [name, intro, lg ?? p.logo_id, u.id, p.id]);
  log(u, "header", null, { name, intro, logoId: lg ?? p.logo_id });
  bump();
  return { ok: true as const };
}

/* ---------------- logo upload (PNG/SVG ≤ 200 KB; SVG sanitized) ---------------- */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export function checkUpload(buf: Uint8Array, declared: string): { ok: true; mime: string; data: Uint8Array } | Fail {
  const kb = Math.ceil(buf.length / 1024);
  if (buf.length > MAX_UPLOAD) return fail(413, "too_large", `حجم این فایل ${kb} کیلوبایت است؛ حداکثر ۲۰۰ کیلوبایت. فایل کوچک‌تری انتخاب کن.`);
  if (!buf.length) return fail(422, "empty", "فایل خالی است.");
  const isPng = PNG_SIG.every((b, i) => buf[i] === b) && String.fromCharCode(...buf.slice(12, 16)) === "IHDR";
  if (isPng) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const w = dv.getUint32(16), h = dv.getUint32(20);
    if (!w || !h || w > 4096 || h > 4096) return fail(422, "bad_png", "این PNG خراب است یا ابعادش بیش از اندازه است.");
    return { ok: true, mime: "image/png", data: buf };
  }
  const head = buf.slice(0, 3);
  if (head[0] === 0xff && head[1] === 0xd8) return fail(415, "format", "این فایل JPG است؛ فقط PNG یا SVG قبول می‌شود. فایل را به PNG تبدیل کن.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return fail(415, "format", "فقط PNG یا SVG قبول می‌شود."); }
  if (!/<svg[\s>]/i.test(text)) return fail(415, "format", "فقط PNG یا SVG قبول می‌شود.");
  let svg: string;
  try { svg = sanitizeSvg(text); } catch (e) { if (e instanceof SvgRejected) return fail(422, "bad_svg", "این SVG خوانده نشد؛ آن را دوباره ذخیره یا به PNG تبدیل کن."); throw e; }
  if (!/<(path|circle|ellipse|rect|line|polyline|polygon|text|use)\b/.test(svg)) return fail(422, "bad_svg", "در این SVG شکلی برای نمایش نماند؛ فایل دیگری انتخاب کن.");
  void declared;
  return { ok: true, mime: "image/svg+xml", data: new TextEncoder().encode(svg) };
}
export function saveUpload(u: U, buf: Uint8Array, declared: string, nameRaw: unknown) {
  ensureSchema();
  const c = checkUpload(buf, declared); if (!c.ok) return c;
  const name = clean(nameRaw).slice(0, 60) || "لوگو";
  const biz = page().business_id;
  const id = execute("INSERT INTO link_logos (business_id, kind, file, name, mime, bytes, data, created_by) VALUES (?, 'upload', ?, ?, ?, ?, ?, ?)",
    [biz, `upload-${Date.now()}`, name, c.mime, c.data.length, c.data as any, u.id]);
  log(u, "logo_upload", null, { logoId: id, mime: c.mime, bytes: c.data.length });
  return { ok: true as const, id, mime: c.mime, bytes: c.data.length };
}

/* ---------------- clicks (no cookie, no IP stored; bots / prefetch ignored) ---------------- */
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|headless|lighthouse|curl|wget|python|httpclient|okhttp|java\//i;
const seen = new Map<string, number>();
export function countClick(id: number, ua: string, purpose: string, ipKey: string): boolean {
  if (!ua || BOT_RE.test(ua) || /prefetch|prerender|preview/i.test(purpose)) return false;
  const now = Date.now(); const k = `${ipKey}|${id}`;
  if ((seen.get(k) ?? 0) > now - 10_000) return false; // one tap per link per 10 s per client
  seen.set(k, now);
  if (seen.size > 20000) for (const [kk, t] of seen) if (t < now - 10_000) seen.delete(kk);
  ensureSchema();
  if (!queryRow("SELECT id FROM links WHERE id = ? AND visible = 1", [id])) return false;
  execute("INSERT INTO link_clicks (link_id, day, count) VALUES (?, ?, 1) ON CONFLICT(link_id, day) DO UPDATE SET count = count + 1", [id, tehranDay()]);
  return true;
}
