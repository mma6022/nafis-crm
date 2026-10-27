// G1 ledger schema fixture (synthetic, in-memory DB + optional masked copy via LEDGER_DB_COPY). No real data printed.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as L from "../src/lib/ledger.ts";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const throwsCode = (fn, code) => { let e = null; try { fn(); } catch (x) { e = x; } assert.ok(e && String(e.message).includes(code), `check #${pass + 1}: expected ${code}, got ${e && e.message}`); pass++; };
const NOW = "2026-10-26T18:00:00.000Z";

function fresh() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  L.ensureLedgerSchema(db, NOW); return db;
}
const one = (db, sql, ...p) => db.prepare(sql).get(...p);
const all = (db, sql, ...p) => db.prepare(sql).all(...p);

// 1. idempotent: run twice, identical schema + seed
{
  const db = fresh();
  const snap = () => JSON.stringify(all(db, "select type,name,sql from sqlite_master order by type,name")) + JSON.stringify(all(db, "select code,title,active,postable from gl_accounts order by code")) + JSON.stringify(all(db, "select * from gl_settings order by key"));
  const a = snap(); L.ensureLedgerSchema(db, "2027-01-01T00:00:00.000Z"); L.ensureLedgerSchema(db); ok(a === snap(), "ensure is idempotent");
  for (const t of L.LEDGER_TABLES) ok(one(db, "select 1 x from sqlite_master where type='table' and name=?", t), `table ${t}`);
  ok(one(db, "select count(*) n from schema_migrations where version=?", L.LEDGER_MIGRATION).n === 1, "migration marker once");
  ok(one(db, "pragma integrity_check").integrity_check === "ok", "integrity");
  ok(all(db, "pragma foreign_key_check").length === 0, "fk check");
  // flags all OFF
  const f = L.readGlFlags(db); ok(Object.keys(f).length === 6 /* G5: + gl.reports, gl.nightly_compare; G6c: + gl.p7_prefunded */ && Object.values(f).every(v => v === false), "all gl flags OFF");
  ok(f["gl.p7_prefunded"] === false, "G6c: gl.p7_prefunded seeded OFF");
  ok(all(db, "select value from gl_settings").every(r => r.value === "0"), "gl_settings rows all 0");
  // coding
  ok(one(db, "select count(*) n from gl_accounts where level='kol'").n === 12, "12 kol");
  ok(one(db, "select count(*) n from gl_accounts where level='moein'").n === 34, "34 moein");
  ok(one(db, "select title from gl_accounts where code='6203'").title.includes("گرد"), "6203 rounding account");
  ok(one(db, "select nature from gl_accounts where code='3102'").nature === "both", "3102 owner current both");
  ok(all(db, "select code from gl_accounts where active=0 order by code").map(r => r.code).join() === "1202,2104,2301,4104,6103,6104", "inactive pending accounts");
  ok(one(db, "select count(*) n from gl_accounts m join gl_accounts k on k.id=m.parent_id where m.level='moein' and substr(m.code,1,2)<>k.code").n === 0, "parents match codes");
  ok(one(db, "select count(*) n from gl_fiscal_years").n === 0 && one(db, "select count(*) n from treasury_accounts").n === 0, "no fiscal year / treasury seeded (Q5 / Q1 pending)");
  ok(one(db, "select count(*) n from gl_vouchers").n === 0, "no vouchers");
}

