// G4 bank shadow-posting fixture (P8 pay / P9 unpay / P18 manual). Synthetic in-memory DB + optional real-code path on a
// DISPOSABLE second copy of the masked DB (LEDGER_DB_COPY is never written). Synthetic values only; no real data printed.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as L from "../src/lib/ledger.ts";
import * as P from "../src/lib/gl-posting.ts";
import * as S from "../src/lib/gl-shadow.ts";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = "2026-10-26T18:00:00.000Z";
const one = (db, sql, ...p) => db.prepare(sql).get(...p);
const n = (db, t, w = "1") => one(db, `select count(*) n from ${t} where ${w}`).n;
const SRC = `
CREATE TABLE customer_payment_orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, purchase_id INTEGER, amount_toman TEXT NOT NULL, stage TEXT NOT NULL, paid_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE accounting_documents (id INTEGER PRIMARY KEY, fund_id INTEGER NOT NULL, document_date TEXT NOT NULL, transaction_date TEXT NOT NULL, amount_toman TEXT NOT NULL,
  purpose TEXT NOT NULL, document_type TEXT NOT NULL, transaction_type TEXT NOT NULL, source TEXT NOT NULL, source_order_id INTEGER UNIQUE, request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL, balance_before_toman TEXT NOT NULL, balance_after_toman TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL);`;
function fresh() {
  const db = new DatabaseSync(":memory:"); db.exec(SRC);
  L.ensureLedgerSchema(db, NOW); S.ensureGlShadowSchema(db, NOW);
  db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('1405','2026-03-21','2027-03-20',?)").run(NOW);
  db.prepare("insert into finance_settings(key,scope_type,scope_id,value,effective_from,changed_by_user_id,reason,created_at) values('gl.ledger_start_date','global',null,'2026-10-22','2026-10-01',7,'آزمون',?)").run(NOW);
  db.exec("insert into customer_payment_orders(id,customer_id,purchase_id,amount_toman,stage,created_at) values(5,41,52,'2500000','awaiting_payment','x'),(6,42,null,'100000','awaiting_payment','x')");
  return db;
}
const bank = (db, v) => db.prepare("update gl_settings set value=? where key='gl.shadow_bank'").run(v);
const nonbank = (db, v) => db.prepare("update gl_settings set value=? where key='gl.shadow_nonbank'").run(v);
let docN = 0;
// the exact writes of lib/accounting.ts (request keys / sources / dates)
const pay = (db, oid, rev, txDate = "2026-10-25", amount = "2500000") => db.prepare(`insert into accounting_documents(fund_id,document_date,transaction_date,amount_toman,purpose,document_type,transaction_type,source,source_order_id,request_key,request_hash,balance_before_toman,balance_after_toman,created_by,created_at)
  values(3,'2026-10-26',?,?,'p','debit','withdrawal','payment_order',?,?,'h','0','0',1,?)`).run(txDate, amount, oid, rev > 0 ? `payment:${oid}:r${rev}` : `payment:${oid}`, `${NOW}#${++docN}`).lastInsertRowid;
const unpay = (db, oid, revision, docDate = "2026-10-26") => {
  const o = one(db, "select * from accounting_documents where source_order_id=? and source='payment_order'", oid);
  const id = db.prepare(`insert into accounting_documents(fund_id,document_date,transaction_date,amount_toman,purpose,document_type,transaction_type,source,request_key,request_hash,balance_before_toman,balance_after_toman,created_by,created_at)
    values(3,?,?,?,'r','credit','deposit','manual',?,'h','0','0',1,?)`).run(docDate, o.transaction_date, o.amount_toman, `payment-revert:${oid}:${revision}`, NOW).lastInsertRowid;
  db.prepare("update accounting_documents set source_order_id=null where id=?").run(o.id);
  return id;
};
const manual = (db, src = "manual") => db.prepare(`insert into accounting_documents(fund_id,document_date,transaction_date,amount_toman,purpose,document_type,transaction_type,source,request_key,request_hash,balance_before_toman,balance_after_toman,created_by,created_at)
  values(3,'2026-10-26','2026-10-26','700000','m','credit','deposit',?,?,'h','0','0',1,?)`).run(src, `manual:${++docN}`, NOW).lastInsertRowid;

