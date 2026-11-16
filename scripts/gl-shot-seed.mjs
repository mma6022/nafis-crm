// Seeds sample GL data into the MASKED screenshot copy only (/tmp/as-shot/crm.db). Refuses any other path.
// Prints counts and ids only; no names, phones or amounts. Never run against live.
import { DatabaseSync } from "node:sqlite";
import * as L from "../src/lib/ledger.ts";
import * as P from "../src/lib/gl-posting.ts";
import * as S from "../src/lib/gl-shadow.ts";
import * as R from "../src/lib/gl-reports.ts";

const path = process.env.GL_SHOT_DB ?? "";
if (path !== "/tmp/as-shot/crm.db") { console.error("refusing: GL_SHOT_DB must be the masked copy /tmp/as-shot/crm.db"); process.exit(2); }
const db = new DatabaseSync(path);
const NOW = new Date().toISOString();
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const tx = (fn) => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
L.ensureLedgerSchema(db, NOW); S.ensureGlShadowSchema(db, NOW); R.ensureGlReportsSchema(db, NOW);
if (one("select count(*) n from gl_vouchers").n) { console.error("already seeded"); process.exit(3); }
const admin = 1, second = one("select id from users where role='admin' and id not in (1,29) order by id limit 1")?.id ?? 7;
if (!one("select 1 x from gl_fiscal_years")) db.prepare("insert into gl_fiscal_years(title,start_date,end_date,created_at) values('1405','2026-03-21','2027-03-20',?)").run(NOW);
const fs_ = db.prepare("insert into finance_settings(key,scope_type,scope_id,value,effective_from,changed_by_user_id,reason,created_at) values(?,'global',null,?,'2026-10-01',?,'نمونهٔ تصویر',?)");
fs_.run("gl.ledger_start_date", "2026-10-22", admin, NOW); fs_.run("gl.opening_base_date", "2026-10-21", admin, NOW);
const rial = (v) => Math.round(Number(v) * 10);
const cu = (id) => P.ensureTafsili(db, "CU", id, `مشتری #${id}`, NOW);
// 1. mirror of the masked balances as one manual voucher (stands in for the opening voucher in the sample)
const cash = all("select customer_id id, sum(cast(balance as real)) b from wallet_accounts_v2 where wallet_type='cash' group by customer_id having b<>0");
const plans = all("select plan_id id, cast(balance_toman as real) b from goods_company_wallets where cast(balance_toman as real)<>0");
const sps = all("select salesperson_id id, cast(balance_toman as real) b from goods_salesperson_wallets where cast(balance_toman as real)<>0");
const company = rial(one("select balance b from company_wallet_accounts where wallet_type='cash'")?.b ?? 0);
const zp = one("select coalesce(sum(cast(amount_rial as integer)),0) s from wallet_payment_intents where status='credited'").s;
const lines = [];
for (const w of cash) { const r = rial(w.b); lines.push({ account: "2201", tafsiliId: cu(w.id), ...(r > 0 ? { creditRial: r } : { debitRial: -r }) }); }
for (const w of plans) { const r = rial(w.b); lines.push({ account: "1201", tafsiliId: P.ensureTafsili(db, "PL", w.id, `طرح #${w.id}`, NOW), ...(r > 0 ? { debitRial: r } : { creditRial: -r }) }); }
for (const w of sps) { const r = rial(w.b); lines.push({ account: "2102", tafsiliId: P.ensureTafsili(db, "SP", w.id, `فروشنده #${w.id}`, NOW), ...(r > 0 ? { creditRial: r } : { debitRial: -r }) }); }
if (company) lines.push({ account: "4103", ...(company > 0 ? { creditRial: company } : { debitRial: -company }) });
if (zp) lines.push({ account: "1103", debitRial: zp });
const net = lines.reduce((s, l) => s + (l.debitRial ?? 0) - (l.creditRial ?? 0), 0);
if (net) lines.push({ account: "3104", ...(net > 0 ? { creditRial: net } : { debitRial: -net }) });
tx(() => P.postVoucher(db, { eventDate: "2026-10-22", kind: "manual", description: "مانده‌های نمونه (کپی ماسک‌شده)", sourceKey: "gl:shot:mirror", lines, nowIso: NOW }));
// 2. a few sample events after the start date
const c1 = cash[0]?.id ?? 1, c2 = cash[1]?.id ?? 2;
tx(() => P.postVoucher(db, { eventDate: "2026-10-24", kind: "manual", description: "شارژ کیف از درگاه (نمونه)", sourceKey: "gl:shot:e1", nowIso: NOW,
  lines: [{ account: "1103", debitRial: 25_000_000 }, { account: "2201", tafsiliId: cu(c1), creditRial: 25_000_000 }] }));
