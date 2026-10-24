// Fixture for the crm-call-form-plans migration + rollback, on a throwaway copy. Never touches live.
// Usage: CALL_FORM_PLANS_FIXTURE_DB=/path/to/copy-source.db node scripts/call-form-plans-migrate-fixture.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.env.CALL_FORM_PLANS_FIXTURE_DB;
if (!src) { console.log("SKIP (set CALL_FORM_PLANS_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfp-mig-"));
const db = path.join(dir, "customers.db");
fs.copyFileSync(src, db);
const run = (script, ...args) => execFileSync(process.execPath, [path.join(here, script), "--db", db, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const cols = () => { const d = new DatabaseSync(db, { readOnly: true }); try { return d.prepare("SELECT name FROM pragma_table_info('team_sales_qualifications')").all().map((c) => c.name); } finally { d.close(); } };
const counts = () => { const d = new DatabaseSync(db, { readOnly: true }); try {
  return Object.fromEntries(["customers", "call_logs", "team_sales_qualifications", "loan_plans"].map((t) => [t, Number(d.prepare(`SELECT count(*) n FROM ${t}`).get().n)]));
} finally { d.close(); } };
let passed = 0; const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };
try {
  const before = counts(); const colsBefore = cols();
  assert.ok(!colsBefore.includes("selected_plans_json"), "source copy must not have the column yet");
  ok("migrate dry run changes nothing", () => { run("call-form-plans-migrate.mjs"); assert.deepEqual(cols(), colsBefore); });
  ok("migrate --apply adds only the column", () => { run("call-form-plans-migrate.mjs", "--apply"); assert.deepEqual(cols(), [...colsBefore, "selected_plans_json"]); assert.deepEqual(counts(), before); });
  ok("migrate --apply again is a no-op", () => { run("call-form-plans-migrate.mjs", "--apply"); assert.deepEqual(cols(), [...colsBefore, "selected_plans_json"]); });
  const w = new DatabaseSync(db);
  const qid = Number(w.prepare("SELECT id FROM team_sales_qualifications ORDER BY id LIMIT 1").get()?.id ?? 0);
  if (qid) w.prepare("UPDATE team_sales_qualifications SET selected_plans_json=? WHERE id=?").run(JSON.stringify([{ id: 1, name: "x", status: "fit" }]), qid);
  w.close();
  ok("rollback dry run changes nothing", () => { run("call-form-plans-rollback.mjs"); assert.ok(cols().includes("selected_plans_json")); });
  const bk = path.join(dir, "backup.db"), ex = path.join(dir, "export.json");
  ok("rollback --apply: backup + export, column dropped, rows intact", () => {
    run("call-form-plans-rollback.mjs", "--apply", "--backup", bk, "--export", ex);
    assert.deepEqual(cols(), colsBefore); assert.deepEqual(counts(), before);
    assert.ok(fs.existsSync(bk));
    const exp = JSON.parse(fs.readFileSync(ex, "utf8"));
    const rows = Array.isArray(exp) ? exp : exp.rows ?? exp.selections;
    if (qid) assert.equal(rows.find((r) => r.id === qid).selectedPlans[0].name, "x");
    const b = new DatabaseSync(bk, { readOnly: true });
    assert.ok(b.prepare("SELECT name FROM pragma_table_info('team_sales_qualifications')").all().some((c) => c.name === "selected_plans_json")); b.close();
  });
  ok("integrity ok after rollback", () => { const d = new DatabaseSync(db, { readOnly: true }); assert.equal(d.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); d.close(); });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`${passed} passed`);
