// G5 reports + nightly compare fixture. Part A: synthetic in-memory DB. Part B: a DISPOSABLE probe copy of the masked DB
// (LEDGER_DB_COPY is opened read-only and never written). Prints counts and PASS lines only; no names, phones or amounts.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as L from "../src/lib/ledger.ts";
import * as P from "../src/lib/gl-posting.ts";
import * as R from "../src/lib/gl-reports.ts";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; if (process.env.FX_VERBOSE) console.log("PASS", m); };
const NOW = "2026-10-26T18:00:00.000Z";
const one = (db, sql, ...p) => db.prepare(sql).get(...p);
const n = (db, t, w = "1") => one(db, `select count(*) n from ${t} where ${w}`).n;
const tx = (db, fn) => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
const setup = (db, admin = 7) => {
  db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('1405','2026-03-21','2027-03-20',?)").run(NOW);
  const fs_ = db.prepare("insert into finance_settings(key,scope_type,scope_id,value,effective_from,changed_by_user_id,reason,created_at) values(?,'global',null,?,'2026-10-01',?,'آزمون',?)");
  fs_.run("gl.ledger_start_date", "2026-10-22", admin, NOW); fs_.run("gl.opening_base_date", "2026-10-21", admin, NOW);
};

// ---------------------------------------------------------------- A. synthetic
{
  const db = new DatabaseSync(":memory:");
  L.ensureLedgerSchema(db, NOW); R.ensureGlReportsSchema(db, NOW);
  ok(["gl.reports", "gl.nightly_compare", "gl.shadow_nonbank", "gl.shadow_bank", "gl.bank_blocking"].every((k) => one(db, "select value v from gl_settings where key=?", k).v === "0"), "A: 5 gl flags present, all OFF");
  ok(n(db, "schema_migrations", `version='${R.GL_REPORTS_MIGRATION}'`) === 1 && n(db, "sqlite_master", "name='gl_reconciliation_runs'") === 1, "A: run table + migration marker");
  R.ensureGlReportsSchema(db, NOW); ok(n(db, "schema_migrations", `version='${R.GL_REPORTS_MIGRATION}'`) === 1, "A: ensure idempotent");
  ok(R.reconcile(db, "2026-10-26").state === "not_started", "A: no ledger start -> not_started");
  setup(db);
  const cu = (id) => P.ensureTafsili(db, "CU", id, `مشتری ${id}`, NOW);
  const v1 = tx(db, () => P.postVoucher(db, { eventDate: "2026-10-21", kind: "manual", description: "o", sourceKey: "gl:fx:open", nowIso: NOW,
    lines: [{ account: "3104", debitRial: 3000 }, { account: "2201", tafsiliId: cu(1), creditRial: 1000 }, { account: "2201", tafsiliId: cu(2), creditRial: 2000 }] }));
  tx(db, () => P.postVoucher(db, { eventDate: "2026-10-23", kind: "manual", description: "p2", sourceKey: "gl:fx:p2", nowIso: NOW,
    lines: [{ account: "1103", debitRial: 500 }, { account: "2201", tafsiliId: cu(1), creditRial: 500 }] }));
  tx(db, () => P.postVoucher(db, { eventDate: "2026-10-24", kind: "manual", description: "p4", sourceKey: "gl:fx:p4", nowIso: NOW,
    lines: [{ account: "2201", tafsiliId: cu(2), debitRial: 300 }, { account: "4103", creditRial: 300 }] }));
  tx(db, () => P.postVoucher(db, { eventDate: "2026-10-24", kind: "manual", description: "memo", sourceKey: "gl:fx:memo", nowIso: NOW,
    lines: [{ account: "8101", tafsiliId: cu(1), debitRial: 9000 }, { account: "8102", creditRial: 9000 }] }));
  // an UNSEALED voucher (raw insert) must never show in reports
  let unsealed = false;
  try {
    const fy = one(db, "select id from gl_fiscal_years").id;
    const vid = db.prepare("insert into gl_vouchers(fiscal_year_id,ref_no,temp_no,event_date,kind,description,total_rial,line_count,created_at) values(?,?,?,?,?,?,?,?,?)")
      .run(fy, "RAW-0001", 999, "2026-10-24", "manual", "raw", 777, 2, NOW).lastInsertRowid;
    const a = (c) => one(db, "select id from gl_accounts where code=?", c).id;
    db.prepare("insert into gl_voucher_lines(voucher_id,line_no,account_id,debit_rial,credit_rial,description) values(?,?,?,?,?,'')").run(vid, 1, a("2201"), 777, 0);
    db.prepare("insert into gl_voucher_lines(voucher_id,line_no,account_id,debit_rial,credit_rial,description) values(?,?,?,?,?,'')").run(vid, 2, a("4103"), 0, 777);
    unsealed = n(db, "gl_voucher_seals", `voucher_id=${vid}`) === 0;
  } catch { /* schema refuses raw unsealed vouchers: also fine */ }
  const tb = R.trialBalance(db, { from: "2026-10-22", to: "2026-10-26", level: "moein" });
  ok(tb.balanced && tb.totals.openDr === 3000 && tb.totals.openCr === 3000 && tb.totals.dr === 800 && tb.totals.cr === 800, "A: trial balance balanced; opening 3000/3000, turnover 800/800");
  ok(tb.memoRows.length === 2 && tb.memoTotals.dr === 9000 && !tb.rows.some((r) => r.code.startsWith("81")), "A: memo 81xx listed apart, never in totals");
  const r2201 = tb.rows.find((r) => r.code === "2201");
  ok(r2201 && r2201.balCr === 3200 && r2201.balDr === 0, "A: 2201 closing credit 3200 (sealed only)" + (unsealed ? " with an unsealed raw voucher present" : ""));
  const kol = R.trialBalance(db, { from: "2026-10-22", to: "2026-10-26", level: "kol" });
  ok(kol.rows.every((r) => r.code.length === 2) && kol.balanced, "A: kol level");
  const tfl = R.trialBalance(db, { from: "2026-10-22", to: "2026-10-26", level: "tafsili" });
  ok(tfl.rows.filter((r) => r.code === "2201").length === 2 && tfl.balanced, "A: tafsili level splits 2201 by customer");
  const led = R.accountLedger(db, { code: "2201", tafsiliId: cu(1), from: "2026-10-22", to: "2026-10-26", page: 1, limit: 50 });
  ok(led.openingRial === -1000 && led.items.length === 1 && led.items[0].runningRial === -1500 && led.closingRial === -1500, "A: account ledger opening + running balance");
  const led2 = R.accountLedger(db, { code: "22", tafsiliId: null, from: "2026-03-21", to: "2026-10-26", page: 1, limit: 50 });
  ok(led2.items.map((x) => x.runningRial).join(",") === "-1000,-3000,-3500,-3200" && led2.closingRial === -3200, "A: kol ledger running balance in date/temp/line order");
  ok(R.accountLedger(db, { code: "9999", tafsiliId: null, from: "2026-10-01", to: "2026-10-26", page: 1, limit: 5 }) === null, "A: unknown account -> null");
  const j = R.journal(db, { from: "2026-10-01", to: "2026-10-26", page: 1, limit: 30 });
  ok(j.total === 4 && j.items[0].id === v1.voucherId && j.items.every((v) => v.lines.length >= 2) && !j.items.some((v) => v.refNo === "RAW-0001"), "A: journal = 4 sealed vouchers with lines, date order");
  db.prepare("insert into gl_posting_queue(source_key,event_type,status,attempts,last_error,created_at,updated_at) values('gl:q:1','P2','failed',3,'gl_x',?,?),('gl:q:2','P4','skipped',0,'gl_before_ledger_start',?,?)").run(NOW, NOW, NOW, NOW);
  const q = R.postingQueue(db);
  ok(q.counts.failed === 1 && q.counts.skipped === 1 && q.items.length === 1 && q.skipped[0].code === "gl_before_ledger_start", "A: queue counts / open items / skipped reasons");
  const st = R.ledgerStatus(db, "2026-10-26");
  ok(st.baseOk && st.baseDate === "2026-10-21" && st.ledgerStartDate === "2026-10-22" && st.flags["gl.reports"] === false && st.opening.state === "none", "A: status reads base/start dates from settings, flags read-only");
  // nightly: OFF -> nothing; ON -> one row per Tehran day, append-only
  ok(R.runNightlyCompare(db, new Date("2026-10-26T23:00:00Z")) === null && n(db, "gl_reconciliation_runs") === 0, "A: nightly flag OFF -> no run");
  db.prepare("update gl_settings set value='1' where key='gl.nightly_compare'").run();
  const run = R.runNightlyCompare(db, new Date("2026-10-26T23:00:00Z"));
  ok(run && run.runDate === "2026-10-27" && n(db, "gl_reconciliation_runs") === 1, "A: nightly ON -> 1 run for the Tehran date");
  ok(R.runNightlyCompare(db, new Date("2026-10-27T01:00:00Z")) === null && n(db, "gl_reconciliation_runs") === 1, "A: second tick same day -> no second run");
  let blocked = false; try { db.exec("delete from gl_reconciliation_runs"); } catch { blocked = true; }
  ok(blocked, "A: run log append-only");
}

