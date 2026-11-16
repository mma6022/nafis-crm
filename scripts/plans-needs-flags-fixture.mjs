// crm-plans-consult phase 1 fixture (not a `test:` script: it needs a DB copy).
//   PLANS_FLAGS_SOURCE_DB=/path/to/copy.db node scripts/plans-needs-flags-fixture.mjs [baseRef=e8510b3]
// The source is opened read-only and backed up twice into a temp dir (pre / post); the migration is applied on post.
// Proves that plan matching for every existing customer is IDENTICAL before (base code + pre copy) and after
// (this code + migrated copy): consultation matches (all consults), first-call evaluations (every team-sales
// qualification), public-plan guarantee options, and the plan rows themselves. Then synthetic combined
// requirements on the post copy (cheque + promissory + salary, any-type cheque) and the encode/decode helpers.
// Each run happens in a child process (each code version opens its own DB at import). Temp dir removed at the end.
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { build } from "esbuild";
import { spawnSync, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyMigration, MARKER } from "./plans-needs-flags-migrate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");
const repoRoot = path.resolve(apiRoot, "../..");

if (process.env.PNF_CHILD) { await child(); } else { await parent(); }

async function parent() {
  const source = process.env.PLANS_FLAGS_SOURCE_DB;
  if (!source) { console.error("Set PLANS_FLAGS_SOURCE_DB to a CRM database copy."); process.exit(2); }
  const baseRef = process.argv[2] ?? "e8510b3";
  const temp = await mkdtemp(path.join(os.tmpdir(), "plans-flags-"));
  let n = 0; const ok = (m) => { n++; console.log("ok -", m); };
  try {
    const pre = path.join(temp, "pre.db"), post = path.join(temp, "post.db");
    for (const f of [pre, post]) { const o = new DatabaseSync(path.resolve(source), { readOnly: true }); await backup(o, f); o.close(); }
    const db = new DatabaseSync(post);
    const res = applyMigration(db);
    assert.equal(res.applied, true);
    assert.equal(db.prepare("SELECT count(*) n FROM schema_migrations WHERE version=?").get(MARKER).n, 1);
    assert.equal(applyMigration(db).applied, false);
    db.close();
    ok(`migration applied on the copy (changed ${res.changed} flags), idempotent`);

    // Base tree (code as deployed) from git, bundled against this worktree's node_modules.
    const baseDir = path.join(temp, "base"); await mkdir(baseDir);
    const tar = execFileSync("git", ["-C", repoRoot, "archive", baseRef, "artifacts/api-server/src"], { maxBuffer: 1024 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", baseDir], { input: tar });
    const bundles = {};
    for (const [name, root] of [["base", path.join(baseDir, "artifacts/api-server")], ["new", apiRoot]]) {
      const out = path.join(temp, `${name}.mjs`);
      await build({ stdin: { contents: `
        export * from "./src/lib/crm-db"; export * from "./src/lib/team-sales-rules"; export * from "./src/lib/public-plan-guarantees";
        export { getConsultation, activeMatchPlans, computeConsultationPlanMatches } from "./src/routes/crm";
        export * from "./src/lib/consultation-report";
        ${name === "new" ? 'export * from "./src/lib/plan-requirements";' : ""}`, resolveDir: root, sourcefile: `pnf-${name}.ts` },
        bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent",
        nodePaths: [path.join(apiRoot, "node_modules"), path.join(repoRoot, "node_modules")],
        banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` } });
      bundles[name] = out;
    }
    const run = (bundle, dbFile, mode) => {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 120000,
        env: { PATH: process.env.PATH, PNF_CHILD: "1", PNF_BUNDLE: bundle, PNF_MODE: mode, CRM_DATABASE_PATH: dbFile,
          CONTRACTS_STORAGE_DIR: path.join(temp, "contracts"), SESSION_SECRET: "fixture-" + Math.random(), NODE_ENV: "production",
          AI_INTEGRATIONS_OPENAI_BASE_URL: "https://fixture.invalid/ai", AI_INTEGRATIONS_OPENAI_API_KEY: "fixture",
          SAPI_API_BASE_URL: "https://fixture.invalid", SAPI_API_TOKEN: "fixture" } });
      if (r.status !== 0) throw new Error(`child ${mode} failed: ${r.stderr.slice(-3000)}`);
      return JSON.parse(r.stdout.trim().split("\n").pop());
    };
    const before = run(bundles.base, pre, "fingerprint");
    const after = run(bundles.new, post, "fingerprint");
    for (const k of ["planRows", "conditionRows"]) assert.deepEqual(after[k], before[k], k);
    ok(`plan rows identical: ${before.planRows.length} plans, ${before.conditionRows.length} routes (needs_* flags, collateral_type)`);
    assert.equal(after.consults.length, before.consults.length);
    for (let i = 0; i < before.consults.length; i++) assert.deepEqual(after.consults[i], before.consults[i], `consult ${before.consults[i].id}`);
    const nm = before.consults.reduce((s, c) => s + c.matches.length, 0);
    ok(`consultation plan matching identical for all ${before.consults.length} consults (${nm} plan results, status + reasons)`);
    assert.equal(after.firstCalls.length, before.firstCalls.length);
    for (let i = 0; i < before.firstCalls.length; i++) assert.deepEqual(after.firstCalls[i], before.firstCalls[i], `qualification ${before.firstCalls[i].id}`);
    ok(`first-call plan evaluation + matchPlans identical for all ${before.firstCalls.length} team-sales qualifications`);
    assert.deepEqual(after.guarantees, before.guarantees);
    ok(`public guarantee options identical for ${before.guarantees.length} plans`);
    assert.deepEqual(after.report, before.report);
    ok(`consultation report facts (amount, military, salesperson) identical for ${before.report.length} consults`);

    const syn = run(bundles.new, post, "synthetic");
    for (const line of syn.lines) ok(line);
    console.log(`# ${n} checks passed`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function child() {
  globalThis.fetch = async () => { throw new Error("network forbidden in fixture"); };
  const f = await import(pathToFileURL(process.env.PNF_BUNDLE).href);
  const mode = process.env.PNF_MODE;
  const strip = (m) => JSON.parse(JSON.stringify(m));
  const FLAGS = ["collateral_type", "guarantor_collateral_type", "needs_guarantor", "needs_customer_check", "needs_customer_promissory",
    "needs_customer_salary_deduct", "needs_guarantor_check", "needs_guarantor_promissory", "needs_guarantor_salary_deduct", "needs_military_service"];
  const plansRows = () => f.queryRows("SELECT * FROM loan_plans WHERE active=1 ORDER BY id");
  const condRows = () => f.queryRows("SELECT * FROM loan_plan_conditions ORDER BY plan_id, sort_order, id");
  if (mode === "fingerprint") {
    const pick = (r) => Object.fromEntries(["id", "plan_id", ...FLAGS].filter((k) => k in r).map((k) => [k, r[k] ?? null]));
    const planRows = f.queryRows("SELECT * FROM loan_plans ORDER BY id").map(pick);
    const conditionRows = f.queryRows("SELECT * FROM loan_plan_conditions ORDER BY id").map(pick);
    const plans = f.activeMatchPlans();
    const consults = f.queryRows("SELECT id FROM consultation_forms ORDER BY id").map(({ id }) => {
      const c = f.getConsultation(Number(id));
      return { id: Number(id), matches: strip(f.computeConsultationPlanMatches(c, plans)) };
    });
    const tsPlans = f.plansFromRows(plansRows(), condRows());
    const firstCalls = f.queryRows("SELECT id, answers_json FROM team_sales_qualifications ORDER BY id").flatMap((r) => {
      let a; try { a = JSON.parse(r.answers_json); } catch { return []; }
      if (!a || typeof a !== "object") return [];
      return [{ id: Number(r.id), evals: strip(f.evaluatePlans(a, tsPlans)), matches: strip(f.matchPlans(a, tsPlans)) }];
    });
    const conds = condRows();
    const bool = (v) => Boolean(Number(v ?? 0));
    const guarantees = plansRows().map((p) => ({ id: Number(p.id), g: strip(f.publicPlanGuarantees({
      customerCheck: p.customer_check, guarantorCheck: p.guarantor_check, needsCustomerPromissory: bool(p.needs_customer_promissory),
      needsGuarantor: bool(p.needs_guarantor), needsGuarantorPromissory: bool(p.needs_guarantor_promissory),
      conditions: conds.filter((c) => Number(c.plan_id) === Number(p.id)).map((c) => ({ collateralType: c.collateral_type, guarantorCollateralType: c.guarantor_collateral_type,
        needsGuarantor: bool(c.needs_guarantor), needsCustomerCheck: bool(c.needs_customer_check), needsCustomerPromissory: bool(c.needs_customer_promissory),
        needsGuarantorCheck: bool(c.needs_guarantor_check), needsGuarantorPromissory: bool(c.needs_guarantor_promissory) })) })) }));
    const report = f.queryRows("SELECT id FROM consultation_forms ORDER BY id").map(({ id }) => {
      const c = f.getConsultation(Number(id));
      return { id: Number(id), amount: c.requestedAmountToman ?? f.parseConsultAmountToman(c.requestedAmount), military: c.militaryStatus ?? null };
    });
    console.log(JSON.stringify({ planRows, conditionRows, consults, firstCalls, guarantees, report }));
    return;
  }
  // ---- synthetic combined requirements (this code, post copy) ----
  const lines = [];
  const R = (coll, fl = {}) => f.sideRequirements(coll, fl);
  assert.deepEqual(R("promissory", { check: 1, salary: 1 }), { check: true, checkKind: "any", promissory: true, salary: true });
  assert.deepEqual(R("physical_check", { promissory: 1 }), { check: true, checkKind: "physical", promissory: true, salary: false });
  assert.deepEqual(f.encodeSide({ check: true, checkKind: "any", promissory: true, salary: true }), { collateralType: "promissory", check: true, promissory: false, salary: true });
  assert.deepEqual(f.encodeSide({ check: true, checkKind: "digital", promissory: true, salary: false }), { collateralType: "digital_check", check: false, promissory: true, salary: false });
  assert.deepEqual(f.encodeSide({ check: false, checkKind: "any", promissory: false, salary: false }), { collateralType: "none", check: false, promissory: false, salary: false });
  assert.deepEqual(f.encodeSide({ check: true, checkKind: "any", promissory: false, salary: false }), { collateralType: "none", check: true, promissory: false, salary: false });
  for (const coll of ["none", "promissory", "physical_check", "digital_check", "salary_deduction"])
    for (let m = 0; m < 8; m++) {
      const req = R(coll, { check: m & 1, promissory: m & 2, salary: m & 4 });
      const enc = f.encodeSide(req);
      assert.deepEqual(R(enc.collateralType, enc), req, `round trip ${coll}/${m}`);
      assert.deepEqual(f.normalizeSideFlags(enc.collateralType, enc), { check: enc.check, promissory: enc.promissory, salary: enc.salary });
    }
  assert.deepEqual(f.normalizeSideFlags("promissory", { check: true, promissory: true, salary: false }), { check: true, promissory: false, salary: false });
  assert.deepEqual(f.normalizeSideFlags("physical_check", { check: true, promissory: false, salary: true }), { check: false, promissory: false, salary: true });
  lines.push("sideRequirements / encodeSide round-trip every collateral × flag combination; normalize clears only repeats");

  const ts = "2026-03-01T08:00:00.000Z";
  const plan = f.execute("INSERT INTO loan_plans(name,principal_amount,installment_terms,active,loan_type,created_at) VALUES('طرح ترکیبی نمونه','500000000','[12]',1,'score',?)", [ts]);
  // route 1: promissory + any cheque + salary deduction (applicant)
  f.execute(`INSERT INTO loan_plan_conditions(plan_id,max_principal,customer_ranks,installment_options,customer_jobs,collateral_type,needs_guarantor,guarantor_ranks,guarantor_jobs,
    guarantor_collateral_type,needs_customer_promissory,needs_guarantor_promissory,needs_customer_salary_deduct,needs_guarantor_salary_deduct,needs_customer_check,needs_guarantor_check,sort_order)
    VALUES(?,'500000000','[]','[]','[]','promissory',0,'[]','[]','none',0,0,1,0,1,0,0)`, [plan]);
  const tsPlans = f.plansFromRows(plansRows(), condRows()).filter((p) => p.planId === Number(plan));
  const ev = (a) => f.evaluatePlans({ mode: "simple", formVersion: 2, callResult: "answered", creditRank: "A1", ...a }, tsPlans)[0].status;
  assert.equal(ev({ canPromissory: "yes", checkStatus: "physical", salaryDeduct: "yes" }), "fit");
  assert.equal(ev({ canPromissory: "yes", checkStatus: "digital", salaryDeduct: "yes" }), "fit");
  assert.equal(ev({ canPromissory: "yes", checkStatus: "none", salaryDeduct: "yes" }), "no");
  assert.equal(ev({ canPromissory: "no", checkStatus: "physical", salaryDeduct: "yes" }), "no");
  assert.equal(ev({ canPromissory: "yes", checkStatus: "physical", salaryDeduct: "no" }), "no");
  lines.push("first call: promissory + any cheque + salary route needs all three (any cheque type counts)");

  const cust = f.execute("INSERT INTO customers(name,phone,created_at,national_code) VALUES('مشتری نمونه ترکیبی',?,?,'9999999981')", [`0900${String(1000000 + Math.floor(Math.random() * 8999999))}`, ts]);
  const consult = (o) => {
    const id = f.execute(`INSERT INTO consultation_forms(customer_id,questionnaire_version,credit_rank,job_type,customer_check_status,has_check,has_customer_salary_deduct,has_guarantor,
      requested_amount,requested_amount_toman,military_status,created_at,updated_at) VALUES(?,2,'A1','employee',?,?,?,0,?,?,?,?,?)`,
      [cust, o.checkStatus ?? null, o.hasCheck ?? null, o.salary ?? null, o.amountText ?? null, o.toman ?? null, o.military ?? null, ts, ts]);
    const c = f.getConsultation(Number(id));
    return f.computeConsultationPlanMatches(c, f.activeMatchPlans()).find((m) => m.plan.id === Number(plan));
  };
  const all = consult({ hasCheck: 1, checkStatus: "physical", salary: 1 });
  const noSalary = consult({ hasCheck: 1, checkStatus: "physical", salary: 0 });
  const noCheck = consult({ hasCheck: 0, salary: 1 });
  assert.notEqual(all.status, "not_eligible", JSON.stringify(all));
  assert.equal(noSalary.status, "not_eligible", JSON.stringify(noSalary));
  assert.equal(noCheck.status, "not_eligible", JSON.stringify(noCheck));
  lines.push(`consultation: combined route ${all.status} with cheque + salary; not eligible without salary or without cheque`);
  const over = consult({ hasCheck: 1, checkStatus: "physical", salary: 1, amountText: "100 میلیون", toman: 900000000 });
  const under = consult({ hasCheck: 1, checkStatus: "physical", salary: 1, amountText: "900 میلیون", toman: 100000000 });
  assert.equal(over.status, "not_eligible", JSON.stringify(over)); assert.notEqual(under.status, "not_eligible", JSON.stringify(under));
  lines.push("consultation amount: numeric toman wins over the old free text");
  f.execute("UPDATE loan_plan_conditions SET needs_military_service=1 WHERE plan_id=?", [plan]);
  const mil = (military) => consult({ hasCheck: 1, checkStatus: "physical", salary: 1, military });
  assert.notEqual(mil("has_card").status, "not_eligible"); assert.notEqual(mil("female").status, "not_eligible");
  assert.equal(mil("no_card").status, "not_eligible");
  const unknown = mil(null);
  assert.notEqual(unknown.status, "not_eligible"); assert.ok(JSON.stringify(unknown).includes("پایان خدمت"), JSON.stringify(unknown));
  lines.push("consultation «پایان خدمت»: card/female ok, no card not eligible, not recorded → to check (never rejected)");
  const pg = f.publicPlanGuarantees({ conditions: [{ collateralType: "promissory", needsCustomerCheck: true, needsGuarantor: false }] });
  assert.deepEqual(pg.guaranteeOptions, [["cheque", "promissory"]]);
  lines.push("public guarantee options show cheque + promissory for a combined route");
  console.log(JSON.stringify({ lines }));
}