// 2. integrity triggers
{
  const db = fresh();
  const acc = c => one(db, "select id from gl_accounts where code=?", c).id;
  db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('1405','2026-03-21','2027-03-20',?)").run(NOW);
  const fy = one(db, "select id from gl_fiscal_years").id;
  const V = (o = {}) => db.prepare(`insert into gl_vouchers(fiscal_year_id,ref_no,temp_no,event_date,kind,description,source_key,reverses_voucher_id,total_rial,line_count,created_at,final_seq,final_period,created_by_user_id,approved_by_user_id)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.fy ?? fy, o.ref ?? `GL-${Math.random().toString(36).slice(2, 10)}`, o.temp ?? 1, o.date ?? "2026-10-23", o.kind ?? "auto", "t", o.key ?? null, o.rev ?? null, o.total ?? 9000000, o.lines ?? 2, NOW, o.fseq ?? null, o.fper ?? null, o.by ?? null, o.ap ?? null).lastInsertRowid;
  const Ln = (v, no, code, d, c) => db.prepare("insert into gl_voucher_lines(voucher_id,line_no,account_id,debit_rial,credit_rial) values(?,?,?,?,?)").run(v, no, acc(code), d, c);
  const seal = v => db.prepare("insert into gl_voucher_seals(voucher_id,sealed_at) values(?,?)").run(v, NOW);

  const v1 = V({ key: "gl:test:1" }); Ln(v1, 1, "1103", 9000000, 0); Ln(v1, 2, "2201", 0, 9000000); seal(v1);
  ok(one(db, "select count(*) n from gl_voucher_seals").n === 1, "balanced voucher seals");
  throwsCode(() => Ln(v1, 3, "2201", 1, 0), "gl_voucher_sealed");
  const v2 = V({ temp: 2 }); Ln(v2, 1, "1103", 9000000, 0); Ln(v2, 2, "2201", 0, 8999999);
  throwsCode(() => seal(v2), "gl_voucher_unbalanced");
  const v3 = V({ temp: 3, lines: 3 }); Ln(v3, 1, "1103", 9000000, 0); Ln(v3, 2, "2201", 0, 8999999); Ln(v3, 3, "6203", 0, 1); seal(v3);
  ok(true, "rounding remainder on one 6203 line balances the same voucher");
  throwsCode(() => V({ temp: 4, key: "gl:test:1" }), "UNIQUE");
  throwsCode(() => V({ temp: 3 }), "UNIQUE");
  throwsCode(() => V({ temp: 5, total: 1.5 }), "CHECK");
  throwsCode(() => V({ temp: 5, total: "9e" }), "CHECK"); // numeric text is coerced by INTEGER affinity; non-numeric text is rejected
  const v6 = V({ temp: 6 }); throwsCode(() => Ln(v6, 1, "1103", 100.5, 0), "CHECK");
  throwsCode(() => Ln(v6, 1, "1103", 100, 100), "CHECK");
  throwsCode(() => Ln(v6, 1, "1103", 0, 0), "CHECK");
  throwsCode(() => Ln(v6, 1, "11", 100, 0), "gl_account_not_postable");
  throwsCode(() => Ln(v6, 1, "2301", 100, 0), "gl_account_not_postable");
  // payable to a person (2102 / marketing 6103) needs the person's SP tafsili, except in the opening voucher (control totals)
  const T = (type, code) => db.prepare("insert into gl_tafsili(type,ref_id,code,title,created_at) values(?,?,?,?,?)").run(type, null, code, "t", NOW).lastInsertRowid;
  const tSP = T("SP", "SP-T1"), tCU = T("CU", "CU-T1");
  const LnT = (v, no, code, d, c, t) => db.prepare("insert into gl_voucher_lines(voucher_id,line_no,account_id,tafsili_id,debit_rial,credit_rial) values(?,?,?,?,?,?)").run(v, no, acc(code), t, d, c);
  const v7 = V({ temp: 907 });
  throwsCode(() => Ln(v7, 1, "2102", 0, 100), "gl_beneficiary_required");
  throwsCode(() => LnT(v7, 1, "2102", 0, 100, tCU), "gl_beneficiary_required");
  ok(LnT(v7, 1, "2102", 0, 100, tSP).changes === 1, "2102 payable with SP beneficiary accepted");
  const v8 = V({ temp: 908, kind: "opening" }); ok(Ln(v8, 1, "2102", 0, 100).changes === 1, "opening control total on 2102 needs no tafsili");
  // immutability
  throwsCode(() => db.prepare("update gl_vouchers set total_rial=1 where id=?").run(v1), "voucher_immutable");
  throwsCode(() => db.prepare("update gl_vouchers set event_date='2026-10-24' where id=?").run(v1), "voucher_immutable");
  throwsCode(() => db.prepare("update gl_vouchers set ref_no='GL-XXXX' where id=?").run(v1), "voucher_immutable");
  throwsCode(() => db.prepare("delete from gl_vouchers where id=?").run(v1), "voucher_immutable");
  throwsCode(() => db.prepare("update gl_voucher_lines set debit_rial=1 where voucher_id=?").run(v1), "voucher_immutable");
  throwsCode(() => db.prepare("delete from gl_voucher_lines where voucher_id=?").run(v1), "voucher_immutable");
  throwsCode(() => db.prepare("delete from gl_voucher_seals where voucher_id=?").run(v1), "voucher_immutable");
  // final number: never at insert; only sealed + locked period; once
  throwsCode(() => V({ temp: 7, fseq: 1, fper: 8 }), "gl_final_no_at_close_only");
  throwsCode(() => db.prepare("update gl_vouchers set final_period=8, final_seq=1 where id=?").run(v1), "gl_final_requires_locked_period");
  db.prepare("update gl_fiscal_years set locked_until='2026-10-31' where id=?").run(fy);
  throwsCode(() => db.prepare("update gl_vouchers set final_period=8, final_seq=1 where id=?").run(v2), "gl_final_requires_seal");
  db.prepare("update gl_vouchers set final_period=8, final_seq=1, finalized_at=? where id=?").run(NOW, v1);
  ok(one(db, "select final_seq from gl_vouchers where id=?", v1).final_seq === 1, "final number set once at close");
  throwsCode(() => db.prepare("update gl_vouchers set final_seq=2 where id=?").run(v1), "voucher_final");
  throwsCode(() => db.prepare("update gl_vouchers set final_period=8, final_seq=1 where id=?").run(v3), "UNIQUE");
  // period lock
  throwsCode(() => V({ temp: 8, date: "2026-10-30" }), "gl_period_locked");
  throwsCode(() => V({ temp: 8, date: "2027-04-01" }), "gl_fiscal_year_mismatch");
  ok(V({ temp: 8, date: "2026-11-01" }) > 0, "insert after the lock is fine");
  throwsCode(() => db.prepare("update gl_fiscal_years set locked_until='2026-09-30' where id=?").run(fy), "gl_period_unlock_forbidden");
  throwsCode(() => db.prepare("update gl_fiscal_years set locked_until=NULL where id=?").run(fy), "gl_period_unlock_forbidden");
  // reversal + maker/checker
  throwsCode(() => V({ temp: 9, kind: "reversal", date: "2026-11-02" }), "CHECK");
  ok(V({ temp: 9, kind: "reversal", rev: v1, date: "2026-11-02" }) > 0, "reversal references original");
  throwsCode(() => V({ temp: 10, kind: "reversal", rev: v1, date: "2026-11-02" }), "UNIQUE");
  throwsCode(() => V({ temp: 11, date: "2026-11-02", by: 5, ap: 5 }), "CHECK");
  throwsCode(() => db.prepare("insert into gl_voucher_drafts(kind,created_by_user_id,decided_by_user_id,created_at,updated_at) values('manual',4,4,?,?)").run(NOW, NOW), "CHECK");
  // accounts in use
  throwsCode(() => db.prepare("update gl_accounts set nature='credit' where code='1103'").run(), "gl_account_in_use");
  db.prepare("update gl_accounts set title=title where code='1103'").run(); ok(true, "title edit allowed");
  throwsCode(() => db.prepare("delete from gl_accounts where code='6209'").run(), "gl_account_immutable");
  // treasury + statements + reconciliation
  db.prepare("insert into treasury_accounts(kind,code,title,sheba,purpose,owner_type,created_at) values('bank','BK01','بانک نمونه','IR000000000000000000000001','[\"general\"]','company',?)").run(NOW);
  throwsCode(() => db.prepare("insert into treasury_accounts(kind,code,title,finance_bank_account_id,purpose,owner_type,created_at) values('cash_box','CB01','صندوق',3,'[\"petty_cash\"]','company',?)").run(NOW), "CHECK");
  const t = one(db, "select id from treasury_accounts").id;
  const S = (h, a) => db.prepare("insert into bank_statement_lines(treasury_account_id,import_batch,txn_date,amount_rial,row_hash,created_at) values(?,?,?,?,?,?)").run(t, "b1", "2026-10-23", a, h, NOW).lastInsertRowid;
  const s1 = S("h1", 90000000);
  throwsCode(() => S("h1", 90000000), "UNIQUE");
  throwsCode(() => S("h2", 0), "CHECK");
  throwsCode(() => db.prepare("update bank_statement_lines set amount_rial=1 where id=?").run(s1), "gl_append_only");
  const vl = one(db, "select id from gl_voucher_lines where voucher_id=? and line_no=1", v1).id;
  const M = () => db.prepare("insert into bank_reconciliation_matches(statement_line_id,voucher_line_id,method,created_at) values(?,?,'manual',?)").run(s1, vl, NOW).lastInsertRowid;
  const m1 = M(); throwsCode(() => M(), "bank_line_already_matched");
  db.prepare("insert into bank_reconciliation_unmatches(match_id,reason,created_at) values(?,?,?)").run(m1, "test", NOW);
  ok(M() > 0, "rematch after unmatch row");
  throwsCode(() => db.prepare("delete from bank_reconciliation_matches where id=?").run(m1), "gl_append_only");
  ok(one(db, "pragma integrity_check").integrity_check === "ok" && all(db, "pragma foreign_key_check").length === 0, "integrity after tests");
}

// 4. v1b: admin-entered finance inputs (effective-dated, append-only), treasury SHEBA/purpose, opening balances, prior payments
{
  const db = fresh();
  for (const t of L.FINANCE_TABLES) ok(one(db, "select 1 x from sqlite_master where type='table' and name=?", t), `table ${t}`);
  ok(one(db, "select count(*) n from schema_migrations where version=?", L.FINANCE_MIGRATION).n === 1, "v1b marker");
  ok(one(db, "select count(*) n from finance_setting_keys").n === L.FINANCE_SETTING_KEYS.length, "key catalog seeded");
  ok(one(db, "select count(*) n from finance_settings").n === 0, "no business value hard-coded (admin enters them)");
  ok(one(db, "select title from gl_accounts where code='6203'").title === "اختلاف گرد کردن", "6203 approved title");
  ok(L.readGlFlags(db) && Object.values(L.readGlFlags(db)).every(v => v === false), "flags still OFF");
  const SET = (key, value, from, o = {}) => db.prepare("insert into finance_settings(key,scope_type,scope_id,value,effective_from,changed_by_user_id,reason,created_at) values(?,?,?,?,?,?,?,?)")
    .run(key, o.scope ?? "global", o.id ?? null, value, from, ("by" in o ? o.by : 7), o.reason ?? "ورود مدیر", NOW).lastInsertRowid;
  // as-of resolution
  ok(L.financeSettingAsOf(db, "gl.opening_base_date", "2026-10-26") === null, "unset -> null (no default)");
  SET("gl.opening_base_date", "2026-10-22", "2026-10-22");
  ok(L.financeSettingAsOf(db, "gl.opening_base_date", "2026-10-26") === "2026-10-22", "opening base date from a setting");
  SET("tax.vat.rate_bp", "900", "2026-01-01"); SET("tax.vat.rate_bp", "1000", "2026-11-01");
  ok(L.financeSettingAsOf(db, "tax.vat.rate_bp", "2026-10-31") === "900", "as of event date: old rate");
  ok(L.financeSettingAsOf(db, "tax.vat.rate_bp", "2026-11-01") === "1000", "as of event date: new rate");
  ok(L.financeSettingAsOf(db, "tax.vat.rate_bp", "2025-12-31") === null, "before first effective_from: null");
  SET("tax.vat.rate_bp", "1000", "2026-01-01", { reason: "اصلاح ورود اشتباه" });
  ok(L.financeSettingAsOf(db, "tax.vat.rate_bp", "2026-06-01") === "1000", "same-date correction: later row wins");
  ok(one(db, "select count(*) n from finance_settings where key='tax.vat.rate_bp'").n === 3, "corrections are new rows");
  const lg = all(db, "select old_value,new_value from finance_settings_log where key='tax.vat.rate_bp' order by id");
  ok(lg.length === 3 && lg[0].old_value === null && lg[1].old_value === "900" && lg[2].old_value === "900" && lg[2].new_value === "1000", "change log old -> new");
  throwsCode(() => db.prepare("update finance_settings set value='0'").run(), "gl_append_only");
  throwsCode(() => db.prepare("delete from finance_settings").run(), "gl_append_only");
  throwsCode(() => db.prepare("update finance_settings_log set reason='x'").run(), "gl_append_only");
  throwsCode(() => db.prepare("delete from finance_settings_log").run(), "gl_append_only");
  // per-type validation
  throwsCode(() => SET("tax.vat.rate_bp", "10001", "2026-01-01"), "finance_setting_invalid_value");
  throwsCode(() => SET("tax.vat.rate_bp", "9.5", "2026-01-01"), "finance_setting_invalid_value");
  throwsCode(() => SET("fee.inquiry.amount_rial", "-5", "2026-01-01"), "finance_setting_invalid_value");
  ok(SET("fee.inquiry.amount_rial", "1500000", "2026-01-01") > 0, "rial amount accepted");
  throwsCode(() => SET("fee.inquiry.payer", "bank", "2026-01-01"), "finance_setting_invalid_value");
  ok(SET("fee.inquiry.payer", "customer", "2026-01-01") > 0, "enum accepted");
  throwsCode(() => SET("gl.ledger_start_date", "1405-08-01x", "2026-01-01"), "finance_setting_invalid_value");
  throwsCode(() => SET("gl.fiscal_year_start_jalali", "13-01", "2026-01-01"), "finance_setting_invalid_value");
  ok(SET("gl.fiscal_year_start_jalali", "01-01", "2026-01-01") > 0, "jalali mm-dd accepted");
  throwsCode(() => SET("tax.vat.applies", "yes", "2026-01-01"), "finance_setting_invalid_value");
  throwsCode(() => SET("finance.approver_role", "Admin Role", "2026-01-01"), "finance_setting_invalid_value");
  throwsCode(() => SET("no.such.key", "1", "2026-01-01"), "finance_setting_unknown_key");
  throwsCode(() => SET("sms.payment_link_enabled", "1", "2026-01-01"), "finance_setting_managed_elsewhere");
  throwsCode(() => SET("tax.vat.rate_bp", "900", "2026-01-01", { reason: "  " }), "CHECK");
  throwsCode(() => SET("tax.vat.rate_bp", "900", "2026-01-01", { by: null }), "NOT NULL");
  throwsCode(() => SET("tax.vat.rate_bp", "900", "2026/01/01"), "CHECK");

  // Salamatian final lists (2026-10-26 23:02)
  const K = (k) => one(db, "select allowed_values a, list_status s, ui_preselect p from finance_setting_keys where key=?", k);
  ok(JSON.parse(K("plan.supplier_deposit_method").a).join() === "gross,net_of_fees,to_customer_direct,prefunded_full_credit" && K("plan.supplier_deposit_method").s === "final", "deposit method: 4 final values");
  ok(K("discount.development.nature").s === "final" && K("discount.development.nature").p === "revenue_reduction", "discount nature final; wizard preselect only");
  ok(K("plan.supplier_deposit_method").p === "prefunded_full_credit", "G6c: deposit method preselect = prefunded_full_credit (wizard only)");
  ok(one(db, "select count(*) n from finance_settings where key='plan.supplier_deposit_method'").n === 0, "G6c: deposit-method preselect is not a stored value");
  ok(L.financeSettingAsOf(db, "plan.supplier_deposit_method", "2026-10-26", { type: "loan_plan", id: 5 }) === null, "G6c: unset method reads null (no hardcoded default)");
  ok(K("fee.inquiry.payer").s === "proposed" && K("fee.inquiry.payer").p === null, "other lists stay proposed");
  ok(one(db, "select count(*) n from finance_settings where key like 'discount.%'").n === 0, "preselect is not a stored value");
  SET("plan.supplier_deposit_method", "prefunded_full_credit", "2026-10-01", { scope: "loan_plan", id: 5 });
  ok(L.financeSettingAsOf(db, "plan.supplier_deposit_method", "2026-10-26", { type: "loan_plan", id: 5 }) === "prefunded_full_credit", "prefunded_full_credit accepted");
  throwsCode(() => db.prepare("insert into finance_setting_keys(key,value_type,allowed_values,scope_type,title,list_status,ui_preselect,created_at) values('x.y','enum','[\"a\"]','global','t','final','b',?)").run(NOW), "finance_setting_preselect_invalid");
  throwsCode(() => L.assertDevelopmentDiscountInputs("marketing_expense", null), "discount_beneficiary_required");
  throwsCode(() => L.assertDevelopmentDiscountInputs(null, 3), "finance_setting_missing");
  L.assertDevelopmentDiscountInputs("revenue_reduction", null); L.assertDevelopmentDiscountInputs("marketing_expense", 3); ok(true, "discount validator");
  ok(all(db, "select code from gl_accounts where code in ('2104','6103','6104') and active=0").length === 3, "rule accounts seeded inactive");
  // per-plan scope
  throwsCode(() => SET("plan.supplier_deposit_method", "gross", "2026-01-01"), "finance_setting_scope");
  throwsCode(() => SET("tax.vat.rate_bp", "900", "2026-01-01", { scope: "loan_plan", id: 3 }), "finance_setting_scope");
  SET("plan.supplier_deposit_method", "gross", "2026-01-01", { scope: "loan_plan", id: 3 });
  SET("plan.supplier_deposit_method", "net_of_fees", "2026-01-01", { scope: "loan_plan", id: 4 });
  ok(L.financeSettingAsOf(db, "plan.supplier_deposit_method", "2026-10-26", { type: "loan_plan", id: 3 }) === "gross"
    && L.financeSettingAsOf(db, "plan.supplier_deposit_method", "2026-10-26", { type: "loan_plan", id: 4 }) === "net_of_fees", "per-plan values");
  ok(L.financeSettingAsOf(db, "plan.supplier_deposit_method", "2026-10-26") === null, "no global fallback for per-plan key");
  // key catalog guarded once in use; no retro-change into a locked period
  throwsCode(() => db.prepare("update finance_setting_keys set value_type='int' where key='tax.vat.rate_bp'").run(), "finance_setting_key_in_use");
  throwsCode(() => db.prepare("delete from finance_setting_keys where key='gl.ledger_start_date'").run(), "gl_append_only");
  db.prepare("insert into gl_fiscal_years(title,start_date,end_date,locked_until,created_at) values('1405','2026-03-21','2027-03-20','2026-09-30',?)").run(NOW);
  throwsCode(() => SET("tax.vat.rate_bp", "800", "2026-09-01"), "gl_period_locked");
  ok(SET("tax.vat.rate_bp", "800", "2026-10-01") > 0, "change after lock accepted");
  // treasury: SHEBA + purpose
  const T = (kind, code, sheba, purpose = '["general"]') => db.prepare("insert into treasury_accounts(kind,code,title,sheba,purpose,owner_type,created_at) values(?,?,?,?,?,'company',?)").run(kind, code, "نمونه", sheba, purpose, NOW).lastInsertRowid;
  throwsCode(() => T("bank", "BK01", null), "treasury_bank_sheba_required");
  throwsCode(() => T("bank", "BK01", "IR12"), "treasury_bank_sheba_required");
  throwsCode(() => T("bank", "BK01", "ir000000000000000000000001"), "treasury_bank_sheba_required");
  const bk = T("bank", "BK01", "IR000000000000000000000001", '["customer_payouts","supplier_receipts"]');
  throwsCode(() => T("bank", "BK02", "IR000000000000000000000001"), "UNIQUE");
  throwsCode(() => T("cash_box", "CB01", "IR000000000000000000000002", '["petty_cash"]'), "treasury_cash_box_no_sheba");
  const cb = T("cash_box", "CB01", null, '["petty_cash"]');
  throwsCode(() => T("bank", "BK03", "IR000000000000000000000003", '[]'), "treasury_purpose_invalid");
  throwsCode(() => T("bank", "BK03", "IR000000000000000000000003", '["loans"]'), "treasury_purpose_invalid");
  throwsCode(() => T("bank", "BK03", "IR000000000000000000000003", null), "treasury_purpose_invalid");
  throwsCode(() => db.prepare("update treasury_accounts set sheba=NULL where id=?").run(bk), "treasury_bank_sheba_required");
  throwsCode(() => db.prepare("update treasury_accounts set sheba='IR000000000000000000000009' where id=?").run(cb), "treasury_cash_box_no_sheba");
  throwsCode(() => db.prepare("update treasury_accounts set kind='bank' where id=?").run(cb), "treasury_bank_sheba_required");
  db.prepare("update treasury_accounts set title='نمونه ۲' where id=?").run(bk); ok(true, "plain title edit allowed");
  // N8: owner_type company | owner_person (+ stored acknowledgment)
  const TO = (code, sheba, o = {}) => db.prepare("insert into treasury_accounts(kind,code,title,sheba,purpose,ownership,owner_type,owner_ack,owner_ack_by_user_id,owner_ack_at,owner_ack_text,created_at) values('bank',?,?,?,'[\"general\"]',?,?,?,?,?,?,?)")
    .run(code, "نمونه", sheba, o.own ?? "owner", "type" in o ? o.type : "owner_person", o.ack ?? 1, "by" in o ? o.by : 7, o.at ?? NOW, o.text ?? L.OWNER_PERSON_ACK_TEXT, NOW).lastInsertRowid;
  throwsCode(() => db.prepare("insert into treasury_accounts(kind,code,title,sheba,purpose,created_at) values('bank','BK04','x','IR000000000000000000000004','[\"general\"]',?)").run(NOW), "treasury_owner_type_invalid");
  throwsCode(() => TO("BK05", "IR000000000000000000000005", { type: null }), "treasury_owner_type_invalid");
  throwsCode(() => TO("BK05", "IR000000000000000000000005", { type: "partner" }), "treasury_owner_type_invalid");
  throwsCode(() => TO("BK05", "IR000000000000000000000005", { own: "company" }), "treasury_owner_type_invalid");
  throwsCode(() => TO("BK05", "IR000000000000000000000005", { ack: 0 }), "treasury_owner_ack_required");
  throwsCode(() => TO("BK05", "IR000000000000000000000005", { by: null }), "treasury_owner_ack_required");
  throwsCode(() => TO("BK05", "IR000000000000000000000005", { text: "قبول دارم" }), "treasury_owner_ack_required");
  const op = TO("BK05", "IR000000000000000000000005"); ok(op > 0, "owner_person account with acknowledgment accepted");
  throwsCode(() => db.prepare("update treasury_accounts set owner_ack=0 where id=?").run(op), "treasury_owner_ack_required");
  throwsCode(() => db.prepare("update treasury_accounts set owner_type='owner_person', ownership='owner' where id=?").run(bk), "treasury_owner_ack_required");
  throwsCode(() => db.prepare("update treasury_accounts set owner_ack=1 where id=?").run(bk), "treasury_owner_ack_unexpected");
  // opening balances: control-account totals, integer rial, maker/checker, balanced, append-only
  const os = db.prepare("insert into gl_opening_balance_sets(as_of_date,entered_by_user_id,reason,created_at) values('2026-10-22',7,'افتتاحیه',?)").run(NOW).lastInsertRowid;
  const acc = (c) => one(db, "select id from gl_accounts where code=?", c).id;
  const OL = (code, d, c, tr = null) => db.prepare("insert into gl_opening_balance_lines(set_id,account_id,treasury_account_id,debit_rial,credit_rial,created_at) values(?,?,?,?,?,?)").run(os, acc(code), tr, d, c, NOW).lastInsertRowid;
  OL("1102", 50000000, 0, bk);
  throwsCode(() => OL("1102", 1, 0, bk), "UNIQUE");
  throwsCode(() => OL("3104", 10.5, 0), "CHECK");
  throwsCode(() => OL("3104", 5, 5), "CHECK");
  throwsCode(() => OL("2301", 5, 0), "gl_account_not_postable");
  throwsCode(() => db.prepare("update gl_opening_balance_sets set approved_by_user_id=8, approved_at=? where id=?").run(NOW, os), "gl_opening_unbalanced");
  OL("3104", 0, 50000000);
  throwsCode(() => db.prepare("update gl_opening_balance_sets set approved_by_user_id=8, approved_at=? where id=?").run(NOW, os), "gl_opening_prior_payments_unconfirmed");
  throwsCode(() => db.prepare("update gl_opening_balance_sets set prior_payments_confirmed_at=? where id=?").run(NOW, os), "gl_opening_confirm_incomplete");
  db.prepare("update gl_opening_balance_sets set prior_payments_confirmed_by_user_id=7, prior_payments_confirmed_at=? where id=?").run(NOW, os);
  throwsCode(() => db.prepare("update gl_opening_balance_sets set approved_by_user_id=7, approved_at=? where id=?").run(NOW, os), "CHECK");
  db.prepare("update gl_opening_balance_sets set approved_by_user_id=8, approved_at=? where id=?").run(NOW, os); ok(true, "balanced set approved by a second user after step-4 confirmation");
  throwsCode(() => db.prepare("update gl_opening_balance_sets set prior_payments_confirmed_by_user_id=9 where id=?").run(os), "gl_append_only");
  throwsCode(() => OL("1101", 1, 0), "gl_opening_set_approved");
  throwsCode(() => db.prepare("update gl_opening_balance_sets set as_of_date='2026-10-21' where id=?").run(os), "gl_append_only");
  throwsCode(() => db.prepare("update gl_opening_balance_sets set approved_by_user_id=9 where id=?").run(os), "gl_append_only");
  throwsCode(() => db.prepare("update gl_opening_balance_lines set debit_rial=1").run(), "gl_append_only");
  throwsCode(() => db.prepare("delete from gl_opening_balance_sets").run(), "gl_append_only");
  // prior payments («قبلاً پرداخت شده»)
  const SHA = "a".repeat(64);
  const PP0 = (order, o = {}) => db.prepare("insert into payment_order_prior_payments(payment_order_id,paid_date,tracking_no,amount_rial,treasury_account_id,receipt_filename,receipt_mime,receipt_sha256,entered_by_user_id,reason,ledger_start_date,pre_start,opening_mismatch,gl_voucher_id,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(order, o.date ?? "2026-10-20", o.tr ?? "TRK-0001", o.amt ?? 120000000, bk, "r.jpg", o.mime ?? "image/jpeg", o.sha ?? SHA, 7, "پرداخت قبل از دفتر",
      "start" in o ? o.start : "2026-10-23", "pre" in o ? o.pre : 1, "mm" in o ? o.mm : 1, o.v ?? null, NOW).lastInsertRowid;
  // N7: cutoff = gl.ledger_start_date setting (no setting -> refused)
  throwsCode(() => PP0(9100), "finance_setting_missing:gl.ledger_start_date");
  SET("gl.ledger_start_date", "2026-10-23", "2026-10-01");
  const PP = PP0;
  throwsCode(() => PP(9100, { start: "2026-10-22" }), "prior_payment_cutoff_mismatch");
  throwsCode(() => PP(9100, { pre: 0 }), "prior_payment_cutoff_mismatch");
  throwsCode(() => PP(9100, { mm: 0 }), "prior_payment_mismatch_flag");
  const fy3 = one(db, "select id from gl_fiscal_years").id;
  const pv = { id: db.prepare("insert into gl_vouchers(fiscal_year_id,ref_no,temp_no,event_date,kind,description,total_rial,line_count,created_at) values(?,?,?,?,?,?,?,?,?)").run(fy3, "GL-PP-1", 909, "2026-10-23", "auto", "t", 1000, 2, NOW).lastInsertRowid };
  throwsCode(() => PP(9100, { v: pv.id }), "prior_payment_pre_start_no_voucher");
  const pIn = PP(9101, { date: "2026-10-23", pre: 0, mm: 0 }); ok(pIn > 0, "on/after GL start: in-ledger record (gets a normal payment voucher)");
  ok(one(db, "select marker m, opening_mismatch x from payment_order_prior_payment_log where prior_payment_id=?", pIn).m === "in_ledger", "log marker in_ledger");
  const p1 = PP(9001);
  ok(JSON.stringify(one(db, "select marker m, opening_mismatch x from payment_order_prior_payment_log where prior_payment_id=?", p1)) === '{"m":"pre_opening","x":1}', "pre-start record: audit row pre_opening + mismatch flag (opening already entered)");
  throwsCode(() => db.prepare("update payment_order_prior_payments set opening_mismatch=0 where id=?").run(p1), "gl_append_only");
  if (pv) throwsCode(() => db.prepare("update payment_order_prior_payments set gl_voucher_id=? where id=?").run(pv.id, p1), "prior_payment_pre_start_no_voucher");
  throwsCode(() => db.prepare("delete from payment_order_prior_payment_log").run(), "gl_append_only");
  throwsCode(() => PP(9001), "prior_payment_exists");
  throwsCode(() => PP(9002, { tr: "12" }), "CHECK");
  throwsCode(() => PP(9002, { amt: 0 }), "CHECK");
  throwsCode(() => PP(9002, { amt: 12.5 }), "CHECK");
  throwsCode(() => PP(9002, { sha: "xyz" }), "CHECK");
  throwsCode(() => PP(9002, { mime: "text/html" }), "CHECK");
  throwsCode(() => db.prepare("update payment_order_prior_payments set amount_rial=1 where id=?").run(p1), "gl_append_only");
  throwsCode(() => db.prepare("delete from payment_order_prior_payments where id=?").run(p1), "gl_append_only");
  db.prepare("insert into payment_order_prior_payment_voids(prior_payment_id,voided_by_user_id,reason,created_at) values(?,8,'ورود اشتباه',?)").run(p1, NOW);
  ok(PP(9001, { tr: "TRK-0002" }) > 0, "re-entry after void");
  throwsCode(() => db.prepare("delete from payment_order_prior_payment_voids").run(), "gl_append_only");
  ok(one(db, "pragma integrity_check").integrity_check === "ok" && all(db, "pragma foreign_key_check").length === 0, "integrity after v1b tests");
}

// 5. upgrade path: a v1 database (as deployed in 20261026185844) gains v1b additively
{
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec(L.LEDGER_DDL);
  db.prepare("insert into schema_migrations values(?,?)").run(L.LEDGER_MIGRATION, NOW);
  db.prepare("insert into gl_accounts(code,title,level,category,nature,created_at) values('62','هزینه‌ها','kol','expense','debit',?)").run(NOW);
  db.prepare("insert into gl_accounts(code,title,level,parent_id,category,nature,postable,created_at) values('6203','اختلاف گرد کردن (ریال)','moein',1,'expense','both',1,?)").run(NOW);
  db.prepare("insert into treasury_accounts(kind,code,title,created_at) values('bank','BK09','قدیمی',?)").run(NOW);
  L.ensureLedgerSchema(db, NOW); L.ensureLedgerSchema(db);
  const cols = all(db, "pragma table_info(treasury_accounts)").map(c => c.name);
  ok(["sheba", "purpose", "purpose_note"].every(c => cols.includes(c)), "v1 -> v1b: columns added");
  ok(one(db, "select count(*) n from treasury_accounts where code='BK09'").n === 1, "v1 -> v1b: existing treasury row kept");
  ok(one(db, "select title from gl_accounts where code='6203'").title === "اختلاف گرد کردن", "v1 -> v1b: 6203 title aligned");
  ok(one(db, "select count(*) n from schema_migrations").n === 3, "v1 -> v1b -> v1c: three markers");
  ok(one(db, "select owner_type from treasury_accounts where code='BK09'").owner_type === "company", "v1 -> v1c: company row mapped to owner_type company");
  ok(one(db, "select count(*) n from finance_settings").n === 0, "v1 -> v1b: no values");
}

// 6. upgrade path: a v1b database (live 20261026193918: old enum name, no owner/cutoff columns) gains v1c
{
  const db = fresh();
  const K = "plan.supplier_deposit_method", OLD = '["gross","net_of_fees","to_customer_direct","prepaid_full_credit"]';
  db.prepare("update finance_setting_keys set allowed_values=?, ui_preselect=NULL where key=?").run(OLD, K); // v1b had no preselect here
  db.prepare("update gl_accounts set title=? where code='2104'").run("پیش‌دریافت اعتبار از تأمین‌کنندگان (prepaid_full_credit)");
  db.prepare("delete from schema_migrations where version=?").run(L.FINANCE_V1C_MIGRATION);
  L.ensureLedgerSchema(db); L.ensureLedgerSchema(db);
  ok(JSON.parse(one(db, "select allowed_values a from finance_setting_keys where key=?", K).a).includes("prefunded_full_credit"), "v1b -> v1c: catalog renamed to prefunded_full_credit");
  ok(!one(db, "select allowed_values a from finance_setting_keys where key=?", K).a.includes("prepaid"), "v1b -> v1c: old name gone");
  ok(one(db, "select ui_preselect p from finance_setting_keys where key=?", K).p === "prefunded_full_credit", "G6c: catalog sync sets the deposit preselect");
  ok(one(db, "select title from gl_accounts where code='2104'").title.includes("prefunded_full_credit"), "v1b -> v1c: 2104 title renamed");
  ok(one(db, "select count(*) n from schema_migrations").n === 3, "v1b -> v1c: three markers");
  ok(one(db, "select count(*) n from sqlite_master where type='trigger' and name in ('prior_pay_guard','gl_opening_set_guard')").n === 0, "old guards replaced by _v1c");
}

// 3. optional: masked copy (opened from a scratch copy, never the source) — ensure twice + old tables untouched
if (process.env.LEDGER_DB_COPY) {
  const db = new DatabaseSync(process.env.LEDGER_DB_COPY); db.exec("PRAGMA foreign_keys=ON");
  const before = JSON.stringify(all(db, "select type,name,sql from sqlite_master where tbl_name not in (" + [...L.LEDGER_TABLES, ...L.FINANCE_TABLES].map(t => `'${t}'`).join(",") + ") order by type,name"));
  const counts = () => JSON.stringify(all(db, "select name from sqlite_master where type='table' and name not like 'gl_%' and name not like 'finance_setting%' and name not like 'payment_order_prior%' and name not like 'sqlite_%' and name not in ('treasury_accounts','bank_statement_lines','bank_reconciliation_matches','bank_reconciliation_unmatches','schema_migrations') order by name").map(r => [r.name, one(db, `select count(*) n from "${r.name}"`).n]));
  const c0 = counts();
  L.ensureLedgerSchema(db); L.ensureLedgerSchema(db);
  const after = JSON.stringify(all(db, "select type,name,sql from sqlite_master where tbl_name not in (" + [...L.LEDGER_TABLES, ...L.FINANCE_TABLES].map(t => `'${t}'`).join(",") + ") order by type,name"));
  ok(before === after, "existing schema objects unchanged on the copy");
  ok(c0 === counts(), "existing row counts unchanged on the copy");
  ok(one(db, "pragma integrity_check").integrity_check === "ok", "copy integrity ok");
  ok(one(db, "select count(*) n from gl_accounts").n === 46, "copy seeded");
  ok(one(db, "select ui_preselect p from finance_setting_keys where key='plan.supplier_deposit_method'").p === "prefunded_full_credit"
    && one(db, "select ui_preselect p from finance_setting_keys where key='discount.development.nature'").p === "revenue_reduction", "G6c copy: both preselects in the catalog");
  ok(one(db, "select count(*) n from finance_settings").n === 0, "G6c copy: still no finance_settings value");
  ok(one(db, "select active from gl_accounts where code='2104'").active === 0, "G6c copy: 2104 stays inactive");
  ok(one(db, "select count(*) n from schema_migrations where version=?", L.FINANCE_MIGRATION).n === 1, "copy v1b marker");
  ok(one(db, "select count(*) n from finance_settings").n === 0 && one(db, "select count(*) n from finance_setting_keys").n === L.FINANCE_SETTING_KEYS.length, "copy: keys only, no values");
}
console.log(`ledger-schema fixture: ${pass} checks passed`);