tx(() => P.postVoucher(db, { eventDate: "2026-10-25", kind: "manual", description: "کارمزد خدمات (نمونه)", sourceKey: "gl:shot:e2", nowIso: NOW,
  lines: [{ account: "2201", tafsiliId: cu(c2), debitRial: 1_500_000 }, { account: "4103", creditRial: 1_500_000 }] }));
tx(() => P.postVoucher(db, { eventDate: "2026-10-25", kind: "manual", description: "اعتبار خرید (یادداشتی، نمونه)", sourceKey: "gl:shot:e3", nowIso: NOW,
  lines: [{ account: "8101", tafsiliId: cu(c1), debitRial: 50_000_000 }, { account: "8102", creditRial: 50_000_000 }] }));
// 3. queue rows
db.prepare("insert into gl_posting_queue(source_key,event_type,status,attempts,last_error,created_at,updated_at) values('gl:shot:q1','P2','failed',3,'gl_unknown_account',?,?),('gl:shot:q2','P4','skipped',0,'gl_before_ledger_start',?,?)").run(NOW, NOW, NOW, NOW);
// 4. one pre-opening paid order (scene 726)
const order = one("select id from customer_payment_orders where stage<>'paid' order by id limit 1");
db.prepare(`insert into payment_order_prior_payments(payment_order_id,paid_date,tracking_no,amount_rial,receipt_filename,receipt_mime,receipt_sha256,entered_by_user_id,reason,created_at,ledger_start_date,pre_start,opening_mismatch)
  values(?,?,?,?,?,?,?,?,?,?,?,1,0)`).run(order.id, "2026-10-20", "TRK-NEMUNE-1", rial(one("select amount_toman a from customer_payment_orders where id=?", order.id).a), "receipt-sample.pdf", "application/pdf", "0".repeat(64), second, "پرداخت پیش از شروع (نمونه)", NOW, "2026-10-22");
// 5. draft opening set (step 4 confirmed) whose 2101 line does NOT match the open orders -> scene 136 warning
const chk = P.opening2101Check(db, null, "2026-10-21");
const cols = all("pragma table_info(gl_opening_balance_sets)").map((c) => c.name);
const setId = db.prepare(`insert into gl_opening_balance_sets(as_of_date,entered_by_user_id,reason,created_at${cols.includes("prior_payments_confirmed_at") ? ",prior_payments_confirmed_at" : ""}) values('2026-10-21',?,'پیش‌نویس نمونه',?${cols.includes("prior_payments_confirmed_at") ? ",?" : ""})`)
  .run(admin, NOW, ...(cols.includes("prior_payments_confirmed_at") ? [NOW] : [])).lastInsertRowid;
const acc = (c) => one("select id from gl_accounts where code=?", c).id;
const d2101 = Math.max(chk.expectedRial - 10_000_000, 10_000_000);
db.prepare("insert into gl_opening_balance_lines(set_id,account_id,credit_rial,debit_rial,created_at) values(?,?,?,0,?)").run(setId, acc("2101"), d2101, NOW);
db.prepare("insert into gl_opening_balance_lines(set_id,account_id,debit_rial,credit_rial,created_at) values(?,?,?,0,?)").run(setId, acc("3104"), d2101, NOW);
// 6. flags ON in this copy only, one nightly run
db.prepare("update gl_settings set value='1' where key in ('gl.reports','gl.nightly_compare')").run();
const run = R.runNightlyCompare(db, new Date());
console.log(JSON.stringify({ vouchers: one("select count(*) n from gl_vouchers").n, cash: cash.length, plans: plans.length, sps: sps.length, setId: Number(setId), preOpeningOrder: order.id, run: run?.status ?? null, check2101: chk.status }));
