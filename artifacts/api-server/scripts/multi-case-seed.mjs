/**
 * Add synthetic multi-case rows to a COPY of a CRM sqlite database.
 * Does not change loan_plans rows (names stay as they are). Does not use real phone numbers.
 *
 *   node artifacts/api-server/scripts/multi-case-seed.mjs /path/to/customers.copy.db
 *
 * Writes <db>.multi-case-seed.json with the customer ids the screenshot script can read.
 * Phones are 09120000021 and the next synthetic numbers in that reserved range.
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: node artifacts/api-server/scripts/multi-case-seed.mjs <customers.db>"); process.exit(1); }
const db = new DatabaseSync(file);
const cols = (table) => { try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { return []; } };
const has = (table) => !!db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(table);
if (!has("customers") || !has("loan_applications") || !has("loan_plans")) {
  console.error("database is missing customers, loan_applications, or loan_plans"); process.exit(1);
}
const planCols = cols("loan_plans");
const bankSql = planCols.includes("bank_name") ? "bank_name" : "NULL";
const plans = db.prepare(`SELECT id, name, ${bankSql} AS bank_name FROM loan_plans WHERE COALESCE(active,1)=1 ORDER BY id LIMIT 2`).all();
if (plans.length < 2) { console.error("need two active loan_plans rows; this script does not insert or rename plans"); process.exit(1); }

const now = new Date().toISOString();
const settingsCols = cols("call_queue_settings");
if (has("call_queue_settings")) {
  if (settingsCols.includes("updated_at")) {
    db.prepare(`INSERT INTO call_queue_settings(key, value, updated_at) VALUES('flag.multi_case_v1','1', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(now);
  } else {
    db.prepare("INSERT INTO call_queue_settings(key, value) VALUES('flag.multi_case_v1','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  }
}

const custCols = cols("customers");
const appCols = cols("loan_applications");
const experts = [
  { key: "kazemi", userId: 8, salespersonId: 6, phone: "09120000021", name: "مشتری آزمایشی کاظمی" },
  { key: "hasani", userId: 2, salespersonId: 3, phone: "09120000022", name: "مشتری آزمایشی حسنی" },
  { key: "ghasemi", userId: 3, salespersonId: 4, phone: "09120000023", name: "مشتری آزمایشی قاسمی" },
];
const manifest = { plans: plans.map((p) => ({ id: p.id, name: p.name, bankName: p.bank_name ?? null })), experts: [], flag: "flag.multi_case_v1=1" };

function insertCustomer(row) {
  const data = { name: row.name, phone: row.phone, salesperson_id: row.salespersonId, description: "multi-case-sample", status: "in_progress", created_at: now };
  const keys = Object.keys(data).filter((k) => custCols.includes(k));
  const info = db.prepare(`INSERT INTO customers(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map((k) => data[k]));
  return Number(info.lastInsertRowid);
}
function insertApp(customerId, planId, amount) {
  const data = { customer_id: customerId, plan_id: planId, stage: "draft", status: "requested", requested_amount: amount, created_at: now, deleted_at: null };
  const keys = Object.keys(data).filter((k) => appCols.includes(k));
  const info = db.prepare(`INSERT INTO loan_applications(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map((k) => data[k]));
  return Number(info.lastInsertRowid);
}

for (const expert of experts) {
  const person = has("salespersons") ? db.prepare("SELECT id FROM salespersons WHERE id=?").get(expert.salespersonId) : { id: expert.salespersonId };
  if (!person) { manifest.experts.push({ ...expert, skipped: "salesperson missing" }); continue; }
  const customerId = insertCustomer(expert);
  const cases = [insertApp(customerId, plans[0].id, "250000000"), insertApp(customerId, plans[1].id, "180000000")];
  manifest.experts.push({ key: expert.key, userId: expert.userId, salespersonId: expert.salespersonId, customerId, caseIds: cases, phone: expert.phone, name: expert.name });
}
const out = `${file}.multi-case-seed.json`;
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
console.log(`wrote ${out}`);
db.close();
