// G3 shadow-posting fixture (synthetic in-memory DB; optional masked copy via LEDGER_DB_COPY: read-only + rolled back). No real data printed.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as L from "../src/lib/ledger.ts";
import * as P from "../src/lib/gl-posting.ts";
import * as S from "../src/lib/gl-shadow.ts";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const throwsCode = (fn, code) => { let e = null; try { fn(); } catch (x) { e = x; } assert.ok(e && String(e.message).includes(code), `check #${pass + 1}: expected ${code}, got ${e && e.message}`); pass++; };
const NOW = "2026-10-26T18:00:00.000Z";
const AT = "2026-10-25T08:00:00.000Z";
const one = (db, sql, ...p) => db.prepare(sql).get(...p);
const n = (db, t, w = "1") => one(db, `select count(*) n from ${t} where ${w}`).n;
const SRC = `
CREATE TABLE wallet_accounts_v2 (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, wallet_type TEXT NOT NULL, balance TEXT NOT NULL DEFAULT '0');
CREATE TABLE wallet_ledger_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_id INTEGER NOT NULL, amount TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE loan_filing_fee_charges (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, amount_toman TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE wallet_transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, from_customer_id INTEGER NOT NULL, to_customer_id INTEGER NOT NULL, wallet_type TEXT NOT NULL, amount_toman TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE goods_purchases (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, salesperson_id INTEGER, stage TEXT NOT NULL, credit_amount_toman TEXT NOT NULL, principal_amount_toman TEXT NOT NULL, payout_amount_toman TEXT NOT NULL, development_discount_toman TEXT NOT NULL, company_credit_toman TEXT NOT NULL, base_payout_amount_toman TEXT, fee_discount_toman TEXT NOT NULL DEFAULT '0');
CREATE TABLE goods_finance_ledger (id INTEGER PRIMARY KEY, purchase_id INTEGER, plan_id INTEGER, customer_id INTEGER, salesperson_id INTEGER, kind TEXT NOT NULL, amount_toman TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE team_commission_ledger_meta (ledger_id INTEGER PRIMARY KEY, salesperson_id INTEGER NOT NULL, kind TEXT NOT NULL, commission_month TEXT NOT NULL, meta_json TEXT);
CREATE TABLE customer_payment_orders (id INTEGER PRIMARY KEY, amount_toman TEXT NOT NULL, stage TEXT NOT NULL, paid_at TEXT, created_at TEXT NOT NULL);`;
function fresh({ fy = true } = {}) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON"); db.exec(SRC);
  L.ensureLedgerSchema(db, NOW); S.ensureGlShadowSchema(db, NOW);
  if (fy) db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('1405','2026-03-21','2027-03-20',?)").run(NOW);
  db.exec("insert into wallet_accounts_v2(id,customer_id,wallet_type) values(1,41,'cash'),(2,41,'credit'),(3,42,'cash'),(4,42,'credit')");
  return db;
}
const setting = (db, key, value, eff = "2026-10-01", plan = null) => db.prepare("insert into finance_settings(key,scope_type,scope_id,value,effective_from,changed_by_user_id,reason,created_at) values(?,?,?,?,?,7,'آزمون',?)").run(key, plan ? "loan_plan" : "global", plan, value, eff, NOW);
const flag = (db, v) => db.prepare("update gl_settings set value=? where key='gl.shadow_nonbank'").run(v);
// the business operations, exactly as the CRM writes them (one transaction each)
function scenario(db) {
  const t = (fn) => { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };
  t(() => db.prepare("insert into wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) values(2,'300000000','loan_credit:actor:7','loan-application:5:credit',?)").run(AT));          // P1
  t(() => db.prepare("insert into wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) values(1,'500000','cash_payment','cash-payment:11',?)").run(AT));                                // P2
  t(() => { const id = db.prepare("insert into loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,created_at) values(41,3,'300000','k1',?)").run(AT).lastInsertRowid;           // P4
    db.prepare("insert into wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) values(1,'300000','filing_fee_out',?,?)").run(`filing-fee:${id}:out`, AT); });
  t(() => db.prepare("insert into loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,created_at) values(41,3,'0','k0',?)").run(AT));                                           // zero fee
  t(() => db.prepare("insert into wallet_transfers(from_customer_id,to_customer_id,wallet_type,amount_toman,status,idempotency_key,created_at) values(41,42,'cash','100000','completed','t1',?)").run(AT)); // P5
  t(() => db.prepare("insert into wallet_transfers(from_customer_id,to_customer_id,wallet_type,amount_toman,status,idempotency_key,created_at) values(41,42,'cash','100000','failed','t2',?)").run(AT));    // failed: none
  t(() => db.prepare("insert into wallet_transfers(from_customer_id,to_customer_id,wallet_type,amount_toman,status,idempotency_key,created_at) values(41,42,'credit','1000','completed','t3',?)").run(AT)); // P6
  t(() => { // P7: purchase #2 numbers (design §4 example)
    db.prepare("insert into goods_purchases(id,customer_id,plan_id,salesperson_id,stage,credit_amount_toman,principal_amount_toman,payout_amount_toman,development_discount_toman,company_credit_toman,base_payout_amount_toman,fee_discount_toman) values(2,41,3,9,'settlement_pending','30000000','30000000','18000000','5100000','24900000','18000000','0')").run();
    for (const [k, a] of [["customer_credit_debit", "30000000"], ["development_discount", "5100000"], ["company_credit", "24900000"]])
      db.prepare("insert into goods_finance_ledger(purchase_id,plan_id,customer_id,salesperson_id,kind,amount_toman,idempotency_key,created_at) values(2,3,41,9,?,?,?,?)").run(k, a, `goods:2:${k}`, AT);
  });
  t(() => { const id = db.prepare("insert into goods_finance_ledger(purchase_id,plan_id,customer_id,salesperson_id,kind,amount_toman,idempotency_key,created_at) values(2,3,41,9,'salesperson_commission','270000','goods:2:salesperson_commission',?)").run(AT).lastInsertRowid; // P10
    db.prepare("insert into team_commission_ledger_meta(ledger_id,salesperson_id,kind,commission_month) values(?,9,'salesperson_commission','1405-08')").run(id); });
  t(() => db.prepare("insert into goods_finance_ledger(salesperson_id,customer_id,kind,amount_toman,idempotency_key,created_at) values(9,41,'data_accuracy_bonus','50000','dab:41',?)").run(AT));   // P11
  t(() => { const id = db.prepare("insert into goods_finance_ledger(purchase_id,plan_id,customer_id,salesperson_id,kind,amount_toman,idempotency_key,created_at) values(2,3,41,9,'paid_mark_reversal','-270000','goods:2:paid_mark_reversal:4',?)").run(AT).lastInsertRowid; // P12
    db.prepare("insert into team_commission_ledger_meta(ledger_id,salesperson_id,kind,commission_month,meta_json) values(?,9,'paid_mark_reversal','1405-08',?)").run(id, JSON.stringify({ reversedLedgerId: 4, reversedKind: "salesperson_commission" })); });
}
const bal = (db, code) => one(db, "select coalesce(sum(l.debit_rial),0)-coalesce(sum(l.credit_rial),0) n from gl_voucher_lines l join gl_accounts a on a.id=l.account_id where a.code=?", code).n;

