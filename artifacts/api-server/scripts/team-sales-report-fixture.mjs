// «گزارش فروش تیم» fixture (2026-10-26): lib-level checks on a throwaway DB copy. Never touches live; sends nothing.
// Usage: SALES_REPORT_FIXTURE_DB=/path/to/copy.db node scripts/run-bundled-fixture.mjs scripts/sales-report-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sr from "../src/lib/team-sales-report.ts";
import { expertCalls, teamCallRows } from "../src/lib/expert-calls.ts";
import { performanceNumbers } from "../src/lib/expert-performance.ts";

let passed = 0; const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };
const src = process.env.SALES_REPORT_FIXTURE_DB;
if (!src) { console.log("SKIP (set SALES_REPORT_FIXTURE_DB to a DB copy)"); process.exit(0); }
const sha = () => crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex"); const srcHash = sha();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srfx-")); const dbPath = path.join(dir, "crm.db"); fs.copyFileSync(src, dbPath);
const db = new DatabaseSync(dbPath);
const NOW = new Date(process.env.SALES_REPORT_NOW ?? "2026-10-26T15:00:00.000Z");
const BANNED = ["سپرده", "برآورد", "تخمینی"];
try {
  sr.ensureSalesReportSchema(db, NOW.toISOString());
  const rep = (q = {}) => { const r = sr.teamSalesReport(db, { range: "month", ...q }, NOW, true); assert.ok(!r.error, JSON.stringify(r)); return r; };
  ok("flag defaults: trainee money OFF, overdue card ON, no-commission bell OFF", () =>
    assert.deepEqual(sr.readSrFlags(db), { traineeMoney: false, overdueCard: true, noCommissionAlert: false }));
  ok("seed is INSERT OR IGNORE (an admin choice survives a restart)", () => {
    db.prepare("UPDATE assistant_settings SET value='1' WHERE key=?").run(sr.SR_FLAG_KEYS.traineeMoney);
    sr.ensureSalesReportSchema(db, NOW.toISOString()); assert.equal(sr.readSrFlags(db).traineeMoney, true);
    db.prepare("UPDATE assistant_settings SET value='0' WHERE key=?").run(sr.SR_FLAG_KEYS.traineeMoney);
  });
  ok("flag validation", () => {
    assert.equal(sr.validateSrFlags({ traineeMoney: "yes" }).ok, false); assert.equal(sr.validateSrFlags({ foo: true }).ok, false);
    assert.equal(sr.validateSrFlags({}).ok, false); assert.equal(sr.validateSrFlags({ overdueCard: false }).ok, true);
  });
  const r = rep();
  ok("user 29 never appears; trainees 5/19/20 are in the trainee group", () => {
    const u29 = db.prepare("SELECT full_name name, salesperson_id FROM users WHERE id=29").get();
    const ids = r.experts.map(e => e.salespersonId);
    if (u29?.salesperson_id != null) assert.ok(!ids.includes(Number(u29.salesperson_id)));
    if (u29?.name) assert.ok(!JSON.stringify(r).includes(String(u29.name)));
    assert.deepEqual(r.table.trainees.map(t => t.salespersonId).sort((a, b) => a - b), [5, 19, 20].filter(s => ids.includes(s)));
    assert.ok(r.table.experts.every(e => ![5, 19, 20].includes(e.salespersonId)));
  });
  ok("per-expert numbers equal /my-performance (calls, sent, deposits, payout, commission)", () => {
    const w = r.current;
    for (const row of [...r.table.experts, ...r.table.trainees]) {
      const n = performanceNumbers(db, row.salespersonId, w, NOW, true);
      assert.equal(row.calls, n.calls, `calls sp${row.salespersonId}`); assert.equal(row.sentToRegistration, n.sentToRegistration);
      assert.equal(row.deposits, n.deposited.count);
      if (!row.trainee) { assert.equal(row.payoutToman, n.deposited.payoutToman); assert.equal(row.commissionToman, n.deposited.commissionToman); }
    }
  });
  ok("KPI cards = whole team (experts + trainees); «جمع کارشناس‌ها» leaves trainees out", () => {
    const s = (a, k) => a.reduce((x, y) => x + y[k], 0);
    assert.equal(r.kpis.calls.current, s(r.table.experts, "calls") + s(r.table.trainees, "calls"));
    assert.equal(r.table.expertsTotal.calls, s(r.table.experts, "calls"));
    assert.equal(r.kpis.deposited.current.count, s(r.table.experts, "deposits") + s(r.table.trainees, "deposits"));
    assert.match(r.table.expertsTotal.label, /بدون کارآموز/);
  });
  ok("trainee money hidden by default (server side), shown with flag ۱", () => {
    assert.ok(r.table.trainees.every(t => t.payoutToman === null && t.commissionToman === null));
    db.prepare("UPDATE assistant_settings SET value='1' WHERE key=?").run(sr.SR_FLAG_KEYS.traineeMoney);
    const r2 = rep(); assert.ok(r2.table.trainees.every(t => typeof t.payoutToman === "string"));
    db.prepare("UPDATE assistant_settings SET value='0' WHERE key=?").run(sr.SR_FLAG_KEYS.traineeMoney);
  });
  ok("flag ۲ OFF → no overdue card (5 cards)", () => {
    db.prepare("UPDATE assistant_settings SET value='0' WHERE key=?").run(sr.SR_FLAG_KEYS.overdueCard);
    assert.equal(rep().kpis.overdue, null);
    db.prepare("UPDATE assistant_settings SET value='1' WHERE key=?").run(sr.SR_FLAG_KEYS.overdueCard);
  });
  ok("«۷ روز پیش» is null («—») until a 7-day-old snapshot exists; then it is read from the snapshot", () => {
    db.prepare(`DELETE FROM ${sr.SNAPSHOT_TABLE}`).run();
    assert.ok(sr.takeOverdueSnapshot(db, NOW, true) > 0); assert.equal(sr.takeOverdueSnapshot(db, NOW, true), 0, "once per day");
    assert.equal(rep().kpis.overdue.weekAgo, null);
    const day = sr.tehranIsoDay(NOW.getTime() - 7 * 86400000);
    const sps = r.experts.map(e => e.salespersonId);
    for (const sp of sps) db.prepare(`INSERT INTO ${sr.SNAPSHOT_TABLE} VALUES(?,?,0,2,1,1,?)`).run(day, sp, NOW.toISOString());
    assert.deepEqual(rep().kpis.overdue.weekAgo, { overdueReminders: 2 * sps.length, p1NoCall: sps.length });
    db.prepare(`DELETE FROM ${sr.SNAPSHOT_TABLE} WHERE day=?`).run(day);
  });
  ok("plan filter applies to deposits, sent, open invoices and stuck cases", () => {
    const plans = db.prepare("SELECT DISTINCT plan_id p FROM goods_purchases WHERE plan_id IS NOT NULL").all().map(x => Number(x.p));
    let dep = 0, inv = 0;
    for (const p of plans) { const x = rep({ plan: p }); dep += x.kpis.deposited.current.count; inv += x.openInvoices.count;
      assert.ok(x.stuck.count <= r.stuck.count); assert.ok(x.kpis.calls.current <= r.kpis.calls.current); assert.ok(x.kpis.sentToRegistration.current <= r.kpis.sentToRegistration.current); }
    const nullPlan = Number(db.prepare("SELECT COUNT(*) n FROM goods_purchases WHERE plan_id IS NULL").get().n);
    if (!nullPlan) { assert.equal(dep, r.kpis.deposited.current.count); assert.equal(inv, r.openInvoices.count); }
    assert.equal(sr.teamSalesReport(db, { range: "month", plan: 999999 }, NOW, true).error, "unknown_plan");
  });
  ok("expert filter narrows everything to one salesperson", () => {
    const sp = r.table.experts[0].salespersonId; const x = rep({ expert: sp });
    assert.equal(x.kpis.calls.current, r.table.experts[0].calls); assert.equal(x.table.experts.length, 1); assert.equal(x.table.trainees.length, 0);
    assert.equal(sr.teamSalesReport(db, { range: "month", expert: 29 }, NOW, true).error, "unknown_expert");
  });
  ok("funnel has 6 stages incl. «تکمیل ثبت» (stage completed) with % of the previous stage", () => {
    assert.deepEqual(r.funnel.map(f => f.label), ["سرنخ", "تماس گرفته‌شده", "درخواست ساخته‌شده", "ارسال به ثبت", "تکمیل ثبت", "واریز به مشتری"]);
    const done = Number(db.prepare(`SELECT COUNT(*) n FROM (SELECT a.id, MIN(julianday(h.created_at)) f FROM loan_applications a JOIN customers c ON c.id=a.customer_id
      JOIN loan_application_stage_history h ON h.application_id=a.id WHERE a.deleted_at IS NULL AND h.to_stage='completed' AND COALESCE(h.from_stage,'')<>'completed'
      AND COALESCE(a.salesperson_id_snapshot,c.salesperson_id) IN (${r.experts.map(e => e.salespersonId).join(",")}) GROUP BY a.id) WHERE f>=julianday(?) AND f<julianday(?)`).get(r.current.from, r.current.to).n);
    assert.ok(r.funnel[4].current <= done);
  });
  ok("ranges + custom validation + comparison label", () => {
    for (const g of ["today", "yesterday", "week", "month", "prev_month"]) { const x = rep({ range: g }); assert.ok(x.compareNote.includes("در مقایسه با")); }
    assert.equal(sr.teamSalesReport(db, { range: "custom", from: "2026-10-20", to: "2026-10-10" }, NOW, true).error, "bad_order");
    assert.equal(sr.teamSalesReport(db, { range: "custom", from: "x", to: "2026-10-10" }, NOW, true).error, "bad_dates");
    const c = rep({ range: "custom", from: "2026-09-01", to: "2026-10-26" }); assert.equal(c.trend.step, "week");
    const y = rep({ range: "custom", from: "2025-10-01", to: "2026-10-26" }); assert.equal(y.trend.step, "month");
    assert.equal(rep({ range: "month" }).trend.step, "day");
  });
  ok("guest «مهمون» / no-expert calls count for the lead's current owner (reports only), same in /my-performance", () => {
    const cust = db.prepare("SELECT id, salesperson_id sp FROM customers WHERE salesperson_id=3 AND merged_into_customer_id IS NULL AND id NOT IN (SELECT customer_id FROM call_logs WHERE customer_id IS NOT NULL) LIMIT 1").get()
      ?? db.prepare("SELECT id, salesperson_id sp FROM customers WHERE salesperson_id=3 AND merged_into_customer_id IS NULL LIMIT 1").get();
    const at = new Date(NOW.getTime() - 3600000).toISOString(); const f = r.current.from, t = NOW.toISOString();
    const before = expertCalls(db, 3, f, t, { excludeTest: false, reportAliases: true }).length;
    const before6 = expertCalls(db, 6, f, t, { excludeTest: false, reportAliases: true }).length;
    const colsCL = new Set(db.prepare("SELECT name FROM pragma_table_info('call_logs')").all().map(x => x.name));
    db.prepare("INSERT INTO call_logs(customer_id, salesperson_id, subject, created_at) VALUES(?,NULL,'تماس تلفنی',?)").run(cust.id, at);
    if (colsCL.has("salesperson_name_snapshot")) db.prepare("INSERT INTO call_logs(customer_id, salesperson_id, subject, created_at, salesperson_name_snapshot) VALUES(?,6,'تماس تلفنی',?,'مهمون')").run(cust.id, at);
    const add = colsCL.has("salesperson_name_snapshot") ? 2 : 1;
    assert.equal(expertCalls(db, 3, f, t, { excludeTest: false, reportAliases: true }).length, before + add);
    assert.equal(expertCalls(db, 6, f, t, { excludeTest: false, reportAliases: true }).length, before6, "guest call not counted for the guest account's salesperson");
    const rows = teamCallRows(db, f, t, {}); assert.equal(rows.filter(x => x.sp === 3).length, before + add);
    assert.ok(expertCalls(db, 3, f, t, { excludeTest: false }).length < before + add, "/my-context «امروز» counter keeps the raw owner");
  });
  ok("flag ۳ OFF → no bell; ON → one bell per active admin (never 29), only for deposits after the switch, idempotent", () => {
    const n0 = Number(db.prepare("SELECT COUNT(*) n FROM site_notification_events").get().n);
    assert.equal(sr.noCommissionAlerts(db, NOW, true), 0);
    db.prepare("UPDATE assistant_settings SET value='1', updated_at=? WHERE key=?").run("2026-10-01T00:00:00.000Z", sr.SR_FLAG_KEYS.noCommissionAlert);
    const n = sr.noCommissionAlerts(db, NOW, true);
    const rows = db.prepare("SELECT recipient_user_id u, resource_id FROM site_notification_events WHERE kind='deposit-no-commission'").all();
    assert.equal(rows.length, n); assert.ok(rows.every(x => Number(x.u) !== 29));
    assert.equal(sr.noCommissionAlerts(db, NOW, true), 0, "idempotent");
    db.prepare("UPDATE assistant_settings SET value='1', updated_at=? WHERE key=?").run(NOW.toISOString(), sr.SR_FLAG_KEYS.noCommissionAlert);
    db.prepare("DELETE FROM site_notification_events WHERE kind='deposit-no-commission'").run();
    assert.equal(sr.noCommissionAlerts(db, NOW, true), 0, "only deposits after the switch");
    db.prepare("UPDATE assistant_settings SET value='0' WHERE key=?").run(sr.SR_FLAG_KEYS.noCommissionAlert);
    assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM site_notification_events").get().n), n0);
  });
  ok("no banned words, no phone-like numbers in the payload", () => {
    const j = JSON.stringify(rep()); for (const w of BANNED) assert.ok(!j.includes(w), w);
    const names = JSON.stringify([rep().openInvoices.oldest, rep().stuck.oldest]); assert.ok(!/(?<!\d)09\d{9}(?!\d)/.test(names));
    assert.ok(!/phone|mobile/i.test(j));
  });
  ok("source DB untouched", () => assert.equal(sha(), srcHash));
  console.log(`sales-report fixture: ${passed} passed`);
} finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
