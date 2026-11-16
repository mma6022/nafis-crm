// G6 backfill fixture. Part 1: synthetic in-memory DB. Part 2 (LEDGER_DB_COPY=/tmp/x.db): a masked COPY, apply only there.
// Prints counts/ids/totals only (no names, no phone numbers).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import * as L from "../src/lib/ledger.ts";
import * as P from "../src/lib/gl-posting.ts";
import * as S from "../src/lib/gl-shadow.ts";
import * as B from "../src/lib/gl-backfill.ts";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const NOW = "2026-10-27T00:00:00.000Z";
const one = (db, sql, ...p) => db.prepare(sql).get(...p);
const n = (db, t, w = "1") => one(db, `select count(*) n from ${t} where ${w}`).n;
const bal = (db, code, kindWhere = "1") => one(db, `select coalesce(sum(l.credit_rial),0)-coalesce(sum(l.debit_rial),0) n from gl_voucher_lines l join gl_accounts a on a.id=l.account_id join gl_vouchers v on v.id=l.voucher_id where a.code=? and ${kindWhere}`, code).n;
const tx = (db, fn) => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
const OLD = ["wallet_ledger_v2", "loan_filing_fee_charges", "wallet_transfers", "goods_purchases", "goods_finance_ledger", "customer_payment_orders", "accounting_documents", "wallet_accounts_v2"];
const oldHash = (db) => createHash("sha256").update(JSON.stringify(OLD.filter((t) => one(db, "select 1 x from sqlite_master where type='table' and name=?", t)).map((t) => db.prepare(`select * from ${t} order by rowid`).all()))).digest("hex");
const setting = (db, key, value, eff = "2026-09-01", plan = null) => db.prepare("insert into finance_settings(key,scope_type,scope_id,value,effective_from,changed_by_user_id,reason,created_at) values(?,?,?,?,?,7,'آزمون G6',?)").run(key, plan ? "loan_plan" : "global", plan, value, eff, NOW);
const strip = (r) => JSON.stringify({ ...r, mode: "x" });
function opening(db, by = 5, approver = 6) {
  const acc = (c) => one(db, "select id from gl_accounts where code=?", c).id;
  const exp = P.opening2101Check(db, null, "2026-10-22").expectedRial;
  const s = Number(db.prepare("insert into gl_opening_balance_sets(as_of_date,entered_by_user_id,reason,created_at) values('2026-10-22',?,'افتتاحیه آزمون G6',?)").run(by, NOW).lastInsertRowid);
  if (exp > 0) {
    db.prepare("insert into gl_opening_balance_lines(set_id,account_id,debit_rial,credit_rial,created_at) values(?,?,0,?,?)").run(s, acc("2101"), exp, NOW);
    db.prepare("insert into gl_opening_balance_lines(set_id,account_id,debit_rial,credit_rial,created_at) values(?,?,?,0,?)").run(s, acc("3104"), exp, NOW);
  }
  db.prepare("update gl_opening_balance_sets set prior_payments_confirmed_by_user_id=?, prior_payments_confirmed_at=? where id=?").run(by, NOW, s);
  if (exp > 0) tx(db, () => P.approveOpeningSet(db, s, approver, "2026-10-26", NOW));
  return exp;
}

const SRC = `
CREATE TABLE wallet_accounts_v2 (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, wallet_type TEXT NOT NULL, balance TEXT NOT NULL DEFAULT '0');
CREATE TABLE wallet_ledger_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_id INTEGER NOT NULL, amount TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE loan_filing_fee_charges (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, amount_toman TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE wallet_transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, from_customer_id INTEGER NOT NULL, to_customer_id INTEGER NOT NULL, wallet_type TEXT NOT NULL, amount_toman TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE goods_purchases (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, salesperson_id INTEGER, stage TEXT NOT NULL, credit_amount_toman TEXT NOT NULL, principal_amount_toman TEXT NOT NULL, payout_amount_toman TEXT NOT NULL, development_discount_toman TEXT NOT NULL, company_credit_toman TEXT NOT NULL, base_payout_amount_toman TEXT, fee_discount_toman TEXT NOT NULL DEFAULT '0');
CREATE TABLE goods_finance_ledger (id INTEGER PRIMARY KEY, purchase_id INTEGER, plan_id INTEGER, customer_id INTEGER, salesperson_id INTEGER, kind TEXT NOT NULL, amount_toman TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE team_commission_ledger_meta (ledger_id INTEGER PRIMARY KEY, salesperson_id INTEGER NOT NULL, kind TEXT NOT NULL, commission_month TEXT NOT NULL, meta_json TEXT);
CREATE TABLE customer_payment_orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, purchase_id INTEGER, amount_toman TEXT NOT NULL, stage TEXT NOT NULL, paid_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE accounting_documents (id INTEGER PRIMARY KEY, fund_id INTEGER NOT NULL, document_date TEXT NOT NULL, transaction_date TEXT NOT NULL, amount_toman TEXT NOT NULL,
  purpose TEXT NOT NULL, document_type TEXT NOT NULL, transaction_type TEXT NOT NULL, source TEXT NOT NULL, source_order_id INTEGER UNIQUE, request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL, balance_before_toman TEXT NOT NULL, balance_after_toman TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL);`;
