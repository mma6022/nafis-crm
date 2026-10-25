// crm-site-leads fixture (needs a DB copy; not a `test:` script).
//   SITE_LEADS_SOURCE_DB=/path/to/copy.db node scripts/site-leads-fixture.mjs
// The source is opened read-only and backed up into a temp dir; everything runs on that temp copy, which is removed at
// the end. ALL outbound network is refused (only 127.0.0.1), no SMS / Telegram, notification env vars removed.
// Prints ids and counts only (no phones / names).
// Proves: additive migration + back-fill (schema_version bumps once), tag lifecycle request → tag → call → off the top
// → history kept, repeat request on a P1, system timeline rows do not answer, callbacks, 3-working-hour deadline /
// countdown maths, «اول لیست» order per expert over HTTP (Kazemi / Hasani / Ghasemi) with the rest in the old order,
// preferred-window alerts (in-CRM only here, once), and owner / priority / status hash identical before and after.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = process.env.SITE_LEADS_SOURCE_DB;
if (!source) { console.error("Set SITE_LEADS_SOURCE_DB to a CRM database copy."); process.exit(2); }
const temp = await mkdtemp(path.join(os.tmpdir(), "site-leads-fx-"));
const file = path.join(temp, "fixture.db");
{ const original = new DatabaseSync(path.resolve(source), { readOnly: true }); await backup(original, file); original.close(); }
const secret = randomBytes(32).toString("hex");
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY/i.test(k)) delete process.env[k];
Object.assign(process.env, { CRM_DATABASE_PATH: file, CONTRACTS_STORAGE_DIR: path.join(temp, "contracts"), SESSION_SECRET: secret, NODE_ENV: "production",
  LOG_LEVEL: "warn", AI_INTEGRATIONS_OPENAI_BASE_URL: "https://fixture.invalid/ai", AI_INTEGRATIONS_OPENAI_API_KEY: "fixture",
  SAPI_API_BASE_URL: "https://fixture.invalid", SAPI_API_TOKEN: "fixture", EMZAME_BASE_URL: "https://fixture.invalid/emzame", EMZAME_NATIONAL_CODE: "fixture", EMZAME_PASSWORD: "fixture" });
delete process.env.SAPI_RELAY_URL;
const nativeFetch = globalThis.fetch;
const refused = [];
globalThis.fetch = async (url, o) => { if (!String(url).startsWith("http://127.0.0.1:")) { refused.push(String(url).slice(0, 30)); throw new Error("network forbidden in fixture"); } return nativeFetch(url, o); };

// schema_version of the untouched copy (before any CRM module opens it)
const pre = new DatabaseSync(file, { readOnly: true });
const schemaBefore = Number(pre.prepare("PRAGMA schema_version").get().schema_version);
const ownerSql = "SELECT id, COALESCE(salesperson_id,-1) s, COALESCE(priority,-1) p, COALESCE(status,'') st, COALESCE(merged_into_customer_id,-1) m FROM customers ORDER BY id";
const ownerHash = (rows) => createHash("sha256").update(rows.map((r) => `${r.id}|${r.s}|${r.p}|${r.st}|${r.m}`).join("\n")).digest("hex");
const ownersBefore = pre.prepare(ownerSql).all();
const hashBefore = ownerHash(ownersBefore);
const settingsHashOf = (db) => createHash("sha256").update(JSON.stringify(db.prepare("SELECT key, value FROM notification_settings ORDER BY key").all())).digest("hex");
const settingsBefore = settingsHashOf(pre);
const hadTable = !!pre.prepare("SELECT 1 FROM sqlite_master WHERE name='site_lead_requests'").get();
pre.close();

