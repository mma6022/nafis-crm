// crm-consult-filters fixture (not a `test:` script: it needs a DB copy).
//   CONSULT_FILTERS_SOURCE_DB=/path/to/copy.db node scripts/consult-filters-fixture.mjs
// The source is opened read-only and backed up into a temp dir; everything below runs on that temp copy
// and the temp dir is removed at the end. Synthetic rows use fake 0900… phones.
// Proves: every filter on synthetic consults with known answers, partitions on the real copy, sales scoping,
// admin-only export + plan-type filter (server-enforced), no national code / phone in the CSV, and that the
// report endpoints write nothing.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = process.env.CONSULT_FILTERS_SOURCE_DB;
if (!source) { console.error("Set CONSULT_FILTERS_SOURCE_DB to a CRM database copy."); process.exit(2); }
const temp = await mkdtemp(path.join(os.tmpdir(), "consult-filters-"));
const file = path.join(temp, "fixture.db");
{ const original = new DatabaseSync(path.resolve(source), { readOnly: true }); await backup(original, file); original.close(); }
const secret = randomBytes(32).toString("hex");
Object.assign(process.env, { CRM_DATABASE_PATH: file, CONTRACTS_STORAGE_DIR: path.join(temp, "contracts"), SESSION_SECRET: secret, NODE_ENV: "production",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "https://fixture.invalid/ai", AI_INTEGRATIONS_OPENAI_API_KEY: "fixture",
  SAPI_API_BASE_URL: "https://fixture.invalid", SAPI_API_TOKEN: "fixture", EMZAME_BASE_URL: "https://fixture.invalid/emzame", EMZAME_NATIONAL_CODE: "fixture", EMZAME_PASSWORD: "fixture" });
delete process.env.SAPI_RELAY_URL;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, o) => { if (!String(url).startsWith("http://127.0.0.1:")) throw new Error("network forbidden in fixture"); return nativeFetch(url, o); };

