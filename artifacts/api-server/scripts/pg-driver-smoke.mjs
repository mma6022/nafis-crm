// Connects to PG (env already loaded by the wrapper). Never prints secrets or row values.
import { openPgDatabase } from "../src/lib/pg-sync.ts";

let db;
try {
  db = openPgDatabase();
  console.log("PASS", "connect");
} catch (e) {
  console.log("FAIL", "connect", String(e && e.message || e).slice(0, 180));
  process.exit(6);
}
const checks = [{ name: "connect", ok: true }];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail });
    console.log("PASS", name, detail ?? "");
  } catch (e) {
    checks.push({ name, ok: false, detail: String(e.message || e).slice(0, 180) });
    console.log("FAIL", name, String(e.message || e).slice(0, 180));
  }
}

check("customers_count", () => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM customers").get();
  const n = Number(row?.n ?? row?.count);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad count ${n}`);
  return n;
});

check("table_info_customers", () => {
  const rows = db.prepare("PRAGMA table_info(customers)").all();
  if (!rows.find((r) => r.name === "id" || r.name === "phone")) throw new Error("missing cols");
  return rows.length;
});

check("sqlite_master_tables", () => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get();
  return Number(row?.n);
});

check("param_query", () => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE id=?").get(1);
  return Number(row?.n);
});

check("or_ignore", () => {
  db.exec("CREATE TABLE IF NOT EXISTS pg_driver_smoke (version TEXT PRIMARY KEY, applied_at TEXT)");
  const a = db.prepare("INSERT OR IGNORE INTO pg_driver_smoke(version, applied_at) VALUES (?, ?)").run("smoke-v1", "now");
  const b = db.prepare("INSERT OR IGNORE INTO pg_driver_smoke(version, applied_at) VALUES (?, ?)").run("smoke-v1", "now");
  if (!a.changes) throw new Error("first insert changes=0");
  if (b.changes) throw new Error("duplicate was not ignored");
  return `id=${a.lastInsertRowid}`;
});

check("transaction", () => {
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO pg_driver_smoke(version, applied_at) VALUES (?, ?)").run("smoke-tx", "t");
    db.exec("ROLLBACK");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
  const row = db.prepare("SELECT COUNT(*) AS n FROM pg_driver_smoke WHERE version=?").get("smoke-tx");
  if (Number(row?.n) !== 0) throw new Error("rollback leaked");
  return "rolled_back";
});

check("julianday", () => {
  const row = db.prepare("SELECT julianday(?) AS j").get("2026-11-11T00:00:00Z");
  const j = Number(row?.j);
  if (!Number.isFinite(j) || j < 2000000) throw new Error(`bad julianday ${j}`);
  return j;
});

check("dossier_table", () => {
  db.exec(`CREATE TABLE IF NOT EXISTS customer_dossier (
    customer_id INTEGER PRIMARY KEY,
    city TEXT,
    amount_toman INTEGER,
    credit_rank TEXT,
    g_job_status TEXT,
    g_credit_rank TEXT,
    g_conditions TEXT,
    customer_note TEXT,
    answers_json TEXT,
    updated_at TEXT,
    actor_user_id INTEGER,
    actor_name TEXT
  )`);
  const row = db.prepare("SELECT COUNT(*) AS n FROM customer_dossier").get();
  return Number(row?.n);
});

check("insert_returning_id", () => {
  const r = db.prepare("INSERT INTO pg_driver_smoke(version, applied_at) VALUES (?, ?)").run("smoke-id", "t");
  if (!r.lastInsertRowid && r.changes < 1) throw new Error("no row");
  return r.changes;
});

const failed = checks.filter((c) => !c.ok).length;
console.log("SUMMARY", "passed", checks.length - failed, "failed", failed);
db.close();
process.exit(failed ? 6 : 0);
