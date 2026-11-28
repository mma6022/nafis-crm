/**
 * t984 «گفتگوهای بله تمام‌قد» backend: GET /bale-workspace/chats/:id/wallet behind flag.bale_fullheight_v1 (default OFF).
 * Scratch copy of a masked DB only (run-t984-bale-fullheight-fixture.mjs). Workers off, network blocked. Asserts the endpoint is read-only
 * (no account created, no row changed) and that it is never wider than the customer file's wallet permission.
 */
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { queryRow, queryRows, execute, executeChanges } from "../src/lib/crm-db.ts";
import { ensureBaleBotSchema } from "../src/lib/bale-bot.ts";
import { BFH_FLAG, bfhDir, bfhLabel, bfhOn } from "../src/lib/bale-fullheight.ts";
import { createBaleWorkspaceRouter } from "../src/routes/bale-workspace.ts";

if (!process.env.CRM_DATABASE_PATH || process.env.CRM_DATABASE_PATH.includes("/var/lib/nafisvam")) throw new Error("scratch DB only");
const net = [];
globalThis.fetch = async (u) => { net.push(String(u)); throw new Error("network blocked in t984 fixture"); };
const failures = []; let passed = 0;
const check = async (name, fn) => { try { await fn(); passed++; console.log("  ok ", name); } catch (e) { failures.push(name); console.error("  FAIL", name, e?.stack?.split("\n").slice(0, 4).join(" | ") ?? e); } };
const setFlag = (k, v) => v == null ? executeChanges("DELETE FROM call_queue_settings WHERE key=?", [k]) : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);

ensureBaleBotSchema();
const EXPERT = 8, ADMIN = 1;
const sp = queryRow("SELECT salesperson_id s FROM users WHERE id=?", [EXPERT]).s;
const own = queryRow("SELECT id FROM customers WHERE salesperson_id=? AND COALESCE(merged_into_customer_id,0)=0 ORDER BY id LIMIT 1", [sp]);
const other = queryRow("SELECT id FROM customers WHERE salesperson_id IS NOT NULL AND salesperson_id<>? AND COALESCE(merged_into_customer_id,0)=0 ORDER BY id LIMIT 1", [sp]);
const bareOwn = queryRow("SELECT id FROM customers WHERE salesperson_id=? AND COALESCE(merged_into_customer_id,0)=0 AND id<>? AND id NOT IN (SELECT customer_id FROM wallet_accounts_v2) ORDER BY id LIMIT 1", [sp, own.id]);
assert.ok(own?.id && other?.id && bareOwn?.id, "customers on the scratch copy");
const bot8 = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [EXPERT]); assert.ok(bot8);
const T0 = "2026-11-18T07:00:00.000Z";
const chat = (cid, tag) => execute("INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,customer_id,link_method,unread,last_at,created_at) VALUES(?,?,?,?,?,0,?,?)", [bot8.id, `t984-${tag}`, "fx", cid, cid ? "manual" : null, T0, T0]);
const cOwn = chat(own.id, "own"), cBare = chat(bareOwn.id, "bare"), cOther = chat(other.id, "other"), cNone = chat(null, "none");

// wallets for the own customer (scratch copy): cash 1,000,000 → +1,200,000 (cash_payment) −200,000 (filing_fee_out); credit 500,000 (loan_credit)
executeChanges("DELETE FROM wallet_ledger_v2 WHERE wallet_id IN (SELECT id FROM wallet_accounts_v2 WHERE customer_id=?)", [own.id]);
executeChanges("DELETE FROM wallet_accounts_v2 WHERE customer_id=?", [own.id]);
const cash = execute("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,?,?,?)", [own.id, "cash", "1000000", T0]);
const credit = execute("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,?,?,?)", [own.id, "credit", "500000", T0]);
const led = (w, amt, kind, key, at) => execute("INSERT INTO wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) VALUES(?,?,?,?,?)", [w, amt, kind, key, at]);
const l1 = led(cash, "5000", "transfer_in", "t984:1", "2026-11-10T08:00:00.000Z");
const l2 = led(cash, "1200000", "cash_payment", "t984:2", "2026-11-20T08:00:00.000Z");
const l3 = led(cash, "200000", "filing_fee_out", "t984:3", "2026-11-25T08:00:00.000Z");
const l4 = led(credit, "500000", "loan_credit:actor:5", "t984:4", "2026-11-22T08:00:00.000Z");

