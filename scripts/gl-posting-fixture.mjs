// G2 posting-library fixture (synthetic in-memory DB; optional masked copy via LEDGER_DB_COPY, read-only checks). No real data printed.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as L from "../src/lib/ledger.ts";
import * as P from "../src/lib/gl-posting.ts";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const throwsCode = (fn, code) => { let e = null; try { fn(); } catch (x) { e = x; } assert.ok(e && String(e.message).includes(code), `check #${pass + 1}: expected ${code}, got ${e && e.message}`); pass++; };
const NOW = "2026-10-26T18:00:00.000Z";
const one = (db, sql, ...p) => db.prepare(sql).get(...p);
const tx = (db, fn) => { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
function fresh() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  db.exec(`CREATE TABLE customer_payment_orders (id INTEGER PRIMARY KEY, amount_toman TEXT NOT NULL, stage TEXT NOT NULL, paid_at TEXT, created_at TEXT NOT NULL)`);
  L.ensureLedgerSchema(db, NOW);
  db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('1405','2026-03-21','2027-03-20',?)").run(NOW);
  return db;
}
const two = (amt, a = "1103", b = "2109") => [{ account: a, debitRial: amt }, { account: b, creditRial: amt }];
const V = (o = {}) => ({ eventDate: "2026-10-23", kind: "auto", description: "آزمون", sourceKey: "gl:test:1", lines: two(1000), nowIso: NOW, ...o });
const setting = (db, key, value, eff = "2026-10-01") => db.prepare("insert into finance_settings(key,scope_type,value,effective_from,changed_by_user_id,reason,created_at) values(?,'global',?,?,7,'آزمون',?)").run(key, value, eff, NOW);

// 1. core posting rules
{
  const db = fresh();
  throwsCode(() => P.postVoucher(db, V()), "gl_no_transaction");
  ok(one(db, "select count(*) n from gl_vouchers").n === 0, "nothing written outside a transaction");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: [{ account: "1103", debitRial: 1000 }, { account: "2109", creditRial: 999 }] }))), "gl_voucher_unbalanced");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: [{ account: "1103", debitRial: 10.5 }, { account: "2109", creditRial: 10.5 }] }))), "gl_bad_amount");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: [{ account: "1103", debitRial: 5, creditRial: 5 }, { account: "2109", creditRial: 0, debitRial: 0 }] }))), "gl_line_side");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: [{ account: "1103", debitRial: 5 }] }))), "gl_voucher_too_few_lines");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: two(5, "1103", "2104") }))), "gl_account_not_postable");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: two(5, "1103", "11") }))), "gl_account_not_postable");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: two(5, "1103", "9999") }))), "gl_account_unknown");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ sourceKey: "bad key" }))), "gl_source_key");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ eventDate: "2026-02-30" }))), "gl_bad_date");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ eventDate: "2027-05-01" }))), "gl_no_fiscal_year");
  const r1 = tx(db, () => P.postVoucher(db, V()));
  ok(r1.created && r1.tempNo === 1 && r1.refNo === "GL-1-000001", "first voucher temp 1");
  ok(one(db, "select count(*) n from gl_voucher_seals where voucher_id=?", r1.voucherId).n === 1, "voucher sealed");
  const r1b = tx(db, () => P.postVoucher(db, V()));
  ok(!r1b.created && r1b.voucherId === r1.voucherId, "same source_key + same lines -> same voucher");
  ok(one(db, "select count(*) n from gl_vouchers").n === 1, "idempotent: still one voucher");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: two(2000) }))), "gl_source_conflict");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ eventDate: "2026-10-24" }))), "gl_source_conflict");
  const r2 = tx(db, () => P.postVoucher(db, V({ sourceKey: "gl:test:2", lines: [{ account: "1103", debitRial: 700 }, { account: "1101", debitRial: 300 }, { account: "2109", creditRial: 1000 }] })));
  ok(r2.tempNo === 2 && one(db, "select line_count n from gl_vouchers where id=?", r2.voucherId).n === 3, "temp_no increments; 3 lines");
  throwsCode(() => db.prepare("update gl_vouchers set description='x' where id=?").run(r1.voucherId), "voucher_immutable");
  throwsCode(() => db.prepare("delete from gl_vouchers where id=?").run(r1.voucherId), "voucher_immutable");
  throwsCode(() => db.prepare("update gl_voucher_lines set debit_rial=1 where voucher_id=?").run(r1.voucherId), "voucher_immutable");
  throwsCode(() => db.prepare("delete from gl_voucher_lines").run(), "voucher_immutable");
  // rollback of the outer tx leaves nothing
  try { tx(db, () => { P.postVoucher(db, V({ sourceKey: "gl:test:3" })); throw new Error("outer_fail"); }); } catch {}
  ok(!one(db, "select 1 x from gl_vouchers where source_key='gl:test:3'"), "outer rollback removes the voucher");
  // period lock
  db.prepare("update gl_fiscal_years set locked_until='2026-10-22'").run();
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ sourceKey: "gl:test:4", eventDate: "2026-10-22" }))), "gl_period_locked");
  ok(tx(db, () => P.postVoucher(db, V({ sourceKey: "gl:test:4", eventDate: "2026-10-23" }))).created, "open day after the lock posts");
  ok(P.isPeriodOpen(db, "2026-10-23") && !P.isPeriodOpen(db, "2026-10-22"), "isPeriodOpen");
}

