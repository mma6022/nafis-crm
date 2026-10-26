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
  const f = L.readGlFlags(db); ok(Object.keys(f).length === 3 && Object.values(f).every(v => v === false), "all gl flags OFF");
  ok(all(db, "select value from gl_settings").every(r => r.value === "0"), "gl_settings rows all 0");
  // coding
  ok(one(db, "select count(*) n from gl_accounts where level='kol'").n === 12, "12 kol");
  ok(one(db, "select count(*) n from gl_accounts where level='moein'").n === 31, "31 moein");
  ok(one(db, "select title from gl_accounts where code='6203'").title.includes("گرد"), "6203 rounding account");
  ok(one(db, "select nature from gl_accounts where code='3102'").nature === "both", "3102 owner current both");
  ok(all(db, "select code from gl_accounts where active=0 order by code").map(r => r.code).join() === "1202,2301,4104", "inactive pending accounts");
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
  db.prepare("insert into treasury_accounts(kind,code,title,created_at) values('bank','BK01','بانک نمونه',?)").run(NOW);
  throwsCode(() => db.prepare("insert into treasury_accounts(kind,code,title,finance_bank_account_id,created_at) values('cash_box','CB01','صندوق',3,?)").run(NOW), "CHECK");
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

// 3. optional: masked copy (opened from a scratch copy, never the source) — ensure twice + old tables untouched
if (process.env.LEDGER_DB_COPY) {
  const db = new DatabaseSync(process.env.LEDGER_DB_COPY); db.exec("PRAGMA foreign_keys=ON");
  const before = JSON.stringify(all(db, "select type,name,sql from sqlite_master where tbl_name not in (" + L.LEDGER_TABLES.map(t => `'${t}'`).join(",") + ") order by type,name"));
  const counts = () => JSON.stringify(all(db, "select name from sqlite_master where type='table' and name not like 'gl_%' and name not like 'sqlite_%' and name not in ('treasury_accounts','bank_statement_lines','bank_reconciliation_matches','bank_reconciliation_unmatches','schema_migrations') order by name").map(r => [r.name, one(db, `select count(*) n from "${r.name}"`).n]));
  const c0 = counts();
  L.ensureLedgerSchema(db); L.ensureLedgerSchema(db);
  const after = JSON.stringify(all(db, "select type,name,sql from sqlite_master where tbl_name not in (" + L.LEDGER_TABLES.map(t => `'${t}'`).join(",") + ") order by type,name"));
  ok(before === after, "existing schema objects unchanged on the copy");
  ok(c0 === counts(), "existing row counts unchanged on the copy");
  ok(one(db, "pragma integrity_check").integrity_check === "ok", "copy integrity ok");
  ok(one(db, "select count(*) n from gl_accounts").n === 43, "copy seeded");
}
console.log(`ledger-schema fixture: ${pass} checks passed`);