// 1. schema: mapping table versioned + append-only; triggers exist; idempotent ensure
{
  const db = fresh();
  ok(n(db, "gl_event_mappings") === 12 && n(db, "gl_event_mappings", "version=1") === 12, "12 mappings seeded at v1 (9 non-bank + G4 P8/P9/P18)");
  S.ensureGlShadowSchema(db, NOW);
  ok(n(db, "gl_event_mappings") === 12, "ensure is idempotent");
  ok(n(db, "sqlite_master", "type='trigger' and name like 'gl_capture_%'") === 4, "4 capture triggers");
  throwsCode(() => db.prepare("update gl_event_mappings set note='x'").run(), "gl_append_only");
  throwsCode(() => db.prepare("delete from gl_event_mappings").run(), "gl_append_only");
  db.prepare("insert into gl_event_mappings(event_code,version,effective_from,mapping_json,created_at) values('P2',2,'2027-01-01',?,?)").run(JSON.stringify({ dr: "1101", cr: "2201" }), NOW);
  ok(S.glMappingAsOf(db, "P2", "2026-12-31").version === 1 && S.glMappingAsOf(db, "P2", "2027-01-01").version === 2, "mapping read as of the event date");
  throwsCode(() => S.glMappingAsOf(db, "P99", "2026-10-25"), "gl_mapping_missing");
  ok(one(db, "select 1 x from schema_migrations where version=?", S.GL_SHADOW_MIGRATION), "migration recorded");
}

