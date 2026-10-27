import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// This regression fixture creates a disposable database and synthetic records;
// it never opens, reads, or copies attached_assets or production customer data.
const temp = await mkdtemp(path.join(os.tmpdir(), "crm-customer-portal-fixture-"));
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(temp, "fixture.sqlite");
const bundle = path.join(temp, "portal-worker.mjs");
const secret = randomBytes(32).toString("hex");
const relaySecret = randomBytes(32).toString("hex");
const smsMessages = [];
const identityCalls = [];
let relay, child;

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function nationalCode(seed) {
  const prefix = String(seed).padStart(9, "0").slice(-9);
  const sum = [...prefix].reduce((total, digit, index) => total + Number(digit) * (10 - index), 0) % 11;
  return prefix + String(sum < 2 ? sum : 11 - sum);
}

function schemaSql() {
  return `
    PRAGMA foreign_keys=ON;
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE allocation_programs(id INTEGER PRIMARY KEY,name TEXT,is_default INTEGER DEFAULT 0,active INTEGER DEFAULT 1,
      cursor_item_index INTEGER DEFAULT 0,cursor_item_used INTEGER DEFAULT 0,updated_at TEXT);
    CREATE TABLE allocation_program_items(id INTEGER PRIMARY KEY,program_id INTEGER,salesperson_id INTEGER,quota INTEGER,sort_order INTEGER DEFAULT 0);
    CREATE TABLE users(
      id INTEGER PRIMARY KEY,username TEXT NOT NULL,full_name TEXT,mobile TEXT,priority_colors TEXT,
      role TEXT NOT NULL,salesperson_id INTEGER,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,
      FOREIGN KEY(salesperson_id) REFERENCES salespersons(id)
    );
    CREATE TABLE app_roles(slug TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,customer_scope TEXT NOT NULL DEFAULT 'all',is_system INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE role_permissions(role_slug TEXT NOT NULL,permission TEXT NOT NULL,PRIMARY KEY(role_slug,permission),FOREIGN KEY(role_slug) REFERENCES app_roles(slug));
    CREATE TABLE auth_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT NOT NULL UNIQUE,user_id INTEGER NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE customers(
      id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT NOT NULL,description TEXT,
      national_code TEXT,birth_date_jalali TEXT,postal_code TEXT,father_name TEXT,verification_status TEXT,
      verification_checked_at TEXT,identity_changed_at TEXT,verification_version INTEGER DEFAULT 0,
      verification_provider TEXT,shahkar_status TEXT,person_info_status TEXT,postal_code_info_status TEXT,
      sana_status TEXT,shahkar_ok INTEGER,person_info_ok INTEGER,postal_code_info_ok INTEGER,sana_ok INTEGER,
      salesperson_id INTEGER,merged_into_customer_id INTEGER,is_urgent INTEGER DEFAULT 0,registered_by INTEGER,registration_source TEXT,source TEXT,credit_grade TEXT,
      created_at TEXT NOT NULL,priority TEXT,status TEXT DEFAULT 'in_progress',credit_score REAL,credit_rank TEXT,
      credit_checked_at TEXT,first_name TEXT,last_name TEXT,address TEXT,official_first_name TEXT,
      official_last_name TEXT,official_father_name TEXT,official_address TEXT,official_postal_code TEXT,
      FOREIGN KEY(salesperson_id) REFERENCES salespersons(id),
      FOREIGN KEY(merged_into_customer_id) REFERENCES customers(id)
    );
    CREATE TABLE customer_merge_audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT,source_customer_id INTEGER NOT NULL,survivor_customer_id INTEGER NOT NULL,
      FOREIGN KEY(source_customer_id) REFERENCES customers(id),FOREIGN KEY(survivor_customer_id) REFERENCES customers(id)
    );
    CREATE TABLE notification_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE customer_portal_sessions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT NOT NULL UNIQUE,mobile TEXT NOT NULL,
      customer_id INTEGER,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
    CREATE TABLE customer_portal_otp_challenges(
      id INTEGER PRIMARY KEY AUTOINCREMENT,mobile TEXT NOT NULL,ip_hash TEXT NOT NULL,otp_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,delivery_status TEXT NOT NULL DEFAULT 'pending',
      consumed_at TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE customer_portal_profile_audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,actor_mobile TEXT NOT NULL,
      old_values_json TEXT NOT NULL,new_values_json TEXT NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
    CREATE TABLE customer_portal_verification_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,checks_json TEXT NOT NULL,
      canonical_json TEXT,status TEXT NOT NULL,error_message TEXT,created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
    CREATE TABLE customer_identity_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,document_type TEXT NOT NULL,
      storage_path TEXT,original_name TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,
      created_by_user_id INTEGER,created_by_customer_id INTEGER,created_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,is_latest INTEGER NOT NULL DEFAULT 1,approved_at TEXT,
      approved_by_user_id INTEGER,review_reason TEXT,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_customer_id) REFERENCES customers(id) ON DELETE SET NULL,
      FOREIGN KEY(approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE customer_credit_checks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,requested_by_user_id INTEGER,
      requested_by_customer_id INTEGER,provider TEXT NOT NULL DEFAULT 'ics24',national_code TEXT NOT NULL,
      provider_reference TEXT,provider_status TEXT,status TEXT NOT NULL,score REAL,score_label TEXT,
      summary TEXT,error_message TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(requested_by_customer_id) REFERENCES customers(id) ON DELETE SET NULL
    );
    CREATE TABLE contract_templates(
      id INTEGER PRIMARY KEY,name TEXT NOT NULL,original_filename TEXT,storage_path TEXT,sha256 TEXT,
      variables_json TEXT,mappings_json TEXT,deleted_at TEXT
    );
    CREATE TABLE loan_plans(
      id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,contract_template_id INTEGER,
      primary_contract_template_id INTEGER,principal_amount TEXT,installment_terms TEXT,filing_fee_toman TEXT,
      required_documents TEXT,description TEXT,min_principal TEXT,terms TEXT,bank_name TEXT,platform_name TEXT,
      annual_interest TEXT,installments TEXT,deposit_percents TEXT,customer_jobs TEXT,needs_guarantor INTEGER,notes TEXT,
      FOREIGN KEY(contract_template_id) REFERENCES contract_templates(id)
    );
    CREATE TABLE loan_plan_conditions(
      id INTEGER PRIMARY KEY,plan_id INTEGER NOT NULL,name TEXT,description TEXT,min_principal TEXT,
      max_principal TEXT,installment_options TEXT,customer_ranks TEXT,sort_order INTEGER DEFAULT 0,
      customer_jobs TEXT,collateral_type TEXT,needs_guarantor INTEGER,guarantor_ranks TEXT,guarantor_jobs TEXT,notes TEXT,
      FOREIGN KEY(plan_id) REFERENCES loan_plans(id) ON DELETE CASCADE
    );
    CREATE TABLE wallet_accounts_v2(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,wallet_type TEXT NOT NULL,
      balance TEXT NOT NULL DEFAULT '0',created_at TEXT NOT NULL,UNIQUE(customer_id,wallet_type),
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
    CREATE TABLE company_wallet_accounts(wallet_type TEXT PRIMARY KEY,balance TEXT NOT NULL);
    CREATE TABLE loan_filing_fee_charges(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,plan_id INTEGER NOT NULL,
      amount_toman TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,application_id INTEGER,
      actor_user_id INTEGER,actor_customer_id INTEGER,created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id),FOREIGN KEY(plan_id) REFERENCES loan_plans(id),
      FOREIGN KEY(actor_user_id) REFERENCES users(id),FOREIGN KEY(actor_customer_id) REFERENCES customers(id)
    );
    CREATE TABLE wallet_ledger_v2(
      id INTEGER PRIMARY KEY AUTOINCREMENT,wallet_id INTEGER NOT NULL,amount TEXT NOT NULL,kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,actor_user_id INTEGER,actor_customer_id INTEGER,created_at TEXT NOT NULL,
      FOREIGN KEY(wallet_id) REFERENCES wallet_accounts_v2(id),FOREIGN KEY(actor_user_id) REFERENCES users(id),
      FOREIGN KEY(actor_customer_id) REFERENCES customers(id)
    );
    CREATE TABLE company_wallet_ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT,wallet_type TEXT NOT NULL,amount_toman TEXT NOT NULL,kind TEXT NOT NULL,
      fee_charge_id INTEGER,actor_user_id INTEGER,actor_customer_id INTEGER,idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,FOREIGN KEY(fee_charge_id) REFERENCES loan_filing_fee_charges(id),
      FOREIGN KEY(actor_user_id) REFERENCES users(id),FOREIGN KEY(actor_customer_id) REFERENCES customers(id)
    );
    CREATE TABLE consultation_forms(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,requested_amount TEXT,extra_notes TEXT,updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );
    CREATE TABLE loan_applications(
      id INTEGER PRIMARY KEY AUTOINCREMENT,consultation_id INTEGER,customer_id INTEGER NOT NULL,
      requested_by_user_id INTEGER,requested_by_customer_id INTEGER,plan_ids TEXT,plan_id INTEGER,
      requested_amount TEXT,status TEXT,stage TEXT,is_pre_registration INTEGER DEFAULT 0,
      condition_snapshot_json TEXT,plan_snapshot_json TEXT,duration_months INTEGER,requested_duration_months INTEGER,
      document_requirements_snapshot_json TEXT,primary_manual_values_json TEXT,notes TEXT,
      salesperson_id_snapshot INTEGER,salesperson_name_snapshot TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,
      initial_approval_at TEXT,current_primary_generation_id INTEGER,new_case_workflow INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(consultation_id) REFERENCES consultation_forms(id),FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(requested_by_user_id) REFERENCES users(id),FOREIGN KEY(requested_by_customer_id) REFERENCES customers(id),
      FOREIGN KEY(plan_id) REFERENCES loan_plans(id),FOREIGN KEY(salesperson_id_snapshot) REFERENCES salespersons(id)
    );
    CREATE TABLE loan_application_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,requirement_key TEXT,label TEXT,
      source TEXT,status TEXT DEFAULT 'pending',incomplete_reason TEXT,storage_path TEXT,original_name TEXT,
      mime_type TEXT,size_bytes INTEGER,created_by_customer_id INTEGER,created_at TEXT NOT NULL,
      FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_customer_id) REFERENCES customers(id) ON DELETE SET NULL
    );
    CREATE TABLE contract_generations(
      id INTEGER PRIMARY KEY,pdf_path TEXT,status TEXT,provider_status TEXT,superseded_at TEXT,deleted_at TEXT
    );
    CREATE TABLE loan_application_generated_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,kind TEXT NOT NULL,
      contract_generation_id INTEGER,link TEXT,status TEXT,review_reason TEXT,created_at TEXT,
      FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE CASCADE,
      FOREIGN KEY(contract_generation_id) REFERENCES contract_generations(id)
    );
    CREATE TABLE loan_application_stage_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL,from_stage TEXT,to_stage TEXT NOT NULL,
      action TEXT NOT NULL,reason TEXT,actor_id INTEGER,actor_customer_id INTEGER,created_at TEXT NOT NULL,
      FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE CASCADE,
      FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(actor_customer_id) REFERENCES customers(id) ON DELETE SET NULL
    );
    CREATE TABLE customer_portal_conversations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,title TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
    CREATE TABLE customer_portal_messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,
      suggested_plan_id INTEGER,created_at TEXT NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES customer_portal_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY(suggested_plan_id) REFERENCES loan_plans(id) ON DELETE SET NULL
    );
  `;
}

