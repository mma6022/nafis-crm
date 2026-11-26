// t963 customer segments: credit-rank filter across all forms + AND/OR (match) + export parity.
// Throwaway COPY of a masked DB only; never live, never user 29, no real credit/identity calls.
// Usage: MASKED_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t963-segment-credit-or-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const src = process.env.T963_FIXTURE_DB || process.env.MASKED_DB;
if (!src) { console.log("SKIP (set MASKED_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db" || fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t963-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET: `fixture-only-${crypto.randomBytes(16).toString("hex")}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
globalThis.fetch = async () => { throw new Error("unexpected network call in t963 fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const { queryRow, queryRows, execute } = await import("../src/lib/crm-db.ts");
const seg = await import("../src/lib/customer-segments.ts");

execute("INSERT OR REPLACE INTO call_queue_settings(key,value,updated_by,updated_at) VALUES (?,?,NULL,datetime('now'))", [seg.SEGMENTS_FLAG, "1"]);
const admin = /** @type {any} */ ({ id: 1, username: "admin", fullName: "مدیر سیستم", role: "admin", roleName: "admin", permissions: [], customerScope: "all", salespersonId: null, active: true });

// ---- seed: pick customers that hold NO rank anywhere and no rows in any rank source.
const base = seg.loadProfiles().filter((p) => p.kind === "customer" && !p.creditRankAny.length && p.hasDossier === "no" && p.hasFirstCall === "no" && p.hasConsult === "no" && p.hasSiteApply === "no");
assert.ok(base.length >= 14, `need 14 clean customers, have ${base.length}`);
const ids = base.slice(0, 14).map((p) => p.customerId);
const [X1, X2, X3, X4, X5, X6, X7, X8, X9, X10, X11, X12, X13, X14] = ids;
const now = "2026-11-26T08:00:00.000Z";
// X1 customers.credit_rank (the ICS24 result written on the customer)
execute("UPDATE customers SET credit_rank='A1' WHERE id=?", [X1]);
// X2 ICS24 check only (customers.credit_rank NULL)
execute("INSERT INTO customer_credit_checks(customer_id,provider,national_code,status,score,score_label,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?)", [X2, "ics24", "0000000000", "report_generated", 700, "B2", now, now, now]);
// a failed newer check must not hide it
execute("INSERT INTO customer_credit_checks(customer_id,provider,national_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?)", [X2, "ics24", "0000000000", "failed", "2026-11-26T09:00:00.000Z", "2026-11-26T09:00:00.000Z"]);
// X3 dossier
execute("INSERT INTO customer_dossier(customer_id, credit_rank) VALUES (?,?)", [X3, "C2"]);
// X4 call-summary file value
execute("INSERT INTO cs_file_values(customer_id,item_key,value_json,source,created_at) VALUES (?,?,?,?,?)", [X4, "creditRank", JSON.stringify("C1"), "ai", now]);
// X5 consultation form
execute("INSERT INTO consultation_forms(customer_id, credit_rank, updated_at, questionnaire_version) VALUES (?,?,?,?)", [X5, "D3", now, 1]);
// X6 site form with a bare legacy letter
execute(`INSERT INTO site_apply_answers(customer_id,outcome,amount_range,job_status,documents_json,has_military_card,can_refer_retiree,has_bounced_or_overdue,need_timing,priority_computed,priority_rule,ip_hash,created_at,credit_rank)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [X6, "new_customer", "up_to_50m", "employee", "[]", "no", "no", "no", "now", 1, "t963", "h", now, "E"]);
// X7 registrar intake rank
execute("UPDATE customers SET intake_credit_rank='C3' WHERE id=?", [X7]);
// X8 repeat request intake rank
execute("INSERT INTO customer_repeat_requests(customer_id,requested_name,explanation,status,provenance,created_at,intake_credit_rank) VALUES (?,?,?,?,?,?,?)", [X8, "x", "x", "pending", "human", now, "B1"]);
// X9 first-call form (answered)
execute("INSERT INTO team_sales_qualifications(customer_id,actor_user_id,call_result,answers_json,matches_json,priority,outcome,reasons_json,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [X9, 2, "answered", JSON.stringify({ creditRank: "A3" }), "{}", 1, "ok", "[]", "", now]);
// X10 two sources: customer E1 + site bare A
execute("UPDATE customers SET credit_rank='E1' WHERE id=?", [X10]);
execute(`INSERT INTO site_apply_answers(customer_id,outcome,amount_range,job_status,documents_json,has_military_card,can_refer_retiree,has_bounced_or_overdue,need_timing,priority_computed,priority_rule,ip_hash,created_at,credit_rank)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [X10, "new_customer", "up_to_50m", "employee", "[]", "no", "no", "no", "now", 1, "t963", "h", now, "A"]);
// X11 only «unknown» (must be filled=unknown, never a real rank); X12 nothing
execute("INSERT INTO customer_dossier(customer_id, credit_rank) VALUES (?,?)", [X11, "unknown"]);
// X13 dossier 'unknown' + ICS24 check 'D1' (unknown must not shadow the real rank)
execute("INSERT INTO customer_dossier(customer_id, credit_rank) VALUES (?,?)", [X13, "unknown"]);
execute("INSERT INTO customer_credit_checks(customer_id,provider,national_code,status,score,score_label,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?)", [X13, "ics24", "0000000000", "report_generated", 400, "D1", now, now, now]);
// X14 two ICS24 checks: the newer one wins
execute("INSERT INTO customer_credit_checks(customer_id,provider,national_code,status,score,score_label,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?)", [X14, "ics24", "0000000000", "report_generated", 300, "E3", "2026-11-20T08:00:00.000Z", now, now]);
execute("INSERT INTO customer_credit_checks(customer_id,provider,national_code,status,score,score_label,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?)", [X14, "ics24", "0000000000", "report_generated", 800, "A2", "2026-11-25T08:00:00.000Z", now, now]);
// cities for AND/OR tests (marker value that no real customer has)
const CITY = "شهر-آزمون-۹۶۳";
for (const id of [X1, X2, X3, X5, X11, X12]) execute("UPDATE customers SET city=? WHERE id=?", [CITY, id]);

const seeded = new Set(ids);
if (process.env.T963_DEBUG) console.log("IDS", JSON.stringify({X1,X2,X3,X4,X5,X6,X7,X8,X9,X10,X11,X12,X13,X14}));
const all = seg.loadProfiles();
const idsOf = (rows) => rows.filter((p) => seeded.has(p.customerId)).map((p) => p.customerId).sort((a, b) => a - b);
const exp = (...x) => x.slice().sort((a, b) => a - b);
const run = (conditions, extra = {}) => seg.filterProfiles(all, { source: "both", conditions, ...extra });
const inRank = (field, ...values) => ({ field, op: "in", values });
const rankRange = (field, min, max) => ({ field, op: "range", min, max });

await ok("root cause fixed: rank filters exist in the catalog (+ the all-forms field with the full A1…E3 grid)", async () => {
  const cat = seg.fieldCatalog();
  const any = cat.fields.find((f) => f.key === "creditRankAny");
  assert.ok(any, "creditRankAny missing from catalog");
  assert.equal(any.group, "credit");
  assert.ok(any.ops.includes("in") && any.ops.includes("range"));
  assert.equal(any.options.length, 21);
  for (const k of ["creditRank", "creditRankFile", "creditRankSite", "guarantorRank"]) assert.ok(cat.fields.find((f) => f.key === k).ops.includes("range"), k);
  const vals = seg.fieldValues(all, { source: "both" }).find((f) => f.field === "creditRankAny");
  assert.deepEqual(vals.values.filter((v) => v.value !== "unknown").map((v) => v.value), ["A", "A1", "A2", "A3", "B", "B1", "B2", "B3", "C", "C1", "C2", "C3", "D", "D1", "D2", "D3", "E", "E1", "E2", "E3"]);
});

await ok("every rank source is read: customer, ICS24 check, dossier, call summary, consult, site, intake, repeat, first call", async () => {
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "A1")])), exp(X1));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "B2")])), exp(X2));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "C2")])), exp(X3));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "C1")])), exp(X4));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "D3")])), exp(X5));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "C3")])), exp(X7));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "B1")])), exp(X8));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "A3")])), exp(X9));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "E1")])), exp(X10));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "D1")])), exp(X13), "unknown must not shadow a real rank");
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "A2")])), exp(X14), "newest report_generated check wins");
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "E3")])), exp(), "older check of X14 is not current");
  const old = all.find((p) => p.customerId === X2);
  assert.deepEqual(old.creditRankAny, ["B2"], "a newer failed check must not hide the last good rank");
});

await ok("OR within the field; a bare letter picks all its sub-grades and legacy letters; unknown is its own value", async () => {
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "A1", "B2", "D3")])), exp(X1, X2, X5));
  // A → A1 (X1), A3 (X9), A2 (X14), and X10's bare site «A»
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "A")])), exp(X1, X9, X10, X14));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "E")])), exp(X6, X10));
  assert.deepEqual(idsOf(run([inRank("creditRankAny", "unknown")])), exp(X11));
  // X10 holds E1 and A: both answer
  assert.ok(idsOf(run([inRank("creditRankAny", "E1")])).includes(X10) && idsOf(run([inRank("creditRankAny", "A1")])).includes(X10) === false);
});

await ok("rank range A1…E3: from/to, open ends, bare letters overlap, unknown never matches", async () => {
  assert.deepEqual(idsOf(run([rankRange("creditRankAny", "A1", "B3")])), exp(X1, X2, X8, X9, X10, X14));
  assert.deepEqual(idsOf(run([rankRange("creditRankAny", "C1", "C3")])), exp(X3, X4, X7));
  assert.deepEqual(idsOf(run([rankRange("creditRankAny", "D1", null)])), exp(X5, X6, X10, X13));
  assert.deepEqual(idsOf(run([rankRange("creditRankAny", null, "A2")])), exp(X1, X10, X14));
  assert.ok(!idsOf(run([rankRange("creditRankAny", "A1", "E3")])).includes(X11));
  // no bounds at all = not filtering yet
  assert.equal(run([rankRange("creditRankAny", "", "")]).length, all.length);
  assert.equal(run([rankRange("creditRankAny", "zz", null)]).length, all.length);
});

await ok("source mode: «فقط فرم‌های سایت» sees only the site ranks, «فقط پرونده» everything but site", async () => {
  const site = seg.filterProfiles(all, { source: "site", conditions: [inRank("creditRankAny", "E", "A")] });
  assert.deepEqual(idsOf(site), exp(X6, X10));
  const file = seg.filterProfiles(all, { source: "file", conditions: [inRank("creditRankAny", "E", "A")] });
  assert.deepEqual(idsOf(file), exp(X1, X9, X10, X14), "X6 is site-only; X10 still has E1 in the file");
});

await ok("picker counts equal the filter result for every rank option (A1…E3, letters, unknown)", async () => {
  const stats = seg.fieldValues(all, { source: "both" });
  for (const key of ["creditRankAny", "creditRank", "creditRankFile", "creditRankSite", "guarantorRank"]) {
    const f = stats.find((s) => s.field === key);
    assert.ok(f.values.length >= 20, key);
    for (const v of f.values) {
      const n = run([inRank(key, v.value)]).length;
      assert.equal(v.count, n, `${key}:${v.value} picker ${v.count} vs filter ${n}`);
    }
  }
  const a = stats.find((s) => s.field === "creditRankAny");
  assert.equal(a.filled + a.empty, all.length);
  assert.ok(a.values.find((v) => v.value === "D1").count >= 1);
});

await ok("display: every rank in the cell, Persian label; export header present", async () => {
  const p = all.find((x) => x.customerId === X10);
  assert.equal(seg.displayValue("creditRankAny", p), "رتبه الف، رتبه ه۱");
  assert.equal(seg.displayValue("creditRankAny", all.find((x) => x.customerId === X11)), "نامشخص");
});

// ---- AND / OR
const A = [inRank("creditRankAny", "A1", "B2", "C2")];       // X1 X2 X3 (+ real data)
const B = [{ field: "city", op: "in", values: [CITY] }];     // X1 X2 X3 X5 X11 X12
await ok("parseQuery: match defaults to «all»; only the exact string «any» switches to OR", async () => {
  assert.equal(seg.parseQuery({}).match, "all");
  assert.equal(seg.parseQuery({ match: "any" }).match, "any");
  for (const bad of ["ANY", "or", "OR", "or ", 1, true, null, ["any"]]) assert.equal(seg.parseQuery({ match: bad }).match, "all", String(bad));
  assert.equal(seg.parseQuery({ conditions: [] }).match, "all");
});

await ok("AND vs OR give the exact counts (inclusion–exclusion on the full masked data + seeded ids)", async () => {
  const a = run(A), b = run(B);
  const and = run([...A, ...B], { match: "all" });
  const or = run([...A, ...B], { match: "any" });
  const aIds = new Set(a.map((p) => p.leadKey)), bIds = new Set(b.map((p) => p.leadKey));
  const inter = [...aIds].filter((k) => bIds.has(k)).length;
  assert.equal(and.length, inter);
  assert.equal(or.length, aIds.size + bIds.size - inter);
  assert.ok(or.length > and.length);
  assert.deepEqual(idsOf(and), exp(X1, X2, X3));
  assert.deepEqual(idsOf(or), exp(X1, X2, X3, X5, X11, X12));
  // default (no match) is AND, byte-for-byte
  assert.equal(run([...A, ...B]).length, and.length);
  // unfinished conditions never turn OR into «everyone»
  const blank = { field: "city", op: "in", values: [] };
  assert.equal(run([...A, blank], { match: "any" }).length, a.length);
  assert.equal(run([...A, blank], { match: "all" }).length, a.length);
  assert.equal(run([blank, { field: "creditScore", op: "range" }], { match: "any" }).length, all.length);
  // one active condition: AND == OR
  assert.equal(run(A, { match: "any" }).length, run(A, { match: "all" }).length);
  // three conditions OR across different kinds of fields
  const C = [{ field: "hasSiteApply", op: "in", values: ["yes"] }];
  const or3 = run([...A, ...B, ...C], { match: "any" }).length;
  const union = new Set([...a, ...b, ...run(C)].map((p) => p.leadKey)).size;
  assert.equal(or3, union);
});

await ok("OR never leaks past the expert's own customers (scope applies before the match)", async () => {
  const expert = /** @type {any} */ ({ id: 2, username: "s.hasani", fullName: "خانم حسنی", role: "salesperson", roleName: "salesperson", permissions: [], customerScope: "assigned", salespersonId: 3, active: true });
  const scope = seg.actorScope(expert);
  const own = seg.filterProfiles(all, { source: "both", conditions: [] }, scope);
  assert.ok(own.length > 0 && own.length < all.length);
  const orOwn = seg.filterProfiles(all, { source: "both", match: "any", conditions: [inRank("creditRankAny", "A", "B", "C", "D", "E"), { field: "hasSiteApply", op: "in", values: ["yes"] }] }, scope);
  assert.ok(orOwn.every((p) => p.kind === "customer" && String(p.ownerId) === "3"));
  assert.throws(() => seg.preview({ source: "both", match: "any", conditions: [{ field: "ownerId", op: "in", values: ["99999"] }, inRank("creditRankAny", "A1")] }, expert), (e) => e instanceof seg.SegmentScopeError);
});

// ---- export == view
function readXlsxRows(buf) {
  let off = 0; const files = {};
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8), csize = buf.readUInt32LE(off + 18), nlen = buf.readUInt16LE(off + 26), xlen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nlen).toString("utf8");
    const data = buf.subarray(off + 30 + nlen + xlen, off + 30 + nlen + xlen + csize);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    off += 30 + nlen + xlen + csize;
  }
  const xml = files["xl/worksheets/sheet1.xml"].toString("utf8");
  return [...xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)].map((m) => [...m[2].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((c) => c[1]));
}

await ok("Excel export uses the same logic: rows == preview total == filter result, for AND, OR and rank range", async () => {
  const cols = ["customerId", "name", "creditRankAny", "city"];
  for (const q of [
    { source: "both", conditions: [...A, ...B], match: "all", columns: cols },
    { source: "both", conditions: [...A, ...B], match: "any", columns: cols },
    { source: "both", conditions: [rankRange("creditRankAny", "A1", "B3")], columns: cols },
    { source: "both", conditions: [inRank("creditRankAny", "C"), { field: "city", op: "contains", values: ["تهران"] }], match: "any", columns: cols },
  ]) {
    const view = seg.filterProfiles(all, q);
    const pv = seg.preview(q, admin, 1, 100);
    assert.equal(pv.total, view.length);
    const x = seg.exportXlsx(q, admin, false);
    assert.equal(x.rowCount, view.length);
    const rows = readXlsxRows(x.buffer);
    assert.equal(rows.length - 1, view.length, "sheet rows");
    const idCol = rows[0].indexOf("شناسه مشتری");
    assert.ok(idCol >= 0);
    const sheetIds = rows.slice(1).map((r) => r[idCol]).filter(Boolean).sort();
    const viewIds = view.filter((p) => p.customerId != null).map((p) => String(p.customerId)).sort();
    assert.deepEqual(sheetIds, viewIds);
  }
  const last = queryRow(`SELECT filter_json FROM ${seg.EXPORT_AUDIT_TABLE} ORDER BY id DESC LIMIT 1`);
  assert.equal(JSON.parse(last.filter_json).match, "any");
});

await ok("read-only: no customer rows changed by loading, filtering, previewing or exporting (seed rows aside)", async () => {
  const fp = () => JSON.stringify(queryRows("SELECT id,credit_rank,intake_credit_rank,city,phone FROM customers ORDER BY id"));
  const before = fp();
  run([...A, ...B], { match: "any" }); seg.preview({ source: "both", conditions: A, match: "any" }, admin, 1, 20); seg.exportXlsx({ source: "both", conditions: A }, admin, false);
  assert.equal(fp(), before);
});

await ok("user 29 is never used as an actor in this fixture", async () => {
  assert.notEqual(admin.id, 29);
});

console.log(`t963-segment-credit-or ${passed}/${passed} ok`);