// 1. schema / mappings / flags
{
  const db = fresh();
  ok(n(db, "sqlite_master", "type='trigger' and name='gl_capture_accounting_doc'") === 1, "capture trigger on accounting_documents");
  ok(n(db, "gl_event_mappings") === 12 && ["P8", "P9", "P18"].every((e) => n(db, "gl_event_mappings", `event_code='${e}' and version=1`) === 1), "12 mappings incl. P8/P9/P18 v1");
  ok(n(db, "schema_migrations", `version='${S.GL_SHADOW_BANK_MIGRATION}'`) === 1, "G4 migration marker");
  ok(["gl.shadow_bank", "gl.bank_blocking", "gl.shadow_nonbank"].every((k) => one(db, "select value v from gl_settings where key=?", k).v === "0"), "all gl flags OFF");
  S.ensureGlShadowSchema(db, NOW);
  ok(n(db, "gl_event_mappings") === 12 && n(db, "sqlite_master", "type='trigger' and name like 'gl_capture_%'") === 1, "re-ensure idempotent");
  // flag OFF => nothing captured, worker inert
  pay(db, 5, 0); unpay(db, 5, 1); manual(db);
  ok(n(db, "gl_posting_queue") === 0 && S.processGlShadowQueue(db, { nowIso: NOW }) === null, "flag OFF: 0 queue rows, worker returns null");
  nonbank(db, "1");
  ok(n(db, "gl_posting_queue") === 0 && S.processGlShadowQueue(db, { nowIso: NOW }).posted === 0, "only shadow_nonbank ON: bank events not captured or processed");
}

// 2. acceptance: pay -> unpay -> pay = 3 vouchers r0, r0:reversal, r1
{
  const db = fresh(); bank(db, "1");
  pay(db, 5, 0);
  ok(one(db, "select source_key k,event_type e from gl_posting_queue").k === "gl:payment-order:5:r0", "pay #1 -> key r0 (P8)");
  unpay(db, 5, 1);
  pay(db, 5, 1, "2026-10-26");
  const keys = db.prepare("select source_key k,event_type e,status from gl_posting_queue order by id").all();
  ok(JSON.stringify(keys.map((r) => [r.k, r.e])) === JSON.stringify([["gl:payment-order:5:r0", "P8"], ["gl:payment-order:5:r0:reversal", "P9"], ["gl:payment-order:5:r1", "P8"]]), "queue keys r0 / r0:reversal / r1");
  ok(keys.every((r) => r.status === "pending") && n(db, "gl_vouchers") === 0, "capture only (no voucher inside the business transaction)");
  // nonbank-only worker does not touch bank rows
  bank(db, "0"); nonbank(db, "1");
  ok(S.processGlShadowQueue(db, { nowIso: NOW }).posted === 0 && n(db, "gl_posting_queue", "status='pending'") === 3, "bank flag OFF: bank rows stay pending");
  bank(db, "1");
  const r = S.processGlShadowQueue(db, { nowIso: NOW });
  ok(r.posted === 3 && r.failed === 0 && n(db, "gl_vouchers") === 3, "worker: 3 vouchers");
  const v = db.prepare("select id,source_key k,kind,reverses_voucher_id rv,event_date d from gl_vouchers order by id").all();
  ok(v[0].k === "gl:payment-order:5:r0" && v[1].k === "gl:payment-order:5:r0:reversal" && v[2].k === "gl:payment-order:5:r1", "voucher keys r0 / r0:reversal / r1");
  ok(v[1].kind === "reversal" && v[1].rv === v[0].id && v[0].d === "2026-10-25" && v[1].d === "2026-10-26" && v[2].d === "2026-10-26", "reversal links r0; dates = deposit date / revert date");
  const lines = (id) => db.prepare("select a.code,t.type,t.ref_id,l.debit_rial d,l.credit_rial c from gl_voucher_lines l join gl_accounts a on a.id=l.account_id left join gl_tafsili t on t.id=l.tafsili_id where voucher_id=? order by line_no").all(id);
  const l0 = lines(v[0].id);
  ok(l0[0].code === "2101" && l0[0].type === "CU" && l0[0].ref_id === 41 && l0[0].d === 25000000 && l0[1].code === "1102" && l0[1].type === "BK" && l0[1].ref_id === 3 && l0[1].c === 25000000, "P8: Dr 2101 CU#41 / Cr 1102 BK#3, rial = toman*10");
  const l1 = lines(v[1].id);
  ok(l1[0].code === "2101" && l1[0].c === 25000000 && l1[1].code === "1102" && l1[1].d === 25000000, "P9: sides swapped");
  const bal = (code) => one(db, "select coalesce(sum(l.debit_rial-l.credit_rial),0) b from gl_voucher_lines l join gl_accounts a on a.id=l.account_id where a.code=?", code).b;
  ok(bal("2101") === 25000000 && bal("1102") === -25000000, "net effect = one payment (2101 Dr 2.5M toman, 1102 Cr)");
  ok(n(db, "gl_voucher_seals") === 3, "all 3 sealed");
  ok(S.processGlShadowQueue(db, { nowIso: NOW }).posted === 0 && n(db, "gl_vouchers") === 3, "re-run: nothing new");
  ok(n(db, "accounting_documents") === 3 && n(db, "accounting_documents", "source_order_id=5") === 1, "business rows untouched by the ledger");
  // second unpay of r1 -> r1:reversal
  unpay(db, 5, 2); S.processGlShadowQueue(db, { nowIso: NOW });
  ok(n(db, "gl_vouchers", "source_key='gl:payment-order:5:r1:reversal' and kind='reversal'") === 1, "unpay #2 reverses r1");
}

