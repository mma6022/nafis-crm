// Cross-owner faded hints (crm-id-search-everywhere): exact-only, minimal fields, rate limited,
// salespersons only (not admin / registrar / team-sales qualifier). Synthetic temp DB only.
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
    CREATE TABLE notification_settings(key TEXT PRIMARY KEY, value TEXT);\`);
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
  ok("no PII: only id, name, ownerName", () => {
    const r = find("1234");
    assert.deepEqual(r, { items: [{ id: 1234, name: "مشتری نمونه", ownerName: "کارشناس الف" }], limited: false });
    const json = JSON.stringify(r);
    for (const leak of ["0912", "0012345678", "phone", "national", "salespersonId", "status", "priority"]) assert.ok(!json.includes(leak), leak);
  });
  ok("admin, registrar, all-scope and the team-sales qualifier get nothing (behaviour unchanged)", () => {
    for (const u of [{ id: 1, role: "admin", customerScope: "all", salespersonId: null },
      { id: 7, role: "registrar", customerScope: "all", salespersonId: null },
      { id: 9, role: "salesperson", customerScope: "all", salespersonId: 3 },
      { id: 8, role: "salesperson", customerScope: "assigned", salespersonId: 6 }]) {
      assert.equal(xo.crossOwnerEligible(u), false, JSON.stringify(u));
      assert.deepEqual(find("1234", u), { items: [], limited: false });
    }
    assert.equal(xo.crossOwnerEligible(seller), true);
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
  ok("GET /customers adds the hints only for eligible salespersons on the first page", () => {
    const route = readFileSync(path.join(apiRoot, "src/routes/crm.ts"), "utf8");
    assert.match(route, /search && offset === 0 && customerId === undefined && crossOwnerEligible\(user\)\s*\?\s*findOtherOwnerMatches\(user, search\)/);
    assert.match(route, /\.\.\.\(crossOwner \? \{ otherOwnerMatches: crossOwner\.items, otherOwnerLimited: crossOwner\.limited \} : \{\}\)/);
  });
  ok("dashboard renders hints inert (no link, button or phone) after own results", () => {
    const ui = readFileSync(path.join(apiRoot, "../crm-dashboard/src/components/customer/OtherOwnerResults.tsx"), "utf8");
    assert.ok(!/<(a|button|Link|input)\b|onClick|href=|CustomerIdBadge|phone/i.test(ui.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
    assert.match(ui, /otherOwnerLabel\(item\.ownerName\)/);
    const lib = readFileSync(path.join(apiRoot, "../crm-dashboard/src/lib/other-owner.ts"), "utf8");
    assert.match(lib, /`مشتریِ \$\{ownerName/);
  });
  crmDb.close?.();
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`cross-owner-search: ${n} checks passed`);