const PRE = "2026-10-10T08:00:00.000Z", POST = "2026-10-24T08:00:00.000Z", POST2 = "2026-10-25T08:00:00.000Z";
function fresh({ nature = true, late = false, method = "gross" } = {}) {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON"); db.exec(SRC);
  L.ensureLedgerSchema(db, NOW); S.ensureGlShadowSchema(db, NOW);
  db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('1405','2026-03-21','2027-03-20',?)").run(NOW);
  setting(db, "gl.ledger_start_date", "2026-10-23"); setting(db, "gl.opening_base_date", "2026-10-22");
  if (nature) setting(db, "discount.development.nature", "revenue_reduction");
  for (const p of [3]) setting(db, "plan.supplier_deposit_method", method, "2026-09-01", p);
  db.exec("insert into wallet_accounts_v2(id,customer_id,wallet_type) values(1,41,'cash'),(2,41,'credit'),(3,42,'cash'),(4,42,'credit')");
  const W = db.prepare("insert into wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) values(?,?,?,?,?)");
  W.run(1, "500000", "cash_payment", "cash-payment:1", PRE); W.run(1, "700000", "cash_payment", "cash-payment:2", POST); W.run(2, "300000000", "loan_credit:actor:7", "loan-application:5:credit", POST);
  const F = db.prepare("insert into loan_filing_fee_charges(id,customer_id,plan_id,amount_toman,idempotency_key,created_at) values(?,41,3,?,?,?)");
  F.run(100, "300000", "f100", PRE); F.run(101, "300000", "f101", POST); F.run(105, "300000", "f105", POST); F.run(102, "0", "f102", POST);
  db.prepare("insert into wallet_transfers(from_customer_id,to_customer_id,wallet_type,amount_toman,status,idempotency_key,created_at) values(41,42,'cash','100000','completed','t1',?)").run(POST);
  const GP = db.prepare("insert into goods_purchases(id,customer_id,plan_id,salesperson_id,stage,credit_amount_toman,principal_amount_toman,payout_amount_toman,development_discount_toman,company_credit_toman,base_payout_amount_toman) values(?,?,3,9,'completed',?,?,?,?,?,?)");
  const G = db.prepare("insert into goods_finance_ledger(purchase_id,plan_id,customer_id,salesperson_id,kind,amount_toman,idempotency_key,created_at) values(?,3,?,9,?,?,?,?)");
  const settle = (pid, cust, credit, disc, comp, payout, at) => { for (const [k, a] of [["customer_credit_debit", credit], ["development_discount", disc], ["company_credit", comp]]) G.run(pid, cust, k, a, `goods:${pid}:${k}`, at); };
  const corr = (pid, cust, d, at) => { G.run(pid, cust, "company_credit", `-${d}`, `goods:${pid}:settings-correction:1500-1700:6-9:company_credit`, at); G.run(pid, cust, "development_discount", d, `goods:${pid}:settings-correction:1500-1700:6-9:development_discount`, at); };
  // #2 pre-start with correction (in opening via order 1)
  GP.run(2, 41, "300000000", "300000000", "180000000", "51000000", "249000000", "180000000"); settle(2, 41, "300000000", "45000000", "255000000", "180000000", PRE); corr(2, 41, "6000000", PRE);
  // #3 post-start
  GP.run(3, 41, "100000000", "100000000", "60000000", "35000000", "65000000", "60000000"); settle(3, 41, "100000000", "35000000", "65000000", "60000000", POST);
  // #4 post-start with a post-start correction (5M company -> discount)
  GP.run(4, 42, "100000000", "100000000", "50000000", "35000000", "65000000", "50000000"); settle(4, 42, "100000000", "30000000", "70000000", "50000000", POST); corr(4, 42, "5000000", POST2);
  // #5 boundary: settled 00:30 Tehran on the start day, but its order was created 23:30 Tehran on the base day (in the opening)
  GP.run(5, 42, "80000000", "80000000", "40000000", "20000000", "60000000", "40000000"); settle(5, 42, "80000000", "20000000", "60000000", "40000000", "2026-10-22T21:00:00.000Z");
  // #6 pre-start, no payment order (like #52): a documented gap
  GP.run(6, 42, "50000000", "50000000", "30000000", "10000000", "40000000", "30000000"); settle(6, 42, "50000000", "10000000", "40000000", "30000000", PRE);
  const cid = G.run(3, 41, "salesperson_commission", "270000", "goods:3:salesperson_commission", POST).lastInsertRowid;
  db.prepare("insert into team_commission_ledger_meta(ledger_id,salesperson_id,kind,commission_month) values(?,9,'salesperson_commission','1405-08')").run(cid);
  const O = db.prepare("insert into customer_payment_orders(id,customer_id,purchase_id,amount_toman,stage,created_at) values(?,?,?,?,'awaiting_payment',?)");
  O.run(1, 41, 2, "180000000", PRE); O.run(2, 41, 3, "60000000", POST); O.run(3, 42, 4, "50000000", POST2); O.run(4, 42, 5, "40000000", "2026-10-22T20:00:00.000Z");
  if (late) {
    // #7 like live purchase 42: settled before the start, its payment order created after the base date (2026-10-24 Tehran),
    // plus a pre-start settings correction (P7C) to prove the exception is generic
    GP.run(7, 43, "120000000", "120000000", "70000000", "40000000", "80000000", "70000000"); settle(7, 43, "120000000", "40000000", "80000000", "70000000", PRE); corr(7, 43, "4000000", PRE);
    O.run(5, 43, 7, "70000000", POST);
  }
  return db;
}
const pay = (db, oid, amount, at = "2026-10-26T08:00:00.000Z") => db.prepare(`insert into accounting_documents(fund_id,document_date,transaction_date,amount_toman,purpose,document_type,transaction_type,source,source_order_id,request_key,request_hash,balance_before_toman,balance_after_toman,created_by,created_at)
  values(3,'2026-10-26','2026-10-26',?,'p','debit','withdrawal','payment_order',?,?,'h','0','0',1,?)`).run(amount, oid, `payment:${oid}`, at);