// 2. flag OFF (default): business writes go through, zero queue rows, zero vouchers, worker does nothing
{
  const db = fresh();
  ok(one(db, "select value from gl_settings where key='gl.shadow_nonbank'").value === "0", "flag OFF by default");
  scenario(db);
  ok(n(db, "gl_posting_queue") === 0 && n(db, "gl_vouchers") === 0 && n(db, "gl_exceptions") === 0, "flag OFF: no queue, no voucher, no exception");
  ok(n(db, "wallet_ledger_v2") === 3 && n(db, "goods_finance_ledger") === 6 && n(db, "wallet_transfers") === 3, "flag OFF: business rows written");
  ok(S.processGlShadowQueue(db) === null, "worker inert with flag OFF");
}

// 3. full scenario, flag ON, all GS values set (gross + revenue_reduction)
{
  const db = fresh(); flag(db, "1");
  setting(db, "gl.ledger_start_date", "2026-10-22"); setting(db, "discount.development.nature", "revenue_reduction"); setting(db, "plan.supplier_deposit_method", "gross", "2026-10-01", 3);
  scenario(db);
  ok(n(db, "gl_posting_queue") === 9, "9 events captured (zero fee + failed transfer + 2 non-P7 goods rows skipped)");
  ok(n(db, "gl_posting_queue", "status='pending'") === 9 && n(db, "gl_vouchers") === 0, "capture only queues; nothing posted inside the business transaction");
  ok(one(db, "select source_key k from gl_posting_queue where event_type='P2'").k === "gl:cash-payment:11", "P2 key per design");
  ok(one(db, "select source_key k from gl_posting_queue where event_type='P7'").k === "gl:goods:2:settle", "P7 key per design");
  ok(one(db, "select source_key k from gl_posting_queue where event_type='P4'").k === "gl:filing-fee:1", "P4 key per design");
  ok(JSON.parse(one(db, "select payload_json p from gl_posting_queue where event_type='P7'").p).company === "24900000", "P7 payload snapshot");
  db.exec("BEGIN"); ok(S.processGlShadowQueue(db) === null, "worker refuses to run inside a caller's transaction"); db.exec("ROLLBACK");
  const r = S.processGlShadowQueue(db, { nowIso: NOW });
  ok(r.posted === 7 && r.skipped === 2 && r.failed === 0, `posted 7 skipped 2 (P1, P6 deferred) got ${JSON.stringify(r)}`);
  ok(n(db, "gl_vouchers") === 7 && n(db, "gl_voucher_seals") === 7, "7 sealed vouchers");
  ok(one(db, "select count(*) n from gl_exceptions where code='gl_deferred:Q7'").n === 2, "P1 + P6 -> deferred:Q7 exceptions");
  ok(n(db, "gl_exceptions", "code='gl_deferred:Q7:memo'") === 1, "P7 memo voucher deferred (exception)");
  const p7 = one(db, "select id,event_date,kind from gl_vouchers where source_key='gl:goods:2:settle'");
  ok(p7.kind === "auto" && p7.event_date === "2026-10-25", "P7 auto voucher at Tehran event date");
  const lines = db.prepare("select a.code,l.debit_rial d,l.credit_rial c from gl_voucher_lines l join gl_accounts a on a.id=l.account_id where voucher_id=? order by line_no").all(p7.id);
  ok(JSON.stringify(lines.map((x) => [x.code, x.d, x.c])) === JSON.stringify([["1201", 249000000, 0], ["4102", 51000000, 0], ["5101", 180000000, 0], ["4101", 0, 300000000], ["2101", 0, 180000000]]), "P7 document 2 matches design example #2 (5 lines, rial)");
  ok(bal(db, "1103") === 5000000 && bal(db, "2201") === -5000000 + 3000000, "P2 1103/2201 and P4 2201 debit");
  ok(bal(db, "4103") === -3000000, "P4 filing fee revenue");
  ok(bal(db, "6101") === 2700000 - 2700000 && bal(db, "6102") === 500000 && bal(db, "2102") === -500000, "P10 then P12 net zero; P11 bonus");
  const p5 = one(db, "select id from gl_vouchers where source_key='gl:wallet-transfer:1'");
  const p5l = db.prepare("select t.code tc,l.debit_rial d from gl_voucher_lines l join gl_tafsili t on t.id=l.tafsili_id where voucher_id=? order by line_no").all(p5.id);
  ok(p5l[0].tc === "CU-41" && p5l[0].d === 1000000 && p5l[1].tc === "CU-42", "P5 debit source customer, credit target");
  ok(one(db, "select count(*) n from gl_tafsili where title like '%#%'").n === n(db, "gl_tafsili"), "tafsili titles neutral (no names)");
  ok(n(db, "gl_posting_queue", "status='posted' and voucher_id is not null") === 7, "queue rows linked to vouchers");
  const r2 = S.processGlShadowQueue(db, { nowIso: NOW });
  ok(r2.posted + r2.skipped + r2.failed === 0 && n(db, "gl_vouchers") === 7, "second run: nothing due, no duplicates");
  ok(one(db, "pragma integrity_check").integrity_check === "ok", "integrity ok");
}