const counts = () => ({ acc: queryRow("SELECT COUNT(*) n FROM wallet_accounts_v2").n, led: queryRow("SELECT COUNT(*) n FROM wallet_ledger_v2").n, bal: JSON.stringify(queryRows("SELECT id,balance FROM wallet_accounts_v2 ORDER BY id")),
  ts: queryRow("SELECT COUNT(*) n FROM call_queue_settings").n, ns: queryRows("SELECT name FROM sqlite_master WHERE name LIKE '%notification_settings%' OR name LIKE '%team_sales_config%' OR name='contracts'").length });

setFlag("flag.bale_bot", "1"); setFlag(`flag.bale_bot.user.${EXPERT}`, "1"); setFlag(`flag.bale_bot.user.${ADMIN}`, "1");
setFlag("flag.bale_workspace_v1", "1"); setFlag(BFH_FLAG, null);

const AU = {
  [EXPERT]: { id: EXPERT, role: "salesperson", permissions: ["customers.view"], customerScope: "assigned", salespersonId: sp },
  [ADMIN]: { id: ADMIN, role: "admin", permissions: ["customers.view"], customerScope: "all", salespersonId: null },
  nope: { id: EXPERT, role: "salesperson", permissions: [], customerScope: "assigned", salespersonId: sp },
};
const app = express();
app.use((req, res, next) => { const k = req.headers["x-au"]; if (k) res.locals.authUser = AU[k]; next(); });
app.use("/api", createBaleWorkspaceRouter({ kick: () => {} }));
app.use((_req, res) => res.status(404).json({ error: "fallthrough" }));
const srv = http.createServer(app); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const call = (au, p) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: `/api${p}`, headers: { "x-au": String(au) } }, (rs) => {
    const ch = []; rs.on("data", (c) => ch.push(c)); rs.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString()); } catch { j = null; } resolve({ status: rs.statusCode, body: j, headers: rs.headers }); });
  }).on("error", reject);
});