const fixtureDbModule = `
  import { DatabaseSync } from "node:sqlite";
  import path from "node:path";
  export const databasePath = path.resolve(process.env.CRM_DATABASE_PATH);
  export const crmDb = new DatabaseSync(databasePath);
  crmDb.exec("PRAGMA foreign_keys=ON");
  crmDb.function("crm_customer_mobile_key", value => {
    let digits=String(value??"").replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\\D/g,"");
    if(digits.startsWith("0098")&&digits.length===14)digits="0"+digits.slice(4);
    else if(digits.startsWith("98")&&digits.length===12)digits="0"+digits.slice(2);
    else if(digits.length===10&&digits.startsWith("9"))digits="0"+digits;
    return digits;
  });
  export const queryRow=(sql,params=[])=>crmDb.prepare(sql).get(...params);
  export const queryRows=(sql,params=[])=>crmDb.prepare(sql).all(...params);
  export const execute=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
  export const executeChanges=(sql,params=[])=>crmDb.prepare(sql).run(...params).changes;
  export const runTransaction=fn=>{crmDb.exec("BEGIN");try{const result=fn();crmDb.exec("COMMIT");return result}catch(error){crmDb.exec("ROLLBACK");throw error}};
  export const runImmediateTransaction=fn=>{crmDb.exec("BEGIN IMMEDIATE");try{const result=fn();crmDb.exec("COMMIT");return result}catch(error){crmDb.exec("ROLLBACK");throw error}};
`;

const workerSource = `
  import express from "express";
  import cookieParser from "cookie-parser";
  import authRouter from "./src/routes/customer-portal-auth";
  import profileRouter from "./src/routes/customer-portal-profile";
  import loansRouter from "./src/routes/customer-portal-loans";
  import adviceRouter from "./src/routes/customer-portal-advice";
  import intakeRouter from "./src/routes/customer-portal-intake";
  import {customerChatRouter,staffChatRouter} from "./src/routes/customer-chat";
  import staffLoanApplicationsRouter from "./src/routes/loan-applications";
  import { requireAuth } from "./src/lib/auth";
  const app=express();
  app.use(express.json(),cookieParser());
  app.get("/healthz",(_req,res)=>res.json({ok:true}));
  app.use("/api/customer-portal/auth",authRouter);
  app.use("/api/customer-portal",profileRouter);
  app.use("/api/customer-portal",adviceRouter);
  app.use("/api/customer-portal",loansRouter);
  app.use("/api/customer-portal",intakeRouter,customerChatRouter);
  app.use("/api/chat",requireAuth,staffChatRouter);
  app.use("/api",requireAuth,staffLoanApplicationsRouter);
  app.get("/staff/private",requireAuth,(_req,res)=>res.json({staff:true}));
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>{
    const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
    if(url!==process.env.PORTAL_RELAY_URL && !["shahkarLite","personInfo","postalCodeInfo","sana"]
      .some(check=>url===process.env.SAPI_RELAY_URL+"/"+check)) {
      process.stderr.write("BLOCKED_OUTBOUND "+url+"\\\\n");
      throw new Error("unexpected_outbound_request");
    }
    return nativeFetch(input,init);
  };
  const server=app.listen(Number(process.env.PORT),"127.0.0.1",()=>console.log("PORTAL_FIXTURE_LISTENING"));
  server.on("error",error=>{console.error(error);process.exitCode=1;});
  process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
`;