const bundle = path.join(temp, "http.mjs");
await build({ stdin: { contents: `
 import express from "express"; import cookieParser from "cookie-parser";
 import { requireAuth } from "./src/lib/auth";
 import report from "./src/routes/consultation-report";
 export * from "./src/lib/crm-db"; export * from "./src/lib/consultation-report";
 export const app = express(); app.use(express.json(), cookieParser()); app.use("/api", requireAuth, report);
 `, resolveDir: process.cwd(), sourcefile: "consult-filters-fixture.ts" }, bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(process.cwd(), "package.json")).href)});` } });

let n = 0; const ok = (m) => { n++; console.log("ok -", m); };
let server;
try {
  const f = await import(pathToFileURL(bundle).href); const db = f.crmDb;
  // ---- pure helpers ----
  assert.equal(f.parseConsultAmountToman("300000000"), 300000000);
  assert.equal(f.parseConsultAmountToman("500 میلیون تومن"), 500000000);
  assert.equal(f.parseConsultAmountToman("150 تا 200"), 150000000);
  assert.equal(f.parseConsultAmountToman("۲۰۰,۰۰۰,۰۰۰"), 200000000);
  assert.equal(f.parseConsultAmountToman("۱.۵ میلیارد"), 1500000000);
  assert.equal(f.parseConsultAmountToman("ندارد"), null);
  assert.equal(f.tehranDayOf("2026-03-01 20:29:00"), "2026-03-01");
  assert.equal(f.tehranDayOf("2026-03-01T20:31:00.000Z"), "2026-03-02");
  assert.equal(f.csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(f.gradeMatches("B", ["B2"]), true); assert.equal(f.gradeMatches("B1", ["B2"]), false); assert.equal(f.gradeMatches("B1", ["B"]), true);
  assert.throws(() => f.parseConsultFilters({ from: "2026-03-05", to: "2026-03-01" }));
  assert.throws(() => f.parseConsultFilters({ jobs: "pilot" }));
  ok("amount parser, Tehran day, CSV guard, grade rule, query validation");

  // ---- synthetic data on the copy ----
  const ts = "2026-03-01T08:00:00.000Z";
  const sp1 = f.execute("INSERT INTO salespersons(name,created_at) VALUES('کارشناس نمونه ۱',?)", [ts]);
  const sp2 = f.execute("INSERT INTO salespersons(name,created_at) VALUES('کارشناس نمونه ۲',?)", [ts]);
  const sessions = {};
  for (const [role, sp] of [["admin", null], ["registrar", null], ["salesperson", sp1], ["salesperson2", sp2]]) {
    const uid = f.execute("INSERT INTO users(username,password_hash,role,salesperson_id,created_at) VALUES(?,'unused',?,?,?)",
      [`cf-${role}-${randomBytes(4).toString("hex")}`, role === "salesperson2" ? "salesperson" : role, sp, ts]);
    const token = randomBytes(24).toString("base64url");
    f.execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      [createHmac("sha256", secret).update(token).digest("hex"), uid, new Date(Date.now() + 600000).toISOString(), ts]);
    sessions[role] = { uid, cookie: `crm_session=${token}` };
  }
  const planScore = f.execute("INSERT INTO loan_plans(name,principal_amount,installment_terms,active,loan_type,created_at) VALUES('طرح نمونه نقدی','100000000','[12]',1,'score',?)", [ts]);
  const planGoods = f.execute("INSERT INTO loan_plans(name,principal_amount,installment_terms,active,loan_type,created_at) VALUES('طرح نمونه کالا','100000000','[12]',1,'goods',?)", [ts]);
  const snap = (eligible, review) => JSON.stringify({ capturedAt: ts, requestedAmount: null, matches: [
    ...eligible.map((id) => ({ plan: { id, name: "x" }, status: "eligible" })), ...review.map((id) => ({ plan: { id, name: "x" }, status: "needs_review" }))] });
  const S = {};
  const add = (key, sp, o) => {
    const cust = f.execute("INSERT INTO customers(name,phone,salesperson_id,created_at,city,national_code) VALUES(?,?,?,?,?,?)",
      [`مشتری نمونه ${key}`, `0900${String(1000000 + Math.floor(Math.random() * 8999999))}`, sp, ts, o.customerCity ?? null, `999999990${Object.keys(S).length}`]);
    const id = f.execute(`INSERT INTO consultation_forms(customer_id,questionnaire_version,credit_rank,has_guarantor,guarantor_credit_rank,job_type,guarantor_job_type,
      customer_check_status,has_check,requested_amount,plan_matches_snapshot,created_at,updated_at) VALUES(?,2,?,?,?,?,?,?,?,?,?,?,?)`,
      [cust, o.rank ?? null, o.g ?? null, o.gRank ?? null, o.job ?? null, o.gJob ?? null, o.check ?? null, o.hasCheck ?? null, o.amount ?? null,
        snap(o.eligible ?? [], o.review ?? []), o.at ?? ts, o.at ?? ts]);
    if (o.profile) f.execute("INSERT INTO customer_consult_profile_versions(customer_id,source,data_json,created_at) VALUES(?,'edit',?,?)", [cust, JSON.stringify(o.profile), ts]);
    if (o.firstCall) f.execute(`INSERT INTO team_sales_qualifications(customer_id,actor_user_id,call_result,answers_json,matches_json,priority,outcome,reasons_json,note,created_at)
      VALUES(?,?,'answered',?,'[]',2,'x','[]','',?)`, [cust, sessions.admin.uid, JSON.stringify({ formVersion: 2, ...o.firstCall }), ts]);
    if (o.case) f.execute("INSERT INTO loan_applications(consultation_id,customer_id,plan_ids,requested_amount,created_at) VALUES(?,?,'[]','0',?)", [id, cust, ts]);
    if (o.deletedCase) f.execute("INSERT INTO loan_applications(consultation_id,customer_id,plan_ids,requested_amount,created_at,deleted_at) VALUES(?,?,'[]','0',?,?)", [id, cust, ts, ts]);
    S[key] = id;
  };
  add("a", sp1, { rank: "A1", g: 1, gRank: "B2", job: "business", gJob: "retired", check: "physical", amount: "300", eligible: [planScore], case: true, at: "2026-03-01 20:29:00", profile: { military: "has_card", city: "تهران" } });
  add("b", sp1, { rank: "B", g: 0, job: "no_doc", check: "none", amount: "500 میلیون تومن", review: [planGoods], at: "2026-03-01T20:31:00.000Z", firstCall: { military: "female", city: "كرج", bouncedCheque: "yes", checkStatus: "none" } });
  add("c", sp2, { rank: "C3", g: 1, gRank: "A1", job: "employee_with_insurance", gJob: "no_doc", hasCheck: 1, amount: "150000000", eligible: [planGoods], review: [planScore], deletedCase: true, firstCall: { military: "no_card", bouncedCheque: "no" }, at: "2026-03-05 10:00:00" });
  add("d", sp2, { rank: "E2", job: "unemployed", amount: null, customerCity: "اصفهان", profile: { military: "unknown" }, firstCall: { military: "has_card", checkStatus: "physical" }, at: "2026-03-10 10:00:00" });
  const mine = [S.a, S.b, S.c, S.d];

  server = f.app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (role, route) => {
    const r = await fetch(base + route, { headers: role ? { Cookie: sessions[role].cookie } : {} });
    const text = await r.text(); let body = text; try { body = JSON.parse(text); } catch { /* csv */ }
    return { status: r.status, body, type: r.headers.get("content-type") ?? "" };
  };
  const get = async (role, qs, status = 200) => { const r = await call(role, `/consultations/report?limit=100&${qs}`); assert.equal(r.status, status, `${role} ${qs}: ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; };
  const ids = async (qs, role = "admin") => { const b = await get(role, `salespersonIds=${sp1},${sp2}&${qs}`); return b.items.map((i) => i.id).sort((x, y) => x - y); };
  const exp = (...k) => k.map((x) => S[x]).sort((x, y) => x - y);
  const changesBefore = db.prepare("SELECT total_changes() AS n").get().n;

  assert.deepEqual(await ids(""), [...mine].sort((x, y) => x - y)); ok("salesperson multi-select (admin) returns exactly the fixture consults");
  assert.deepEqual((await get("admin", `salespersonIds=${sp2}`)).items.map((i) => i.id).sort((x, y) => x - y), exp("c", "d"));
  assert.deepEqual(await ids("from=2026-03-01&to=2026-03-01"), exp("a")); assert.deepEqual(await ids("from=2026-03-02&to=2026-03-05"), exp("b", "c"));
  assert.deepEqual(await ids("from=2026-03-06"), exp("d")); ok("date range by Tehran day (20:29Z = 23:59 Tehran stays on 03-01)");
  assert.deepEqual(await ids("planResult=eligible"), exp("a", "c")); assert.deepEqual(await ids("planResult=review"), exp("b")); assert.deepEqual(await ids("planResult=none"), exp("d"));
  assert.deepEqual(await ids(`planId=${planGoods}`), exp("c")); assert.deepEqual(await ids(`planId=${planScore}`), exp("a")); ok("plan result + specific plan (suitable only)");
  assert.deepEqual(await ids("planType=score"), exp("a")); assert.deepEqual(await ids("planType=goods"), exp("c")); ok("plan type (admin)");
  assert.deepEqual(await ids("grades=A1,B2"), exp("a", "b")); assert.deepEqual(await ids("grades=C"), exp("c")); assert.deepEqual(await ids("grades=E1"), []); ok("applicant grade multi-select incl. legacy letter rule");
  assert.deepEqual(await ids("guarantor=yes"), exp("a", "c")); assert.deepEqual(await ids("guarantor=no"), exp("b")); assert.deepEqual(await ids("guarantorGrades=A1"), exp("c"));
  assert.deepEqual(await ids("guarantor=yes&guarantorGrades=B2"), exp("a")); ok("guarantor has/hasn't + guarantor grade");
  assert.deepEqual(await ids("jobs=business,unemployed"), exp("a", "d")); assert.deepEqual(await ids("guarantorJobs=no_doc"), exp("c")); ok("applicant / guarantor job");
  assert.deepEqual(await ids("cheque=has"), exp("a", "c", "d")); assert.deepEqual(await ids("cheque=no"), exp("b")); assert.deepEqual(await ids("cheque=bounced"), exp("b")); ok("cheque has / no (incl. first-call fallback) / bounced");
  assert.deepEqual(await ids("military=has_card"), exp("a")); assert.deepEqual(await ids("military=female"), exp("b")); assert.deepEqual(await ids("military=no_card"), exp("c"));
  assert.deepEqual(await ids("military=unrecorded"), exp("d")); ok("military: latest profile wins over first call; «نمی‌دونه» = ثبت نشده");
  assert.deepEqual(await ids("city=" + encodeURIComponent("کرج")), exp("b")); assert.deepEqual(await ids("city=" + encodeURIComponent("اصفهان")), exp("d")); assert.deepEqual(await ids("city=" + encodeURIComponent("تهران")), exp("a")); ok("city (profile → first call → customers.city, ي/ك normalized)");
  assert.deepEqual(await ids("amountMin=200000000"), exp("a", "b")); assert.deepEqual(await ids("amountMax=200000000"), exp("c")); assert.deepEqual(await ids("amountMin=100000000&amountMax=300000000"), exp("a", "c")); ok("requested amount range (missing amount excluded)");
  assert.deepEqual(await ids("caseStatus=opened"), exp("a")); assert.deepEqual(await ids("caseStatus=not"), exp("b", "c", "d")); ok("next status (deleted case does not count)");
  assert.deepEqual(await ids("guarantor=yes&planResult=eligible&cheque=has&from=2026-03-02"), exp("c")); ok("filters combine (AND)");
  const sumB = await get("admin", `salespersonIds=${sp1},${sp2}`);
  assert.deepEqual(sumB.summary, { total: 4, withPlan: 2, reviewOnly: 1, noPlan: 1, cases: 1 }); ok("summary counts");
  const searchB = await get("admin", `search=${encodeURIComponent("#" + db.prepare("SELECT customer_id FROM consultation_forms WHERE id=?").get(S.c).customer_id)}`);
  assert.deepEqual(searchB.items.map((i) => i.id), [S.c]); ok("search by «#id» like the list");

  // ---- scoping ----
  const own = await get("salesperson", "");
  assert.ok(own.items.every((i) => i.customerSalespersonName === "کارشناس نمونه ۱"));
  assert.deepEqual(own.items.map((i) => i.id).sort((x, y) => x - y), exp("a", "b")); assert.equal(own.salespersonScoped, true);
  assert.deepEqual((await get("salesperson", `salespersonIds=${sp2}`)).items, []);
  assert.deepEqual((await get("salesperson2", "planResult=eligible")).items.map((i) => i.id), [S.c]);
  ok("salesperson sees only own customers' consults, even with another salesperson's id in the query");
  // ---- admin-only ----
  await get("salesperson", "planType=score", 403); await get("registrar", "planType=goods", 403);
  assert.equal(own.canExport, false); assert.equal(own.canFilterPlanType, false);
  assert.ok(own.plans.every((p) => !("loanType" in p))); assert.ok(own.items.every((i) => i.facts.eligiblePlans.every((p) => p.loanType === null)));
  for (const role of ["salesperson", "registrar"]) assert.equal((await call(role, "/consultations/report/export")).status, 403);
  assert.equal((await call(null, "/consultations/report")).status, 401);
  const csv = await call("admin", `/consultations/report/export?salespersonIds=${sp1},${sp2}&caseStatus=not`);
  assert.equal(csv.status, 200); assert.match(csv.type, /text\/csv/);
  const lines = csv.body.replace(/^\ufeff/, "").trim().split("\r\n");
  assert.equal(lines.length, 4); assert.ok(lines[0].startsWith("شناسه مشاوره,شناسه مشتری"));
  assert.ok(!/99999999\d|09\d{9}|کد ملی|موبایل/.test(csv.body), "CSV must not carry national code or phone");
  ok("export + plan type filter are admin-only on the server; CSV uses #customer id, no national code / phone");

  // ---- real data on the copy (fixture rows included) ----
  const all = await get("admin", "limit=1");
  const realTotal = db.prepare("SELECT COUNT(*) AS n FROM consultation_forms").get().n;
  assert.equal(all.total, realTotal);
  const s = all.summary; assert.equal(s.withPlan + s.reviewOnly + s.noPlan, s.total);
  assert.equal(s.cases, db.prepare("SELECT COUNT(*) AS n FROM consultation_forms cf WHERE EXISTS (SELECT 1 FROM loan_applications la WHERE la.consultation_id=cf.id AND la.deleted_at IS NULL)").get().n);
  const tot = async (qs) => (await get("admin", `limit=1&${qs}`)).total;
  assert.equal(await tot("caseStatus=opened") + await tot("caseStatus=not"), realTotal);
  assert.equal(await tot("planResult=eligible") + await tot("planResult=review") + await tot("planResult=none"), realTotal);
  assert.equal(await tot("military=has_card") + await tot("military=no_card") + await tot("military=female") + await tot("military=unrecorded"), realTotal);
  assert.equal(await tot("guarantor=yes"), db.prepare("SELECT COUNT(*) AS n FROM consultation_forms WHERE has_guarantor=1").get().n);
  for (const sp of db.prepare("SELECT id FROM salespersons").all().map((r) => r.id)) {
    assert.equal(await tot(`salespersonIds=${sp}`), db.prepare("SELECT COUNT(*) AS n FROM consultation_forms cf JOIN customers c ON c.id=cf.customer_id WHERE c.salesperson_id=?").get(sp).n);
  }
  const realCsv = await call("admin", "/consultations/report/export");
  assert.equal(realCsv.body.replace(/^\ufeff/, "").trim().split("\r\n").length, realTotal + 1);
  console.log(`info - real copy: ${realTotal} consults; summary ${JSON.stringify(s)}`);
  for (const k of ["military=unrecorded", "cheque=bounced", "city=" + encodeURIComponent("تهران"), "amountMin=1"]) console.log(`info - ${decodeURIComponent(k)}: ${await tot(k)}`);
  ok("real copy: totals, partitions and per-salesperson counts match SQL; CSV has one line per consult");
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changesBefore); ok("report + export wrote nothing");
  console.log(`${n} checks passed`);
} finally {
  server?.close();
  await rm(temp, { recursive: true, force: true });
}