const bundle = path.join(temp, "http.mjs");
await build({ stdin: { contents: `
 import express from "express"; import cookieParser from "cookie-parser";
 import { requireAuth } from "./src/lib/auth";
 import crm from "./src/routes/crm";
 export * from "./src/lib/crm-db"; export * as sl from "./src/lib/site-leads"; export * as pl from "./src/lib/public-leads";
 export * as cb from "./src/lib/callback-requests"; export * as rules from "./src/lib/team-sales-rules"; export * as ts from "./src/lib/team-sales";
 export const app = express(); app.use(express.json(), cookieParser()); app.use("/api", requireAuth, crm);
 `, resolveDir: process.cwd(), sourcefile: "site-leads-fixture.ts" }, bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(process.cwd(), "package.json")).href)});` } });

let n = 0; const ok = (m) => { n++; console.log("ok -", m); };
let server;
try {
  const f = await import(pathToFileURL(bundle).href); const db = f.crmDb; const { sl, pl, cb, rules } = f;
  const sv = () => Number(db.prepare("PRAGMA schema_version").get().schema_version);
  const cfg = f.ts.getTeamSalesConfig();
  assert.equal(cfg.qualifierSalespersonId, 6); assert.deepEqual(cfg.closerSalespersonIds.map(Number), [3, 4]); assert.equal(cfg.closerFirstCallWorkingHours, 3);

  // ---------- migration + back-fill ----------
  const opened = sv();
  const mig = sl.ensureSiteLeadSchema();
  const afterMig = sv();
  const again = sl.ensureSiteLeadSchema(db); // forced second pass (bypasses the cache): must be a no-op
  assert.equal(again.created, false);
  assert.equal(sv(), afterMig, "second ensure must not bump schema_version");
  if (!hadTable) { assert.equal(mig.created, true); assert.ok(afterMig > opened, "real migration bumps schema_version"); }
  const bf = f.queryRow("SELECT COUNT(*) n, SUM(answered_at IS NULL) open, SUM(is_repeat) rep, COUNT(DISTINCT CASE WHEN answered_at IS NULL THEN customer_id END) cust FROM site_lead_requests");
  const bfRep = f.queryRow("SELECT COUNT(DISTINCT customer_id) n FROM site_lead_requests WHERE answered_at IS NULL AND is_repeat=1");
  const perOwner = f.queryRows(`SELECT COALESCE(c.salesperson_id,0) sp, COUNT(DISTINCT r.customer_id) n FROM site_lead_requests r JOIN customers c ON c.id=r.customer_id
    WHERE r.answered_at IS NULL GROUP BY 1 ORDER BY 1`);
  console.log("BACKFILL", JSON.stringify({ schemaBefore, opened, afterMig, created: mig.created, requests: bf.n, unanswered: bf.open, activeCustomers: bf.cust, repeatCustomers: bfRep.n,
    perOwner: perOwner.map((r) => [r.sp, r.n]) }));
  assert.equal(Number(f.queryRow("SELECT COUNT(*) n FROM site_lead_requests WHERE window_alerted_at IS NULL").n), 0, "back-filled rows never alert retroactively");
  assert.equal(Number(f.queryRow("SELECT COUNT(*) n FROM site_notification_events WHERE kind='site-lead-window'").n), 0);
  ok(`migration: table + back-fill (${bf.n} requests, ${bf.open} unanswered on ${bf.cust} customers), schema_version only on the real migration, re-run no-op`);

  // ---------- deadline / countdown maths (fixed Tehran times) ----------
  const T = (s) => new Date(s + "+03:30");
  const due = (at, ct) => sl.siteLeadDue(T(at), ct, cfg).toISOString();
  const iso = (s) => T(s).toISOString();
  // 2026-10-24 = Saturday (working), 2026-10-30 = Friday (off), 2026-10-29 = Thursday (working)
  assert.equal(due("2026-10-24T10:00:00", "any"), iso("2026-10-24T13:00:00"));
  assert.equal(due("2026-10-24T17:00:00", "any"), iso("2026-10-25T11:00:00"));
  assert.equal(due("2026-10-24T06:30:00", "any"), iso("2026-10-24T12:00:00"));
  assert.equal(due("2026-10-30T11:00:00", "any"), iso("2026-10-31T12:00:00"));
  assert.equal(due("2026-10-24T14:00:00", "morning"), iso("2026-10-25T12:00:00"));
  assert.equal(due("2026-10-24T10:00:00", "evening"), iso("2026-10-24T16:00:00"));
  assert.equal(due("2026-10-24T10:00:00", "morning"), iso("2026-10-24T13:00:00"));
  assert.equal(due("2026-10-29T19:00:00", "evening"), iso("2026-10-31T16:00:00"));
  assert.equal(sl.windowIsNow("morning", T("2026-10-24T09:05:00"), cfg), true);
  assert.equal(sl.windowIsNow("morning", T("2026-10-24T13:05:00"), cfg), false);
  assert.equal(sl.windowIsNow("evening", T("2026-10-24T13:05:00"), cfg), true);
  assert.equal(sl.windowIsNow("any", T("2026-10-30T10:00:00"), cfg), false);
  assert.equal(sl.windowIsNow("now", T("2026-10-24T20:00:00"), cfg), false);
  ok("deadline = 3 working hours from the request (or from the asked window), Fri / after-hours skipped; window-now rule");

  // ---------- synthetic intake on the copy ----------
  const phone = () => `0990${String(1000000 + Math.floor(Math.random() * 8999999))}`;
  const lead = (ph, ct = "any") => ({ name: "مشتری نمونه", phone: ph, need: pl.NEEDS[0], amountBand: pl.AMOUNT_BANDS[0], planId: null, term: null, contactTime: ct, src: null, utm: {} });
  const active = (id) => sl.activeSiteLeads([id]).get(id) ?? null;
  const hasTag = (id) => !!f.queryRow("SELECT 1 x FROM customer_tags WHERE customer_id=? AND tag='website_lead'", [id]);

  // lifecycle: request → tag → call → off the top → history kept
  const ph1 = phone();
  const r1 = pl.recordPublicLead(lead(ph1, "morning"), "fx-ip-1");
  assert.equal(r1.created, true);
  const s1 = active(r1.customerId);
  assert.ok(s1 && !s1.isRepeat && s1.contactTime === "morning" && hasTag(r1.customerId));
  assert.ok(sl.topOfList().some((t) => t.customerId === r1.customerId && t.kind === "site_lead"));
  // timeline system rows are not calls
  f.execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,created_at) VALUES (?,?,?,?)", [r1.customerId, null, "اطلاعات تماس اول درست بود", new Date().toISOString()]);
  f.execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,created_at) VALUES (?,?,?,?)", [r1.customerId, null, "ارتقا به اولویت ۱ توسط نمونه", new Date().toISOString()]);
  assert.ok(active(r1.customerId), "system timeline rows must not answer a site lead");
  const callId = f.execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,created_at) VALUES (?,?,?,?)", [r1.customerId, 6, "تماس اول", new Date().toISOString()]);
  assert.equal(active(r1.customerId), null);
  assert.ok(!sl.topOfList().some((t) => t.customerId === r1.customerId && t.kind === "site_lead"));
  const h1 = sl.siteLeadHistory(r1.customerId);
  assert.equal(h1.length, 1); assert.equal(h1[0].answeredByCallId, callId); assert.equal(h1[0].answerSource, "call_log"); assert.ok(hasTag(r1.customerId));
  // second request from the same (now existing) customer = repeat, active again
  pl.recordPublicLead(lead(ph1, "any"), "fx-ip-1");
  const s1b = active(r1.customerId);
  assert.ok(s1b && s1b.isRepeat && s1b.openRequests === 1);
  assert.equal(sl.siteLeadHistory(r1.customerId).length, 2);
  ok("lifecycle: request → «سرنخ سایت» → real call answers it (system rows do not) → off the top, history kept; resubmission = «درخواست چندباره»");

  // repeat request on an existing P1 of Hasani (owner / priority untouched)
  const p1 = f.queryRow("SELECT id, phone FROM customers WHERE salesperson_id=3 AND priority=1 AND merged_into_customer_id IS NULL AND COALESCE(status,'in_progress')='in_progress' AND phone IS NOT NULL ORDER BY id DESC LIMIT 1");
  const p1Before = f.queryRow("SELECT salesperson_id s, priority p, status st FROM customers WHERE id=?", [p1.id]);
  const rp = pl.recordPublicLead(lead(p1.phone, "evening"), "fx-ip-2");
  assert.equal(rp.created, false); assert.equal(rp.customerId, Number(p1.id));
  const sp1 = active(rp.customerId);
  assert.ok(sp1 && sp1.isRepeat && sp1.contactTime === "evening");
  assert.deepEqual(f.queryRow("SELECT salesperson_id s, priority p, status st FROM customers WHERE id=?", [p1.id]), p1Before);
  ok(`repeat request on a P1 (#${p1.id}, Hasani): «سرنخ سایت» + «درخواست چندباره», owner / priority / status unchanged`);

  // callbacks: linked → repeat request; «تماس گرفته شد» answers it; unknown phone → none until converted
  const ghasemiCust = f.queryRow("SELECT id, phone FROM customers WHERE salesperson_id=4 AND merged_into_customer_id IS NULL AND COALESCE(status,'in_progress')='in_progress' AND phone IS NOT NULL AND id NOT IN (SELECT customer_id FROM site_lead_requests) ORDER BY id DESC LIMIT 1");
  const cbr = pl.recordPublicCallback({ name: "نمونه", phone: ghasemiCust.phone, contactTime: "now", need: null, planId: null, src: null, utm: {} }, "fx-ip-3");
  assert.equal(cbr.customerId, Number(ghasemiCust.id));
  assert.ok(active(cbr.customerId)?.isRepeat);
  const admin = { id: 1, role: "admin", permissions: ["callbacks.view", "callbacks.manage", "callbacks.assign", "customers.create", "customers.view"], customerScope: "all" };
  assert.equal(cb.setCallbackStatus(admin, cbr.id, "called").ok, true);
  assert.equal(active(cbr.customerId), null);
  assert.equal(sl.siteLeadHistory(cbr.customerId)[0].answerSource, "callback_called");
  const cbNew = pl.recordPublicCallback({ name: "نمونه", phone: phone(), contactTime: "morning", need: null, planId: null, src: null, utm: {} }, "fx-ip-4");
  assert.equal(cbNew.customerId, null);
  assert.equal(Number(f.queryRow("SELECT COUNT(*) n FROM site_lead_requests WHERE source='callback' AND source_id=?", [cbNew.id]).n), 0);
  const conv = cb.convertCallback(admin, cbNew.id);
  assert.equal(conv.ok, true);
  const convCust = Number(f.queryRow("SELECT customer_id c FROM callback_requests WHERE id=?", [cbNew.id]).c);
  assert.ok(active(convCust) && !active(convCust).isRepeat);
  ok("callbacks: linked callback = repeat request, «تماس گرفته شد» answers it; unlinked one counts once converted");

  // cancelled customer with a new site request is listed under «در حال پیگیری»
  const cancelled = f.queryRow("SELECT id, phone, salesperson_id s FROM customers WHERE status='cancelled' AND merged_into_customer_id IS NULL AND phone IS NOT NULL AND salesperson_id=6 ORDER BY id DESC LIMIT 1");

  // ---------- HTTP: «اول لیست» per expert ----------
  const ts0 = new Date().toISOString();
  const sessions = {};
  for (const [role, uid] of [["kazemi", 8], ["hasani", 2], ["ghasemi", 3], ["admin", 1]]) {
    const token = randomBytes(24).toString("base64url");
    f.execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      [createHmac("sha256", secret).update(token).digest("hex"), uid, new Date(Date.now() + 600000).toISOString(), ts0]);
    sessions[role] = `crm_session=${token}`;
  }
  server = f.app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (role, route) => { const r = await fetch(base + route, { headers: { Cookie: sessions[role] } }); assert.equal(r.status, 200, route); return r.json(); };
  const all = async (role, qs) => {
    const items = []; let total = Infinity;
    for (let off = 0; off < total; off += 100) { const b = await get(role, `/customers?${qs}&limit=100&offset=${off}`); total = b.total; items.push(...b.items); if (!b.items.length) break; }
    return items;
  };
  if (cancelled) pl.recordPublicLead(lead(cancelled.phone, "any"), "fx-ip-5");
  const top = sl.topOfList();
  const keyOf = (id) => f.queryRow(`SELECT (c.priority IS NOT NULL) a, CASE
      WHEN EXISTS (SELECT 1 FROM customer_portal_registrations p WHERE p.customer_id=c.id) THEN 0
      WHEN EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id=c.id AND t.tag='repeat_request') THEN 1
      WHEN c.is_urgent=1 THEN 2 ELSE 3 END b, c.created_at d FROM customers c WHERE c.id=?`, [id]);
  const cmpOld = (x, y) => { const a = keyOf(x), b = keyOf(y); return a.a - b.a || a.b - b.b || (a.d < b.d ? 1 : a.d > b.d ? -1 : 0) || y - x; };
  const summary = {};
  for (const [role, sp] of [["kazemi", 6], ["hasani", 3], ["ghasemi", 4]]) {
    const items = await all(role, "status=in_progress");
    const mineTop = top.filter((t) => Number(f.queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [t.customerId])?.s) === sp);
    const head = items.slice(0, mineTop.length).map((i) => Number(i.id));
    assert.deepEqual(head, mineTop.map((t) => t.customerId), `${role}: top rows in «اول لیست» order`);
    for (const [i, it] of items.slice(0, mineTop.length).entries()) {
      assert.ok(it.topOfList && it.topOfList.kind === mineTop[i].kind && it.topOfList.dueAt === mineTop[i].dueAt);
      if (it.topOfList.kind === "site_lead") assert.ok(it.siteLead && it.siteLead.dueAt === it.topOfList.dueAt);
    }
    const sites = mineTop.filter((t) => t.kind === "site_lead"), kzs = mineTop.filter((t) => t.kind === "from_kazemi");
    assert.equal(mineTop.findIndex((t) => t.kind === "from_kazemi") === -1 || mineTop.findIndex((t) => t.kind === "from_kazemi") >= sites.length, true, "site leads before «از کاظمی»");
    if (role === "kazemi") assert.equal(kzs.length, 0, "Kazemi's own list has no «از کاظمی» group");
    const rest = items.slice(mineTop.length).map((i) => Number(i.id));
    assert.ok(rest.every((id) => !top.some((t) => t.customerId === id)));
    for (let i = 1; i < rest.length; i++) assert.ok(cmpOld(rest[i - 1], rest[i]) <= 0, `${role}: rest keeps the previous order at ${i}`);
    // P1s are below active site leads
    const firstP1 = items.findIndex((i) => i.priority === 1 && !i.topOfList);
    assert.ok(firstP1 === -1 || firstP1 >= mineTop.length);
    const q = await get(role, "/site-leads/queue");
    assert.deepEqual(q.items.map((x) => x.customerId), mineTop.map((t) => t.customerId), `${role}: queue = top rows`);
    const now = Date.now();
    summary[role] = { listed: items.length, siteLeads: sites.length, repeats: sites.filter((t) => sl.activeSiteLeads([t.customerId]).get(t.customerId)?.isRepeat).length,
      fromKazemi: kzs.length, overdueSiteLeads: sites.filter((t) => Date.parse(t.dueAt) <= now).length };
  }
  if (cancelled) {
    const kItems = await all("kazemi", "status=in_progress");
    assert.ok(kItems.some((i) => Number(i.id) === Number(cancelled.id) && i.topOfList?.kind === "site_lead"), "cancelled customer with a new site request shows under «در حال پیگیری»");
  }
  const adminQ = await get("admin", "/site-leads/queue");
  assert.equal(adminQ.items.length, top.length);
  console.log("TOP (fixture copy, incl. synthetic rows)", JSON.stringify(summary));
  const detail = await get("hasani", `/customers/${p1.id}`);
  assert.ok(detail.siteLead?.isRepeat && Array.isArray(detail.siteLeadRequests) && detail.siteLeadRequests.length >= 1 && detail.topOfList?.kind === "site_lead");
  ok("HTTP: per expert, active site leads (repeats incl., above P1s) → «از کاظمی» in deadline → the previous order; queue + detail agree");

  // explicit «آخرین تماس» sort is the user's choice: no top prefix
  const lc = await get("kazemi", "/customers?status=in_progress&sortBy=lastCallAt&sortDirection=desc&limit=50");
  for (let i = 1; i < lc.items.length; i++) { const a = lc.items[i - 1].lastCallAt, b = lc.items[i].lastCallAt; assert.ok(b == null || (a != null && a >= b)); }
  ok("explicit last-call sort untouched");

  // ---------- preferred-window alerts ----------
  // synthetic Kazemi morning request received before 09:00 on a working day → one in-CRM notification at 09:00+, once.
  const ph2 = phone();
  const r2 = pl.recordPublicLead(lead(ph2, "morning"), "fx-ip-6");
  const owner2 = Number(f.queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [r2.customerId]).s);
  f.execute("UPDATE customers SET salesperson_id=6 WHERE id=?", [r2.customerId]); // synthetic customer only
  const tomorrow9 = (() => { const d = new Date(Date.now() + 3.5 * 3600e3); for (let i = 1; i < 8; i++) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, 0, 9 * 60 - 210 + 5)); if (cfg.workDays.includes(new Date(x.getTime() + 3.5 * 3600e3).getUTCDay())) return x; } })();
  const tg = [];
  const fired = await sl.siteLeadWindowTick(tomorrow9, { telegram: async (alerts) => { tg.push(alerts.length); return "disabled"; } });
  assert.ok(fired.some((a) => a.customerId === r2.customerId));
  assert.ok(fired.every((a) => a.contactTime === "morning" && a.ownerId === 6));
  const ev = f.queryRow("SELECT kind, resource_type rt, resource_id rid, permission, owner_id o, title FROM site_notification_events WHERE kind='site-lead-window' AND customer_id=?", [r2.customerId]);
  assert.equal(ev.rt, "customer"); assert.equal(Number(ev.rid), r2.customerId); assert.equal(ev.permission, "customers.view"); assert.equal(Number(ev.o), 6);
  assert.equal(ev.title, "مشتری خواسته صبح تماس بگیرید");
  assert.deepEqual(tg, [fired.length]);
  assert.equal((await sl.siteLeadWindowTick(new Date(tomorrow9.getTime() + 60e3), {})).length, 0, "each request alerts once");
  assert.equal((await sl.siteLeadWindowTick(new Date(tomorrow9.getTime() - 3 * 3600e3), {})).length, 0, "no alert outside working hours");
  // Hasani's evening P1 repeat is not Kazemi's → no alert
  assert.ok(!fired.some((a) => a.customerId === rp.customerId));
  f.execute("UPDATE customers SET salesperson_id=? WHERE id=?", [owner2 || null, r2.customerId]);
  ok(`window alerts: ${fired.length} in-CRM notification(s) at the start of «صبح», once each, Kazemi's only; Telegram via injected stub only`);

  // ---------- invariants ----------
  const ownersAfter = db.prepare(ownerSql).all().filter((r) => ownersBefore.some((b) => b.id === r.id));
  assert.equal(ownerHash(ownersAfter), hashBefore, "owner / priority / status hash of existing customers unchanged");
  assert.equal(settingsHashOf(db), settingsBefore, "notification_settings unchanged (team_sales_config incl.)");
  assert.deepEqual(refused, [], "no outbound network attempted");
  ok(`owner hash identical (${ownersBefore.length} customers), notification_settings untouched, no outbound network`);
  console.log(`\n${n} checks passed`);
} finally {
  if (server) server.close();
  await rm(temp, { recursive: true, force: true });
}