const now = new Date().toISOString();
const yesterday = new Date(Date.now() - 10 * 60_000).toISOString();
let salespersonA, salespersonB, userA, userB, staffCookieA, staffCookieB, customerA, customerB, mergedSource, survivor, planId, nonpayablePlanId;

try {
  relay = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const timestamp = req.headers["x-relay-timestamp"];
    const signature = req.headers["x-relay-signature"];
    const expected = createHmac("sha256", relaySecret).update(`${timestamp}.${rawBody}`).digest("hex");
    const timeValid = /^\d+$/.test(String(timestamp)) && Math.abs(Date.now() / 1000 - Number(timestamp)) <= 60;
    if (req.method !== "POST" || !["/send", "/shahkarLite", "/personInfo", "/postalCodeInfo", "/sana"].includes(req.url) || !timeValid || signature !== expected) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false }));
      return;
    }
    const message = JSON.parse(rawBody);
    if (req.url !== "/send") {
      identityCalls.push({ path: req.url, body: message });
      const ok = !(req.url === "/shahkarLite" && message.mobile === "09120000191") &&
        !(req.url === "/personInfo" && message.nationalCode === nationalCode(100000192));
      const data = req.url === "/personInfo"
        ? { firstName: "Synthetic", lastName: "Customer", fatherName: "Synthetic Parent" }
        : req.url === "/postalCodeInfo" ? { postalCode: "9876543210" } : ok;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        success: req.url === "/shahkarLite" ? true : ok, data,
      }));
      return;
    }
    assert.equal(message.sending_type, "pattern");
    assert.equal(message.code, "7ztdnd9x3l");
    assert.deepEqual(message.recipients?.length, 1);
    assert.equal(typeof message.params?.code, "string");
    smsMessages.push({ mobile: message.recipients[0], code: message.params.code });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  const relayPort = await listen(relay);
  const relayUrl = `http://127.0.0.1:${relayPort}/send`;

  const database = new DatabaseSync(databasePath);
  database.exec(schemaSql());
  database.prepare("INSERT INTO notification_settings(key,value,updated_at) VALUES(?,?,?)")
    .run("ippanelRelayUrl", relayUrl, now);
  database.prepare("INSERT INTO notification_settings(key,value,updated_at) VALUES(?,?,?)")
    .run("ippanelEnabled", "true", now);
  database.prepare("INSERT INTO notification_settings(key,value,updated_at) VALUES(?,?,?)")
    .run("ippanelFromNumber", "+983000505", now);
  salespersonA = Number(database.prepare("INSERT INTO salespersons(name,active) VALUES('Synthetic Sales A',1)").run().lastInsertRowid);
  database.prepare("INSERT INTO allocation_programs(id,name,is_default,active) VALUES(1,'Synthetic Default',1,1)").run();
  database.prepare("INSERT INTO allocation_program_items(program_id,salesperson_id,quota) VALUES(1,?,100)").run(salespersonA);
  salespersonB = Number(database.prepare("INSERT INTO salespersons(name,active) VALUES('Synthetic Sales B',1)").run().lastInsertRowid);
  userA = Number(database.prepare("INSERT INTO users(username,full_name,role,salesperson_id,active,created_at) VALUES('fixture-sales-a','Synthetic Actor A','salesperson',?,1,?)").run(salespersonA, now).lastInsertRowid);
  database.prepare("UPDATE users SET mobile='09120000091' WHERE id=?").run(userA);
  userB = Number(database.prepare("INSERT INTO users(username,full_name,role,salesperson_id,active,created_at) VALUES('fixture-sales-b','Synthetic Actor B','salesperson',?,1,?)").run(salespersonB, now).lastInsertRowid);
  const createStaffSession = userId => {
    const token = randomBytes(24).toString("base64url");
    database.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
      .run(createHmac("sha256", secret).update(token).digest("hex"), userId,
        new Date(Date.now() + 300_000).toISOString(), now);
    return `crm_session=${token}`;
  };
  staffCookieA = createStaffSession(userA);
  staffCookieB = createStaffSession(userB);

  const addCustomer = (name, phone, salespersonId, { mergedInto = null, national = null } = {}) =>
    Number(database.prepare(`INSERT INTO customers(name,phone,national_code,birth_date_jalali,postal_code,father_name,
      verification_status,salesperson_id,merged_into_customer_id,created_at,status)
      VALUES(?,?,?,?,?,?,'verified',?,?,?,'in_progress')`)
      .run(name, phone, national, "1370/01/01", "1234567890", "Synthetic Father",
        salespersonId, mergedInto, now).lastInsertRowid);

  customerA = addCustomer("Synthetic Customer A", "09120000001", salespersonA, { national: nationalCode(100000001) });
  customerB = addCustomer("Synthetic Customer B", "09120000005", salespersonB, { national: nationalCode(100000002) });
  mergedSource = addCustomer("Synthetic Merged Source", "09120000002", salespersonA, { national: nationalCode(100000003) });
  survivor = addCustomer("Synthetic Survivor", "09120000004", salespersonB, { national: nationalCode(100000004) });
  database.prepare("UPDATE customers SET merged_into_customer_id=? WHERE id=?").run(survivor, mergedSource);
  database.prepare("INSERT INTO customer_merge_audit(source_customer_id,survivor_customer_id) VALUES(?,?)").run(mergedSource, survivor);
  database.prepare(`UPDATE customers SET shahkar_ok=1,person_info_ok=1,shahkar_status='success',person_info_status='success',
    verification_checked_at=?,first_name='Synthetic',last_name='Customer'`).run(now);
  addCustomer("Synthetic A Load 1", "09120000011", salespersonA, { national: nationalCode(100000011) });
  addCustomer("Synthetic A Load 2", "09120000012", salespersonA, { national: nationalCode(100000012) });

  const templateId = Number(database.prepare(`INSERT INTO contract_templates(name,mappings_json)
    VALUES('Synthetic Template','[{"sourceType":"loanPlan","loanPlanField":"loanPlan.principalAmount","variable":"principal"},{"sourceType":"manual","variable":"staff_contract_field","label":"اطلاعات قرارداد","required":true}]')`)
    .run().lastInsertRowid);
  planId = Number(database.prepare(`INSERT INTO loan_plans(name,active,contract_template_id,principal_amount,
    installment_terms,filing_fee_toman,required_documents) VALUES('Synthetic Portal Plan',1,?,'100000','[{"installments":12}]','1200','[]')`)
    .run(templateId).lastInsertRowid);
  database.prepare(`INSERT INTO loan_plan_conditions(id,plan_id,name,min_principal,max_principal,installment_options,customer_ranks,sort_order)
    VALUES(1,?,'Synthetic condition','0','100000','[12]','["A"]',0)`).run(planId);
  nonpayablePlanId = Number(database.prepare(`INSERT INTO loan_plans(name,active,principal_amount,installment_terms,filing_fee_toman)
    VALUES('Synthetic Active Advice-Only Plan',1,'50000','[12]','0')`).run().lastInsertRowid);
  database.prepare("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,'cash','5000',?)").run(customerA, now);
  database.prepare("INSERT INTO company_wallet_accounts(wallet_type,balance) VALUES('cash','0')").run();
  for (const [index, documentType] of ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"].entries()) {
    await writeFile(path.join(temp, `synthetic-${index}.pdf`),"%PDF-1.4\n% synthetic fixture\n%%EOF");
    database.prepare(`INSERT INTO customer_identity_documents(customer_id,document_type,storage_path,original_name,mime_type,
      size_bytes,sha256,created_by_customer_id,created_at,version,is_latest,approved_at)
      VALUES(?,?,?,?,'application/pdf',10,?,?,?,1,1,?)`)
      .run(customerA, documentType, path.join(temp, `synthetic-${index}.pdf`), `synthetic-${index}.pdf`,
        `synthetic-hash-${index}`, customerA, yesterday, yesterday);
  }
  database.prepare(`INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,requested_by_customer_id,national_code,
    status,score,score_label,created_at,updated_at,completed_at)
    VALUES(?,?,?,?,'report_generated',800,'A',?,?,?)`)
    .run(customerA, userA, customerA, nationalCode(100000001), yesterday, yesterday, yesterday);
  database.prepare(`INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,requested_by_customer_id,national_code,
    provider_reference,status,created_at,updated_at)
    VALUES(?,?,?,?,'fixture-stale-active-reference','processing',?,?)`)
    .run(customerA, userA, customerA, nationalCode(100000001), yesterday, yesterday);

  const otherApplication = Number(database.prepare(`INSERT INTO loan_applications(customer_id,requested_by_user_id,
    plan_id,plan_ids,requested_amount,status,stage,duration_months,requested_duration_months,created_at,updated_at)
    VALUES(?,?,?,'[1]','5000','reviewing','funder_initial_approval',12,12,?,?)`)
    .run(customerB, userB, planId, now, now).lastInsertRowid);
  database.close();

  await build({
    stdin: { contents: workerSource, resolveDir: apiRoot, sourcefile: "customer-portal-fixture-worker.ts" },
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` },
    plugins: [{
      name: "synthetic-customer-portal-infrastructure",
      setup(context) {
        context.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "fixture-db", namespace: "portal-fixture" }));
        context.onLoad({ filter: /^fixture-db$/, namespace: "portal-fixture" }, () => ({ contents: fixtureDbModule, loader: "js" }));
        // Intake does not propagate templates. Keep unrelated goods generation
        // and contract workers out of this isolated customer fixture.
        context.onResolve({ filter: /\/contract-template-updates$/ }, () => ({ path: "disabled-template-updates", namespace: "portal-fixture" }));
        context.onLoad({ filter: /^disabled-template-updates$/, namespace: "portal-fixture" }, () => ({
          contents: "export const propagateContractTemplateChange=()=>{throw Error('unexpected_template_propagation')};",
          loader: "js",
        }));
        context.onResolve({ filter: /\/wallets$/ }, () => ({ path: "fixture-wallets", namespace: "portal-fixture" }));
        context.onLoad({ filter: /^fixture-wallets$/, namespace: "portal-fixture" }, () => ({
          contents: `
            import {queryRow} from "./crm-db";
            export const ensureWalletSchema=()=>{};
            export const getWalletSummaryReadOnly=customerId=>({cash:{balanceToman:String(queryRow("SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'",[customerId])?.balance??"0")},credit:{balanceToman:"0"}});
            export const wallet=(customerId,type)=>{const row=queryRow("SELECT id,balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type=?",[customerId,type]);if(!row)throw Error("wallet_not_found");return row};
            export const creditLoanWallet=()=>{throw Error("unexpected wallet credit in portal fixture")};
          `,
          loader: "js",
          resolveDir: apiRoot,
        }));
        context.onResolve({ filter: /\/emzame-signature$/ }, () => ({ path: "disabled-signature", namespace: "portal-fixture" }));
        context.onLoad({ filter: /^disabled-signature$/, namespace: "portal-fixture" }, () => ({
          contents: "export const classifyProviderState=()=>{throw Error('provider_disabled')};export const isStrictSignedProviderState=()=>{throw Error('provider_disabled')};export const providerContractState=()=>{throw Error('provider_disabled')};",
          loader: "js",
        }));
        context.onResolve({ filter: /\/emzame-client$/ }, () => ({ path: "disabled-emzame", namespace: "portal-fixture" }));
        context.onLoad({ filter: /^disabled-emzame$/, namespace: "portal-fixture" }, () => ({
          contents: "export const emzameRequest=()=>{throw Error('provider_disabled')};export const emzameAuth=()=>{throw Error('provider_disabled')};",
          loader: "js",
        }));
        context.onResolve({ filter: /\/ics24$/ }, () => ({ path: "synthetic-ics24", namespace: "portal-fixture" }));
        context.onLoad({ filter: /^synthetic-ics24$/, namespace: "portal-fixture" }, () => ({
          contents: `
            export function normalizeDigits(value){return String(value??"").replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))}
            export function normalizeMobile(value){let digits=normalizeDigits(value).replace(/\\D/g,"");if(digits.startsWith("0098"))digits="0"+digits.slice(4);else if(digits.startsWith("98"))digits="0"+digits.slice(2);return /^09\\d{9}$/.test(digits)?digits:undefined}
            export function validNationalCode(value){const code=normalizeDigits(value).replace(/\\D/g,"");if(!/^\\d{10}$/.test(code)||/^(\\d)\\1{9}$/.test(code))return false;const sum=[...code.slice(0,9)].reduce((n,d,i)=>n+Number(d)*(10-i),0)%11;return Number(code[9])===(sum<2?sum:11-sum)}
            let started=0;
            export async function initiate(){started+=1;return "synthetic-ics24-reference-"+started}
            export async function status(){return {status:"Processing",statusTitle:"Synthetic pending",reportCode:null}}
            export async function report(){throw Error("synthetic_report_not_expected")}
            export async function validate(){throw Error("synthetic_validation_not_expected")}
            export async function renew(){throw Error("synthetic_renewal_not_expected")}
          `,
          loader: "js",
        }));
        context.onResolve({ filter: /integrations-openai-ai-server/ }, () => ({ path: "disabled-openai", namespace: "portal-fixture" }));
        context.onLoad({ filter: /^disabled-openai$/, namespace: "portal-fixture" }, () => ({
          contents: "export const openai={chat:{completions:{create:async()=>{throw Error('openai_provider_disabled_in_fixture')}}}};export const createConsultationClient=()=>({client:openai,model:'fixture-disabled-model'});",
          loader: "js",
        }));
      },
    }],
  });

  const apiSocket = createServer();
  const apiPort = await listen(apiSocket);
  await new Promise((resolve) => apiSocket.close(resolve));
  const env = {
    ...process.env,
    CRM_DATABASE_PATH: databasePath,
    SESSION_SECRET: secret,
    IR_RELAY_SHARED_SECRET: relaySecret,
    SAPI_RELAY_URL: `http://127.0.0.1:${relayPort}`,
    PORTAL_RELAY_URL: relayUrl,
    PORT: String(apiPort),
    NODE_ENV: "production",
    PAYMENT_CALLBACK_BASE_URL: "",
    TELEGRAM_BOT_TOKEN: "",
    AUTO_BACKUP_DIR: path.join(temp, "backups"),
  };
  child = spawn(process.execPath, ["--trace-sigint",bundle], { cwd: apiRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  const origin = `http://127.0.0.1:${apiPort}`;
  const get = (url, cookie) => fetch(origin + url, { headers: cookie ? { Cookie: cookie } : {} });
  const post = (url, data, cookie, headers = {}) => fetch(origin + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(data),
  });
  const patch = (url, data, cookie) => fetch(origin + url, {
    method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(data),
  });
  async function json(response) { return response.clone().json().catch(() => null); }
  async function clearOtpIpThrottle() {
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE customer_portal_otp_challenges SET created_at=?").run(new Date(Date.now() - 120_000).toISOString());
    db.close();
  }
  async function login(mobile, expectedStatus = 200) {
    const before = smsMessages.length;
    const requested = await post("/api/customer-portal/auth/otp/request", { mobile });
    assert.equal(requested.status, 202, `OTP request response ${JSON.stringify(await json(requested))}`);
    assert.equal(smsMessages.length, before + 1, "expected an authenticated fake SMS relay delivery");
    const sms = smsMessages.at(-1);
    await clearOtpIpThrottle();
    const verified = await post("/api/customer-portal/auth/otp/verify", { mobile, code: sms.code });
    const body = await json(verified);
    assert.equal(verified.status, expectedStatus, `OTP verify response ${JSON.stringify(body)}`);
    const token = verified.headers.get("set-cookie")?.match(/customer_portal_session=([^;]+)/)?.[1];
    return { response: verified, body, cookie: token ? `customer_portal_session=${token}` : undefined };
  }

  let ready = false;
  let healthDiagnostic = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response=await get("/healthz");
      if (response.ok) { ready = true; break; }
      healthDiagnostic=`HTTP ${response.status} ${(await response.text()).slice(0,200)}`;
    } catch(error) { healthDiagnostic=String(error); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) {
    child.kill("SIGINT");
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(ready, `isolated API worker did not start: ${healthDiagnostic}; ${logs.slice(-4000)}`);

  const known = await login("09120000001");
  assert.equal(known.body.customerId, customerA, "a unique current phone maps to its existing customer");
  assert.equal(known.body.profileComplete, true);
  assert.ok(known.cookie, "successful OTP verification creates a customer session cookie");
  const secondVerify = await post("/api/customer-portal/auth/otp/verify", { mobile: "09120000001", code: smsMessages[0].code });
  assert.equal(secondVerify.status, 401, "OTP challenge is single-use");
  assert.equal((await get("/staff/private", known.cookie)).status, 401, "customer portal session cannot authenticate to staff API");
  assert.equal((await get("/api/customer-portal/applications/" + otherApplication, known.cookie)).status, 404,
    "customer portal application routes are scoped to the authenticated customer");

  const uniqueChargeKey = `fixture-charge-${randomBytes(5).toString("hex")}`;
  const firstCharge = await post("/api/customer-portal/filing-fee", { planId,conditionId:1,requestedAmount:"5000",durationMonths:12 }, known.cookie, { "Idempotency-Key": uniqueChargeKey });
  assert.equal(firstCharge.status, 201, `initial filing fee charge: ${JSON.stringify(await json(firstCharge))}`);
  const chargeBody = await json(firstCharge);
  assert.equal(chargeBody.amountToman, "1200");
  const secondCharge = await post("/api/customer-portal/filing-fee", { planId,conditionId:1,requestedAmount:"5000",durationMonths:12 }, known.cookie, {
    "Idempotency-Key": `fixture-retry-${randomBytes(5).toString("hex")}`,
  });
  assert.equal(secondCharge.status, 200, "a second idempotency key reuses the existing charge");
  assert.equal((await json(secondCharge)).chargeId, chargeBody.chargeId);
  const intakeState=await get(`/api/customer-portal/intake/status?planId=${planId}`,known.cookie);
  assert.equal(intakeState.status,200);
  const readyState=await json(intakeState);
  assert.equal(readyState.feeChargeId,chargeBody.chargeId);
  assert.equal(readyState.documentsPreviouslyApproved,true);
  assert.deepEqual(readyState.requiredDocumentTypes,[]);
  assert.equal(readyState.canSubmit,true);

  const humanSend=await post("/api/customer-portal/chat/messages",{clientId:"fixture-human-message",text:"سلام 👋"},known.cookie);
  assert.equal(humanSend.status,201,`human chat send: ${JSON.stringify(await json(humanSend))}`);
  const human=await json(humanSend);
  const replay=await post("/api/customer-portal/chat/messages",{clientId:"fixture-human-message",text:"سلام 👋"},known.cookie);
  assert.equal((await json(replay)).id,human.id,"a retry persists only one human message");
  assert.equal((await post("/api/customer-portal/chat/messages",{clientId:"fixture-human-message",text:"changed"},known.cookie)).status,409,
    "the same idempotency key cannot overwrite an existing message");
  assert.equal((await get(`/api/chat/${customerA}/messages`,staffCookieB)).status,404,"other salespeople cannot read this chat");
  assert.equal((await json(await get("/api/chat/unread-count",staffCookieA))).count,1);
  const reply=await post(`/api/chat/${customerA}/messages`,{clientId:"fixture-human-reply",text:"پاسخ کارشناس"},staffCookieA);
  assert.equal(reply.status,201);
  const replyBody=await json(reply);
  const history=await json(await get("/api/customer-portal/chat/messages",known.cookie));
  assert.equal(history.items.length,2);
  assert.equal(history.items[1].senderType,"staff");
  assert.equal((await post("/api/customer-portal/chat/read",{lastMessageId:replyBody.id},known.cookie)).status,200);
  await post("/api/customer-portal/chat/read",{lastMessageId:human.id},known.cookie);
  assert.equal((await json(await get("/api/customer-portal/chat/messages",known.cookie))).lastReadId,replyBody.id,
    "an older read marker never makes newer messages unread again");

  const applicationResponse = await post("/api/customer-portal/applications", {
    planId, conditionId: 1, requestedAmount: "5000", durationMonths: 12, feeChargeId: chargeBody.chargeId,
  }, known.cookie);
  assert.equal(applicationResponse.status, 201, `portal application create: ${JSON.stringify(await json(applicationResponse))}`);
  const createdApplication = await json(applicationResponse);
  assert.equal(createdApplication.editable,false,"submitted portal cases are read-only");
  assert.equal(createdApplication.stage,"draft","contract preparation is handed to the salesperson");
  assert.deepEqual(createdApplication.salesExpert,{name:"Synthetic Sales A",mobile:"09120000091"});
  const repeatApplication = await post("/api/customer-portal/applications", {
    planId, conditionId: 1, requestedAmount: "5000", durationMonths: 12, feeChargeId: chargeBody.chargeId,
  }, known.cookie);
  assert.equal(repeatApplication.status,200);
  assert.equal((await json(repeatApplication)).id,createdApplication.id,"reloads reuse the submitted case");
  assert.equal((await post("/api/customer-portal/applications", {
    planId, conditionId: 1, requestedAmount: "5000", durationMonths: 12, feeChargeId: chargeBody.chargeId,
    manualValues:{staff_contract_field:"customer must not prepare the contract"},
  }, known.cookie)).status,400,"contract fields are staff-owned, not customer input");
  assert.equal((await patch(`/api/customer-portal/applications/${createdApplication.id}`,{requestedAmount:"6000"},known.cookie)).status,409);
  const dbAfterApplication = new DatabaseSync(databasePath);
  assert.equal(dbAfterApplication.prepare("SELECT primary_manual_values_json FROM loan_applications WHERE id=?")
    .get(createdApplication.id).primary_manual_values_json,"{}","required contract fields do not block portal submission");
  const stageActorRow = dbAfterApplication.prepare(`SELECT actor_id,actor_customer_id,action FROM loan_application_stage_history
    WHERE application_id=? AND action='customer_portal_created'`).get(createdApplication.id);
  const stageActor = stageActorRow && { ...stageActorRow };
  assert.deepEqual(stageActor, { actor_id: null, actor_customer_id: customerA, action: "customer_portal_created" },
    "customer-created stage history records customer provenance without a staff actor");
  dbAfterApplication.prepare("UPDATE loan_applications SET salesperson_id_snapshot=?,salesperson_name_snapshot='Historical Other Seller' WHERE id=?")
    .run(salespersonB, createdApplication.id);
  assert.equal(dbAfterApplication.prepare("SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'").get(customerA).balance, "3800",
    "fee retry with a different key debits the wallet once");
  assert.equal(dbAfterApplication.prepare("SELECT COUNT(*) AS n FROM wallet_ledger_v2 WHERE kind='filing_fee_out'").get().n, 1);
  assert.equal(dbAfterApplication.prepare("SELECT COUNT(*) AS n FROM company_wallet_ledger WHERE kind='filing_fee'").get().n, 1);
  dbAfterApplication.close();

  const staffPatchUrl = `/api/loan-applications/${createdApplication.id}`;
  const historicalOwnerPatch = await patch(staffPatchUrl, { requestedAmount: "6000" }, staffCookieB);
  assert.equal(historicalOwnerPatch.status, 404,
    `a salesperson who matches only the historical snapshot cannot edit another salesperson's currently assigned customer: ${JSON.stringify(await json(historicalOwnerPatch))}`);
  const currentOwnerPatch = await patch(staffPatchUrl, { requestedAmount: "6000",manualValues:{staff_contract_field:"Synthetic staff contract details"} }, staffCookieA);
  assert.equal(currentOwnerPatch.status, 200,
    `the currently assigned salesperson may edit despite a different historical snapshot: ${JSON.stringify(await json(currentOwnerPatch))}`);
  assert.equal((await json(currentOwnerPatch)).requested_amount, "6000");
  const contactAfterSnapshotChange = await json(await get(`/api/customer-portal/applications/${createdApplication.id}`,known.cookie));
  assert.deepEqual(contactAfterSnapshotChange.salesExpert,{name:"Synthetic Sales A",mobile:"09120000091"},
    "expert contact follows current ownership, never historical attribution");
  const retainedAttribution = new DatabaseSync(databasePath);
  const retainedSnapshot = retainedAttribution.prepare("SELECT salesperson_id_snapshot,salesperson_name_snapshot FROM loan_applications WHERE id=?")
    .get(createdApplication.id);
  assert.equal(retainedSnapshot.salesperson_id_snapshot, salespersonB);
  assert.equal(retainedSnapshot.salesperson_name_snapshot, "Historical Other Seller",
    "editing terms preserves the historical salesperson attribution snapshot");
  retainedAttribution.close();

  const staleGateDb = new DatabaseSync(databasePath);
  const staleFeeChargeId = Number(staleGateDb.prepare(`INSERT INTO loan_filing_fee_charges
    (customer_id,plan_id,amount_toman,idempotency_key,actor_customer_id,created_at)
    VALUES(?,?,'1200','fixture-stale-gate-charge',?,?)`)
    .run(customerA, planId, customerA, now).lastInsertRowid);
  staleGateDb.close();

  const mergedLogin = await login("09120000002", 409);
  assert.equal(mergedLogin.cookie, undefined, "a historical merged phone cannot create a session for a survivor with another current phone");

  const unknownMobile = "09120000006";
  const unknown = await login(unknownMobile);
  assert.equal(unknown.body.customerId, null, "an unknown verified mobile starts without a customer binding");
  assert.ok(unknown.cookie);
  assert.equal(unknown.body.identityReady, false);
  const restrictedMe = await json(await get("/api/customer-portal/me", unknown.cookie));
  assert.equal(restrictedMe.identityReady, false);
  assert.equal(restrictedMe.customer, null, "pending identity never discloses customer personal data");
  assert.equal((await get("/api/customer-portal/wallet", unknown.cookie)).status, 403);
  assert.equal((await patch("/api/customer-portal/profile", { nationalCode: nationalCode(100000006) }, unknown.cookie)).status, 403);
  const beforeBasicCalls = identityCalls.length;
  const profile = await post("/api/customer-portal/identity", {
    nationalCode: nationalCode(100000006), birthDate: "1372/02/03",
  }, unknown.cookie);
  assert.equal(profile.status, 200, `provider-owned registration: ${JSON.stringify(await json(profile))}`);
  assert.deepEqual(identityCalls.slice(beforeBasicCalls).map(call => call.path).sort(), ["/personInfo", "/shahkarLite"]);
  const profileBody = await json(await get("/api/customer-portal/me", unknown.cookie));
  assert.equal(profileBody.identityReady, true);
  assert.equal(profileBody.verificationStatus, "unverified", "basic login never fabricates postal/Sana loan eligibility");
  assert.equal(profileBody.customer.name, "Synthetic Customer");
  assert.equal(profileBody.customer.firstName, "Synthetic");
  assert.equal(profileBody.customer.lastName, "Customer");
  assert.equal(profileBody.customer.fatherName, "Synthetic Parent");
  assert.equal(profileBody.customer.birthDate, "1372/02/03");
  assert.equal(profileBody.customer.nationalCode, nationalCode(100000006));
  assert.equal((await get("/api/customer-portal/wallet", unknown.cookie)).status, 200);
  const sameMobileLogin = await login(unknownMobile);
  assert.equal(sameMobileLogin.body.identityReady, true, "returning basic-verified customers skip onboarding without postal/Sana");
  const allocationDb = new DatabaseSync(databasePath);
  const assigned = allocationDb.prepare("SELECT salesperson_id,phone FROM customers WHERE id=?").get(profileBody.customer.id);
  assert.equal(assigned.salesperson_id, salespersonA, "new portal customers follow the configured default allocation program, not least-loaded fallback");
  assert.equal(allocationDb.prepare("SELECT customer_id FROM customer_portal_registrations WHERE customer_id=?").get(profileBody.customer.id).customer_id,profileBody.customer.id,
    "new portal-origin provenance is retained");
  assert.equal(assigned.phone, unknownMobile);
  assert.equal(allocationDb.prepare("SELECT customer_id FROM customer_portal_sessions WHERE mobile=?").get("+989120000006").customer_id, profileBody.customer.id,
    "profile creation binds the current customer session");
  allocationDb.close();

  const changedProfile = await patch("/api/customer-portal/profile", {
    name: "Synthetic Customer A Changed", fatherName: "Synthetic Father",
    nationalCode: nationalCode(100000101), birthDate: "1370/01/01", postalCode: "1234567890",
  }, known.cookie);
  assert.equal(changedProfile.status, 200, `identity change: ${JSON.stringify(await json(changedProfile))}`);
  const afterIdentityChange = new DatabaseSync(databasePath);
  const identityChangedAt = afterIdentityChange.prepare("SELECT identity_changed_at FROM customers WHERE id=?").get(customerA).identity_changed_at;
  afterIdentityChange.prepare(`UPDATE customers SET verification_status='verified',shahkar_ok=1,person_info_ok=1,
    shahkar_status='success',person_info_status='success',verification_checked_at=identity_changed_at WHERE id=?`).run(customerA);
  const staleChecksBefore = afterIdentityChange.prepare(`SELECT id,status FROM customer_credit_checks
    WHERE customer_id=? ORDER BY id`).all(customerA).map(row => ({ ...row }));
  afterIdentityChange.close();
  assert.equal(staleChecksBefore.length, 2, "completed and active pre-change credit-check rows remain in storage");

  const hiddenOldChecks = await get("/api/customer-portal/credit-checks", known.cookie);
  assert.equal(hiddenOldChecks.status, 200);
  assert.deepEqual((await json(hiddenOldChecks)).checks, [],
    "credit history hides both completed and active checks from before the identity-change marker");

  const postChangeCredit = await post("/api/customer-portal/credit-checks", {}, known.cookie);
  assert.equal(postChangeCredit.status, 201,
    `a stale active row must neither be reused nor rate-limit a new check: ${JSON.stringify(await json(postChangeCredit))}`);
  const postChangeCreditBody = await json(postChangeCredit);
  assert.equal(postChangeCreditBody.status, "awaiting_otp");
  const visibleNewCheck = await get("/api/customer-portal/credit-checks", known.cookie);
  assert.equal(visibleNewCheck.status, 200);
  const visibleChecks = (await json(visibleNewCheck)).checks;
  assert.equal(visibleChecks.length, 1, "the check created after the marker remains visible");
  assert.equal(visibleChecks[0].id, postChangeCreditBody.id);
  const persistedCreditRows = new DatabaseSync(databasePath);
  assert.equal(persistedCreditRows.prepare("SELECT COUNT(*) AS n FROM customer_credit_checks WHERE customer_id=?").get(customerA).n, 3,
    "starting a post-marker check does not delete historical rows");
  assert.equal(persistedCreditRows.prepare("SELECT COUNT(*) AS n FROM customer_credit_checks WHERE id IN (?,?)").get(
    staleChecksBefore[0].id, staleChecksBefore[1].id).n, 2);
  assert.equal(persistedCreditRows.prepare("SELECT created_at>? AS after_marker FROM customer_credit_checks WHERE id=?")
    .get(identityChangedAt, postChangeCreditBody.id).after_marker, 1);
  persistedCreditRows.close();

  const staleCreditApplication = await post("/api/customer-portal/applications", {
    planId, conditionId: 1, requestedAmount: "5000", durationMonths: 12, feeChargeId: staleFeeChargeId,
  }, known.cookie);
  assert.equal(staleCreditApplication.status, 422);
  assert.equal((await json(staleCreditApplication)).error, "credit_check_stale",
    "a successful credit check from before identity change is not reusable");
  const freshCredit = new DatabaseSync(databasePath);
  const freshCreditAt = new Date(Date.now() + 1000).toISOString();
  freshCredit.prepare(`INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,requested_by_customer_id,national_code,
    status,score,score_label,created_at,updated_at,completed_at) VALUES(?,?,?,?,'report_generated',800,'A',?,?,?)`)
    .run(customerA, userA, customerA, nationalCode(100000101), freshCreditAt, freshCreditAt, freshCreditAt);
  freshCredit.close();
  const staleDocsApplication = await post("/api/customer-portal/applications", {
    planId, conditionId: 1, requestedAmount: "5000", durationMonths: 12, feeChargeId: staleFeeChargeId,
  }, known.cookie);
  assert.equal(staleDocsApplication.status, 422);
  assert.equal((await json(staleDocsApplication)).error, "identity_documents_missing",
    "approved identity documents from before identity change are not reusable");

  const sapiCustomer = await login("09120000005");
  assert.equal(sapiCustomer.body.customerId, customerB);
  const sapiHistoryDb = new DatabaseSync(databasePath);
  sapiHistoryDb.prepare(`INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,requested_by_customer_id,national_code,
    status,score,score_label,created_at,updated_at,completed_at)
    VALUES(?,?,?,?,'report_generated',700,'B',?,?,?)`)
    .run(customerB, userB, customerB, nationalCode(100000002), yesterday, yesterday, yesterday);
  sapiHistoryDb.prepare(`INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,requested_by_customer_id,national_code,
    provider_reference,status,created_at,updated_at)
    VALUES(?,?,?,?,'fixture-sapi-stale-active-reference','processing',?,?)`)
    .run(customerB, userB, customerB, nationalCode(100000002), yesterday, yesterday);
  sapiHistoryDb.prepare("INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,actor_customer_id,created_at) VALUES(?,?,'250','fixture-sapi-fee',?,?)").run(customerB,planId,customerB,yesterday);
  sapiHistoryDb.close();
  const verifiedBySapi = await post("/api/customer-portal/verify", {}, sapiCustomer.cookie);
  assert.equal(verifiedBySapi.status, 200, `synthetic SAPI verification: ${JSON.stringify(await json(verifiedBySapi))}`);
  assert.equal((await json(verifiedBySapi)).status, "verified");
  const normalizedIntake=await json(await get(`/api/customer-portal/intake/status?planId=${planId}`,sapiCustomer.cookie));
  assert.equal(normalizedIntake.verification.inquiryAttempted,true,"official normalization retains the attempted inquiry claim");
  assert.ok(normalizedIntake.requiredDocumentTypes.includes("birth_certificate_first_page"),"required document names match the public upload DTO");
  assert.equal(normalizedIntake.canSubmit,false,"identity-changing inquiries require renewed credit and current documents");
  const afterSapi = new DatabaseSync(databasePath);
  const sapiMarker = afterSapi.prepare("SELECT identity_changed_at,postal_code FROM customers WHERE id=?").get(customerB);
  assert.equal(sapiMarker.postal_code, "9876543210");
  assert.ok(sapiMarker.identity_changed_at, "SAPI canonical identity changes stamp an identity marker");
  const checksAfterSapi = await get("/api/customer-portal/credit-checks", sapiCustomer.cookie);
  assert.deepEqual((await json(checksAfterSapi)).checks, [],
    "an identity-changing SAPI verification also hides credit checks completed before its new marker");
  assert.equal(afterSapi.prepare("SELECT COUNT(*) AS n FROM customer_credit_checks WHERE customer_id=?").get(customerB).n, 2,
    "credit rows remain historical after SAPI identity verification");
  afterSapi.close();

  const adviceSeed = new DatabaseSync(databasePath);
  const adviceNow = new Date().toISOString();
  const conversationId = Number(adviceSeed.prepare(`INSERT INTO customer_portal_conversations(customer_id,title,created_at,updated_at)
    VALUES(?,'Synthetic saved AI advice',?,?)`).run(customerA, adviceNow, adviceNow).lastInsertRowid);
  adviceSeed.prepare(`INSERT INTO customer_portal_messages(conversation_id,role,content,suggested_plan_id,created_at)
    VALUES(?,'assistant',?,?,?)`)
    .run(conversationId, `This is not currently application-ready: [PLAN_ID:${nonpayablePlanId}]`, nonpayablePlanId, adviceNow);
  adviceSeed.prepare(`INSERT INTO customer_portal_messages(conversation_id,role,content,suggested_plan_id,created_at)
    VALUES(?,'assistant',?,?,?)`)
    .run(conversationId, `This plan is available: [PLAN_ID:${planId}]`, planId, adviceNow);
  adviceSeed.close();

  const savedAdvice = await get(`/api/customer-portal/consultations/${conversationId}/messages`, known.cookie);
  assert.equal(savedAdvice.status, 200, `saved AI advice read flow: ${JSON.stringify(await json(savedAdvice))}`);
  const savedMessages = (await json(savedAdvice)).messages;
  assert.equal(savedMessages.length, 2);
  const unavailableAdvice = savedMessages.find(message => message.content.includes("not currently application-ready"));
  assert.ok(unavailableAdvice);
  assert.deepEqual(unavailableAdvice.recommendedPlans, [],
    "a saved AI marker for an active but non-payable plan creates no recommendation");
  const payableAdvice = savedMessages.find(message => message.content.includes("This plan is available"));
  assert.deepEqual(payableAdvice.recommendedPlans, [{
    id: planId, name: "Synthetic Portal Plan", applicationUrl: `/customer/apply?planId=${planId}`,
  }], "a saved marker for a payable plan yields its application URL");
  const loanOptions = await get("/api/customer-portal/loan-options", known.cookie);
  assert.equal(loanOptions.status, 200);
  const options = (await json(loanOptions)).plans;
  assert.ok(options.some(plan => plan.planId === planId), "the payable plan is present in loan options");
  assert.ok(!options.some(plan => plan.planId === nonpayablePlanId), "the active non-payable plan is excluded from loan options");

  for (const [mobile, national] of [["09120000191", nationalCode(100000191)], ["09120000192", nationalCode(100000192)]]) {
    const pending = await login(mobile);
    const denied = await post("/api/customer-portal/identity", { nationalCode: national, birthDate: "1370/01/01" }, pending.cookie);
    assert.equal(denied.status, 422);
    assert.equal((await json(denied)).identityReady, false);
    assert.equal((await get("/api/customer-portal/wallet", pending.cookie)).status, 403);
    const me = await json(await get("/api/customer-portal/me", pending.cookie));
    assert.equal(me.customer, null, "an unmatched identity exposes no private profile");
    const auditDb = new DatabaseSync(databasePath);
    const row = auditDb.prepare("SELECT name,national_code,shahkar_ok,person_info_ok FROM customers WHERE id=?").get((await json(denied)).customerId);
    assert.equal(row.national_code, null, "failed ownership must not bind another person's identity to an OTP-controlled phone");
    assert.equal(row.name, "در انتظار احراز هویت");
    if (mobile.endsWith("191")) assert.equal(row.shahkar_ok, 0, "definitive ownership mismatch is saved as false");
    else assert.equal(row.person_info_ok, null, "uncompleted person inquiry is not a verified or definitive negative fact");
    const repeat = await post("/api/customer-portal/identity", { nationalCode: national, birthDate: "1370/01/01" }, pending.cookie);
    assert.equal(repeat.status, 429, "provider-cost guard applies before another external request");
    auditDb.close();
  }
  const aliasDb = new DatabaseSync(databasePath);
  aliasDb.prepare("UPDATE customers SET phone=? WHERE id=?").run("09120000004", mergedSource);
  aliasDb.close();
  const currentAlias = await login("09120000004");
  assert.equal(currentAlias.body.customerId, survivor, "multiple historical rows sharing the current phone still resolve to one canonical customer");

  const smsBeforeProxy = smsMessages.length;
  for (const [mobile, ip] of [["09120000180", "198.51.100.180"], ["09120000181", "198.51.100.181"], ["09120000182", "198.51.100.181"]]) {
    await fetch(origin + "/api/customer-portal/auth/otp/request", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": ip }, body: JSON.stringify({ mobile }),
    });
  }
  assert.equal(smsMessages.length, smsBeforeProxy + 2, "trusted proxy clients have separate IP quotas; one client's quota still applies");

  const manualDb = new DatabaseSync(databasePath);
  manualDb.prepare("UPDATE customers SET shahkar_status='manual_verified',person_info_status='manual_verified' WHERE id=?").run(customerB);
  const manualReady = await login("09120000005");
  assert.equal(manualReady.body.identityReady, true, "an approved manual identity review remains authoritative in the customer portal");
  manualDb.prepare("UPDATE customers SET first_name=NULL,official_first_name=NULL WHERE id=?").run(customerB);
  const incompleteManual = await json(await get("/api/customer-portal/me", manualReady.cookie));
  assert.equal(incompleteManual.identityReady, false, "manual checks do not waive required identity fields");
  const callsBeforeManual = identityCalls.length;
  const manualRetry = await post("/api/customer-portal/identity", {
    nationalCode: nationalCode(100000002), birthDate: "1370/01/01",
  }, manualReady.cookie);
  assert.equal(manualRetry.status, 409, "incomplete manually approved identity is referred to support");
  assert.equal(identityCalls.length, callsBeforeManual, "manual approvals are never silently requeried");
  manualDb.prepare("UPDATE customers SET first_name='Synthetic',official_first_name='Synthetic' WHERE id=?").run(customerB);
  assert.equal((await json(await get("/api/customer-portal/me", manualReady.cookie))).identityReady, true);
  manualDb.close();

  const finalDb = new DatabaseSync(databasePath);
  const fkViolations = finalDb.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(fkViolations, [], "synthetic portal flow leaves no foreign-key violations");
  assert.equal(finalDb.prepare("SELECT COUNT(*) AS n FROM customer_portal_sessions WHERE customer_id=?").get(profileBody.customer.id).n, 2);
  finalDb.close();
  assert.ok(smsMessages.every(item => /^\+989\d{9}$/.test(item.mobile)));
  assert.doesNotMatch(logs, /BLOCKED_OUTBOUND/, "provider/payment calls other than the local fake SMS relay are blocked");
  console.log("Customer portal fixture passed: isolated OTP/session, identity/merge guards, default-program allocation and origin tag, access isolation, credit freshness, SAPI identity markers, fixed-fee retry safety, approved-file reuse, read-only submitted cases, human chat persistence/idempotency/read markers and salesperson isolation.");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (relay?.listening) await new Promise(resolve => relay.close(resolve));
  await rm(temp, { recursive: true, force: true });
}