// 4. no GS values: exceptions only, no guessed voucher; then before-start events are skipped
{
  const db = fresh(); flag(db, "1"); scenario(db);
  const r = S.processGlShadowQueue(db, { nowIso: NOW });
  ok(r.posted === 0 && r.failed === 9 && n(db, "gl_vouchers") === 0, "no ledger start date: all failed (retryable), no voucher");
  ok(n(db, "gl_posting_queue", "last_error='finance_setting_missing:gl.ledger_start_date' and next_attempt_at is not null") === 9, "failure reason + retry time recorded");
  setting(db, "gl.ledger_start_date", "2026-10-22");
  const later = "2026-10-26T19:00:00.000Z";
  const r2 = S.processGlShadowQueue(db, { nowIso: later });
  ok(r2.posted === 6 && r2.skipped === 3, `retry posts the 6 that need no GS value, skips P7 + 2 deferred, got ${JSON.stringify(r2)}`);
  ok(n(db, "gl_exceptions", "code='finance_setting_missing:plan.supplier_deposit_method,discount.development.nature'") === 1 && !one(db, "select 1 x from gl_vouchers where source_key='gl:goods:2:settle'"), "P7 without GS values: exception only, no voucher");
  const db2 = fresh(); flag(db2, "1"); setting(db2, "gl.ledger_start_date", "2026-10-26"); scenario(db2);
  const r3 = S.processGlShadowQueue(db2, { nowIso: NOW });
  ok(r3.skipped === 9 && n(db2, "gl_vouchers") === 0 && n(db2, "gl_exceptions", "code='gl_before_ledger_start'") >= 1, "events before ledger start: skipped (belong to opening)");
}