// 2. tafsili + beneficiary
{
  const db = fresh();
  const cu = tx(db, () => P.ensureTafsili(db, "CU", 41, "مشتری نمونه", NOW));
  ok(tx(db, () => P.ensureTafsili(db, "CU", 41, "دیگر", NOW)) === cu, "ensureTafsili idempotent");
  ok(one(db, "select code,title from gl_tafsili where id=?", cu).code === "CU-41" && one(db, "select title from gl_tafsili where id=?", cu).title === "مشتری نمونه", "tafsili code + title kept");
  throwsCode(() => P.ensureTafsili(db, "XX", 1, "x"), "gl_tafsili_type");
  throwsCode(() => P.ensureTafsili(db, "CU", 0, "x"), "gl_tafsili_ref");
  const sp = tx(db, () => P.ensureTafsili(db, "SP", 3, "فروشنده نمونه", NOW));
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: [{ account: "6101", tafsiliId: sp, debitRial: 50 }, { account: "2102", tafsiliId: cu, creditRial: 50 }] }))), "gl_tafsili_type_mismatch");
  throwsCode(() => tx(db, () => P.postVoucher(db, V({ lines: [{ account: "6101", tafsiliId: sp, debitRial: 50 }, { account: "2102", creditRial: 50 }] }))), "gl_beneficiary_required");
  ok(tx(db, () => P.postVoucher(db, V({ lines: [{ account: "6101", tafsiliId: sp, debitRial: 50 }, { account: "2102", tafsiliId: sp, creditRial: 50 }] }))).created, "2102 with SP posts");
  throwsCode(() => db.prepare("delete from gl_tafsili").run(), "gl_tafsili_immutable");
}

// 3. reversal
{
  const db = fresh();
  const cu = tx(db, () => P.ensureTafsili(db, "CU", 9, "م", NOW));
  const r = tx(db, () => P.postVoucher(db, V({ lines: [{ account: "1103", debitRial: 1200 }, { account: "2201", tafsiliId: cu, creditRial: 1200 }] })));
  throwsCode(() => P.reverseVoucher(db, r.voucherId, { reason: "اشتباه ورود" }), "gl_no_transaction");
  throwsCode(() => tx(db, () => P.reverseVoucher(db, r.voucherId, { reason: "کوتاه" .slice(0, 3) })), "gl_reason_required");
  const rv = tx(db, () => P.reverseVoucher(db, r.voucherId, { reason: "ورود اشتباه", byUserId: 8, nowIso: NOW }));
  const vl = db.prepare("select a.code,l.tafsili_id,l.debit_rial,l.credit_rial from gl_voucher_lines l join gl_accounts a on a.id=l.account_id where voucher_id=? order by line_no").all(rv.voucherId);
  ok(vl[0].code === "1103" && vl[0].credit_rial === 1200 && vl[1].code === "2201" && vl[1].debit_rial === 1200 && vl[1].tafsili_id === cu, "reversal swaps sides, keeps tafsili");
  const rvRow = one(db, "select kind,reverses_voucher_id,source_key from gl_vouchers where id=?", rv.voucherId);
  ok(rvRow.kind === "reversal" && rvRow.reverses_voucher_id === r.voucherId && rvRow.source_key === `gl:reversal:${r.voucherId}`, "reversal row linked");
  ok(!tx(db, () => P.reverseVoucher(db, r.voucherId, { reason: "ورود اشتباه" })).created, "reverse again with same key: idempotent");
  throwsCode(() => tx(db, () => P.reverseVoucher(db, r.voucherId, { reason: "ورود اشتباه", sourceKey: "gl:reversal:other" })), "gl_already_reversed");
  throwsCode(() => tx(db, () => P.reverseVoucher(db, rv.voucherId, { reason: "برگشتِ برگشت" })), "gl_reverse_reversal");
  const net = one(db, "select sum(debit_rial)-sum(credit_rial) n from gl_voucher_lines l join gl_accounts a on a.id=l.account_id where a.code='2201'").n;
  ok(net === 0, "2201 nets to 0 after reversal");
  const r2 = tx(db, () => P.postVoucher(db, V({ sourceKey: "gl:test:9", eventDate: "2026-10-20" })));
  db.prepare("update gl_fiscal_years set locked_until='2026-10-21'").run();
  throwsCode(() => tx(db, () => P.reverseVoucher(db, r2.voucherId, { reason: "دوره قفل است" })), "gl_period_locked");
  ok(tx(db, () => P.reverseVoucher(db, r2.voucherId, { reason: "اصلاح در دوره باز", eventDate: "2026-10-25" })).created, "locked-period voucher reversed in an open date");
}

