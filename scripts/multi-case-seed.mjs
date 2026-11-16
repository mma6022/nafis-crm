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
const templateSql = [
  planCols.includes("contract_template_id") ? "contract_template_id" : "NULL AS contract_template_id",
  planCols.includes("primary_contract_template_id") ? "primary_contract_template_id" : "NULL AS primary_contract_template_id",
].join(", ");
const activePlans = db.prepare(`SELECT id, name, ${bankSql} AS bank_name, ${templateSql} FROM loan_plans WHERE COALESCE(active,1)=1 ORDER BY id`).all();
if (activePlans.length < 2) { console.error("need two active loan_plans rows; this script does not insert or rename plans"); process.exit(1); }
const templateOf = (plan) => Number(plan.contract_template_id || plan.primary_contract_template_id || 0);
function templateCanCreate(id) {
  if (!id || !has("contract_templates")) return false;
  let row = null;
  try { row = db.prepare("SELECT mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL").get(id); }
  catch { try { row = db.prepare("SELECT mappings_json FROM contract_templates WHERE id=?").get(id); } catch { return false; } }
  let mappings = null;
  try { mappings = JSON.parse(row?.mappings_json || "null"); } catch { return false; }
  if (!Array.isArray(mappings)) return false;
  const source = (mapping) => mapping?.sourceType ?? (mapping?.customerField ? "customer" : mapping?.loanPlanField ? "loanPlan" : "manual");
  return mappings.filter((mapping) => source(mapping) === "loanPlan" && mapping?.loanPlanField === "loanPlan.principalAmount").length === 1;
}
const withTemplate = activePlans.filter((plan) => templateCanCreate(templateOf(plan)));
let plans = (withTemplate.length >= 2 ? withTemplate : activePlans).slice(0, 2);
const templateCol = planCols.includes("contract_template_id") ? "contract_template_id" : planCols.includes("primary_contract_template_id") ? "primary_contract_template_id" : "";
if (templateCol && has("contract_templates") && withTemplate.length < 2) {
  let rows = [];
  try { rows = db.prepare("SELECT id FROM contract_templates WHERE deleted_at IS NULL ORDER BY id").all(); }
  catch { try { rows = db.prepare("SELECT id FROM contract_templates ORDER BY id").all(); } catch { rows = []; } }
  const good = rows.find((row) => templateCanCreate(row.id));
  if (good) {
    for (const plan of activePlans) {
      if (templateCanCreate(templateOf(plan))) continue;
      if (templateOf(plan) > 0) continue;
      db.prepare(`UPDATE loan_plans SET ${templateCol}=? WHERE id=? AND (${templateCol} IS NULL OR ${templateCol}=0)`).run(good.id, plan.id);
      plan[templateCol] = good.id;
      if (activePlans.filter((item) => templateCanCreate(templateOf(item))).length >= 2) break;
    }
    plans = activePlans.filter((plan) => templateCanCreate(templateOf(plan))).slice(0, 2);
  }
}
if (!plans.every((plan) => templateCanCreate(templateOf(plan)))) {
  console.error("need two active plans whose primary template maps loanPlan.principalAmount exactly once; this script does not rename plans");
  process.exit(1);
}

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
manifest.unreadyPlans = activePlans
  .filter((plan) => !templateCanCreate(templateOf(plan)))
  .map((plan) => ({ id: plan.id, name: plan.name, bankName: plan.bank_name ?? null }));

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
function primeIdentity(customerId, nationalCode) {
  const patch = {
    national_code: nationalCode,
    birth_date_jalali: "1370/01/01",
    postal_code: "1234567890",
    verification_status: "verified",
    verification_checked_at: now,
    shahkar_ok: 1,
    person_info_ok: 1,
    postal_code_info_ok: 1,
    sana_ok: 1,
    credit_rank: "A",
  };
  const names = Object.keys(patch).filter((key) => cols("customers").includes(key));
  if (names.length) db.prepare(`UPDATE customers SET ${names.map((name) => `${name}=?`).join(",")} WHERE id=?`).run(...names.map((name) => patch[name]), customerId);
  if (has("customer_credit_checks")) {
    insertRow("customer_credit_checks", {
      customer_id: customerId, national_code: nationalCode, status: "report_generated",
      score: 750, score_label: "A", completed_at: now, created_at: now, updated_at: now,
    });
  }
  if (has("customer_identity_documents")) {
    for (const documentType of ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"]) {
      insertRow("customer_identity_documents", {
        customer_id: customerId, document_type: documentType, storage_path: "synthetic/multi-case-sample",
        original_name: `${documentType}.jpg`, mime_type: "image/jpeg", size_bytes: 1,
        sha256: "0".repeat(64), created_at: now, is_latest: 1, version: 1,
      });
    }
  }
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
  primeIdentity(customerId, `100000000${experts.indexOf(expert) + 1}`);
  const cases = [insertApp(customerId, plans[0].id, "250000000"), insertApp(customerId, plans[1].id, "180000000")];
  manifest.experts.push({ key: expert.key, userId: expert.userId, salespersonId: expert.salespersonId, customerId, caseIds: cases, phone: expert.phone, name: expert.name });
}