// 3. edge cases: before ledger start, original not captured, ordering, P18 deferred, opening not captured
{
  const db = fresh(); bank(db, "1");
  pay(db, 6, 0, "2026-10-20", "100000"); unpay(db, 6, 1, "2026-10-21");
  S.processGlShadowQueue(db, { nowIso: NOW });
  ok(n(db, "gl_vouchers") === 0 && n(db, "gl_posting_queue", "status='skipped'") === 2, "pre-start pay + revert: no voucher (N7: status only)");
  ok(one(db, "select last_error e from gl_posting_queue where event_type='P9'").e === "gl_before_ledger_start", "pre-start revert reason");
  const db2 = fresh(); pay(db2, 6, 0); bank(db2, "1"); unpay(db2, 6, 1);
  S.processGlShadowQueue(db2, { nowIso: NOW });
  ok(one(db2, "select status s,last_error e from gl_posting_queue").e === "gl_original_not_captured" && n(db2, "gl_exceptions", "code='gl_original_not_captured'") === 1, "revert of a pay made while flag OFF -> skipped + exception (G6 catch-up)");
  const db3 = fresh(); bank(db3, "1"); pay(db3, 6, 0, "2026-10-25", "100000"); unpay(db3, 6, 1);
  S.processGlShadowQueue(db3, { nowIso: NOW, events: ["P9"] });
  ok(one(db3, "select status s,last_error e from gl_posting_queue where event_type='P9'").e === "gl_original_pending", "revert processed before its original -> failed, retried");
  S.processGlShadowQueue(db3, { nowIso: NOW }); S.processGlShadowQueue(db3, { nowIso: "2026-10-26T19:00:00.000Z" });
  ok(n(db3, "gl_vouchers") === 2 && n(db3, "gl_posting_queue", "status='posted'") === 2, "after retry: P8 + P9 posted");
  const db4 = fresh(); bank(db4, "1"); manual(db4); manual(db4, "opening");
  ok(n(db4, "gl_posting_queue") === 1 && one(db4, "select source_key k from gl_posting_queue").k.startsWith("gl:acc-doc:"), "P18 manual captured as gl:acc-doc:<id>; opening doc not captured");
  S.processGlShadowQueue(db4, { nowIso: NOW });
  ok(one(db4, "select last_error e from gl_posting_queue").e === "gl_deferred:W3:counter_account" && n(db4, "gl_vouchers") === 0, "P18 deferred to W3 (no guessed counter account)");
  // capture can never fail a business write
  const db5 = fresh(); bank(db5, "1"); db5.exec("drop table customer_payment_orders");
  pay(db5, 77, 0);
  ok(n(db5, "accounting_documents") === 1 && n(db5, "gl_posting_queue") === 1, "missing order: business row kept");
  ok(S.processGlShadowQueue(db5, { nowIso: NOW }).failed === 1, "and reported failed by the worker");
  // /pay error classification
}

// 4. /pay error code: gl failures are told apart from conflicts
{
  const src = fs.readFileSync(`${process.cwd()}/src/routes/payment-orders.ts`, "utf8");
  ok(/isGlFailure\(error\)\) return failGl\(req, res, "\/pay"/.test(src) && /"gl_posting_failed"/.test(src), "/pay maps gl failures to gl_posting_failed");
  ok(src.indexOf('isGlFailure(error)) return failGl(req, res, "/pay"') < src.indexOf('"payment_recording_conflict")'), "before the generic conflict");
  const accSrc = fs.readFileSync(`${process.cwd()}/src/lib/accounting.ts`, "utf8");
  ok(/accounting_require_payment_journal/.test(accSrc), "F4 trigger still defined in accounting.ts");
}