const R = (toman) => Number(toman) * 10;

// 1. the event list and the dry-run
{
  const db = fresh();
  const ev = B.collectBackfillEvents(db);
  ok(ev.length === 3 + 3 + 1 + 5 + 2 + 1, "events: 3 wallet (2 P2 + P1), 3 fees (zero fee skipped), 1 transfer, 5 P7, 2 P7C, 1 P10");
  ok(ev.filter((e) => e.eventType === "P7C").map((e) => e.sourceKey).join() === "gl:goods:2:correction:4,gl:goods:4:correction:12", "purchase corrections (non-standard key) are their own events");
  ok(ev.every((e, i) => i === 0 || ev[i - 1].at <= e.at), "ordered by created_at");
  ok(ev.find((e) => e.eventType === "P7" && e.payload.purchase_id === 2).payload.company === "255000000", "P7 original uses the original rows, not the corrected purchase");
  opening(db);
  const h = oldHash(db), counts = ["gl_vouchers", "gl_posting_queue", "gl_exceptions", "gl_tafsili", "gl_voucher_lines"].map((t) => n(db, t));
  const d1 = B.runGlBackfill(db, { apply: false, excludeFees: [105], nowIso: NOW });
  const d2 = B.runGlBackfill(db, { apply: false, excludeFees: [105], nowIso: NOW });
  ok(strip(d1) === strip(d2), "two dry-runs identical");
  ok(JSON.stringify(counts) === JSON.stringify(["gl_vouchers", "gl_posting_queue", "gl_exceptions", "gl_tafsili", "gl_voucher_lines"].map((t) => n(db, t))), "dry-run writes nothing to gl_*");
  ok(oldHash(db) === h, "dry-run: old tables unchanged");
  ok(d1.created === 7 && d1.controls.tbBalanced, `dry-run would create 7 vouchers, balanced (got ${d1.created})`);
}