console.log("t984 bale fullheight fixture");
const before = counts();
await check("OFF (flag absent): /me has no fullHeight and the wallet route is 404", async () => {
  assert.equal(bfhOn(), false);
  const me = await call(EXPERT, "/bale-workspace/me"); assert.equal(me.status, 200); assert.equal(me.body.fullHeight, undefined);
  assert.equal((await call(EXPERT, `/bale-workspace/chats/${cOwn}/wallet`)).status, 404);
});
for (const v of ["0", "true", "yes", ""]) await check(`only '1' is ON (value ${JSON.stringify(v)} stays OFF)`, async () => { setFlag(BFH_FLAG, v); assert.equal(bfhOn(), false); assert.equal((await call(EXPERT, `/bale-workspace/chats/${cOwn}/wallet`)).status, 404); });
setFlag(BFH_FLAG, "1");
await check("ON: /me carries fullHeight:true", async () => { const me = await call(EXPERT, "/bale-workspace/me"); assert.equal(me.body.fullHeight, true); });
await check("expert reads own customer's wallet: balances as strings, both wallets, newest first, no-store", async () => {
  const r = await call(EXPERT, `/bale-workspace/chats/${cOwn}/wallet`); assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.body.customerId, own.id); assert.equal(r.body.cashToman, "1000000"); assert.equal(r.body.creditToman, "500000"); assert.equal(r.body.truncated, false);
  assert.deepEqual(r.body.items.map((x) => x.id), [l3, l4, l2, l1]);
  const by = Object.fromEntries(r.body.items.map((x) => [x.id, x]));
  assert.equal(by[l3].dir, "out"); assert.equal(by[l2].dir, "in"); assert.equal(by[l4].wallet, "credit");
  assert.equal(by[l3].label, "کارمزد بررسی پرونده"); assert.equal(by[l2].label, "شارژ نقدی از درگاه"); assert.equal(by[l4].label, "شارژ اعتبار تسهیلات");
  // «مانده پس از تراکنش» walks back from the current balance: newest cash row ends at 1,000,000; before the −200,000 fee: 1,200,000; before +1,200,000: 0 (≥0)
  assert.equal(by[l3].balanceAfterToman, "1000000"); assert.equal(by[l2].balanceAfterToman, "1200000"); assert.equal(by[l1].balanceAfterToman, "0"); // fixture data is not a consistent ledger; the walk simply continues
  assert.equal(by[l4].balanceAfterToman, "500000");
  assert.deepEqual(Object.keys(r.body.items[0]).sort(), ["amountToman", "at", "balanceAfterToman", "dir", "id", "label", "wallet"]); // no actor / key / phone
});
await check("direction + label tables", async () => {
  for (const k of ["transfer_out", "filing_fee_out", "goods_purchase_debit", "credit_correction_debit", "legacy_manual_withdrawal", "legacy_filing_fee"]) assert.equal(bfhDir(k), "out", k);
  for (const k of ["transfer_in", "cash_payment", "loan_credit:actor:7", "legacy_manual_deposit", "legacy_loan_credit"]) assert.equal(bfhDir(k), "in", k);
  assert.equal(bfhLabel("something_new"), "سابقه کیف پول");
});
await check("a customer without wallet accounts: zeros, empty list, and NO account is created (read-only)", async () => {
  const b = counts(); const r = await call(EXPERT, `/bale-workspace/chats/${cBare}/wallet`);
  assert.equal(r.status, 200); assert.equal(r.body.cashToman, "0"); assert.equal(r.body.creditToman, "0"); assert.deepEqual(r.body.items, []);
  assert.equal(queryRow("SELECT COUNT(*) n FROM wallet_accounts_v2 WHERE customer_id=?", [bareOwn.id]).n, 0);
  assert.deepEqual(counts(), b);
});
await check("another expert's customer: 403 for the expert, 200 for admin", async () => {
  assert.equal((await call(EXPERT, `/bale-workspace/chats/${cOther}/wallet`)).status, 403);
  assert.equal((await call(ADMIN, `/bale-workspace/chats/${cOther}/wallet`)).status, 200);
});
await check("no customers.view → 403 even for the own customer (never wider than the customer file)", async () => {
  assert.equal((await call("nope", `/bale-workspace/chats/${cOwn}/wallet`)).status, 403);
});
await check("unlinked chat → 409; unknown chat → 404; unauthenticated user object → 403", async () => {
  assert.equal((await call(EXPERT, `/bale-workspace/chats/${cNone}/wallet`)).status, 409);
  assert.equal((await call(EXPERT, `/bale-workspace/chats/99999999/wallet`)).status, 404);
});
await check("user 29 is never served", async () => {
  const r = await call(29, `/bale-workspace/chats/${cOwn}/wallet`); assert.ok([403, 404].includes(r.status));
});
await check("read-only: after every call above nothing in wallets / settings / schema changed", async () => {
  const a = counts(); assert.equal(a.acc, before.acc); assert.equal(a.led, before.led); assert.equal(a.bal, before.bal); assert.equal(a.ns, before.ns);
});
await check("flag back OFF: wallet 404 again and /me has no fullHeight", async () => {
  setFlag(BFH_FLAG, null);
  assert.equal((await call(EXPERT, `/bale-workspace/chats/${cOwn}/wallet`)).status, 404);
  assert.equal((await call(EXPERT, "/bale-workspace/me")).body.fullHeight, undefined);
});
await check("no network", async () => { assert.deepEqual(net, []); });

srv.close();
console.log(failures.length ? `FAIL ${failures.length}: ${failures.join("; ")}` : `PASS ${passed}`);
process.exit(failures.length ? 1 : 0);