// ---------------------------------------------------------------- B. probe copy
if (process.env.LEDGER_DB_COPY) {
  const tmp = `${process.env.LEDGER_DB_COPY}.g5probe`;
  try { fs.unlinkSync(tmp); } catch {}
  { const s = new DatabaseSync(process.env.LEDGER_DB_COPY, { readOnly: true }); s.exec(`VACUUM INTO '${tmp}'`); s.close(); }
  process.env.CRM_DATABASE_PATH = tmp; process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "silent";
  process.env.SESSION_SECRET = (await import("node:crypto")).randomBytes(32).toString("hex"); // throwaway, fixture process only
  const C = await import("../src/lib/crm-db.ts");
  const S = await import("../src/lib/gl-shadow.ts");
  const db = C.crmDb;
  const tables0 = n(db, "sqlite_master", "type='table'");
  L.ensureLedgerSchema(db, NOW); S.ensureGlShadowSchema(db, NOW); R.ensureGlReportsSchema(db, NOW);
  ok(n(db, "gl_vouchers") === 0 && one(db, "select value v from gl_settings where key='gl.reports'").v === "0", "B: empty ledger, gl.reports OFF");
  const admin = one(db, "select id from users where role='admin' and id<>29 order by id limit 1").id;
  setup(db, admin);
  // post vouchers that mirror every system balance (independent SQL), then compare
  const rial = (v) => Math.round(Number(v) * 10);
  const cash = db.prepare("select customer_id id, sum(cast(balance as real)) b from wallet_accounts_v2 where wallet_type='cash' group by customer_id having b<>0").all();
  const plans = db.prepare("select plan_id id, cast(balance_toman as real) b from goods_company_wallets where cast(balance_toman as real)<>0").all();
  const sps = db.prepare("select salesperson_id id, cast(balance_toman as real) b from goods_salesperson_wallets where cast(balance_toman as real)<>0").all();
  const company = rial(one(db, "select balance b from company_wallet_accounts where wallet_type='cash'")?.b ?? 0);
  const owed = db.prepare("select coalesce(sum(cast(amount_toman as real)),0) s from customer_payment_orders where stage<>'paid'").get().s
    + db.prepare("select coalesce(sum(cast(payout_amount_toman as real)),0) s from goods_purchases p where stage='completed' and not exists (select 1 from customer_payment_orders o where o.purchase_id=p.id)").get().s;
  const zp = one(db, "select coalesce(sum(cast(amount_rial as integer)),0) s from wallet_payment_intents where status='credited'").s;
  const lines = [];
  for (const w of cash) { const r = rial(w.b); lines.push({ account: "2201", tafsiliId: P.ensureTafsili(db, "CU", w.id, `CU ${w.id}`, NOW), ...(r > 0 ? { creditRial: r } : { debitRial: -r }) }); }
  for (const w of plans) { const r = rial(w.b); lines.push({ account: "1201", tafsiliId: P.ensureTafsili(db, "PL", w.id, `PL ${w.id}`, NOW), ...(r > 0 ? { debitRial: r } : { creditRial: -r }) }); }
  for (const w of sps) { const r = rial(w.b); lines.push({ account: "2102", tafsiliId: P.ensureTafsili(db, "SP", w.id, `SP ${w.id}`, NOW), ...(r > 0 ? { creditRial: r } : { debitRial: -r }) }); }
  if (company) lines.push({ account: "4103", ...(company > 0 ? { creditRial: company } : { debitRial: -company }) });
  if (owed) lines.push({ account: "2101", creditRial: rial(owed) });
  if (zp) lines.push({ account: "1103", debitRial: zp });
  const net = lines.reduce((s, l) => s + (l.debitRial ?? 0) - (l.creditRial ?? 0), 0);
  if (net) lines.push({ account: "3104", ...(net > 0 ? { creditRial: net } : { debitRial: -net }) });
  C.runTransaction(() => P.postVoucher(db, { eventDate: "2026-10-23", kind: "manual", description: "fixture mirror", sourceKey: "gl:fx:mirror", lines, nowIso: NOW }));
  const r0 = R.reconcile(db, "2026-10-26");
  ok(r0.state === "ready" && r0.sections.length === 7, "B: 7 compare sections (8101 deferred: Q7)");
  ok(r0.sections.find((s) => s.key === "wallet_credit").status === "deferred", "B: credit wallets deferred on Q7");
  const bad = r0.sections.filter((s) => s.status === "mismatch").map((s) => s.key);
  ok(bad.length === 0 || (bad.length === 1 && bad[0] === "payment_orders" && r0.sections.find((s) => s.key === "payment_orders").rows.every((x) => x.ref.startsWith("GP-"))), `B: mirrored ledger -> 0 mismatches (only listed purchases-without-order allowed) [${cash.length} cash wallets, ${plans.length} plans, ${sps.length} sps]`);
  const cashSec = r0.sections.find((s) => s.key === "wallet_cash");
  ok(cashSec.mismatchCount === 0 && cashSec.checked === cash.length, "B: every non-zero cash wallet checked, 0 mismatches");
  // tamper ONE wallet balance on the probe -> exactly that customer
  const victim = cash[Math.floor(cash.length / 2)];
  const wid = one(db, "select id from wallet_accounts_v2 where customer_id=? and wallet_type='cash' order by id limit 1", victim.id).id;
  db.prepare("update wallet_accounts_v2 set balance=cast(cast(balance as integer)+1000 as text) where id=?").run(wid);
  const r1 = R.reconcile(db, "2026-10-26");
  const s1 = r1.sections.find((s) => s.key === "wallet_cash");
  ok(s1.mismatchCount === 1 && s1.rows[0].refId === victim.id && s1.rows[0].diffRial === -10000 && s1.rows[0].ref === `CU-${victim.id}`, "B: tampered wallet -> exactly that customer, diff -1000 toman");
  ok(r1.sections.filter((s) => s.key !== "wallet_cash").every((s, i) => s.mismatchCount === r0.sections.filter((x) => x.key !== "wallet_cash")[i].mismatchCount), "B: other sections unchanged by the tamper");
  // pre-opening order (scene 726) + HTTP checks
  const order = one(db, "select id from customer_payment_orders order by id limit 1");
  // PROBE ONLY: the F4 journal trigger is dropped on the disposable probe so one order can be set to 'paid' for the unpay guard test.
  const f4 = one(db, "select sql from sqlite_master where type='trigger' and name='accounting_require_payment_journal'")?.sql;
  if (f4) db.exec("drop trigger accounting_require_payment_journal");
  db.prepare("update customer_payment_orders set stage='paid', paid_at=? where id=?").run(NOW, order.id);
  if (f4) db.exec(f4);
  db.prepare(`insert into payment_order_prior_payments(payment_order_id,paid_date,tracking_no,amount_rial,receipt_filename,receipt_mime,receipt_sha256,entered_by_user_id,reason,created_at,ledger_start_date,pre_start,opening_mismatch)
    values(?,?,?,?,?,?,?,?,?,?,?,1,0)`).run(order.id, "2026-10-20", "TRK-0001", 10, "r.pdf", "application/pdf", "0".repeat(64), admin, "آزمون", NOW, "2026-10-22");
  ok(one(db, "select marker m from payment_order_prior_payment_log").m === "pre_opening", "B: pre-start record logged as pre_opening");
  const express = (await import("express")).default;
  const glRouter = (await import("../src/routes/gl-reports.ts")).default;
  const poRouter = (await import("../src/routes/payment-orders.ts")).default;
  let who = { id: admin, role: "admin", permissions: [], salespersonId: null, name: "fx" };
  const app = express(); app.use(express.json()); app.use((_q, res, next) => { res.locals.authUser = who; next(); }); app.use(glRouter); app.use(poRouter);
  const srv = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { s: r.status, b: await r.json().catch(() => null), cc: r.headers.get("cache-control") }; };
  let r = await get("/gl/reports/trial-balance");
  ok(r.s === 404 && r.b.error === "gl_reports_off" && r.cc === "private, no-store", "B: flag OFF -> 404 gl_reports_off, no-store");
  r = await get("/gl/reports/status"); ok(r.s === 200 && r.b.enabled === false && Object.keys(r.b).length === 1, "B: flag OFF -> status says only enabled:false");
  who = { ...who, role: "salesperson", permissions: ["accounting.view"] };
  r = await get("/gl/reports/status"); ok(r.s === 403, "B: non-finance role -> 403 even with accounting.view");
  who = { ...who, role: "accounting", permissions: ["accounting.view"] };
  db.prepare("update gl_settings set value='1' where key='gl.reports'").run();
  r = await get("/gl/reports/status"); ok(r.s === 200 && r.b.enabled && r.b.baseDate === "2026-10-21" && r.b.vouchers === 1, "B: flag ON -> status (accounting role)");
  r = await get("/gl/reports/trial-balance?from=2026-10-22&to=2026-10-26&level=moein"); ok(r.s === 200 && r.b.balanced, "B: trial balance via HTTP, balanced");
  r = await get("/gl/reports/ledger?code=2201&from=2026-10-01"); ok(r.s === 200 && r.b.items.length === cash.length, "B: account ledger via HTTP");
  r = await get("/gl/reports/ledger?code=x1"); ok(r.s === 400, "B: bad account code -> 400");
  r = await get("/gl/reports/journal"); ok(r.s === 200 && r.b.total === 1, "B: journal via HTTP");
  r = await get("/gl/reports/queue"); ok(r.s === 200 && r.b.counts.pending === 0, "B: queue via HTTP");
  r = await get("/gl/reports/reconciliation"); ok(r.s === 200 && r.b.live.sections.find((s) => s.key === "wallet_cash").mismatchCount === 1 && r.b.nightlyEnabled === false, "B: reconciliation via HTTP shows the tamper");
  ok((await fetch(base + "/gl/reports/status", { method: "POST" })).status === 404, "B: no write endpoint");
  who = { ...who, role: "admin", permissions: [] };
  r = await get(`/payment-orders/${order.id}`); ok(r.s === 200 && r.b.preOpening && r.b.preOpening.paidDate === "2026-10-20" && r.b.canUnpay === false, "B: 726 order detail: preOpening marker, no unpay");
  r = await get(`/payment-orders?stage=paid`); ok(r.s === 200 && r.b.items.find((x) => x.id === order.id)?.preOpening === true && r.b.items.filter((x) => x.preOpening).length === 1, "B: list marks only that order preOpening");
  const up = await fetch(`${base}/payment-orders/${order.id}/unpay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "fixture test" }) });
  ok(up.status === 409 && (await up.json()).error === "pre_opening_unpay_forbidden", "B: unpay of a pre-opening order refused (409)");
  const pay = await fetch(`${base}/payment-orders/${order.id}/pay`, { method: "POST" });
  ok(pay.status === 409 && (await pay.json()).error === "pre_opening_pay_forbidden", "B: pay of a pre-opening order refused (409, no double count with the opening 2101)");
  srv.close();
  ok(n(db, "sqlite_master", "type='table'") >= tables0, "B: additive only");
  db.close?.(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) try { fs.unlinkSync(f); } catch {}
  ok(!fs.existsSync(tmp), "B: probe removed");
}
console.log(`gl-reports-fixture: ${pass} PASS`);
