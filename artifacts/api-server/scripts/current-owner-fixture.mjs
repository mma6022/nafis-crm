import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// No production database or uploads are opened: the route bundle receives only
// this temporary, deliberately small SQLite database and synthetic identities.
const temp = await mkdtemp(path.join(os.tmpdir(), "current-owner-"));
const dbPath = path.join(temp, "fixture.sqlite");
const bundle = path.join(temp, "routes.mjs");
process.env.CONTRACTS_STORAGE_DIR = path.join(temp, "contracts");
const dbModule = `
  import { DatabaseSync } from "node:sqlite";
  export const databasePath = ${JSON.stringify(dbPath)};
  export const crmDb = new DatabaseSync(databasePath);
  crmDb.function("crm_customer_mobile_key", value => {
    let digits=String(value??"").replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\\D/g,"");
    if(digits.startsWith("0098")&&digits.length===14)digits="0"+digits.slice(4);
    else if(digits.startsWith("98")&&digits.length===12)digits="0"+digits.slice(2);
    else if(digits.length===10&&digits.startsWith("9"))digits="0"+digits;
    return digits;
  });
  export const queryRow = (sql, params=[]) => crmDb.prepare(sql).get(...params);
  export const queryRows = (sql, params=[]) => crmDb.prepare(sql).all(...params);
  export const execute = (sql, params=[]) => Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
  export const executeChanges = (sql, params=[]) => crmDb.prepare(sql).run(...params).changes;
  export const runTransaction = (fn) => {
    if (globalThis.__fixtureRaceMobile) {
      const race=globalThis.__fixtureRaceMobile;
      globalThis.__fixtureRaceMobile=null;
      crmDb.prepare("INSERT INTO customers(id,name,phone,created_at,salesperson_id,status) VALUES(?,?,?,?,?,'in_progress')")
        .run(race.id,race.name,race.phone,new Date().toISOString(),race.salespersonId);
      throw new Error("ACTIVE_CUSTOMER_MOBILE_CONFLICT");
    }
    crmDb.exec("BEGIN"); try { const result=fn(); crmDb.exec("COMMIT"); return result; } catch(error) { crmDb.exec("ROLLBACK"); throw error; }
  };
`;
let db, server;
try {
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT);
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,description TEXT,national_code TEXT,
      credit_score REAL,credit_rank TEXT,credit_checked_at TEXT,birth_date_jalali TEXT,postal_code TEXT,
      father_name TEXT,address TEXT,email TEXT,first_name TEXT,last_name TEXT,verification_status TEXT,
      verification_checked_at TEXT,shahkar_status TEXT,person_info_status TEXT,postal_code_info_status TEXT,
      sana_status TEXT,shahkar_ok INTEGER,person_info_ok INTEGER,postal_code_info_ok INTEGER,sana_ok INTEGER,
      official_first_name TEXT,official_last_name TEXT,official_father_name TEXT,official_address TEXT,
      official_postal_code TEXT,is_urgent INTEGER,created_at TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER,
      priority INTEGER,status TEXT);
    CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,created_at TEXT);
    CREATE TABLE customer_tag_catalog(tag TEXT PRIMARY KEY,label_fa TEXT NOT NULL,canonical_label TEXT UNIQUE);
    INSERT INTO customer_tag_catalog VALUES('repeat_request','درخواست چند باره','درخواست چند باره');
    CREATE TABLE customer_tags(customer_id INTEGER,tag TEXT,created_at TEXT,PRIMARY KEY(customer_id,tag));
    CREATE TABLE customer_repeat_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,requested_name TEXT,
      submitted_description TEXT,explanation TEXT,status TEXT,created_by_user_id INTEGER,created_at TEXT,acknowledged_at TEXT);
    CREATE TABLE customer_merge_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,survivor_customer_id INTEGER,
      source_customer_id INTEGER,actor_user_id INTEGER,assigned_salesperson_id INTEGER,created_at TEXT,details_json TEXT);
    CREATE TABLE consultation_forms(id INTEGER PRIMARY KEY,customer_id INTEGER);
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,customer_id INTEGER,consultation_id INTEGER,plan_id INTEGER,plan_ids TEXT,
      salesperson_id_snapshot INTEGER,salesperson_name_snapshot TEXT,requested_amount TEXT,condition_snapshot_json TEXT,
      is_pre_registration INTEGER,stage TEXT,status TEXT,deleted_at TEXT,created_at TEXT);
    CREATE TABLE loan_application_documents(id INTEGER PRIMARY KEY,application_id INTEGER,source TEXT,requirement_key TEXT);
    CREATE TABLE loan_application_stage_history(id INTEGER PRIMARY KEY,application_id INTEGER);
    CREATE TABLE loan_physical_checks(id INTEGER PRIMARY KEY,application_id INTEGER);
    CREATE TABLE loan_funder_defects(id INTEGER PRIMARY KEY,application_id INTEGER);
    CREATE TABLE customer_identity_documents(id INTEGER PRIMARY KEY,customer_id INTEGER,is_latest INTEGER,document_type TEXT,
      storage_path TEXT,original_name TEXT,mime_type TEXT,size_bytes INTEGER,approved_at TEXT,approved_by_user_id INTEGER,review_reason TEXT,created_at TEXT);
    CREATE TABLE loan_application_guarantors(id INTEGER PRIMARY KEY,application_id INTEGER);
    CREATE TABLE loan_application_collateral(id INTEGER PRIMARY KEY,application_id INTEGER);
    CREATE TABLE loan_application_generated_documents(id INTEGER PRIMARY KEY,application_id INTEGER,contract_generation_id INTEGER);
    CREATE TABLE contract_templates(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE contract_generations(id INTEGER PRIMARY KEY,template_id INTEGER,customer_id INTEGER,loan_plan_id INTEGER,
      status TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,manual_values_json TEXT,error_message TEXT,
      send_claim_id TEXT,send_claim_expires_at TEXT,pdf_path TEXT,contract_number TEXT,
      provider_file_id TEXT,provider_contract_id TEXT,provider_status TEXT);
    CREATE TABLE schema_migrations(version TEXT PRIMARY KEY);
    INSERT INTO schema_migrations VALUES('goods-plan-allocation-v1');
    INSERT INTO schema_migrations VALUES('wallets-two-wallets-v1');
    CREATE TABLE wallet_accounts_v2(id INTEGER PRIMARY KEY,customer_id INTEGER,wallet_type TEXT,balance TEXT);
    CREATE TABLE wallet_ledger_v2(id INTEGER PRIMARY KEY,wallet_id INTEGER,application_id INTEGER,amount TEXT,kind TEXT,
      actor_user_id INTEGER,created_at TEXT);
    CREATE TABLE reminders(id INTEGER PRIMARY KEY,user_id INTEGER,salesperson_id INTEGER,customer_id INTEGER,
      subject TEXT,message TEXT,remind_at TEXT,notified_at TEXT,sent_sms INTEGER,done INTEGER,created_at TEXT);
    INSERT INTO users VALUES(1,'old','Old'),(2,'new','New'),(3,'admin','Admin'),(4,'registrar','Registrar');
    INSERT INTO salespersons VALUES(11,'Old owner'),(22,'New owner');
    INSERT INTO customers(id,name,phone,national_code,birth_date_jalali,created_at,salesperson_id,status)
      VALUES(101,'Source','09120000001',NULL,'1370/01/02','2026-01-01',11,'in_progress'),
        (102,'Survivor','09120000002',NULL,'1370/01/02','2026-01-01',11,'in_progress');
    INSERT INTO loan_plans VALUES(1,'Fixture plan');
    INSERT INTO loan_applications VALUES(201,101,1,1,'[1]',11,'Old owner','9000','{}',0,'completed','approved',NULL,'2026-01-01');
    INSERT INTO contract_templates VALUES(1,'Fixture contract');
    INSERT INTO contract_generations(id,template_id,customer_id,loan_plan_id,status,created_at,updated_at,manual_values_json)
      VALUES(501,1,101,1,'generated','2026-01-01','2026-01-01','{}');
    INSERT INTO wallet_accounts_v2 VALUES(401,101,'credit','1000');
    INSERT INTO wallet_ledger_v2 VALUES(402,401,201,'1000','loan_credit:actor:1',1,'2026-01-01');
    INSERT INTO reminders VALUES(601,1,11,101,'Synthetic reminder','Synthetic', '2026-01-01',NULL,0,0,'2026-01-01');
  `);
  await build({
    stdin: {
      contents: `
        import express from "express";
        import { permissionsForRole } from "./src/lib/access-control";
        import loans from "./src/routes/loan-applications";
        import goods from "./src/routes/goods-purchases";
        import payments from "./src/routes/payment-orders";
        import contracts from "./src/routes/contracts";
        import wallets from "./src/routes/wallet-management";
        import crm from "./src/routes/crm";
        export const app=express();
        const actors={admin:{id:3,role:"admin",customerScope:"all",salespersonId:null},
          old:{id:1,role:"salesperson",customerScope:"assigned",salespersonId:11},
          next:{id:2,role:"salesperson",customerScope:"assigned",salespersonId:22},
          registrar:{id:4,role:"registrar",customerScope:"all",salespersonId:null}};
        app.use(express.json(),(req,res,next)=>{
          const actor=actors[req.header("X-Fixture-Role")];
          if(!actor)return res.status(401).json({error:"unauthorized"});
          res.locals.authUser={...actor,permissions:permissionsForRole(actor.role)};
          next();
        });
        app.use("/api",loans,goods,payments,contracts,wallets,crm);
      `,
      resolveDir: process.cwd(), sourcefile: "current-owner-fixture.ts",
    },
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(process.cwd(), "package.json")).href)});` },
    plugins: [{
      name: "isolated-database-and-offline-providers",
      setup(context) {
        context.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
        context.onLoad({ filter: /^db$/, namespace: "fixture" }, () => ({ contents: dbModule, loader: "js" }));
        context.onResolve({ filter: /\/logger$/ }, () => ({ path: "logger", namespace: "fixture" }));
        context.onLoad({ filter: /^logger$/, namespace: "fixture" }, () => ({
          contents: "export const logger={info(){},warn(){},error(){},debug(){},child(){return this}};",
          loader: "js",
        }));
        context.onResolve({ filter: /\/auth$/ }, () => ({ path: "auth", namespace: "fixture" }));
        context.onLoad({ filter: /^auth$/, namespace: "fixture" }, () => ({
          contents: "export const requireAuth=(req,res,next)=>next(); export const requireAdmin=(req,res,next)=>res.locals.authUser?.role==='admin'?next():res.status(403).json({error:'Forbidden'}); export const hashPassword=()=>{throw Error('unused')}; export const revokeUserSessions=()=>{throw Error('unused')};",
          loader: "js",
        }));
        context.onResolve({ filter: /\/(emzame-signature|emzame-client)$/ }, () => ({ path: "provider", namespace: "fixture" }));
        context.onLoad({ filter: /^provider$/, namespace: "fixture" }, () => ({
          contents: "export const providerContractState=()=>{throw Error('offline')}; export const emzameRequest=()=>{throw Error('offline')}; export const emzameAuth=()=>{throw Error('offline')};",
          loader: "js",
        }));
      },
    }],
  });
  const fixture = await import(pathToFileURL(bundle).href);
  server = fixture.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function get(role, route, status = 200) {
    const response = await fetch(base + route, { headers: { "X-Fixture-Role": role } });
    const value = await response.json().catch(() => null);
    assert.equal(response.status, status, `${role} ${route}: ${JSON.stringify(value)}`);
    return value;
  }
  async function mutate(role, method, route, body, status) {
    const response = await fetch(base + route, {
      method, headers: { "X-Fixture-Role": role, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status, `${role} ${method} ${route}: ${await response.text()}`);
  }
  async function mutateJson(role, method, route, body, status) {
    const response = await fetch(base + route, {
      method, headers: { "X-Fixture-Role": role, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => null);
    assert.equal(response.status, status, `${role} ${method} ${route}: ${JSON.stringify(value)}`);
    return value;
  }
  const named = async (route, pick, oldAccess = true) => {
    const admin = pick(await get("admin", route));
    assert.equal(admin, "New owner", `admin: ${route}`);
    assert.equal(pick(await get("next", route)), "New owner", `new owner: ${route}`);
    if (oldAccess) assert.equal(pick(await get("old", route)), undefined, `former owner: ${route}`);
  };
  db.exec(`
    INSERT INTO goods_plan_wallets(id,customer_id,plan_id,balance_toman) VALUES(301,101,1,'0');
    INSERT INTO goods_purchases(id,customer_id,plan_id,salesperson_id,wallet_id,stage,
      credit_amount_toman,principal_amount_toman,payout_amount_toman,development_discount_toman,
      company_credit_toman,payout_bps,development_discount_bps,created_by,created_at,completed_at,
      commission_bps,commission_toman,commission_month,commission_settings_json)
      VALUES(302,101,1,11,301,'completed','10000','9000','8000','500','500',8000,500,1,'2026-01-01','2026-01-02',
      200,'160','1404-10','{"rate0_bps":200}');
    INSERT INTO goods_salesperson_wallets VALUES(11,'160');
    INSERT INTO goods_finance_ledger(purchase_id,plan_id,customer_id,salesperson_id,kind,amount_toman,idempotency_key,actor_user_id,created_at)
      VALUES(302,1,101,11,'salesperson_commission','160','synthetic-commission',1,'2026-01-02');
    INSERT INTO customer_payment_orders(id,purchase_id,customer_id,salesperson_id,amount_toman,stage,created_by,created_at,updated_at)
      VALUES(701,302,101,11,'8000','sales_approval',1,'2026-01-02','2026-01-02');
  `);
  const phoneMatch = await get("next", "/customers/phone-match?phone=%2B989120000001");
  assert.equal(phoneMatch.customer.id, 101, "exact normalized-phone lookup may return a cross-owner profile");
  assert.equal(phoneMatch.customer.salespersonId, 11);
  assert.deepEqual((await get("next", "/customers/phone-match?phone=09129999999")).customer, null);
  const duplicateCreate = await mutateJson("next", "POST", "/customers", {
    name: "Duplicate form", phone: "00989120000001",
  }, 409);
  assert.equal(duplicateCreate.code, "duplicate_mobile");
  assert.equal(duplicateCreate.customer.id, 101);
  globalThis.__fixtureRaceMobile = {
    id: 103, name: "Concurrent winner", phone: "09126666666", salespersonId: 11,
  };
  const raceConflict = await mutateJson("next", "POST", "/customers", {
    name: "Concurrent duplicate", phone: "09126666666",
  }, 409);
  assert.equal(raceConflict.code, "duplicate_mobile");
  assert.equal(raceConflict.customer.id, 103, "a database uniqueness race returns the winning profile");
  const validCode = (prefix) => {
    const sum = [...prefix].reduce((n, digit, index) => n + Number(digit) * (10 - index), 0) % 11;
    return prefix + String(sum < 2 ? sum : 11 - sum);
  };
  db.prepare("UPDATE customers SET national_code=? WHERE id=101").run(validCode("001234567"));
  const codeOnlyConflict = await mutateJson("next", "POST", "/customers", {
    name: "Different phone", phone: "09125555555", nationalCode: validCode("001234567"),
  }, 409);
  assert.notEqual(codeOnlyConflict.code, "duplicate_mobile", "national-code conflicts remain a distinct response");
  db.prepare(`INSERT INTO customers(id,name,phone,created_at,salesperson_id,status)
    VALUES(106,'Cancelled historical','09128888888','2026-01-05',11,'cancelled')`).run();
  const cancelledMatch = await get("next", "/customers/phone-match?phone=%2B989128888888");
  assert.equal(cancelledMatch.customer.id, 106);
  assert.equal(cancelledMatch.customer.status, "cancelled");
  const cancelledDuplicate = await mutateJson("next", "POST", "/customers", {
    name: "New profile for cancelled number", phone: "00989128888888",
  }, 409);
  assert.equal(cancelledDuplicate.code, "duplicate_mobile");
  assert.equal(cancelledDuplicate.customer.id, 106);
  const cancelledOwner = db.prepare("SELECT salesperson_id,status FROM customers WHERE id=106").get();
  await mutateJson("next", "POST", "/customers/repeat-requests", {
    phone: "09128888888", requestedName: "Cancelled customer repeat",
    explanation: "Repeat submission on historical record",
  }, 201);
  const inProgressBoard = await get("old", "/customers?status=in_progress");
  const cancelledBoardCard = inProgressBoard.items.find(customer => customer.id === 106);
  assert.ok(cancelledBoardCard, "pending repeat-tagged cancelled records remain visible on the assigned owner's default in-progress board");
  assert.equal(cancelledBoardCard.status, "cancelled", "board visibility does not rewrite customer status");
  assert.equal(cancelledBoardCard.pendingRepeatRequestCount, 1);
  assert.equal((await get("old", "/customers?status=completed")).items.some(customer => customer.id === 106), false,
    "explicit non-default status filters remain respected");
  assert.equal((await get("old", "/customers?status=cancelled")).items.some(customer => customer.id === 106), true);
  await mutateJson("old", "POST", "/customers/106/repeat-requests/acknowledge", {}, 200);
  assert.deepEqual(db.prepare("SELECT salesperson_id,status FROM customers WHERE id=106").get(), cancelledOwner);
  assert.equal((await get("admin", "/customer-tags"))[0].label, "درخواست چند باره");
  const customTag = await mutateJson("registrar", "POST", "/customer-tags", {
    label: "  مشتری   ویژه ",
  }, 201);
  assert.match(customTag.key, /^custom_[0-9a-f]{32}$/);
  assert.equal(customTag.label, "مشتری ویژه");
  await mutate("registrar", "POST", "/customer-tags", { label: "مشتری ویژه" }, 409);
  await mutate("old", "PATCH", "/customers/101/tags", { tags: ["repeat_request"] }, 400);
  const originalOwner = db.prepare("SELECT salesperson_id,name,phone,description FROM customers WHERE id=101").get();
  const recorded = await mutateJson("next", "POST", "/customers/repeat-requests", {
    phone: "+98 912 000 0001", requestedName: "Repeat submitter",
    submittedDescription: "New details from repeat", explanation: "Customer called again",
  }, 201);
  assert.equal(recorded.customerId, 101);
  assert.equal(recorded.status, "pending");
  assert.equal((await get("old", "/customers/101/repeat-requests")).length, 1);
  assert.equal((await get("old", "/customers/101/repeat-requests"))[0].createdByUserId, 2);
  assert.equal((await get("registrar", "/customers/101/repeat-requests")).length, 1,
    "all-scope non-admin users can read active customer request history");
  await get("next", "/customers/101/repeat-requests", 404);
  await mutate("next", "POST", "/customers/101/repeat-requests/acknowledge", {}, 404);
  assert.deepEqual(
    db.prepare("SELECT salesperson_id,name,phone,description FROM customers WHERE id=101").get(),
    originalOwner,
    "repeat request must not edit customer data or assignment",
  );
  const pendingFiltered = await get("old", "/customers?tag=repeat_request");
  assert.deepEqual(pendingFiltered.items.map(customer => customer.id), [101]);
  assert.deepEqual(pendingFiltered.items[0].tags, ["repeat_request"]);
  assert.equal(pendingFiltered.items[0].pendingRepeatRequestCount, 1);
  await mutate("old", "PATCH", "/customers/101/tags", { tags: [] }, 400);
  const updatedTags = await mutateJson("registrar", "PATCH", "/customers/101/tags", {
    tags: ["repeat_request", customTag.key],
  }, 200);
  assert.deepEqual(updatedTags.tags.sort(), [customTag.key, "repeat_request"].sort(),
    "all-scope non-admin users can manage active customer tags");
  const ack = await mutateJson("registrar", "POST", "/customers/101/repeat-requests/acknowledge", {}, 200);
  assert.equal(ack.acknowledgedCount, 1);
  assert.equal(ack.pendingRepeatRequestCount, 0);
  assert.deepEqual(ack.tags, [customTag.key]);
  assert.equal((await get("old", "/customers/101/repeat-requests"))[0].status, "acknowledged");
  assert.equal((await get("old", "/customers?tag=repeat_request")).total, 0);
  assert.equal((await mutateJson("old", "POST", "/customers/101/repeat-requests/acknowledge", {}, 200)).acknowledgedCount, 0);
  assert.deepEqual(db.prepare("SELECT salesperson_id,name,phone,description FROM customers WHERE id=101").get(), originalOwner);
  db.exec(`
    INSERT INTO customer_tag_catalog(tag,label_fa,canonical_label)
      VALUES('custom_target','برچسب مقصد','برچسب مقصد');
    INSERT INTO customers(id,name,phone,created_at,salesperson_id,status)
      VALUES(104,'Merge source','09127777777','2026-01-03',11,'in_progress'),
        (105,'Merge survivor','09129999998','2026-01-04',22,'in_progress');
    INSERT INTO customer_tags(customer_id,tag,created_at)
      VALUES(104,'${customTag.key}','2026-01-03'),(105,'custom_target','2026-01-04');
  `);
  db.prepare("UPDATE customers SET national_code=? WHERE id IN (104,105)").run(validCode("001111111"));
  await mutateJson("registrar", "POST", "/customers/repeat-requests", {
    phone: "09127777777", requestedName: "Merged repeat", explanation: "Pending before merge",
  }, 201);
  const mergeResult = await mutateJson("admin", "POST", "/customers/merge", {
    sourceCustomerId: 104, targetCustomerId: 105, salespersonId: 22,
  }, 200);
  assert.equal(mergeResult.survivorCustomerId, 105);
  const mergedHistory = await get("next", "/customers/105/repeat-requests");
  assert.equal(mergedHistory.length, 1);
  assert.equal(mergedHistory[0].requestedName, "Merged repeat");
  const mergedTags = (await get("next", "/customers?tag=repeat_request")).items;
  assert.ok(mergedTags.some(customer => customer.id === 105),
    "pending repeat tag remains visible on the merge survivor");
  assert.deepEqual((await get("next", "/customers?customerId=105")).items[0].tags.sort(),
    [customTag.key, "custom_target", "repeat_request"].sort(),
    "merge preserves the union of source and survivor tags");
  const historicalPhoneMatch = await get("next", "/customers/phone-match?phone=09127777777");
  assert.equal(historicalPhoneMatch.customer.id, 105,
    "a historical merged-source phone resolves through merge audit to its active survivor");
  const mergedAck = await mutateJson("next", "POST", "/customers/105/repeat-requests/acknowledge", {}, 200);
  assert.equal(mergedAck.acknowledgedCount, 1);
  assert.deepEqual(mergedAck.tags.sort(), [customTag.key, "custom_target"].sort());
  const before = await get("old", "/loan-applications/201");
  assert.equal(before.customerSalespersonName, "Old owner");
  assert.equal((await get("old", "/goods-purchases/302")).customerSalespersonName, "Old owner");
  assert.equal((await get("old", "/payment-orders/701")).customerSalespersonName, "Old owner");
  // Reassignment changes display ownership, never the recorded owner or posted commission.
  db.exec("UPDATE customers SET salesperson_id=22 WHERE id=101");
  await named("/loan-applications", r => r.items.find(x => x.id === 201)?.customerSalespersonName);
  await named("/goods-purchases", r => r.items.find(x => x.id === 302)?.customerSalespersonName);
  await named("/payment-orders", r => r.items.find(x => x.id === 701)?.customerSalespersonName);
  await named("/contracts/generations", r => r.find(x => x.id === 501)?.customerSalespersonName);
  await named("/wallet-management/accounts", r => r.items.find(x => x.customerId === 101)?.customerSalespersonName);
  await named("/wallet-management/transactions", r => r.items.find(x => x.recordId === 402)?.customerSalespersonName);
  assert.equal((await get("next", "/contracts/generations/501")).customerSalespersonName, "New owner");
  db.exec("INSERT INTO reminders VALUES(602,2,22,101,'New owner reminder','Synthetic','2026-01-01',NULL,0,0,'2026-01-01')");
  db.exec("UPDATE reminders SET done=1,notified_at='2026-01-02' WHERE id=601");
  for (const suffix of ["", "?done=false", "?due=true", "?done=false&due=true"]) {
    const own = await get("next", `/reminders${suffix}`);
    assert.deepEqual(own.map(r => r.id), [602], `another user's reminder must not leak through ${suffix || "the list"}`);
    assert.equal(own[0].customerSalespersonName, "New owner");
  }
  assert.equal((await get("next", "/loan-applications/201")).salespersonNameSnapshot, "Old owner");
  assert.equal((await get("next", "/goods-purchases/302")).salespersonId, 11);
  assert.equal((await get("next", "/payment-orders/701")).salespersonId, 11);
  await get("old", "/loan-applications/201", 404);
  await get("old", "/goods-purchases/302", 404);
  await get("old", "/payment-orders/701", 404);
  await get("old", "/contracts/generations/501", 404);
  assert.equal((await get("old", "/reminders")).some(r => r.id === 601), false);
  await mutate("old", "PATCH", "/reminders", { id: 601, done: true }, 404);
  await mutate("old", "POST", "/reminders/601/acknowledge", {}, 404);
  // An audited merge archives the source without rewriting its financial identities.
  db.exec("UPDATE customers SET salesperson_id=11,merged_into_customer_id=102 WHERE id=101; UPDATE customers SET salesperson_id=22 WHERE id=102; INSERT INTO customer_merge_audit(source_customer_id,survivor_customer_id) VALUES(101,102); UPDATE reminders SET customer_id=102 WHERE customer_id=101");
  await named("/loan-applications", r => r.items.find(x => x.id === 201)?.customerSalespersonName);
  await named("/loan-applications?customerId=102", r => r.items.find(x => x.id === 201)?.customerSalespersonName);
  await named("/goods-purchases", r => r.items.find(x => x.id === 302)?.customerSalespersonName);
  await named("/payment-orders", r => r.items.find(x => x.id === 701)?.customerSalespersonName);
  await named("/contracts/generations", r => r.find(x => x.id === 501)?.customerSalespersonName);
  await named("/wallet-management/accounts", r => r.items.find(x => x.customerId === 101)?.customerSalespersonName);
  await named("/wallet-management/transactions", r => r.items.find(x => x.recordId === 402)?.customerSalespersonName);
  assert.equal((await get("admin", "/loan-applications/201")).customerSalespersonName, "New owner");
  assert.equal((await get("next", "/loan-applications/201")).salespersonNameSnapshot, "Old owner");
  assert.equal((await get("next", "/goods-purchases/302")).customerSalespersonName, "New owner");
  assert.equal((await get("next", "/payment-orders/701")).customerSalespersonName, "New owner");
  assert.equal((await get("next", "/contracts/generations/501")).customerSalespersonName, "New owner");
  assert.equal((await get("next", "/reminders")).find(r => r.id === 602)?.customerSalespersonName, "New owner");
  await get("old", "/loan-applications/201", 404);
  await get("old", "/goods-purchases/302", 403);
  await get("old", "/payment-orders/701", 404);
  await get("old", "/contracts/generations/501", 404);
  assert.equal((await get("old", "/reminders")).some(r => r.id === 601), false);
  await mutate("old", "PATCH", "/reminders", { id: 601, done: true }, 404);
  await mutate("old", "POST", "/reminders/601/acknowledge", {}, 404);
  const historical = db.prepare("SELECT salesperson_id_snapshot,salesperson_name_snapshot FROM loan_applications WHERE id=201").get();
  assert.deepEqual({ ...historical }, { salesperson_id_snapshot: 11, salesperson_name_snapshot: "Old owner" });
  assert.deepEqual({ ...db.prepare("SELECT salesperson_id,commission_toman,commission_bps FROM goods_purchases WHERE id=302").get() },
    { salesperson_id: 11, commission_toman: "160", commission_bps: 200 });
  assert.equal(db.prepare("SELECT salesperson_id,amount_toman FROM goods_finance_ledger WHERE purchase_id=302").get().salesperson_id, 11);
  assert.equal(db.prepare("SELECT balance_toman FROM goods_salesperson_wallets WHERE salesperson_id=11").get().balance_toman, "160");
  console.log("Synthetic customer ownership and repeat-request routes passed.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  db?.close();
  await rm(temp, { recursive: true, force: true });
}