// 4. non-blocking post + exceptions
{
  const db = fresh();
  db.exec("create table op(x integer)");
  const out = tx(db, () => { db.prepare("insert into op values(1)").run(); return P.postOrQueue(db, { ...V({ sourceKey: "gl:p2:77", lines: two(5, "1103", "2104") }), eventType: "P2", sourceType: "wallet_payment_intents", sourceId: 77 }); });
  ok(out.status === "failed" && one(db, "select count(*) n from op").n === 1, "posting failure does not stop the business write");
  const q = one(db, "select status,attempts,event_type,last_error from gl_posting_queue where source_key='gl:p2:77'");
  ok(q.status === "failed" && q.attempts === 1 && q.event_type === "P2" && q.last_error.includes("gl_account_not_postable"), "failed queue row in the same transaction");
  ok(one(db, "select count(*) n from gl_vouchers").n === 0 && one(db, "select count(*) n from gl_voucher_lines").n === 0, "no partial voucher left");
  tx(db, () => P.postOrQueue(db, { ...V({ sourceKey: "gl:p2:77", lines: two(5, "1103", "2104") }), eventType: "P2" }));
  ok(one(db, "select attempts n from gl_posting_queue where source_key='gl:p2:77'").n === 2, "repeat failure bumps attempts, one row");
  ok(tx(db, () => P.postOrQueue(db, { ...V({ sourceKey: "gl:p2:78" }), eventType: "P2" })).status === "posted", "postOrQueue posts when valid");
  throwsCode(() => P.postOrQueue(db, { ...V({ sourceKey: "gl:p2:79" }), eventType: "P2" }), "gl_no_transaction");
  P.recordGlException(db, "goods_purchases", 5, "finance_setting_missing:plan.supplier_deposit_method", "x", NOW);
  P.recordGlException(db, "goods_purchases", 5, "finance_setting_missing:plan.supplier_deposit_method", "x", NOW);
  ok(one(db, "select count(*) n from gl_exceptions").n === 1, "exception recorded once");
}

// 5. helpers + setting as of a date
{
  const db = fresh();
  ok(P.tehranDateOf("2026-10-22T20:29:59Z") === "2026-10-22" && P.tehranDateOf("2026-10-22T20:30:00Z") === "2026-10-23", "Tehran date boundary 00:00 = 20:30Z");
  ok(P.tomanToRial("12345") === 123450 && P.tomanToRial(7n) === 70, "toman -> rial");
  throwsCode(() => P.tomanToRial("1.5"), "gl_bad_amount");
  ok(P.addDays("2026-10-23", -1) === "2026-10-22" && P.addDays("2027-03-01", -1) === "2027-02-28", "addDays");
  setting(db, "discount.development.rate_bp", "500", "2026-10-01");
  setting(db, "discount.development.rate_bp", "700", "2026-10-20");
  ok(L.financeSettingAsOf(db, "discount.development.rate_bp", "2026-10-19") === "500" && L.financeSettingAsOf(db, "discount.development.rate_bp", "2026-10-20") === "700", "setting read as of the event date");
  ok(L.financeSettingAsOf(db, "discount.development.rate_bp", "2026-09-30") === null, "no value before first effective date");
}

