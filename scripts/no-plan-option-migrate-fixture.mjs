// Fixture for the crm-no-plan-option migration + rollback, on a throwaway copy. Never touches live.
// Usage: NO_PLAN_OPTION_FIXTURE_DB=/path/to/copy-source.db node scripts/no-plan-option-migrate-fixture.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.env.NO_PLAN_OPTION_FIXTURE_DB;
if (!src) { console.log("SKIP (set NO_PLAN_OPTION_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npo-mig-"));
const db = path.join(dir, "customers.db");
fs.copyFileSync(src, db);
const TABLES = ["team_sales_qualifications", "loan_plan_conditions", "customers"];
const ADDED = { team_sales_qualifications: ["no_plan_fit", "no_plan_note"], loan_plan_conditions: ["needs_military_service"], customers: ["city"] };
const run = (script, ...args) => execFileSync(process.execPath, [path.join(here, script), "--db", db, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const ro = (fn) => { const d = new DatabaseSync(db, { readOnly: true }); try { return fn(d); } finally { d.close(); } };
const cols = () => ro((d) => Object.fromEntries(TABLES.map((t) => [t, d.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((c) => c.name)])));
const NEW_TABLES = ["customer_consult_profile_versions", "customer_national_code_changes"];
const tables = () => ro((d) => NEW_TABLES.filter((t) => d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)));
const counts = () => ro((d) => Object.fromEntries([...TABLES, "call_logs", "loan_plans", "loan_applications"].map((t) => [t, Number(d.prepare(`SELECT count(*) n FROM ${t}`).get().n)])));
const planHash = () => ro((d) => JSON.stringify([d.prepare("SELECT * FROM loan_plans ORDER BY id").all(), d.prepare("SELECT * FROM loan_plan_conditions ORDER BY id").all().map((r) => { const { needs_military_service, ...rest } = r; return rest; })]));
let passed = 0; const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };
try {
  const before = counts(); const colsBefore = cols(); const plansBefore = planHash();
  for (const [t, cs] of Object.entries(ADDED)) for (const c of cs) assert.ok(!colsBefore[t].includes(c), `source copy must not have ${t}.${c} yet`);
  assert.deepEqual(tables(), [], "source copy must not have the two new tables yet");
  ok("migrate dry run changes nothing (lists the two tables too)", () => {
    const out = run("no-plan-option-migrate.mjs"); assert.match(out, /would add/); assert.match(out, /table customer_consult_profile_versions/); assert.match(out, /table customer_national_code_changes/);
    assert.deepEqual(cols(), colsBefore); assert.deepEqual(tables(), []);
  });
  const expected = Object.fromEntries(TABLES.map((t) => [t, [...colsBefore[t], ...ADDED[t]]]));
  ok("migrate --apply adds only the four columns + two empty tables (with indexes), row counts unchanged", () => {
    run("no-plan-option-migrate.mjs", "--apply"); assert.deepEqual(cols(), expected); assert.deepEqual(counts(), before);
    assert.deepEqual(tables(), NEW_TABLES);
    ro((d) => { for (const t of NEW_TABLES) assert.equal(Number(d.prepare(`SELECT count(*) n FROM ${t}`).get().n), 0, t); });
    const idx = ro((d) => d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('customer_consult_profile_versions','customer_national_code_changes') ORDER BY name").all().map((r) => r.name));
    assert.deepEqual(idx, ["idx_consult_profile_customer", "idx_consult_profile_qualification", "idx_national_code_changes_customer"]);
  });
  ok("migrate leaves every plan/condition untouched (military NULL everywhere)", () => {
    assert.equal(planHash(), plansBefore);
    assert.equal(ro((d) => Number(d.prepare("SELECT count(*) n FROM loan_plan_conditions WHERE needs_military_service IS NOT NULL").get().n)), 0);
    assert.equal(ro((d) => Number(d.prepare("SELECT count(*) n FROM customers WHERE city IS NOT NULL").get().n)), 0);
  });
  ok("migrate --apply again is a no-op", () => { const out = run("no-plan-option-migrate.mjs", "--apply"); assert.match(out, /"applied":false/); assert.deepEqual(cols(), expected); assert.deepEqual(tables(), NEW_TABLES); });
  const w = new DatabaseSync(db);
  const qid = Number(w.prepare("SELECT id FROM team_sales_qualifications ORDER BY id LIMIT 1").get()?.id ?? 0);
  if (qid) w.prepare("UPDATE team_sales_qualifications SET no_plan_fit=1, no_plan_note=? WHERE id=?").run("x-note", qid);
  const cid = Number(w.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get().id);
  w.prepare("UPDATE customers SET city=? WHERE id=?").run("x-city", cid);
  w.prepare("INSERT INTO customer_national_code_changes(customer_id,old_national_code,new_national_code,identity_changed,source,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?)").run(cid, null, "0000000000", 0, "quick_credit", 1, "2026-01-01T00:00:00.000Z");
  w.close();
  ok("rollback dry run changes nothing and counts data rows", () => { const out = run("no-plan-option-rollback.mjs"); assert.match(out, /"rowsWithData": 1/); assert.deepEqual(cols(), expected); });
  const bk = path.join(dir, "backup.db"), ex = path.join(dir, "export.json");
  ok("rollback --apply: backup + export, columns dropped, rows intact", () => {
    run("no-plan-option-rollback.mjs", "--apply", "--backup", bk, "--export", ex);
    assert.deepEqual(cols(), colsBefore); assert.deepEqual(counts(), before); assert.equal(planHash(), plansBefore);
    const exp = JSON.parse(fs.readFileSync(ex, "utf8"));
    assert.equal(exp["customers.city"].find((r) => r.id === cid).value, "x-city");
    assert.equal(exp["table customer_national_code_changes"].length, 1); assert.equal(exp["table customer_consult_profile_versions"].length, 0);
    assert.deepEqual(tables(), []);
    if (qid) { assert.equal(exp["team_sales_qualifications.no_plan_note"].find((r) => r.id === qid).value, "x-note"); assert.equal(exp["team_sales_qualifications.no_plan_fit"].find((r) => r.id === qid).value, 1); }
    const b = new DatabaseSync(bk, { readOnly: true });
    assert.ok(b.prepare("SELECT name FROM pragma_table_info('customers')").all().some((c) => c.name === "city")); b.close();
  });
  ok("integrity ok after rollback", () => ro((d) => assert.equal(d.prepare("PRAGMA integrity_check").get().integrity_check, "ok")));
  ok("rollback --apply again is a no-op", () => { const out = run("no-plan-option-rollback.mjs", "--apply"); assert.match(out, /Nothing to roll back/); });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`${passed} passed`);