// 5. other P7 settings -> deferred exceptions (inactive accounts)
{
  for (const [method, nature, code] of [["net_of_fees", "revenue_reduction", "gl_deferred:deposit_method:net_of_fees"], ["prefunded_full_credit", "revenue_reduction", "gl_deferred:deposit_method:prefunded_full_credit"], ["gross", "marketing_expense", "gl_deferred:discount_nature:marketing_expense"]]) {
    const db = fresh(); flag(db, "1"); setting(db, "gl.ledger_start_date", "2026-10-22"); setting(db, "discount.development.nature", nature); setting(db, "plan.supplier_deposit_method", method, "2026-10-01", 3);
    scenario(db); S.processGlShadowQueue(db, { nowIso: NOW });
    ok(n(db, "gl_exceptions", "code=?".replace("?", `'${code}'`)) === 1 && !one(db, "select 1 x from gl_vouchers where source_key='gl:goods:2:settle'"), `${method}/${nature}: exception, no voucher`);
  }
  const db = fresh(); flag(db, "1"); setting(db, "gl.ledger_start_date", "2026-10-22"); setting(db, "discount.development.nature", "revenue_reduction");
  setting(db, "plan.supplier_deposit_method", "gross", "2026-10-26", 3); scenario(db); S.processGlShadowQueue(db, { nowIso: NOW });
  ok(!one(db, "select 1 x from gl_vouchers where source_key='gl:goods:2:settle'"), "setting effective after the event date is not used (as-of event date)");
}

// 5b. G6c: P7 'prefunded_full_credit' (draft rule, awaiting Salamatian's P7 sign-off) — behind gl.p7_prefunded, 2104 active, no-negative 2104
{
  const pre = (db, v) => db.prepare("update gl_settings set value=? where key='gl.p7_prefunded'").run(v);
  const base = (nature = "revenue_reduction") => { const db = fresh(); flag(db, "1"); setting(db, "gl.ledger_start_date", "2026-10-22"); setting(db, "discount.development.nature", nature);
    setting(db, "plan.supplier_deposit_method", "prefunded_full_credit", "2026-10-01", 3); return db; };
  const ex = (db, code) => n(db, "gl_exceptions", `code='${code}'`) === 1 && !one(db, "select 1 x from gl_vouchers where source_key='gl:goods:2:settle'");
  ok(S.P7_PREFUNDED_DRAFT.status === "awaiting_salamatian_p7_signoff" && S.P7_PREFUNDED_DRAFT.account === "2104", "prefunded rule is a draft awaiting Salamatian's sign-off");
  ok(one(fresh(), "select value from gl_settings where key='gl.p7_prefunded'").value === "0", "gl.p7_prefunded seeded OFF");
  { const db = base(); scenario(db); S.processGlShadowQueue(db, { nowIso: NOW }); ok(ex(db, "gl_deferred:deposit_method:prefunded_full_credit"), "flag OFF: prefunded stays an exception"); }
  { const db = base(); db.prepare("delete from gl_settings where key='gl.p7_prefunded'").run(); scenario(db); S.processGlShadowQueue(db, { nowIso: NOW }); ok(ex(db, "gl_deferred:deposit_method:prefunded_full_credit"), "flag row missing = OFF"); }
  { const db = base(); pre(db, "1"); scenario(db); S.processGlShadowQueue(db, { nowIso: NOW }); ok(ex(db, "gl_account_inactive:2104"), "flag ON but 2104 inactive (code awaiting confirmation): exception"); }
  { const db = base(); pre(db, "1"); db.prepare("update gl_accounts set active=1 where code='2104'").run(); scenario(db); S.processGlShadowQueue(db, { nowIso: NOW });
    ok(ex(db, "gl_prefunded_insufficient:2104"), "no supplier deposit on 2104: no-negative rule -> exception, no voucher"); }
  {
    const db = base(); pre(db, "1"); db.prepare("update gl_accounts set active=1 where code='2104'").run();
    db.exec("BEGIN"); // synthetic supplier deposit (the real one needs the manual bank document's counter account, W3 deferred)
    const pl3 = P.ensureTafsili(db, "PL", 3, "طرح #3", NOW), bk = P.ensureTafsili(db, "BK", 1, "بانک آزمون", NOW);
    P.postVoucher(db, { eventDate: "2026-10-23", kind: "manual", description: "واریز پیش‌دریافت تأمین‌کننده (آزمون)", sourceKey: "gl:test:deposit:3", createdByUserId: 7, approvedByUserId: 8, nowIso: NOW,
      lines: [{ account: "1102", tafsiliId: bk, debitRial: 300000000 }, { account: "2104", tafsiliId: pl3, creditRial: 300000000 }] });
    db.exec("COMMIT");
    scenario(db); S.processGlShadowQueue(db, { nowIso: NOW });
    const v = one(db, "select id from gl_vouchers where source_key='gl:goods:2:settle'");
    ok(!!v, "flag ON + 2104 active + deposit covers it: P7 posts");
    const lines = db.prepare("select a.code, l.debit_rial d, l.credit_rial c from gl_voucher_lines l join gl_accounts a on a.id=l.account_id where l.voucher_id=? order by l.line_no").all(v.id);
    ok(JSON.stringify(lines.map((x) => [x.code, x.d, x.c])) === JSON.stringify([["2104", 249000000, 0], ["4102", 51000000, 0], ["5101", 180000000, 0], ["4101", 0, 300000000], ["2101", 0, 180000000]]), "prefunded P7: 1201 replaced by 2104, discount on 4102 (revenue_reduction), rest unchanged");
    ok(bal(db, "1201") === 0 && bal(db, "2104") === -51000000, "1201 untouched; 2104 credit balance reduced by the company share");
  }
  { const db = base("marketing_expense"); pre(db, "1"); db.prepare("update gl_accounts set active=1 where code='2104'").run(); scenario(db); S.processGlShadowQueue(db, { nowIso: NOW });
    ok(ex(db, "gl_deferred:discount_nature:marketing_expense"), "prefunded + marketing_expense: still deferred (6103 inactive)"); }
}