// 2. apply, the 2101 rule, controls, idempotency
{
  const db = fresh();
  const exp2101 = opening(db);
  ok(exp2101 === R(180000000) + R(40000000), "opening 2101 = orders 1 and 4 (created by the end of the base date)");
  const h = oldHash(db);
  const a1 = B.runGlBackfill(db, { apply: true, excludeFees: [105], nowIso: NOW, keepItems: true });
  const it = (ev, pid) => a1.items.filter((i) => i.eventType === ev && one(db, "select purchase_id p from goods_finance_ledger where id=?", i.id)?.p === pid);
  ok(a1.created === 7, `apply created 7 (got ${a1.created})`);
  ok(n(db, "gl_vouchers", "kind='backfill'") === 7, "kind = backfill");
  ok(a1.controls.tbBalanced && a1.controls.totalDebitRial === a1.controls.totalCreditRial, "trial balance balanced");
  ok(it("P7", 2)[0].code === "gl_before_ledger_start" && it("P7C", 2)[0].code === "gl_before_ledger_start", "pre-start P7 and its correction: status only");
  ok(it("P7", 5)[0].code === "gl_in_opening_2101", "boundary purchase whose order is in the opening: excluded (no overlap)");
  ok(it("P7", 6)[0].code === "gl_before_ledger_start" && a1.controls.p7Gaps.join() === "6", "pre-start purchase without an order: reported as a gap");
  ok(n(db, "gl_vouchers", "kind='backfill' and event_date<'2026-10-23'") === 0, "no backfill voucher dated before the ledger start");
  ok(a1.controls.p7Overlap.length === 0, "no purchase both in the opening 2101 and in a P7 voucher");
  // the 2101 proof
  ok(bal(db, "2101", "v.kind='opening'") === exp2101, "2101 opening part = opening voucher");
  ok(bal(db, "2101", "v.kind<>'opening'") === R(60000000) + R(50000000), "2101 replay part = post-start P7 payout only (#3 + #4)");
  ok(bal(db, "2101") === exp2101 + R(60000000) + R(50000000) && a1.controls.gl2101Rial === a1.controls.opening2101Rial + a1.controls.postStartP7PayoutRial, "2101 = opening balance + post-start P7");
  // purchase #4: original + correction with the reverse sign
  const v4 = db.prepare("select id,source_key from gl_vouchers where source_key like 'gl:goods:4:%' order by id").all();
  ok(v4.map((v) => v.source_key).join() === "gl:goods:4:settle,gl:goods:4:correction:12", "purchase #4: two vouchers (original + correction)");
  const corrLines = db.prepare("select a.code,l.debit_rial d,l.credit_rial c from gl_voucher_lines l join gl_accounts a on a.id=l.account_id where l.voucher_id=? order by l.line_no").all(v4[1].id);
  ok(JSON.stringify(corrLines.map((l) => [l.code, l.d, l.c])) === JSON.stringify([["1201", 0, R(5000000)], ["4102", R(5000000), 0]]), "correction: Cr 1201 / Dr 4102 by the moved amount");
  ok(-bal(db, "1201") === R(65000000) + R(65000000) && -bal(db, "4102") === R(35000000) + R(35000000), "1201/4102 end on the corrected purchase values");
  ok(a1.controls.gl4101Rial === a1.controls.salesInScopeRial && a1.controls.gl4101Rial === R(200000000), "4101 = credit of post-start settled purchases");
  ok(a1.controls.gl4103Rial === a1.controls.feesInScopeRial && a1.controls.gl4103Rial === R(300000), "4103 = post-start fees (excluded fee out)");
  ok(a1.exceptions.some((x) => x.id === 105 && x.code === "gl_excluded:fee_list") && n(db, "gl_exceptions", "code='gl_excluded:fee_list' and source_id='105'") === 1, "--exclude-fee: status only + listed");
  ok(a1.controls.gl2102Rial === a1.controls.commissionsInScopeRial && a1.controls.gl2102Rial === R(270000), "2102 = salesperson commissions");
  ok(a1.byType.P1.skip === 1 && n(db, "gl_exceptions", "code='gl_deferred:Q7'") >= 1, "P1 deferred (Q7)");
  ok(oldHash(db) === h, "apply: old tables unchanged");
  // second apply: nothing new
  const vc = n(db, "gl_vouchers"), qc = n(db, "gl_posting_queue");
  const a2 = B.runGlBackfill(db, { apply: true, excludeFees: [105], nowIso: NOW });
  ok(a2.created === 0 && n(db, "gl_vouchers") === vc && n(db, "gl_posting_queue") === qc, "second apply: 0 new vouchers");
  ok(Object.values(a2.byType).every((m) => Object.keys(m).every((k) => k === "already")), "second apply: every event already handled");
  // a later P8 after the start reduces 2101 once
  pay(db, 2, "60000000");
  const a3 = B.runGlBackfill(db, { apply: true, excludeFees: [105], nowIso: NOW });
  ok(a3.created === 1 && bal(db, "2101") === exp2101 + R(50000000) && a3.controls.gl2101Rial === a3.controls.opening2101Rial + a3.controls.postStartP7PayoutRial - a3.controls.p8PaidRial, "P8 replayed once: 2101 = opening + post-start P7 - paid");
  ok(one(db, "pragma integrity_check").integrity_check === "ok" && db.prepare("pragma foreign_key_check").all().length === 0, "integrity");
}

// 3. no double voucher with the worker, nor with an old gl:backfill:<table>:<id> key; in-transaction refused; resume after a stop
{
  const db = fresh(); opening(db);
  db.prepare("update gl_settings set value='1' where key='gl.shadow_nonbank'").run();
  const W = db.prepare("insert into wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) values(1,'900000','cash_payment','cash-payment:9',?)"); W.run(POST);
  ok(S.processGlShadowQueue(db, { nowIso: NOW }).posted === 1, "worker posted the live P2");
  db.prepare("update gl_settings set value='0' where key='gl.shadow_nonbank'").run();
  // simulate an older backfill voucher under the backfill key for fee 101
  tx(db, () => P.postVoucher(db, { eventDate: "2026-10-24", kind: "backfill", description: "x", sourceKey: "gl:backfill:loan_filing_fee_charges:101",
    lines: [{ account: "2201", tafsiliId: P.ensureTafsili(db, "CU", 41, "c", NOW), debitRial: 3000000 }, { account: "4103", tafsiliId: P.ensureTafsili(db, "PL", 3, "p", NOW), creditRial: 3000000 }] }));
  const a = B.runGlBackfill(db, { apply: true, nowIso: NOW, keepItems: true });
  ok(a.items.find((i) => i.sourceKey === "gl:cash-payment:9").status === "already", "worker-posted event: not posted again");
  ok(a.items.find((i) => i.sourceKey === "gl:filing-fee:101").status === "already", "event with a gl:backfill:<table>:<id> voucher: not posted again");
  ok(n(db, "gl_vouchers", "source_key in ('gl:cash-payment:9')") === 1 && n(db, "gl_vouchers", "source_key in ('gl:filing-fee:101','gl:backfill:loan_filing_fee_charges:101')") === 1, "one voucher each");
  db.exec("BEGIN"); let e = null; try { B.runGlBackfill(db, { apply: true }); } catch (x) { e = x; } db.exec("ROLLBACK");
  ok(e && String(e.message).includes("gl_backfill_in_transaction"), "refused inside a caller transaction");
  const bare = new DatabaseSync(":memory:"); bare.exec(SRC); let e2 = null; try { B.runGlBackfill(bare, { apply: false }); } catch (x) { e2 = x; }
  ok(e2 && String(e2.message).includes("gl_ledger_schema_missing") && n(bare, "sqlite_master", "name like 'gl_%'") === 0, "no ledger schema: refused, nothing created");
  // resume: batch 1 + crash simulated by a failing setting -> rerun finishes
  const db2 = fresh({ nature: false }); opening(db2);
  const f = B.runGlBackfill(db2, { apply: true, nowIso: NOW, batchSize: 2, keepItems: true });
  ok(f.items.some((i) => i.eventType === "P7" && i.status === "skip" && String(i.code).startsWith("finance_setting_missing")), "missing setting: P7 skipped with the reason");
  setting(db2, "discount.development.nature", "revenue_reduction");
  const g = B.runGlBackfill(db2, { apply: true, nowIso: NOW, retrySkipped: true });
  ok(g.created === 3 && g.controls.gl2101Rial === g.controls.opening2101Rial + g.controls.postStartP7PayoutRial, "--retry-skipped finishes the run; 2101 rule still holds");
}

