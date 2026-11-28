/**
 * t991: the «مرحله N از ۷» prompt must be sent once per step transition, never on every inbound message.
 * Live bug (customer #1294 and three more on 2026-11-28): every free-text message from a customer with an
 * open filing made the bot paste the same step prompt again, even while an expert was talking to the customer.
 * Throwaway COPY of a masked DB only; Bale HTTP is mocked; never live.
 *
 *   T991_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t991-step2-repeat-fixture.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIVE = "/var/lib/nafisvam/customers.db";
const src = process.env.T991_FIXTURE_DB || process.env.CUSTOMER_BALE_FIXTURE_DB
  || ["/workspace/t861/masked.db", "/workspace/q-480000/mdb/m.db"].find((p) => fs.existsSync(p));
if (!src) { console.log("SKIP (set T991_FIXTURE_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === LIVE || (fs.existsSync(LIVE) && fs.realpathSync(src) === fs.realpathSync(LIVE))) throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t991-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", BALE_BOT_WORKER: "0" });

const { queryRow, queryRows, execute, executeChanges } = await import("../src/lib/crm-db.ts");
const { ensureBaleBotSchema, setBaleBotFetch } = await import("../src/lib/bale-bot.ts");
const { ensureBaleContactSchema } = await import("../src/lib/bale-contact.ts");
const cb = await import("../src/lib/customer-bale.ts");
const { CB_TEXTS, CB_BTNS, cbHandleInbound, cbActiveFiling, cbSetFlag, cbSetAdminFlag, stepLine, CB_STEP_PROMPT_COOLDOWN_MS } = cb;

setBaleBotFetch(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } }));
ensureBaleBotSchema(); ensureBaleContactSchema(); cb.ensureCustomerBaleSchema();

const T0 = Date.parse("2026-11-28T11:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
let failures = 0;
const ok = async (name, fn) => { try { await fn(); console.log("  ok ", name); } catch (e) { failures++; console.error("  FAIL", name, e?.message ?? e); } };

for (const k of ["tracking", "ai", "filing"]) cbSetFlag(k, true, iso(T0));
cbSetAdminFlag(false, iso(T0));
const bot = queryRow("SELECT * FROM bale_bots WHERE user_id=8");
assert.ok(bot, "bot for user 8");
let n = 920000;
const insCust = (name, phone) => execute(
  `INSERT INTO customers(name,first_name,phone,created_at,salesperson_id,status,verification_status,credit_rank)
   VALUES(?,?,?,?,6,'in_progress','verified','A1')`, [name, name.split(" ")[0], phone, iso(T0)]);
function newChat(name, phone) {
  const cid = insCust(name, phone);
  const chatId = String(++n);
  execute(`INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,last_name,username,created_at) VALUES(?,?,?,?, 't991', ?)`, [bot.id, chatId, name, "آزمایشی", iso(T0)]);
  const chat = queryRow("SELECT * FROM bale_bot_chats WHERE bot_id=? AND chat_id=?", [bot.id, chatId]);
  executeChanges("UPDATE bale_bot_chats SET customer_id=?, link_method='contact' WHERE id=?", [cid, chat.id]);
  return { chat: queryRow("SELECT * FROM bale_bot_chats WHERE id=?", [chat.id]), cid };
}
const ctx = (c, text, atMs, extra = {}) => ({ chat: { ...c.chat, owner_id: bot.user_id, customer_id: c.cid }, bot, customerId: c.cid, customerName: "آزمایش", text, at: iso(atMs), ...extra });
const stepOuts = (chatRow) => queryRows("SELECT * FROM bale_bot_messages WHERE chat_row=? AND dir='out' AND author_user_id IS NULL AND text LIKE 'مرحله % از ۷%' ORDER BY id", [chatRow]);
const addInbound = (chatRow, text, atMs) => execute("INSERT INTO bale_bot_messages(chat_row,dir,kind,text,created_at) VALUES(?,'in','text',?,?)", [chatRow, text, iso(atMs)]);
const expertSays = (chatRow, text, atMs) => execute("INSERT INTO bale_bot_messages(chat_row,dir,kind,text,status,author_user_id,created_at) VALUES(?,'out','text',?,'sent',8,?)", [chatRow, text, iso(atMs)]);

console.log("\n== t991 step prompt is not repeated on every message ==\n");

await ok("stepLine(2) is the credit-check header the customers saw", () => assert.equal(stepLine(2), "مرحله ۲ از ۷ — اعتبارسنجی"));

await ok("step 2 (identity ok, no credit): prompt once, then free text and expert chat do not repeat it", async () => {
  const c = newChat("کاربر الف", "09120000901");
  await cbHandleInbound(ctx(c, CB_TEXTS.menuApply, T0));
  const f = cbActiveFiling(c.chat.id);
  executeChanges("UPDATE customer_bale_filings SET identity_status='ok', step=2, wait_kind=NULL WHERE id=?", [f.id]);
  executeChanges("DELETE FROM bale_bot_messages WHERE chat_row=?", [c.chat.id]);
  // explicit resume: the prompt is sent (step transition into the step)
  await cbHandleInbound(ctx(c, CB_BTNS.resume, T0 + 1000));
  assert.equal(stepOuts(c.chat.id).length, 1, "prompt sent once on resume");
  assert.match(stepOuts(c.chat.id)[0].text, /^مرحله ۲ از ۷ — اعتبارسنجی/);
  // the customer chats with the expert: every message used to trigger the prompt again
  for (const [i, text] of ["خب برای من اینو انجام بدید", "سلام", "ضامن لازم نیست؟", "ok", "؟"].entries()) {
    addInbound(c.chat.id, text, T0 + 60000 * (i + 1));
    await cbHandleInbound(ctx(c, text, T0 + 60000 * (i + 1)));
  }
  assert.equal(stepOuts(c.chat.id).length, 1, "five free-text messages sent no extra prompt");
  expertSays(c.chat.id, "ضامن نیاز داری", T0 + 600000);
  await cbHandleInbound(ctx(c, "باشه", T0 + 660000));
  await cbHandleInbound(ctx(c, "ممنون", T0 + 700000));
  assert.equal(stepOuts(c.chat.id).length, 1, "still no repeat after the expert wrote");
  const aud = queryRows("SELECT action FROM customer_bale_audit WHERE chat_row=? AND action='step_prompt_suppressed'", [c.chat.id]);
  assert.equal(aud.length, 7, "each suppressed prompt is audited");
});

await ok("expert wrote after the prompt: still silent after the cooldown; without an expert: one reminder per cooldown", async () => {
  const withExpert = newChat("کاربر ب", "09120000902");
  const without = newChat("کاربر پ", "09120000903");
  for (const c of [withExpert, without]) {
    await cbHandleInbound(ctx(c, CB_TEXTS.menuApply, T0));
    const f = cbActiveFiling(c.chat.id);
    executeChanges("UPDATE customer_bale_filings SET identity_status='ok', step=2, wait_kind=NULL WHERE id=?", [f.id]);
    executeChanges("DELETE FROM bale_bot_messages WHERE chat_row=?", [c.chat.id]);
    await cbHandleInbound(ctx(c, CB_BTNS.resume, T0));
  }
  expertSays(withExpert.chat.id, "سلام، کارشناس هستم", T0 + 5000);
  const later = T0 + CB_STEP_PROMPT_COOLDOWN_MS + 3600000;
  await cbHandleInbound(ctx(withExpert, "سلام", later));
  assert.equal(stepOuts(withExpert.chat.id).length, 1, "expert engaged: no repeat even after the cooldown");
  await cbHandleInbound(ctx(without, "سلام", T0 + 3600000));
  assert.equal(stepOuts(without.chat.id).length, 1, "inside the cooldown: no repeat");
  await cbHandleInbound(ctx(without, "سلام", later));
  assert.equal(stepOuts(without.chat.id).length, 2, "customer came back after the cooldown: one reminder");
  await cbHandleInbound(ctx(without, "هنوز هستم", later + 60000));
  assert.equal(stepOuts(without.chat.id).length, 2, "and not again right after");
});

await ok("a real step transition always sends the new step prompt; buttons are never suppressed", async () => {
  const c = newChat("کاربر ت", "09120000904");
  await cbHandleInbound(ctx(c, CB_TEXTS.menuApply, T0));
  const f = cbActiveFiling(c.chat.id);
  executeChanges("UPDATE customer_bale_filings SET identity_status='ok', step=2, wait_kind=NULL WHERE id=?", [f.id]);
  executeChanges("DELETE FROM bale_bot_messages WHERE chat_row=?", [c.chat.id]);
  await cbHandleInbound(ctx(c, CB_BTNS.resume, T0));
  await cbHandleInbound(ctx(c, "سلام", T0 + 1000));
  assert.equal(stepOuts(c.chat.id).length, 1);
  // «ارسال کد» is a wizard action: state changes to credit_otp and its prompt (same step 2, different text) is sent
  await cbHandleInbound(ctx(c, CB_BTNS.sendCode, T0 + 2000, { creditStartFn: async () => "otp" }));
  assert.equal(cbActiveFiling(c.chat.id).wait_kind, "credit_otp");
  assert.equal(stepOuts(c.chat.id).length, 2);
  assert.ok(stepOuts(c.chat.id)[1].text.includes("کد"), "OTP prompt text");
  // the same button again is explicit input, not free text: always answered
  await cbHandleInbound(ctx(c, CB_BTNS.submitCode, T0 + 3000));
  assert.equal(stepOuts(c.chat.id).length, 3);
  // OTP step: any text is the OTP; the validate result moves the step and its prompt goes out
  await cbHandleInbound(ctx(c, "123456", T0 + 4000, { creditValidateFn: async () => "ok" }));
  assert.equal(cbActiveFiling(c.chat.id).step, 3);
  const outs = stepOuts(c.chat.id);
  assert.match(outs[outs.length - 1].text, /^مرحله ۳ از ۷/);
  // «مرحله ۳» prompt is also sent once for free text
  const before = stepOuts(c.chat.id).length;
  await cbHandleInbound(ctx(c, "چی بگم", T0 + 5000));
  await cbHandleInbound(ctx(c, "چی بگم", T0 + 6000));
  assert.equal(stepOuts(c.chat.id).length, before, "step 3 prompt not repeated for free text");
});

await ok("identity wait: the «در انتظار کارشناس» prompt is sent once, not per message", async () => {
  const c = newChat("کاربر ث", "09120000905");
  await cbHandleInbound(ctx(c, CB_TEXTS.menuApply, T0));
  const f = cbActiveFiling(c.chat.id);
  executeChanges("UPDATE customer_bale_filings SET identity_status='wait', wait_kind='identity', step=1 WHERE id=?", [f.id]);
  executeChanges("DELETE FROM bale_bot_messages WHERE chat_row=?", [c.chat.id]);
  await cbHandleInbound(ctx(c, "سلام", T0 + 1000));
  const first = stepOuts(c.chat.id).length;
  assert.equal(first, 1);
  await cbHandleInbound(ctx(c, "سلام؟", T0 + 2000));
  await cbHandleInbound(ctx(c, "کسی هست؟", T0 + 3000));
  assert.equal(stepOuts(c.chat.id).length, first);
});

if (failures) { console.error("\nFAILED", failures); process.exit(1); }
console.log("\nAll t991 checks passed.");