// 6. forced posting failure: business write intact, queue row failed, no partial voucher; retry later succeeds
{
  const db = fresh(); flag(db, "1"); setting(db, "gl.ledger_start_date", "2026-10-22");
  db.exec("BEGIN"); db.prepare("insert into wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) values(1,'500000','cash_payment','cash-payment:12',?)").run(AT); db.exec("COMMIT");
  const boom = () => { throw new Error("forced_post_failure"); };
  const r = S.processGlShadowQueue(db, { nowIso: NOW, post: boom });
  ok(r.failed === 1 && n(db, "wallet_ledger_v2") === 1, "forced failure: business row intact");
  const q = one(db, "select status,attempts,last_error,next_attempt_at from gl_posting_queue");
  ok(q.status === "failed" && q.attempts === 1 && q.last_error === "forced_post_failure" && q.next_attempt_at > NOW, "failed row with reason and backoff");
  ok(n(db, "gl_vouchers") === 0 && n(db, "gl_tafsili") === 0, "no partial voucher or tafsili left (savepoint)");
  ok(S.processGlShadowQueue(db, { nowIso: NOW }).failed === 0 && n(db, "gl_vouchers") === 0, "not retried before backoff");
  ok(S.processGlShadowQueue(db, { nowIso: "2026-10-26T18:05:00.000Z" }).posted === 1 && n(db, "gl_vouchers") === 1, "retried after backoff -> posted");
  // no fiscal year -> failed, business intact; posting fault inside a business transaction can never happen (capture only)
  const db2 = fresh({ fy: false }); flag(db2, "1"); setting(db2, "gl.ledger_start_date", "2026-10-22");
  db2.prepare("insert into wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) values(1,'500000','cash_payment','cash-payment:13',?)").run(AT);
  S.processGlShadowQueue(db2, { nowIso: NOW });
  ok(one(db2, "select last_error e from gl_posting_queue").e.includes("gl_no_fiscal_year"), "no fiscal year -> failed row");
  // max attempts: stops retrying
  for (let i = 0; i < 8; i++) S.processGlShadowQueue(db2, { nowIso: `2027-0${1 + (i % 8)}-01T00:00:00.000Z`.replace("2027-09", "2027-09") });
  const q2 = one(db2, "select attempts,next_attempt_at from gl_posting_queue");
  ok(q2.attempts === S.GL_QUEUE_MAX_ATTEMPTS && q2.next_attempt_at === null, "stops after max attempts (stays in failed report)");
  // capture can never fail the business write: broken payload source still inserts
  const db3 = fresh(); flag(db3, "1");
  db3.prepare("insert into goods_finance_ledger(purchase_id,kind,amount_toman,idempotency_key,created_at) values(999,'company_credit','1','x',?)").run(AT);
  ok(n(db3, "goods_finance_ledger") === 1 && one(db3, "select payload_json p from gl_posting_queue").p === "{}", "capture with missing purchase: business row kept, payload '{}'");
  ok(S.processGlShadowQueue(db3, { nowIso: NOW }).failed === 1, "and the worker reports it as failed");
  // duplicate capture key ignored
  db3.prepare("insert into goods_finance_ledger(purchase_id,kind,amount_toman,idempotency_key,created_at) values(999,'company_credit','1','y',?)").run(AT);
  ok(n(db3, "goods_finance_ledger") === 2 && n(db3, "gl_posting_queue") === 1, "duplicate source_key: business row kept, queue unchanged");
}