// 4. CLI guard: --apply refused on the configured live DB path
{
  const cli = path.resolve(process.cwd(), "dist/gl-backfill-cli.mjs");
  if (existsSync(cli)) {
    const tmp = `/tmp/gl-backfill-guard-${process.pid}.db`; const d = new DatabaseSync(tmp); d.exec("create table x(a)"); d.close();
    const r = spawnSync(process.execPath, [cli, "--db", tmp, "--apply"], { env: { PATH: process.env.PATH, CRM_DB_PATH: tmp }, encoding: "utf8" });
    ok(r.status === 3 && /apply_refused_on_live/.test(r.stderr), "CLI refuses --apply on the live DB path");
    const r2 = spawnSync(process.execPath, [cli, "--db", "/opt/nafisvam/none.db", "--apply"], { encoding: "utf8" });
    ok(r2.status !== 0, "CLI refuses a missing / live path");
    const r3 = spawnSync(process.execPath, [cli, "--db", tmp, "--forced-post", "/tmp/none-forced.json"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    ok(r3.status === 2 && /gl_forced_post_list_missing/.test(r3.stderr), "CLI refuses without the dated-exception list");
  }
}

// 6. dated exception (pattern of Mohammad's decision t250s795 for live purchase 42): its own P7 after the start
{
  const LIST = [{ seq: 1, purchaseId: 7, reason: "آزمون: تسویه پیش از شروع، دستور پرداخت پس از مبنا", decision: "t-test", decidedBy: "Mohammad", decidedAt: "2026-10-27T01:28+03:30", addedAt: "2026-10-27" }];
  const cuBal = (db, cust) => one(db, "select coalesce(sum(l.credit_rial),0)-coalesce(sum(l.debit_rial),0) n from gl_voucher_lines l join gl_accounts a on a.id=l.account_id join gl_tafsili t on t.id=l.tafsili_id where a.code='2101' and t.type='CU' and t.ref_id=?", cust).n;
  {
    const db = fresh({ late: true }); opening(db);
    const r = B.runGlBackfill(db, { apply: false, excludeFees: [105], nowIso: NOW });
    ok(r.controls.p7Gaps.join() === "6,7", "without the dated exception: #7 is a gap (like live #42)");
  }
  const db = fresh({ late: true }); const exp = opening(db);
  ok(exp === R(180000000) + R(40000000), "#7's order is not in the opening 2101");
  const h = oldHash(db);
  const a = B.runGlBackfill(db, { apply: true, excludeFees: [105], forcedPost: LIST, nowIso: NOW, keepItems: true });
  const v = db.prepare("select id,event_date,description,kind,source_key from gl_vouchers where source_key like 'gl:goods:7:%' order by id").all();
  ok(v.length === 2 && v[0].source_key === "gl:goods:7:settle" && v[1].source_key.startsWith("gl:goods:7:correction:"), "#7: own P7 voucher + its P7C, one each");
  ok(v.every((x) => x.event_date === "2026-10-24" && x.kind === "backfill"), "dated max(start 2026-10-23, order created 2026-10-24) = 2026-10-24");
  ok(v.every((x) => x.description.includes("استثنای تاریخ‌دار #1") && x.description.includes("t-test") && x.description.includes("2026-10-10")), "voucher description: exception #, decision, settled date");
  const ex = db.prepare("select code,note,voucher_id from gl_exceptions where source_type='goods_purchases' and source_id='7' and code like 'gl_forced_post_after_start:%' order by id").all();
  ok(ex.length === 2 && ex[0].code === "gl_forced_post_after_start:1" && ex[0].voucher_id === v[0].id && ex[1].voucher_id === v[1].id, "audit rows in gl_exceptions with the voucher ids");
  ok(ex.every((x) => x.note.includes(`digest=${B.forcedPostDigest(LIST[0])}`) && x.note.includes("t-test") && x.note.includes("Mohammad") && x.note.includes("#5")), "audit note: digest, decision, who, the payment order");
  ok(a.forcedPosts.length === 2 && a.forcedPosts.every((f) => f.postDate === "2026-10-24" && f.settledDate === "2026-10-10" && f.voucherId), "report lists the forced posts");
  const p7lines = db.prepare("select a.code,l.credit_rial c from gl_voucher_lines l join gl_accounts a on a.id=l.account_id where l.voucher_id=? and a.code='2101'").all(v[0].id);
  ok(p7lines.length === 1 && p7lines[0].c === R(70000000) && cuBal(db, 43) === R(70000000), "P7 credits 2101 on the customer's subledger by the payout");
  const c = a.controls;
  ok(c.p7Gaps.join() === "6" && c.p7Overlap.length === 0 && c.forcedPurchases.join() === "7", "no gap for #7, no overlap");
  ok(c.forcedP7PayoutRial === R(70000000) && c.postStartP7PayoutRial === R(60000000) + R(50000000), "forced payout reported apart from the post-start P7");
  ok(bal(db, "2101") === exp + R(60000000) + R(50000000) + R(70000000) && c.gl2101Rial === c.opening2101Rial + c.postStartP7PayoutRial + c.forcedP7PayoutRial, "2101 = opening + post-start P7 + #7 (no gap, no double count)");
  ok(c.tbBalanced, "TB balanced");
  ok(oldHash(db) === h, "old tables (purchase, its ledger rows, its order) unchanged");
  const vc = n(db, "gl_vouchers");
  const a2 = B.runGlBackfill(db, { apply: true, excludeFees: [105], forcedPost: LIST, nowIso: NOW });
  ok(a2.created === 0 && n(db, "gl_vouchers") === vc && a2.controls.forcedPurchases.join() === "7" && a2.controls.gl2101Rial === a2.controls.opening2101Rial + a2.controls.postStartP7PayoutRial + a2.controls.forcedP7PayoutRial, "second apply: 0 new, controls still hold");
  // append-only: an applied entry may not be edited or removed; appending is fine
  let e1 = null; try { B.runGlBackfill(db, { apply: false, forcedPost: [{ ...LIST[0], reason: "x" }], nowIso: NOW }); } catch (x) { e1 = x; }
  ok(e1 && /gl_forced_post_list_not_append_only:seq_1/.test(e1.message), "edited applied entry: refused");
  let e2 = null; try { B.runGlBackfill(db, { apply: false, forcedPost: [], nowIso: NOW }); } catch (x) { e2 = x; }
  ok(e2 && /gl_forced_post_list_not_append_only/.test(e2.message), "removed applied entry: refused");
  const more = [...LIST, { ...LIST[0], seq: 2, purchaseId: 6, decision: "t-test-2" }];
  const am = B.runGlBackfill(db, { apply: false, forcedPost: more, nowIso: NOW, keepItems: true });
  ok(am.created === 1 && am.items.find((i) => i.sourceKey === "gl:goods:6:settle").eventDate === "2026-10-23", "appended entry (#6, earlier skipped, no order): re-opened without --retry-skipped, dated at the start");
  let e3 = null; try { B.validateForcedPostList({ entries: [{ ...LIST[0], seq: 2 }] }); } catch (x) { e3 = x; }
  let e4 = null; try { B.validateForcedPostList({ entries: [LIST[0], { ...LIST[0], seq: 2 }] }); } catch (x) { e4 = x; }
  ok(e3 && e4 && /gl_forced_post_list_invalid/.test(e3.message) && /duplicate_purchase/.test(e4.message), "list validation: seq order, unique purchase");
  // paying the order after the start: P8 brings the subledger to zero, once
  pay(db, 5, "70000000");
  const a3 = B.runGlBackfill(db, { apply: true, excludeFees: [105], forcedPost: LIST, nowIso: NOW });
  ok(a3.created === 1 && cuBal(db, 43) === 0 && a3.controls.gl2101Rial === a3.controls.opening2101Rial + a3.controls.postStartP7PayoutRial + a3.controls.forcedP7PayoutRial - a3.controls.p8PaidRial, "paying #5 (like #37): subledger 0, 2101 rule holds");
  // a forced purchase whose order is already in the opening 2101: refused, status only (never a double count)
  const dbc = fresh(); const expc = opening(dbc);
  const ac = B.runGlBackfill(dbc, { apply: true, excludeFees: [105], forcedPost: [{ ...LIST[0], purchaseId: 2 }], nowIso: NOW, keepItems: true });
  ok(ac.items.find((i) => i.sourceKey === "gl:goods:2:settle").code === "gl_forced_post_conflict:in_opening_2101" && n(dbc, "gl_vouchers", "source_key like 'gl:goods:2:%'") === 0 && bal(dbc, "2101") === expc + R(60000000) + R(50000000), "forced purchase already in the opening: refused");
  // the shipped list: entry #1 = purchase 42, decision t250s795 (pinned digest; editing it fails this fixture)
  const shipped = B.validateForcedPostList(JSON.parse(readFileSync(path.resolve(process.cwd(), "config/gl-backfill-forced-post.json"), "utf8")));
  ok(shipped[0].purchaseId === 42 && shipped[0].decision === "t250s795" && shipped[0].decidedBy === "Mohammad" && B.forcedPostDigest(shipped[0]) === "43a078e9d9961550", `shipped list entry #1 pinned (${B.forcedPostDigest(shipped[0])})`);
}

// 6b. G6c: prefunded_full_credit in the backfill (draft rule, flag OFF) — P7 and P7C share the same company-share account rule
{
  const db = fresh({ method: "prefunded_full_credit" }); opening(db);
  const codes = (r) => r.items.filter((i) => /^gl:goods:\d+:(settle|correction)/.test(i.sourceKey) && i.eventDate > "2026-10-22").map((i) => i.code ?? "post").filter((c) => c !== "gl_in_opening_2101");
  const r = B.runGlBackfill(db, { apply: false, excludeFees: [105], nowIso: NOW, keepItems: true });
  console.log("G6c prefunded OFF codes:", JSON.stringify([...new Set(codes(r))]));
  ok(codes(r).length > 0 && codes(r).every((c) => c === "gl_deferred:deposit_method:prefunded_full_credit"), "backfill, flag OFF: every post-start P7/P7C under prefunded is deferred");
  db.prepare("update gl_settings set value='1' where key='gl.p7_prefunded'").run();
  const r2 = B.runGlBackfill(db, { apply: false, excludeFees: [105], nowIso: NOW, keepItems: true });
  ok(codes(r2).every((c) => c === "gl_account_inactive:2104"), "backfill, flag ON + 2104 inactive: exception, never a guessed voucher");
  db.prepare("update gl_accounts set active=1 where code='2104'").run();
  const r3 = B.runGlBackfill(db, { apply: false, excludeFees: [105], nowIso: NOW, keepItems: true });
  console.log("G6c prefunded ON codes:", JSON.stringify([...new Set(codes(r3))]));
  ok(codes(r3).length > 0 && codes(r3).every((c) => c === "gl_prefunded_insufficient:2104" || c === "gl_prefunded_p7c_without_p7"), "backfill, 2104 active but no deposit: no-negative rule; corrections wait for their P7");
  ok(n(db, "gl_vouchers", "kind='backfill'") === 0, "dry-runs left no backfill voucher");
}

// 5. masked copy (apply only on the copy)
const COPY = process.env.LEDGER_DB_COPY;
if (COPY) {
  ok(COPY.startsWith("/tmp/"), "copy lives under /tmp");
  const db = new DatabaseSync(COPY); db.exec("PRAGMA foreign_keys=ON");
  L.ensureLedgerSchema(db, NOW); S.ensureGlShadowSchema(db, NOW);
  ok(n(db, "gl_vouchers") === 0, "copy: ledger empty before");
  if (!n(db, "gl_fiscal_years")) db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('1405','2026-03-21','2027-03-20',?)").run(NOW);
  setting(db, "gl.ledger_start_date", "2026-10-23"); setting(db, "gl.opening_base_date", "2026-10-22"); setting(db, "discount.development.nature", "revenue_reduction");
  for (const r of db.prepare("select distinct plan_id p from goods_purchases").all()) setting(db, "plan.supplier_deposit_method", "gross", "2026-09-01", r.p);
  const exp = opening(db, 900001, 900002);
  const h = oldHash(db);
  const FEES = [105, 127, 157, 175];
  const FORCED = B.validateForcedPostList(JSON.parse(readFileSync(path.resolve(process.cwd(), "config/gl-backfill-forced-post.json"), "utf8")));
  const d1 = B.runGlBackfill(db, { apply: false, excludeFees: FEES, forcedPost: FORCED, nowIso: NOW }), d2 = B.runGlBackfill(db, { apply: false, excludeFees: FEES, forcedPost: FORCED, nowIso: NOW });
  ok(strip(d1) === strip(d2) && n(db, "gl_posting_queue") === 0, "copy: two identical dry-runs, nothing written");
  const a1 = B.runGlBackfill(db, { apply: true, excludeFees: FEES, forcedPost: FORCED, nowIso: NOW, keepItems: true });
  const c = a1.controls;
  ok(c.tbBalanced, "copy: TB balanced");
  ok(c.p7Overlap.length === 0, "copy: no P7 overlap with the opening 2101");
  ok(c.gl2101Rial === c.opening2101Rial + c.postStartP7PayoutRial + c.forcedP7PayoutRial - c.p8PaidRial && c.opening2101Rial === exp, "copy: 2101 = opening + post-start P7 + purchase 42 (- P8)");
  ok(bal(db, "2101") === c.gl2101Rial && c.p7Gaps.length === 0 && c.forcedPurchases.join() === "42", `copy: no gap left, purchase 42 is the dated exception (gaps ${c.p7Gaps.join(" ") || "-"})`);
  const v42 = db.prepare("select id,event_date,kind,description from gl_vouchers where source_key like 'gl:goods:42:%'").all();
  const cust42 = one(db, "select customer_id c from goods_purchases where id=42").c;
  const o37 = one(db, "select id,amount_toman a,created_at from customer_payment_orders where purchase_id=42");
  const cuBalC = (d) => one(d, "select coalesce(sum(l.credit_rial),0)-coalesce(sum(l.debit_rial),0) n from gl_voucher_lines l join gl_accounts a on a.id=l.account_id join gl_tafsili t on t.id=l.tafsili_id where a.code='2101' and t.type='CU' and t.ref_id=?", cust42).n;
  ok(v42.length === 1 && v42[0].event_date === "2026-10-24" && v42[0].kind === "backfill" && v42[0].description.includes("t250s795") && o37.id === 37, `copy: purchase 42 = one P7 voucher dated 2026-10-24 (order #37's date) citing t250s795`);
  ok(cuBalC(db) === R(o37.a) && c.forcedP7PayoutRial === R(o37.a), "copy: 42's subledger on 2101 = payout = order #37 amount");
  const ex42 = one(db, "select note,voucher_id from gl_exceptions where source_type='goods_purchases' and source_id='42' and code='gl_forced_post_after_start:1'");
  ok(ex42 && ex42.voucher_id === v42[0].id && ex42.note.includes("t250s795") && ex42.note.includes("#37"), "copy: audit row for 42 with the voucher, decision and order #37");
  ok(n(db, "gl_vouchers", "kind='backfill' and event_date<'2026-10-23'") === 0, "copy: no voucher before the start");
  ok(c.gl4103Rial === c.feesInScopeRial && c.gl4101Rial === c.salesInScopeRial && c.gl2102Rial === c.commissionsInScopeRial, "copy: 4103 / 4101 / 2102 match the sources in scope");
  ok(a1.items.filter((i) => i.status === "fail").length === 0, `copy: 0 failed (${a1.items.filter((i) => i.status === "fail").map((i) => i.code).join(",")})`);
  const vc = n(db, "gl_vouchers");
  const a2 = B.runGlBackfill(db, { apply: true, excludeFees: FEES, forcedPost: FORCED, nowIso: NOW });
  ok(a2.created === 0 && n(db, "gl_vouchers") === vc, "copy: second apply 0 new");
  ok(oldHash(db) === h, "copy: old tables unchanged (purchase 42 rows, order #37)");
  ok(one(db, "pragma integrity_check").integrity_check === "ok", "copy: integrity ok");
  // simulate paying #37 on a SECOND throw-away copy (the main copy and every source row stay as they are)
  const PAYCOPY = `${COPY}.pay37.db`; rmSync(PAYCOPY, { force: true }); db.exec(`VACUUM INTO '${PAYCOPY}'`);
  const dp = new DatabaseSync(PAYCOPY); dp.exec("PRAGMA foreign_keys=ON");
  const by = one(dp, "select min(id) i from users").i;
  // the masked copy has no bank accounts: a synthetic one on the throw-away copy only
  const fund = one(dp, "select min(id) i from finance_bank_accounts").i ?? Number(dp.prepare("insert into finance_bank_accounts(bank_name,owner_name,fund_name,iban,owner_type,created_by,created_at) values('آزمون','آزمون','آزمون','IR000000000000000000000000','company',?,?)").run(by, NOW).lastInsertRowid);
  dp.prepare(`insert into accounting_documents(fund_id,document_date,transaction_date,amount_toman,purpose,document_type,transaction_type,source,source_order_id,request_key,request_hash,balance_before_toman,balance_after_toman,created_by,created_at)
    values(?,'2026-10-27','2026-10-27',?,'payment-order','debit','withdrawal','payment_order',37,'payment:37:test','h','0','0',?,?)`).run(fund, o37.a, by, NOW);
  const a3 = B.runGlBackfill(dp, { apply: true, excludeFees: FEES, forcedPost: FORCED, nowIso: NOW });
  ok(a3.created === 1 && cuBalC(dp) === 0 && a3.controls.gl2101Rial === a3.controls.opening2101Rial + a3.controls.postStartP7PayoutRial + a3.controls.forcedP7PayoutRial - a3.controls.p8PaidRial, "copy: paying #37 brings 42's subledger to 0; 2101 rule holds");
  dp.close(); rmSync(PAYCOPY, { force: true });
  const rep = { events: a1.events, created: a1.created, forcedPosts: a1.forcedPosts, byType: a1.byType, accounts: a1.accounts, controls: c, exceptions: a1.exceptions.map((x) => ({ table: x.table, id: x.id, ev: x.eventType, code: x.code })), dryRunCreated: d1.created, secondApplyCreated: a2.created };
  if (process.env.G6_REPORT) writeFileSync(process.env.G6_REPORT, JSON.stringify(rep, null, 2), { mode: 0o600 });
  console.log(`copy: events ${a1.events}, created ${a1.created}, opening2101 ${c.opening2101Rial}, postStartP7 ${c.postStartP7PayoutRial}, gl2101 ${c.gl2101Rial}, gaps ${c.p7Gaps.join(" ") || "-"}, exceptions ${a1.exceptions.length}`);
  db.close();
}
console.log(`gl-backfill fixture: ${pass} checks passed`);