// 6. opening voucher
{
  const db = fresh();
  const acc = (c) => one(db, "select id from gl_accounts where code=?", c).id;
  const TODAY = "2026-10-26";
  const set = (by = 5) => Number(db.prepare("insert into gl_opening_balance_sets(as_of_date,entered_by_user_id,reason,created_at) values('2026-10-22',?,'افتتاحیه نمونه',?)").run(by, NOW).lastInsertRowid);
  const line = (s, code, d, c, tf = null) => db.prepare("insert into gl_opening_balance_lines(set_id,account_id,tafsili_id,debit_rial,credit_rial,created_at) values(?,?,?,?,?,?)").run(s, acc(code), tf, d, c, NOW);
  // orders: 1 open (created before base end), 2 paid in system before base (excluded), 3 open but created after base (excluded), 4 open with pre-start prior payment (excluded)
  const O = db.prepare("insert into customer_payment_orders(id,amount_toman,stage,paid_at,created_at) values(?,?,?,?,?)");
  O.run(1, "1000", "awaiting_payment", null, "2026-10-20T08:00:00Z");
  O.run(2, "500", "paid", "2026-10-21T08:00:00Z", "2026-10-19T08:00:00Z");
  O.run(3, "300", "awaiting_payment", null, "2026-10-22T20:31:00Z");
  O.run(4, "200", "awaiting_payment", null, "2026-10-18T08:00:00Z");
  O.run(5, "50", "paid", "2026-10-24T08:00:00Z", "2026-10-22T20:00:00Z");
  const s1 = set();
  ok(P.openingBaseDate(db, TODAY).code === "finance_setting_missing:gl.ledger_start_date", "base date: start setting missing");
  setting(db, "gl.ledger_start_date", "2026-10-23");
  ok(P.openingBaseDate(db, TODAY).code === "finance_setting_missing:gl.opening_base_date", "base date: base setting missing");
  setting(db, "gl.opening_base_date", "2026-10-21");
  ok(P.openingBaseDate(db, TODAY).code === "gl_opening_base_not_day_before_start", "base date must be the day before the start");
  setting(db, "gl.opening_base_date", "2026-10-22", "2026-10-02");
  const b = P.openingBaseDate(db, TODAY); ok(b.ok && b.baseDate === "2026-10-22" && b.ledgerStartDate === "2026-10-23", "base date read from settings");
  ok(P.opening2101Check(db, s1, "2026-10-22").status === "no_draft", "2101: no draft line yet");
  // pre-start prior payment for order 4 (before any opening lines exist -> mismatch flag 0)
  db.prepare(`insert into payment_order_prior_payments(payment_order_id,paid_date,tracking_no,amount_rial,receipt_filename,receipt_mime,receipt_sha256,entered_by_user_id,reason,created_at,ledger_start_date,pre_start,opening_mismatch)
    values(4,'2026-10-15','TRK-1111',2000,'r.png','image/png',?,5,'پرداخت بیرون از سامانه',?,'2026-10-23',1,0)`).run("a".repeat(64), NOW);
  line(s1, "1102", 7000 + 5000, 0); line(s1, "2101", 0, 10500); line(s1, "3104", 0, 1500);
  let c = P.opening2101Check(db, s1, "2026-10-22");
  ok(c.expectedRial === 10500 && c.draftRial === 10500 && c.prePaidOrders === 1 && c.openOrders === 3, "2101 expected = open orders net of pre-start payments (incl. paid after base)");
  ok(c.status === "step4_pending", "step 4 not confirmed -> pending");
  let r = P.openingApprovalReadiness(db, s1, 6, TODAY);
  ok(!r.ok && r.reasons.includes("gl_opening_prior_payments_unconfirmed") && r.reasons.includes("gl_opening_step4_pending"), "approve locked until step 4 confirmed");
  throwsCode(() => tx(db, () => P.approveOpeningSet(db, s1, 6, TODAY, NOW)), "gl_opening_prior_payments_unconfirmed");
  db.prepare("update gl_opening_balance_sets set prior_payments_confirmed_by_user_id=5, prior_payments_confirmed_at=? where id=?").run(NOW, s1);
  ok(P.openingApprovalReadiness(db, s1, 6, TODAY).ok, "ready after step 4 and 2101 match");
  ok(P.openingApprovalReadiness(db, s1, 5, TODAY).reasons.includes("gl_opening_second_person_required"), "same person cannot approve");
  throwsCode(() => tx(db, () => P.approveOpeningSet(db, s1, 5, TODAY, NOW)), "gl_opening_second_person_required");
  // a new open order created before base end -> mismatch
  O.run(6, "100", "awaiting_payment", null, "2026-10-21T09:00:00Z");
  c = P.opening2101Check(db, s1, "2026-10-22"); ok(c.status === "mismatch" && c.expectedRial === 11500, "2101 mismatch detected");
  throwsCode(() => tx(db, () => P.approveOpeningSet(db, s1, 6, TODAY, NOW)), "gl_opening_2101_mismatch");
  db.prepare("update customer_payment_orders set stage='paid', paid_at='2026-10-21T10:00:00Z' where id=6").run();
  // locked sub-ledger account in a set
  const s2 = set(); line(s2, "1102", 100, 0); line(s2, "2201", 0, 100);
  ok(P.openingApprovalReadiness(db, s2, 6, TODAY).reasons.some((x) => x.startsWith("gl_opening_locked_account:2201")), "sub-ledger account 2201 locked in opening");
  // approve s1
  const v = tx(db, () => P.approveOpeningSet(db, s1, 6, TODAY, NOW));
  const vr = one(db, "select kind,event_date,created_by_user_id,approved_by_user_id,source_key,total_rial from gl_vouchers where id=?", v.voucherId);
  ok(vr.kind === "opening" && vr.event_date === "2026-10-22" && vr.created_by_user_id === 5 && vr.approved_by_user_id === 6 && vr.source_key === `gl:opening:${s1}` && vr.total_rial === 12000, "opening voucher posted on the base date by the second person");
  ok(one(db, "select voucher_id from gl_opening_balance_sets where id=?", s1).voucher_id === v.voucherId, "set linked to voucher");
  ok(P.openingApprovalReadiness(db, s2, 6, TODAY).reasons.includes("gl_opening_exists"), "only one opening voucher");
  throwsCode(() => db.prepare("update gl_opening_balance_sets set approved_by_user_id=7 where id=?").run(s1), "gl_append_only");
  // as_of_date not equal to base date
  const s3 = Number(db.prepare("insert into gl_opening_balance_sets(as_of_date,entered_by_user_id,reason,created_at) values('2026-10-21',5,'تاریخ دیگر',?)").run(NOW).lastInsertRowid);
  ok(P.openingApprovalReadiness(db, s3, 6, TODAY).reasons.includes("gl_opening_as_of_not_base_date"), "set date must equal the base date setting");
  ok(one(db, "pragma integrity_check").integrity_check === "ok" && db.prepare("pragma foreign_key_check").all().length === 0, "integrity after opening tests");
}

