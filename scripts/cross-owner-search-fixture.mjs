// Cross-owner faded hints (crm-id-search-everywhere): exact-only, minimal fields, rate limited,
// assigned-scope salespersons incl. trainees and (Task C) the team-sales qualifier; never admin / registrar / user 29.
// Masked name + mobile, owner label, «انتقال تماس به کارشناسش» (extension + one bell to the owner), audit log. Synthetic temp DB only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// crm-db is replaced by an in-memory DB with only the tables this lookup reads, plus the
// real SQL normalisers (registerCustomerIdentityFunctions). No real data is touched.
process.env.NODE_ENV = "production"; // plain JSON logs (no pino-pretty transport in the bundle)
process.env.LOG_LEVEL = "silent";
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "crm-cross-owner-"));
const stubDb = `
  import { DatabaseSync } from "node:sqlite";
  import { registerCustomerIdentityFunctions } from "./src/lib/customer-integrity";
  export const databasePath = ":memory:";
  export const crmDb = new DatabaseSync(":memory:");
  registerCustomerIdentityFunctions(crmDb);
  crmDb.exec(\`CREATE TABLE salespersons(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, national_code TEXT,
      salesperson_id INTEGER REFERENCES salespersons(id), merged_into_customer_id INTEGER);
    CREATE TABLE notification_settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY, salesperson_id INTEGER, role TEXT, active INTEGER, full_name TEXT);
    CREATE TABLE voip_extensions(user_id INTEGER PRIMARY KEY, extension TEXT);
    CREATE TABLE site_notification_events(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,customer_name TEXT NOT NULL,
      owner_id INTEGER,resource_type TEXT NOT NULL,resource_id INTEGER NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',
      permission TEXT NOT NULL,created_at TEXT NOT NULL,actor_key TEXT,recipient_user_id INTEGER);\`);
  export const queryRow=(sql,params=[])=>crmDb.prepare(sql).get(...params);
  export const queryRows=(sql,params=[])=>crmDb.prepare(sql).all(...params);
  export const execute=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
  export const executeChanges=(sql,params=[])=>crmDb.prepare(sql).run(...params).changes;
  export const runTransaction=fn=>{crmDb.exec("BEGIN");try{const r=fn();crmDb.exec("COMMIT");return r}catch(e){crmDb.exec("ROLLBACK");throw e}};
  export const runImmediateTransaction=runTransaction;
`;
const plugin = { name: "fx", setup(ctx) {
  ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fx" }));
  ctx.onLoad({ filter: /.*/, namespace: "fx" }, () => ({ contents: stubDb, resolveDir: apiRoot, loader: "ts" }));
} };
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok -", name); };
try {
  const out = path.join(temp, "lib.mjs");
  await build({ stdin: { contents: 'export * from "./src/lib/cross-owner-search"; export * as db from "./src/lib/crm-db";', resolveDir: apiRoot, loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent", plugins: [plugin],
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` } });
  const xo = await import(pathToFileURL(out).href);
  const { crmDb, execute } = xo.db;
  const sp = (id, name) => execute("INSERT INTO salespersons(id,name) VALUES(?,?)", [id, name]);
  sp(3, "کارشناس الف"); sp(4, "کارشناس ب"); sp(6, "کارشناس صف");
  const cust = (id, name, phone, spId, extra = {}) => execute(
    `INSERT INTO customers(id,name,phone,salesperson_id,national_code${extra.merged ? ",merged_into_customer_id" : ""}) VALUES(?,?,?,?,?${extra.merged ? ",?" : ""})`,
    [id, name, phone, spId, "0012345678", ...(extra.merged ? [extra.merged] : [])]);
  cust(1234, "مشتری نمونه", "09120000001", 3);
  cust(12, "مشتری دوازده", "09120000012", 4);           // own (sp 4)
  cust(77, "علی رضایی", "09120000077", 3);
  cust(78, "علی رضایی‌نژاد", "09120000078", 3);
  cust(90, "بدون کارشناس", "09120000090", null);
  cust(91, "قدیمی ادغام‌شده", "09120000091", 3, { merged: 1234 });
  // Team-sales qualifier is the default (salesperson 6) — make it explicit.
  execute("INSERT INTO notification_settings(key,value) VALUES('team_sales_config', ?)", [JSON.stringify({ qualifierSalespersonId: 6 })]);

  const seller = { id: 3, role: "salesperson", customerScope: "assigned", salespersonId: 4 };
  const now = Date.now();
  const find = (q, user = seller, t = now) => xo.findOtherOwnerMatches(user, q, t);
  const ids = (q, user, t) => find(q, user, t).items.map((x) => x.id);

  ok("exact customer id in all four forms → other owner's customer", () => {
    for (const q of ["1234", "#1234", "#۱۲۳۴", "۱۲۳۴", "١٢٣٤"]) assert.deepEqual(ids(q), [1234], q);
  });
  ok("exact mobile (any common format) → match", () => {
    for (const q of ["09120000077", "۰۹۱۲۰۰۰۰۰۷۷", "+989120000077", "9120000077", "0912 000 0077"]) assert.deepEqual(ids(q), [77], q);
  });
  ok("exact full name (≥3 letters, Arabic ي/ك and spacing normalised) → match, not the longer name", () => {
    assert.deepEqual(ids("علی رضایی"), [77]);
    assert.deepEqual(ids("  علي   رضايي "), [77]);
    assert.deepEqual(ids("علی رضایی‌نژاد"), [78]);
  });
  ok("enumeration attempts return nothing", () => {
    for (const q of ["0912", "09120000", "0912000007", "091200000777", "912000", "علی", "علی رض", "رضایی", "مشتری", "%", "_", "%%%", "علی%", "ع_ی رضایی", "#", "#0", "0", "12a", "1234567890", "ab", "  "])
      assert.deepEqual(ids(q), [], JSON.stringify(q));
  });
  ok("own, unassigned and merged customers are never returned as faded hints", () => {
    assert.deepEqual(ids("12"), []);                 // own customer
    assert.deepEqual(ids("09120000012"), []);
    assert.deepEqual(ids("90"), []);                 // no owner
    assert.deepEqual(ids("91"), []);                 // merged source
  });
  ok("no PII: id, partial name, masked mobile, owner name only", () => {
    const r = find("1234");
    assert.deepEqual(r, { items: [{ id: 1234, name: "مشتری ن***", maskedPhone: "0912*****01", ownerName: "کارشناس الف" }], limited: false });
    const json = JSON.stringify(r);
    for (const leak of ["09120000001", "نمونه", "0012345678", "national", "salespersonId", "status", "priority", "description", "amount"]) assert.ok(!json.includes(leak), leak);
    assert.equal(xo.maskCustomerName("سهیلا دهقانی"), "سهیلا د***");
    assert.equal(xo.maskCustomerName("سهیلا"), "سه***");
    assert.equal(xo.maskCustomerName(""), "***");
    assert.equal(xo.maskCustomerPhone("۰۹۱۲۱۲۳۴۵۶۷"), "0912*****67");
    assert.equal(xo.maskCustomerPhone("021555"), "***");
  });
  ok("eligibility: experts, trainees 5/19/20 and the qualifier yes; admin, registrar, all-scope and user 29 no", () => {
    for (const u of [{ id: 1, role: "admin", customerScope: "all", salespersonId: null },
      { id: 7, role: "registrar", customerScope: "all", salespersonId: null },
      { id: 9, role: "salesperson", customerScope: "all", salespersonId: 3 },
      { id: 29, role: "salesperson", customerScope: "assigned", salespersonId: 4 }]) {
      assert.equal(xo.crossOwnerEligible(u), false, JSON.stringify(u));
      assert.deepEqual(find("1234", u), { items: [], limited: false });
    }
    assert.equal(xo.crossOwnerEligible(seller), true);
    for (const spId of [5, 19, 20, 6]) assert.equal(xo.crossOwnerEligible({ id: 100 + spId, role: "salesperson", customerScope: "assigned", salespersonId: spId }), true, String(spId));
    assert.deepEqual(ids("1234", { id: 106, role: "salesperson", customerScope: "assigned", salespersonId: 6 }), [1234], "qualifier now sees the hint");
  });
  ok("rate limit: 30 distinct lookups per 10 min, repeats free, then limited, then resets", () => {
    xo.resetCrossOwnerRateLimit();
    const u = { ...seller, id: 50 };
    for (let i = 1; i <= xo.CROSS_OWNER_LIMIT; i++) assert.equal(find(`#${1000 + i}`, u, now).limited, false, String(i));
    assert.equal(find("#1001", u, now).limited, false, "repeat of an earlier lookup is free");
    const blocked = find("1234", u, now);
    assert.deepEqual(blocked, { items: [], limited: true });
    assert.equal(find("09120000077", u, now + 1000).limited, true);
    assert.deepEqual(find("1234", { ...seller, id: 51 }, now).items.map((x) => x.id), [1234], "other users unaffected");
    assert.equal(find("1234", u, now + xo.CROSS_OWNER_WINDOW_MS + 1).limited, false, "window slides");
    // Non-exact input is not a lookup and never consumes the budget.
    xo.resetCrossOwnerRateLimit();
    for (let i = 0; i < 100; i++) find("0912", u, now);
    assert.equal(find("1234", u, now).limited, false);
  });
  ok("searches with matches are logged (no raw query), plain own-only searches are not", () => {
    const before = crmDb.prepare("SELECT COUNT(*) n FROM cross_owner_lookup_log").get().n;
    find("علی رضایی", { ...seller, id: 60 });
    find("0912", { ...seller, id: 60 });
    const rows = crmDb.prepare("SELECT * FROM cross_owner_lookup_log WHERE id>? ORDER BY id").all(before);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, "search"); assert.equal(rows[0].lookup_kind, "name"); assert.equal(rows[0].customer_ids, "[77]");
    assert.ok(!JSON.stringify(rows).includes("رضایی"));
  });
  ok("transfer-call: only after own search; extension + one bell to the owner (5 min); logged; nothing else changes", () => {
    execute("INSERT INTO users(id,salesperson_id,role,active,full_name) VALUES(203,3,'salesperson',1,'کارشناس الف'),(204,4,'salesperson',1,'کارشناس ب'),(205,5,'salesperson',1,'کارآموز')");
    execute("INSERT INTO voip_extensions(user_id,extension) VALUES(203,'105')");
    cust(500, "کارآموز مشتری", "09120000500", null);
    execute("INSERT INTO salespersons(id,name) VALUES(5,'کارآموز')"); execute("UPDATE customers SET salesperson_id=5 WHERE id=500");
    const u = { ...seller, id: 204, fullName: "کارشناس ب" };
    const snapshot = () => JSON.stringify(crmDb.prepare("SELECT id,name,phone,salesperson_id FROM customers ORDER BY id").all());
    const customersBefore = snapshot();
    assert.deepEqual(xo.transferCallHint(u, 77, now), { ok: false, status: 404, error: "این مشتری در نتیجهٔ جست‌وجوی اخیر شما نیست" }, "no search yet");
    assert.equal(xo.transferCallHint({ ...u, id: 29 }, 77, now).status, 403);
    find("09120000077", u, now);
    const r = xo.transferCallHint(u, 77, now);
    assert.deepEqual(r, { ok: true, ownerName: "کارشناس الف", extension: "105", notified: true, notifyReason: null });
    const bells = crmDb.prepare("SELECT * FROM site_notification_events").all();
    assert.equal(bells.length, 1);
    assert.equal(bells[0].recipient_user_id, 203); assert.equal(bells[0].title, "مشتری‌ات زنگ زده"); assert.equal(bells[0].actor_key, "transfer-call:204");
    assert.equal(bells[0].resource_type, "customer"); assert.equal(bells[0].customer_id, 77);
    assert.equal(xo.transferCallHint(u, 77, now + 60_000).notified, false, "no second bell within 5 min");
    assert.equal(xo.transferCallHint(u, 77, now + 6 * 60_000).notified, true, "again after 5 min");
    assert.equal(xo.transferCallHint(u, 77, now + 31 * 60_000).ok, false, "search window expired");
    assert.equal(xo.transferCallHint(u, 12, now).ok, false, "own customer");
    find("09120000500", u, now);
    const t = xo.transferCallHint(u, 500, now);
    assert.equal(t.ok && t.notified, false, "trainee owner gets no bell"); assert.equal(t.extension, null);
    find("علی رضایی", { ...u, id: 61 }, now);
    assert.equal(xo.transferCallHint({ ...u, id: 61 }, 77, now, { notify: false }).notified, false, "notify switch off");
    assert.equal(crmDb.prepare("SELECT COUNT(*) n FROM site_notification_events").get().n, 2);
    assert.ok(crmDb.prepare("SELECT COUNT(*) n FROM cross_owner_lookup_log WHERE action='transfer_click'").get().n >= 5);
    assert.equal(snapshot(), customersBefore, "no customer / ownership change");
  });
  ok("duplicate-mobile lookups: another expert's profile is redacted for a salesperson; owner/admin unchanged", () => {
    const full = { id: 77, name: "علی رضایی", phone: "09120000077", salespersonId: 3, salespersonName: "کارشناس الف", status: "in_progress",
      priority: 1, isUrgent: true, activityCount: 4, pendingRepeatRequestCount: 0, description: "یادداشت محرمانه", nationalCode: "0012345678",
      postalCode: "1234567890", birthDateJalali: "1370/01/01", tags: [{ id: 1 }], creditScore: 700 };
    const r = xo.redactForeignCustomer(seller, full);
    assert.equal(r.name, "علی ر***"); assert.equal(r.description, null); assert.equal(r.nationalCode, null); assert.equal(r.postalCode, null);
    assert.equal(r.birthDateJalali, null); assert.deepEqual(r.tags, []); assert.equal(r.creditScore, null); assert.equal(r.isUrgent, true);
    assert.equal(r.id, 77); assert.equal(r.salespersonName, "کارشناس الف"); assert.equal(r.activityCount, 4);
    assert.deepEqual(xo.redactForeignCustomer({ ...seller, salespersonId: 3 }, full), full, "owner");
    assert.deepEqual(xo.redactForeignCustomer({ id: 1, role: "admin", customerScope: "all", salespersonId: null }, full), full, "admin");
    assert.equal(xo.redactForeignCustomer(seller, null), null);
    const route = readFileSync(path.join(apiRoot, "src/routes/crm.ts"), "utf8");
    assert.equal((route.match(/redactForeignCustomer\(res\.locals\.authUser as AuthUser/g) ?? []).length, 3);
  });
  ok("GET /customers adds the hints only for eligible salespersons on the first page; routes registered", () => {
    const route = readFileSync(path.join(apiRoot, "src/routes/crm.ts"), "utf8");
    assert.match(route, /search && offset === 0 && customerId === undefined && crossOwnerEligible\(user\)\s*\?\s*findOtherOwnerMatches\(user, search\)/);
    assert.match(route, /\.\.\.\(crossOwner \? \{ otherOwnerMatches: crossOwner\.items, otherOwnerLimited: crossOwner\.limited \} : \{\}\)/);
    assert.match(route, /"\/cross-owner\/transfer-call\/:customerId"/);
    assert.match(route, /res\.json\(\{ ownerName: result\.ownerName, extension: result\.extension, notified: result\.notified \}\)/);
    assert.match(route, /"\/my-transfers"/);
  });
  ok("dashboard hint: no profile link, no full phone; only the transfer-call button", () => {
    const ui = readFileSync(path.join(apiRoot, "../crm-dashboard/src/components/customer/OtherOwnerResults.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/<(a|Link|input)\b|href=|CustomerIdBadge|navigate|\/customers\//.test(ui));
    assert.equal((ui.match(/<button\b/g) ?? []).length, 1);
    assert.match(ui, /otherOwnerLabel\(item\.ownerName\)/);
    assert.match(ui, /انتقال تماس به کارشناسش/);
    const lib = readFileSync(path.join(apiRoot, "../crm-dashboard/src/lib/other-owner.ts"), "utf8");
    assert.match(lib, /`کارشناس این مشتری: \$\{ownerName/);
  });
  crmDb.close?.();
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`cross-owner-search: ${n} checks passed`);
