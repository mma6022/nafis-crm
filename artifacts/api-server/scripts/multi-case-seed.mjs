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

function digits(value) {
  return String(value ?? "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\D/g, "");
}
function mobileKey(value) {
  let n = digits(value);
  if (n.startsWith("0098") && n.length === 14) n = `0${n.slice(4)}`;
  else if (n.startsWith("98") && n.length === 12) n = `0${n.slice(2)}`;
  else if (n.length === 10 && n.startsWith("9")) n = `0${n}`;
  return n;
}
db.function("crm_customer_mobile_key", (value) => mobileKey(value));
db.function("crm_customer_national_code_key", (value) => digits(value));
db.function("crm_persian_search_key", (value) => String(value ?? "").normalize("NFC").replace(/[يى]/g, "ی").replace(/ك/g, "ک"));

function meta(table) { try { return db.prepare(`PRAGMA table_info(${table})`).all(); } catch { return []; } }
function fillRequired(table, data) {
  for (const col of meta(table)) {
    if (!col.notnull || col.dflt_value != null || col.pk || data[col.name] !== undefined) continue;
    const type = String(col.type || "").toUpperCase();
    data[col.name] = /INT|REAL|NUM/.test(type) ? 0 : "";
  }
  return data;
}
function insertRow(table, data) {
  fillRequired(table, data);
  const names = Object.keys(data).filter((key) => cols(table).includes(key));
  const info = db.prepare(`INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...names.map((key) => data[key]));
  return Number(info.lastInsertRowid);
}
function insertCustomer(row) {
  return insertRow("customers", { name: row.name, phone: row.phone, salesperson_id: row.salespersonId, description: "multi-case-sample", status: "in_progress", created_at: now });
}
function consultationFor(customerId) {
  if (!has("consultation_forms") || !appCols.includes("consultation_id")) return null;
  return insertRow("consultation_forms", { customer_id: customerId, requested_amount: "0", extra_notes: "multi-case-sample", updated_at: now, created_at: now });
}
function insertApp(customerId, planId, amount) {
  const actor = has("users") ? db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() : null;
  return insertRow("loan_applications", {
    customer_id: customerId, plan_id: planId, plan_ids: JSON.stringify([planId]), consultation_id: consultationFor(customerId),
    requested_by_user_id: actor?.id ?? null, stage: "draft", status: "requested", requested_amount: amount,
    duration_months: 12, requested_duration_months: 12, created_at: now, updated_at: now, new_case_workflow: 1, is_pre_registration: 0,
  });
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