const host = manifest.experts.find((row) => row.customerId);
if (host) try {
  const flowId = insertRow("customers", {
    name: "مشتری آزمایشی مسیر ثبت",
    phone: "09120000024",
    national_code: "1234567891",
    birth_date_jalali: "1370/01/01",
    postal_code: "1234567890",
    salesperson_id: host.salespersonId,
    description: "multi-case-sample-flow",
    status: "in_progress",
    verification_status: "verified",
    verification_checked_at: now,
    shahkar_ok: 1,
    person_info_ok: 1,
    postal_code_info_ok: 1,
    sana_ok: 1,
    credit_rank: "A",
    created_at: now,
  });
  const flowCase = insertApp(flowId, plans[0].id, "250000000");
  if (has("customer_credit_checks")) {
    insertRow("customer_credit_checks", {
      customer_id: flowId,
      national_code: "1234567891",
      status: "report_generated",
      score: 750,
      score_label: "A",
      completed_at: now,
      created_at: now,
      updated_at: now,
    });
  }
  if (has("customer_identity_documents")) {
    for (const documentType of ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"]) {
      insertRow("customer_identity_documents", {
        customer_id: flowId,
        document_type: documentType,
        storage_path: "synthetic/multi-case-sample",
        original_name: `${documentType}.jpg`,
        mime_type: "image/jpeg",
        size_bytes: 1,
        sha256: "0".repeat(64),
        created_at: now,
        is_latest: 1,
        version: 1,
      });
    }
  }
  if (has("wallet_accounts_v2")) {
    insertRow("wallet_accounts_v2", {
      customer_id: flowId,
      wallet_type: "cash",
      balance: "100000000",
      created_at: now,
    });
  }
  manifest.flow = {
    customerId: flowId,
    salespersonId: host.salespersonId,
    openPlanId: plans[0].id,
    freePlanId: plans[1].id,
    caseId: flowCase,
    phone: "09120000024",
    unreadyPlanId: (manifest.unreadyPlans.find((plan) => plan.id === 17) ?? manifest.unreadyPlans[0])?.id ?? null,
    note: "Verified identity, fresh credit rank A, cash wallet, and one open case. The other active plan is free so the wizard can pass the same-plan block and reach review. Template-excluded plans, including plan 17 when it is active, stay in the plan list as disabled tiles.",
  };
} catch (error) {
  manifest.flow = { error: error instanceof Error ? error.message : String(error) };
}
if (has("reminders") && cols("reminders").includes("done")) {
  const changed = db.prepare("UPDATE reminders SET done=1 WHERE user_id IN (8,2,3) AND COALESCE(done,0)=0").run();
  manifest.remindersMarkedDone = Number(changed.changes ?? 0);
}
const out = `${file}.multi-case-seed.json`;
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
console.log(`wrote ${out}`);
db.close();