// 7. optional masked copy: library runs on the real schema; everything rolled back; old tables untouched
if (process.env.LEDGER_DB_COPY) {
  const db = new DatabaseSync(process.env.LEDGER_DB_COPY); db.exec("PRAGMA foreign_keys=ON");
  L.ensureLedgerSchema(db);
  const counts = () => JSON.stringify(db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map((r) => [r.name, one(db, `select count(*) n from "${r.name}"`).n]));
  const c0 = counts();
  ok(one(db, "select count(*) n from gl_vouchers").n === 0, "copy: ledger empty");
  const chk = P.opening2101Check(db, null, "2026-10-22");
  ok(chk.status === "no_draft" && Number.isSafeInteger(chk.expectedRial) && chk.openOrders >= 0, "copy: 2101 check runs on real payment orders (read-only)");
  db.exec("BEGIN");
  try {
    db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('t','2026-03-21','2027-03-20',?)").run(NOW);
    const t = P.ensureTafsili(db, "CU", 1, "t", NOW);
    ok(P.postVoucher(db, V({ lines: [{ account: "1103", debitRial: 10 }, { account: "2201", tafsiliId: t, creditRial: 10 }] })).created, "copy: posts inside a transaction");
  } finally { db.exec("ROLLBACK"); }
  ok(c0 === counts(), "copy: all row counts unchanged after rollback");
  ok(one(db, "pragma integrity_check").integrity_check === "ok", "copy integrity ok");
}
console.log(`gl-posting fixture: ${pass} checks passed`);