// 7. masked copy (disposable): schema applied as on live; old tables' row counts unchanged; flag OFF => a real-path insert queues nothing (rolled back)
if (process.env.LEDGER_DB_COPY) {
  const db = new DatabaseSync(process.env.LEDGER_DB_COPY); db.exec("PRAGMA foreign_keys=ON");
  const old = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'gl_%' and name not in ('schema_migrations','finance_settings','finance_settings_log','finance_setting_keys')").all().map((r) => r.name);
  const counts = () => old.map((t) => `${t}:${one(db, `select count(*) n from "${t}"`).n}`).join("|");
  const c0 = counts();
  L.ensureLedgerSchema(db, NOW); S.ensureGlShadowSchema(db, NOW); S.ensureGlShadowSchema(db, NOW);
  ok(n(db, "sqlite_master", "type='trigger' and name like 'gl_capture_%'") === 5, "copy: 5 capture triggers on the real tables (4 non-bank + G4 accounting_documents)");
  ok(n(db, "gl_event_mappings") === 12, "copy: 12 mappings");
  ok(one(db, "select value from gl_settings where key='gl.p7_prefunded'").value === "0" && one(db, "select active from gl_accounts where code='2104'").active === 0
    && n(db, "gl_event_mappings", "event_code='P7'") === 1, "copy (G6c): gl.p7_prefunded OFF, 2104 inactive, no new P7 mapping version");
  ok(n(db, "gl_vouchers") === 0 && n(db, "gl_posting_queue") === 0 && n(db, "gl_exceptions") === 0, "copy: ledger, queue, exceptions empty");
  ok(one(db, "select value from gl_settings where key='gl.shadow_nonbank'").value === "0" && S.processGlShadowQueue(db) === null, "copy: flag OFF, worker inert");
  ok(c0 === counts(), "copy: old tables' row counts unchanged");
  const w = one(db, "select id from wallet_accounts_v2 where wallet_type='cash' limit 1");
  db.exec("BEGIN");
  db.prepare("insert into wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) values(?,'1','cash_payment','cash-payment:fixture-probe',?)").run(w.id, NOW);
  ok(n(db, "gl_posting_queue") === 0, "copy: flag OFF, real insert path queues nothing");
  flag(db, "1");
  db.prepare("insert into wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) values(?,'1','cash_payment','cash-payment:fixture-probe2',?)").run(w.id, NOW);
  ok(n(db, "gl_posting_queue") === 1, "copy: flag ON, real insert path queues one row");
  db.exec("ROLLBACK");
  ok(c0 === counts() && n(db, "gl_posting_queue") === 0 && one(db, "select value from gl_settings where key='gl.shadow_nonbank'").value === "0", "copy: probe rolled back, flag OFF");
  ok(one(db, "pragma integrity_check").integrity_check === "ok", "copy integrity ok");
}
console.log(`gl-shadow fixture: ${pass} checks passed`);
