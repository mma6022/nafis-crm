// Copy-DB demo seed for the team-sales commission model. LOCAL COPY ONLY — refuses anything that looks like the live DB.
// Phases (server stopped while running):
//   TC_DEMO_PHASE=prep     scrub relay URL + sessions, temp passwords (users 1,2 only) from TC_DEMO_PW_FILE, synthetic customers/purchases/orders
//   TC_DEMO_PHASE=complete registrar final approval of the synthetic purchases (team hook; the signed-acknowledgement document step is skipped —
//                          contract/document rows are off-limits, so the demo does not fabricate them)
// Usage: CRM_DATABASE_PATH=/tmp/x.db TC_DEMO_PHASE=prep node scripts/run-bundled-fixture.mjs scripts/team-commission-demo-seed.mjs
import fs from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;
const dbPath = process.env.CRM_DATABASE_PATH ?? "";
if (!dbPath || dbPath.startsWith("/var/lib") || !/^\/tmp\//.test(dbPath)) { console.error("refusing: CRM_DATABASE_PATH must be a throwaway copy under /tmp"); process.exit(2); }
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
const { queryRow, queryRows, execute, runTransaction } = await import("../src/lib/crm-db.ts");
const m = await import("../src/lib/team-commission.ts");
m.ensureTeamCommissionSchema();
const now = () => new Date().toISOString();
const phase = process.env.TC_DEMO_PHASE;
const SEED = "tc-demo";

if (phase === "prep") {
  if (queryRow("SELECT 1 x FROM customers WHERE description=?", [SEED])) { console.log("already seeded"); process.exit(0); }
  execute("DELETE FROM notification_settings WHERE key='ippanelRelayUrl'");
  execute("DELETE FROM auth_sessions");
  const pw = fs.readFileSync(process.env.TC_DEMO_PW_FILE, "utf8").trim();
  for (const uid of [1, 2]) {
    const salt = randomBytes(16).toString("hex");
    const h = scryptSync(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
    execute("UPDATE users SET password_hash=? WHERE id=?", [`scrypt:32768:8:1$${salt}$${h}`, uid]);
  }
  const fund = Number(execute("INSERT INTO finance_bank_accounts(bank_name,owner_name,fund_name,iban,owner_type,created_by,created_at) VALUES('بانک نمونه','نفیس وام (نمونه)','صندوق نمونه','IR000000000000000000000000','company',1,?)", [now()]));
  const cols = (t) => queryRows(`PRAGMA table_info(${t})`).map((c) => c.name).filter((c) => c !== "id");
  const clone = (t, id, over) => { const cs = cols(t); return Number(execute(`INSERT INTO ${t}(${cs.join(",")}) SELECT ${cs.map((c) => (c in over ? "?" : c)).join(",")} FROM ${t} WHERE id=?`, [...cs.filter((c) => c in over).map((c) => over[c]), id])); };
  const blank = Object.fromEntries(["credit_score","credit_rank","credit_checked_at","birth_date_jalali","postal_code","father_name","address","email","verification_checked_at","verification_provider","shahkar_status","sana_status","person_info_status","postal_code_info_status","shahkar_ok","person_info_ok","postal_code_info_ok","sana_ok","official_first_name","official_last_name","official_father_name","official_address","official_postal_code","merged_into_customer_id","identity_changed_at"].map((k) => [k, null]));
  const base = queryRow("SELECT id FROM customers ORDER BY id LIMIT 1").id;
  const purchaseTpl = queryRow("SELECT id FROM goods_purchases ORDER BY id DESC LIMIT 1").id;
  const customer = (n, name, sp, nc) => clone("customers", base, { ...blank, name, first_name: name.split(" ")[0], last_name: name.split(" ").slice(1).join(" "), phone: `090000020${n}0`, description: SEED,
    salesperson_id: sp, priority: 1, status: "in_progress", national_code: nc, verification_status: "unverified", is_urgent: 0, created_at: new Date(Date.now() - 86400e3).toISOString() });
  const cfg = (sp) => JSON.stringify({ ...queryRow("SELECT * FROM goods_salesperson_settings WHERE salesperson_id=?", [sp]) });
  const purchase = (c, sp, payout, baseAmt, stage) => clone("goods_purchases", purchaseTpl, { customer_id: c, salesperson_id: sp, stage, payout_amount_toman: String(payout), base_payout_amount_toman: String(baseAmt),
    completed_at: null, commission_bps: null, commission_toman: null, commission_month: null, commission_settings_json: cfg(sp), created_at: now(), fee_discount_toman: "0" });
  const hist = (c, source, oldP, sp) => execute("INSERT INTO customer_priority_history(customer_id,old_priority,new_priority,old_salesperson_id,new_salesperson_id,actor_user_id,source,reason,created_at) VALUES(?,?,1,6,?,8,?,?,?)",
    [c, oldP, sp, source, "نمونه‌ی دمو", new Date(Date.now() - 3 * 3600e3).toISOString()]);
  const order = (pid, c, sp, amount, nc, owner) => Number(execute(`INSERT INTO customer_payment_orders(purchase_id,customer_id,salesperson_id,amount_toman,stage,destination_iban,destination_owner_name,verified_national_code,created_by,created_at,updated_at)
    VALUES(?,?,?,?,'awaiting_payment','IR000000000000000000000001',?,?,1,?,?)`, [pid, c, sp, String(amount), owner, nc, now(), now()]));
  const month = m.persianMonthOf(new Date());
  const f = customer(0, "مشتری نمونه پایه", 3, "0000000000");
  const fp = purchase(f, 3, 1_750_000_000, 1_750_000_000, "completed");
  execute("UPDATE goods_purchases SET completed_at=?,commission_bps=150,commission_toman='26250000',commission_month=? WHERE id=?", [now(), month, fp]);
  const a = customer(1, "مشتری نمونه الف", 3, "0000000011"); hist(a, "qualifier_form", null, 3);
  const pa = purchase(a, 3, 300_000_000, 280_000_000, "registrar_confirmation"); const oa = order(pa, a, 3, 300_000_000, "0000000011", "مشتری نمونه الف");
  const b = customer(2, "مشتری نمونه ب", 3, "0000000022"); hist(b, "promote", 2, 3);
  const pb = purchase(b, 3, 300_000_000, 280_000_000, "registrar_confirmation"); const ob = order(pb, b, 3, 300_000_000, "0000000022", "مشتری نمونه ب");
  fs.writeFileSync(process.env.TC_DEMO_IDS ?? "/tmp/tc-demo-ids.json", JSON.stringify({ fund, filler: { c: f, p: fp }, a: { c: a, p: pa, o: oa }, b: { c: b, p: pb, o: ob } }, null, 1));
  console.log("seeded", JSON.stringify({ fund, a, pa, oa, b, pb, ob }));
} else if (phase === "complete") {
  const ids = JSON.parse(fs.readFileSync(process.env.TC_DEMO_IDS ?? "/tmp/tc-demo-ids.json", "utf8"));
  for (const k of ["a", "b"]) {
    const r = runTransaction(() => m.onGoodsPurchaseCompletion(queryRow("SELECT * FROM goods_purchases WHERE id=?", [ids[k].p]), 1));
    console.log(k, "completion:", r);
  }
} else { console.error("set TC_DEMO_PHASE=prep|complete"); process.exit(2); }