// 5. real code path on a disposable copy (lib/accounting.ts postPaymentDocument / reversePaymentDocument, F4 trigger untouched)
if (process.env.LEDGER_DB_COPY) {
  const tmp = `${process.env.LEDGER_DB_COPY}.g4probe`;
  { const s = new DatabaseSync(process.env.LEDGER_DB_COPY, { readOnly: true }); s.exec(`VACUUM INTO '${tmp}'`); s.close(); }
  process.env.CRM_DATABASE_PATH = tmp; process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "silent";
  const C = await import("../src/lib/crm-db.ts");
  const A = await import("../src/lib/accounting.ts");
  const db = C.crmDb;
  A.ensureAccountingSchema();
  const f4 = () => one(db, "select sql from sqlite_master where name='accounting_require_payment_journal'")?.sql;
  const f4Before = f4();
  L.ensureLedgerSchema(db, NOW); S.ensureGlShadowSchema(db, NOW);
  ok(!!f4Before && f4() === f4Before, "copy: F4 trigger present and byte-identical after G4 schema");
  ok(n(db, "sqlite_master", "type='trigger' and name like 'gl_capture_%'") === 5 && n(db, "gl_event_mappings") === 12, "copy: 5 capture triggers, 12 mappings");
  ok(n(db, "gl_vouchers") === 0 && n(db, "gl_posting_queue") === 0 && one(db, "select value v from gl_settings where key='gl.shadow_bank'").v === "0", "copy: empty ledger, flag OFF");
  const order = one(db, "select * from customer_payment_orders where stage='awaiting_payment' order by id limit 1");
  const admin = one(db, "select id from users where role='admin' and id<>29 order by id limit 1").id;
  C.runTransaction(() => {
    db.prepare("insert into finance_bank_accounts(id,bank_name,owner_name,fund_name,iban,owner_type,created_by,created_at) values(990001,'fixture','fixture','fixture','IR000000000000000000990001','company',?,?)").run(admin, NOW);
    A.postDocument({ fundId: 990001, documentDate: "2026-10-01", transactionDate: "2026-10-01", amount: 10n ** 12n, purpose: "opening", documentType: "credit", transactionType: "deposit", source: "opening", requestKey: "fixture-opening", requestHash: "h", actorId: admin });
  });
  db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('1405','2026-03-21','2027-03-20',?)").run(NOW);
  db.prepare("insert into finance_settings(key,scope_type,scope_id,value,effective_from,changed_by_user_id,reason,created_at) values('gl.ledger_start_date','global',null,'2026-10-22','2026-10-01',?,'آزمون',?)").run(admin, NOW);
  const rc = { name: "x", mime: "image/png", sha256: "0".repeat(64), size: 1 };
  C.runTransaction(() => A.postPaymentDocument(order, admin, 990001, "2026-10-25T08:00:00.000Z", rc, 0));
  ok(n(db, "gl_posting_queue") === 0, "copy: flag OFF -> real pay queues nothing");
  db.prepare("update gl_settings set value='1' where key='gl.shadow_bank'").run();
  C.runTransaction(() => A.reversePaymentDocument(order, admin, 1, "fixture revert"));
  ok(one(db, "select last_error e, status s from gl_posting_queue").s === "pending", "copy: real unpay captured");
  // restart the scenario with the flag ON from the first pay (second synthetic order id is the same real order, revision 1/2)
  C.runTransaction(() => A.postPaymentDocument(order, admin, 990001, "2026-10-26T08:00:00.000Z", { ...rc, sha256: "1".repeat(64) }, 1));
  C.runTransaction(() => A.reversePaymentDocument(order, admin, 2, "fixture revert 2"));
  C.runTransaction(() => A.postPaymentDocument(order, admin, 990001, "2026-10-26T09:00:00.000Z", { ...rc, sha256: "2".repeat(64) }, 2));
  const ks = db.prepare("select source_key k from gl_posting_queue order by id").all().map((r) => r.k);
  ok(JSON.stringify(ks) === JSON.stringify([`gl:payment-order:${order.id}:r0:reversal`, `gl:payment-order:${order.id}:r1`, `gl:payment-order:${order.id}:r1:reversal`, `gl:payment-order:${order.id}:r2`]), "copy: real keys r0:reversal / r1 / r1:reversal / r2");
  const r = S.processGlShadowQueue(db, { nowIso: NOW });
  ok(r.posted === 3 && r.skipped === 1 && one(db, "select last_error e from gl_posting_queue where source_key like '%:r0:reversal'").e === "gl_original_not_captured", "copy: pay(r1) -> unpay -> pay(r2) = 3 vouchers; r0 reversal flagged (pay was before flag)");
  ok(n(db, "gl_vouchers", "kind='reversal'") === 1 && n(db, "gl_voucher_seals") === 3, "copy: 1 reversal, all sealed");
  ok(f4() === f4Before && one(db, "pragma integrity_check").integrity_check === "ok", "copy: F4 unchanged, integrity ok");
  db.close(); fs.rmSync(tmp, { force: true }); for (const s of ["-wal", "-shm"]) fs.rmSync(tmp + s, { force: true });
  ok(!fs.existsSync(tmp), "copy: disposable probe DB removed (given copy never written)");
}
console.log(`gl-shadow-bank fixture: ${pass} checks passed`);
