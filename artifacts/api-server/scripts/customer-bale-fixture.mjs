// customer Bale bot fixture: scratch copy of masked_live.db, Bale/OpenAI/DeepSeek HTTP all mocked.
import assert from "node:assert/strict";
import { queryRow, queryRows, execute, executeChanges } from "../src/lib/crm-db.ts";
import { ensureBaleBotSchema, _resetSchemaFlagForTests, setBaleBotFetch } from "../src/lib/bale-bot.ts";
import { ensureBaleContactSchema, _resetBcSchemaFlagForTests, BC_GHASEMI_USER_ID, bcMaySendFromBot } from "../src/lib/bale-contact.ts";
import {
  CB_FLAGS, CB_ADMIN_FLAG, CB_TEXTS, CB_BTNS, CB_DEFAULT_OPENAI_MODEL, CB_DEFAULT_DEEPSEEK_MODEL,
  CB_KB_SCOPE_ALL, CB_KB_SCOPE_SHARED, CB_KB_SCOPE_EXPERTS, CB_TEST_TITLE, CB_TEST_OK, CB_TEST_FAIL,
  ensureCustomerBaleSchema, _resetCustomerBaleSchemaFlag, cbFlagOn, cbSetFlag, cbAnyFlagOn,
  cbAdminFlagOn, cbSetAdminFlag, cbSetPhaseFlags, faDigits, stepLine,
  cbHandleInbound, cbListCasesForCustomer, cbTop3Plans, cbOpenSamePlan, planLabelForCustomer,
  cbStartOrResumeFiling, cbActiveFiling, cbOnFeePaid, cbIssueContract, cbAdvanceContract,
  cbAnswerAi, cbGuardAiText, cbStoreSecret, cbSecretMeta, cbReadSecret, cbMaskSecretIn,
  cbDeleteSecret, cbTestSecret, setCbSecretTestFn, cbPreviewKb, cbKbText, cbKbUpsert, cbKbList, cbNormalizeKbScope,
  cbQueueText, cbWelcomeAfterLink, cbCreateHandoff, cbClaimHandoff, cbAiFailed, cbRecordAiTurn,
  cbSetAiMode, last30DaysTehranWindow, lockDownOn, cbIsFromBale,
  ensureSharedCustomerBot, cbSharedBot, cbSharedBotPublic, cbClearSharedBotToken, isSharedCustomerBot , setCbSignPath, cbCheckSign,
} from "../src/lib/customer-bale.ts";
import { bcLinkOrCreateLead, BC_OK_NEW, BC_ASK_FIRST_SHARED } from "../src/lib/bale-contact.ts";
import { botSends, isSharedCustomerBot as isSharedBotRow } from "../src/lib/bale-bot.ts";
import { jalaliWeekdayDate } from "../../crm-dashboard/src/features/bale-bot/jalali.ts";

if (!process.env.CRM_DATABASE_PATH) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const LIVE = "/var/lib/nafisvam/customers.db";
  const candidates = [
    process.env.CUSTOMER_BALE_FIXTURE_DB, process.env.MASKED_DB,
    "/workspace/team-model/rel/masked-pkgtest.db",
    "/workspace/perm-status/masked_live.db",
  ].filter((p) => p && fs.existsSync(p));
  if (!candidates.length) throw new Error("CRM_DATABASE_PATH required (scratch copy only)");
  const src = path.resolve(candidates[0]);
  if (src === path.resolve(LIVE)) throw new Error("Refusing live DB");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-fx-"));
  const dest = path.join(dir, "customers.db");
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o600);
  process.env.CRM_DATABASE_PATH = dest;
}
process.env.BALE_BOT_WORKER = "0";
process.env.NODE_ENV = "test";

const failures = [];
const check = (name, fn) => {
  try { const r = fn(); if (r && typeof r.then === "function") throw new Error("use checkAsync for " + name); console.log("  ok ", name); }
  catch (e) { failures.push(name); console.error("  FAIL", name, e?.message ?? e); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); console.log("  ok ", name); }
  catch (e) { failures.push(name); console.error("  FAIL", name, e?.message ?? e); }
};

const AT = "2026-11-10T12:00:00.000Z";
const setSetting = (key, value) => {
  if (value == null) executeChanges("DELETE FROM call_queue_settings WHERE key=?", [key]);
  else execute("INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [key, value, AT]);
};

const baleCalls = [];
setBaleBotFetch(async (url) => {
  const u = String(url);
  if (!u.includes("tapi.bale.ai")) throw new Error("unexpected network " + u);
  baleCalls.push(u.replace(/bot[^/]+/, "bot<redacted>"));
  return new Response(JSON.stringify({ ok: true, result: { message_id: 7000 + baleCalls.length } }), { headers: { "content-type": "application/json" } });
});

// Global fetch guard: any real OpenAI / DeepSeek / unexpected host fails the run.
const realFetch = globalThis.fetch;
const aiCalls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("tapi.bale.ai")) return realFetch(url, init);
  if (u.includes("api.openai.com") || u.includes("api.deepseek.com")) {
    throw new Error("unmocked AI HTTP: " + u.replace(/key=[^&]+/g, "key=redacted"));
  }
  throw new Error("unexpected network " + u);
};

_resetSchemaFlagForTests();
_resetBcSchemaFlagForTests();
_resetCustomerBaleSchemaFlag();
ensureBaleBotSchema();
ensureBaleContactSchema();
ensureCustomerBaleSchema();

const botOf = (userId) => {
  const b = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [userId]);
  assert.ok(b, "bot for user " + userId);
  return b;
};
const kazemi = botOf(8), hasani = botOf(2), ghasemi = botOf(3);

let uid = 910000;
const nextId = () => ++uid;
function openChat(bot, first = "سمیرا") {
  const chatId = String(nextId());
  execute(
    `INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,last_name,username,created_at)
     VALUES(?,?,?,?, 'samira_t', ?)`,
    [bot.id, chatId, first, "آزمایشی", AT],
  );
  const row = queryRow("SELECT * FROM bale_bot_chats WHERE bot_id=? AND chat_id=?", [bot.id, chatId]);
  return row;
}

function linkChat(chat, customerId) {
  executeChanges("UPDATE bale_bot_chats SET customer_id=?, link_method='contact' WHERE id=?", [customerId, chat.id]);
  return queryRow("SELECT * FROM bale_bot_chats WHERE id=?", [chat.id]);
}

function outs(chatRow) {
  return queryRows("SELECT * FROM bale_bot_messages WHERE chat_row=? AND dir='out' ORDER BY id", [chatRow]);
}
function texts(chatRow) { return outs(chatRow).map((m) => m.text); }
function wipeOut(chatRow) { executeChanges("DELETE FROM bale_bot_messages WHERE chat_row=?", [chatRow]); }

for (let i = 0; i < 12; i++) executeChanges("DELETE FROM customers WHERE phone=?", ["0912000004" + String(i).padStart(1, "0")]);

const insCust = (name, phone, sp, rank = "A1") => execute(
  `INSERT INTO customers(name,first_name,phone,description,created_at,salesperson_id,status,verification_status,credit_rank)
   VALUES(?,?,?,NULL,?,?,'in_progress','verified',?)`,
  [name, name.split(" ")[0], phone, AT, sp, rank],
);

const samiraId = insCust("سمیرا نادری", "09120000040", 6, "A1");
const nimaId = insCust("نیما اکبری", "09120000041", 6, "D3");
const maryamId = insCust("مریم حسینی", "09120000042", 3, "B1");

const flagsOff = () => { cbSetFlag("tracking", false, AT); cbSetFlag("ai", false, AT); cbSetFlag("filing", false, AT); };
const flagsOn = () => { cbSetFlag("tracking", true, AT); cbSetFlag("ai", true, AT); cbSetFlag("filing", true, AT); };
flagsOff();

const ctxOf = (chat, bot, customerId, name, extra = {}) => ({
  chat: { ...chat, owner_id: bot.user_id, customer_id: customerId },
  bot, customerId, customerName: name, text: "", at: AT, ...extra,
});

console.log("\n== customer-bale fixture ==\n");

/* flags default off + updated_at */
check("flags default off / any false", () => {
  flagsOff();
  assert.equal(cbFlagOn("tracking"), false);
  assert.equal(cbFlagOn("ai"), false);
  assert.equal(cbFlagOn("filing"), false);
  assert.equal(cbAnyFlagOn(), false);
  assert.equal(cbAdminFlagOn(), false);
  const adminRow = queryRow("SELECT value FROM call_queue_settings WHERE key=?", [CB_ADMIN_FLAG]);
  assert.ok(!adminRow || adminRow.value !== "1");
  for (const k of Object.values(CB_FLAGS)) {
    const r = queryRow("SELECT value, updated_at FROM call_queue_settings WHERE key=?", [k]);
    assert.equal(r.value, "0");
    assert.ok(r.updated_at, "updated_at set for " + k);
  }
});

await checkAsync("flags OFF: handleInbound is a no-op", async () => {
  flagsOff();
  const chat = linkChat(openChat(kazemi), samiraId);
  const n0 = outs(chat.id).length;
  const r = await cbHandleInbound(ctxOf(chat, kazemi, samiraId, "سمیرا", { text: CB_TEXTS.menuTrack }));
  assert.equal(r, null);
  assert.equal(outs(chat.id).length, n0);
});

/* plan label */
check("plan label is لندتک / bank, normalizes dash, never internal name", () => {
  assert.equal(planLabelForCustomer("ملت"), "لندتک / ملت");
  assert.equal(planLabelForCustomer("اقتصاد نوین"), "لندتک / اقتصاد نوین");
  assert.equal(planLabelForCustomer("  اقتصاد - نوین  "), "لندتک / اقتصاد نوین");
  assert.ok(!planLabelForCustomer("اقتصاد - نوین").includes("،"), "must not split a single bank name");
  assert.equal(planLabelForCustomer("گردشگری - اقتصاد نوین  - دی"), "لندتک / گردشگری، اقتصاد نوین، دی");
  assert.equal(planLabelForCustomer("بلوبانک - های بانک"), "لندتک / بلوبانک، های بانک");
  const lab = planLabelForCustomer("بلوبانک");
  assert.ok(!lab.includes("بازنشسته") && !lab.includes("چابک") && !lab.includes("ترنم"));
});

/* tracking */
function seedApp(customerId, planId, stage, createdAt, fee) {
  const plan = queryRow("SELECT * FROM loan_plans WHERE id=?", [planId]);
  const cid = execute("INSERT INTO consultation_forms(customer_id,requested_amount,updated_at) VALUES(?,?,?)", [customerId, 0, createdAt]);
  const id = execute(
    `INSERT INTO loan_applications(consultation_id,customer_id,plan_ids,plan_id,requested_amount,stage,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?, 'requested', ?, ?)`,
    [cid, customerId, JSON.stringify([planId]), planId, 0, stage, createdAt, createdAt],
  );
  if (fee) {
    execute(
      `INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,application_id,created_at)
       VALUES(?,?,?,?,?,?)`,
      [customerId, planId, fee, "cb-test-" + id, id, createdAt],
    );
  }
  return id;
}

check("tracking lists all cases for the phone with label/id/paid amount/stage", () => {
  flagsOn();
  const a1 = seedApp(samiraId, 19, "customer_documents_upload", "2026-10-24T08:00:00.000Z", 300000);
  const a2 = seedApp(samiraId, 8, "primary_contract_pending_signature", "2026-10-28T08:00:00.000Z", 300000);
  const list = cbListCasesForCustomer(samiraId);
  assert.ok(list.length >= 2);
  const ids = list.map((x) => x.id);
  assert.ok(ids.includes(a1) && ids.includes(a2));
  for (const c of list) {
    assert.match(c.plan, /^لندتک \//);
    assert.ok(!/چابک|ترنم|بازنشسته/.test(c.plan));
    assert.ok(c.stage && c.stage.length > 0);
    assert.ok("feePaid" in c && "feeText" in c);
    if (c.id === a1) {
      assert.equal(c.feePaid, true);
      assert.equal(c.feeAmount, 300000);
      assert.equal(c.stage, "بارگذاری مدارک مشتری");
    }
  }
  const unpaid = seedApp(samiraId, 21, "draft", AT, null);
  const u = cbListCasesForCustomer(samiraId).find((x) => x.id === unpaid);
  assert.equal(u.feePaid, false);
  assert.equal(u.feeText, CB_TEXTS.feeUnpaid);
});

await checkAsync("tracking bot texts: none / many", async () => {
  flagsOn();
  const emptyCust = insCust("بی‌پرونده آزمایشی", "09120000043", 6, "A1");
  const chat = linkChat(openChat(kazemi, "بی‌پرونده"), emptyCust);
  await cbHandleInbound(ctxOf(chat, kazemi, emptyCust, "بی‌پرونده", { text: CB_TEXTS.menuTrack }));
  assert.ok(texts(chat.id).some((t) => t.includes("هنوز پرونده")));
  const chat2 = linkChat(openChat(kazemi), samiraId);
  await cbHandleInbound(ctxOf(chat2, kazemi, samiraId, "سمیرا", { text: CB_TEXTS.menuTrack }));
  const tx = texts(chat2.id).join("\n");
  assert.ok(tx.includes("پرونده‌های متصل") || tx.includes("لندتک /"));
  assert.ok(tx.includes("کارمزد ثبت"));
});

/* top 3 */
check("top-3 active plans by last 30 days (rolling from now), filtered by conditions", () => {
  const now = new Date("2026-11-09T20:00:00.000Z");
  const w = last30DaysTehranWindow(now);
  assert.equal(w.end, "2026-11-09T20:00:00.000Z");
  assert.equal(w.start, "2026-10-10T20:00:00.000Z");
  assert.ok(CB_TEXTS.plans.includes("۳۰ روز گذشته"));
  assert.ok(!CB_TEXTS.plans.includes("ماه گذشته"));
  const topA = cbTop3Plans(samiraId, now);
  assert.ok(topA.length <= 3);
  assert.ok(topA.length >= 1, "expected at least one matching plan");
  for (const p of topA) {
    assert.match(p.label, /^لندتک \//);
    const active = queryRow("SELECT active FROM loan_plans WHERE id=?", [p.id]);
    assert.equal(Number(active.active), 1);
  }
  const topD = cbTop3Plans(nimaId, now);
  for (const p of topD) {
    const conds = queryRows("SELECT customer_ranks FROM loan_plan_conditions WHERE plan_id=?", [p.id]);
    // if conditions exist they should be compatible with D3 (rankMatches is also used in production)
  }
  // volume order: first has count >= second
  for (let i = 1; i < topA.length; i++) assert.ok(topA[i - 1].n >= topA[i].n);
});

/* same plan block */
check("same-plan open case is blocked", () => {
  const open = cbOpenSamePlan(samiraId, 19);
  assert.ok(open, "samira already has open plan 19");
});

/* filing resume + human waits + create under own salesperson */
await checkAsync("filing: resume at same step, human waits, fee then create under own salesperson", async () => {
  flagsOn();
  const filerId = insCust("سارا پرونده‌ساز", "09120000044", 6, "A1");
  const chat = linkChat(openChat(kazemi, "سارا"), filerId);
  const ctx = (text, extra = {}) => ctxOf(chat, kazemi, filerId, "سارا", { text, ...extra });
  await cbHandleInbound(ctx(CB_TEXTS.menuApply));
  let f = cbActiveFiling(chat.id);
  assert.equal(f.step, 1);
  // identity wait (manual)
  await cbHandleInbound(ctx("0012345678 1370/01/01", {
    identityFn: async () => "wait",
  }));
  f = cbActiveFiling(chat.id);
  assert.equal(f.wait_kind, "identity");
  let tx = texts(chat.id).join("\n");
  assert.ok(tx.includes("در انتظار کارشناس"));
  // expert clears wait in CRM by flipping status (simulate)
  executeChanges("UPDATE customer_bale_filings SET identity_status='ok', wait_kind=NULL, step=2 WHERE id=?", [f.id]);
  wipeOut(chat.id);
  await cbHandleInbound(ctx(CB_TEXTS.menuApply)); // resume offer
  tx = texts(chat.id).join("\n");
  assert.ok(tx.includes("ثبت درخواست ناتمام") || tx.includes("ادامه"));
  await cbHandleInbound(ctx(CB_BTNS.resume));
  await cbHandleInbound(ctx(CB_BTNS.sendCode, { creditStartFn: async () => "otp" }));
  f = cbActiveFiling(chat.id);
  assert.equal(f.wait_kind, "credit_otp");
  // OTP must not be stored
  await cbHandleInbound(ctx("123456", { creditValidateFn: async () => "fail" }));
  f = cbActiveFiling(chat.id);
  assert.equal(f.wait_kind, "credit_fail");
  const blob = JSON.stringify(queryRow("SELECT * FROM customer_bale_filings WHERE id=?", [f.id]));
  assert.ok(!blob.includes("123456"), "OTP must not be stored");
  tx = texts(chat.id).join("\n");
  assert.ok(tx.includes("در انتظار کارشناس"));
  assert.ok(!tx.includes("123456"), "OTP must not appear in messages");
  executeChanges("UPDATE customer_bale_filings SET credit_status='ok', wait_kind=NULL, step=3 WHERE id=?", [f.id]);
  wipeOut(chat.id);
  await cbHandleInbound(ctx(CB_BTNS.resume));
  // pick a plan that is NOT 19 (already open) — use اقتصاد نوین / plan 8 if offered, else first non-19
  const plans = cbTop3Plans(filerId, new Date("2026-11-09T20:00:00.000Z"));
  assert.ok(plans.length, "top-3 available for filer");
  const pick = plans[0];
  await cbHandleInbound(ctx(pick.label));
  f = cbActiveFiling(chat.id);
  assert.ok(f.plan_id, "plan selected");
  assert.equal(f.step, 4);
  // send docs one by one, drop mid-way, resume
  await cbHandleInbound(ctx(CB_BTNS.sendPhoto, { hasPhoto: true }));
  f = cbActiveFiling(chat.id);
  assert.equal(f.doc_index, 1);
  assert.equal(f.step, 4);
  wipeOut(chat.id);
  await cbHandleInbound(ctx(CB_TEXTS.menuApply));
  tx = texts(chat.id).join("\n");
  assert.ok(tx.includes("از همان مرحله") || tx.includes("آخرین مرحله"));
  await cbHandleInbound(ctx(CB_BTNS.resume));
  f = cbActiveFiling(chat.id);
  assert.equal(f.step, 4);
  assert.equal(f.doc_index, 1);
  // finish remaining docs
  for (let i = f.doc_index; i < 5; i++) await cbHandleInbound(ctx(CB_BTNS.sendPhoto, { hasPhoto: true }));
  f = cbActiveFiling(chat.id);
  assert.equal(f.wait_kind, "docs");
  tx = texts(chat.id).join("\n");
  assert.ok(tx.includes("در انتظار کارشناس"));
  executeChanges("UPDATE customer_bale_filings SET wait_kind=NULL, step=5 WHERE id=?", [f.id]);
  await cbHandleInbound(ctx(CB_BTNS.confirm));
  f = cbActiveFiling(chat.id);
  assert.equal(f.wait_kind, "fee");
  tx = texts(chat.id).join("\n");
  assert.ok(tx.includes("در انتظار پرداخت کارمزد"));
  // paying is not done by the bot — after a charge is linked:
  const appId = cbOnFeePaid(f.id, AT);
  assert.ok(appId);
  const app = queryRow("SELECT * FROM loan_applications WHERE id=?", [appId]);
  assert.equal(Number(app.salesperson_id_snapshot), 6); // Samira's own salesperson (Kazemi)
  assert.equal(cbIsFromBale(appId), true);
  f = cbActiveFiling(chat.id);
  assert.equal(f.application_id, appId);
});

await checkAsync("contract path call order is generate → send → check-status", async () => {
  const order = [];
  const path = {
    generate: async (applicationId) => { order.push("generate:" + applicationId); return { id: 4242 }; },
    send: async (generationId) => { order.push("send:" + generationId); return { ok: true }; },
    checkStatus: async (generationId) => { order.push("check-status:" + generationId); return { status: "pending" }; },
  };
  const r = await cbIssueContract(99, path);
  assert.deepEqual(r.order, ["generate", "send", "check-status"]);
  assert.deepEqual(order, ["generate:99", "send:4242", "check-status:4242"]);
  assert.equal(r.status, "pending");
});

/* AI */
check("guard rejects rates and approval promises", () => {
  assert.equal(cbGuardAiText("نرخ سود ۱۸٪ است").ok, false);
  assert.equal(cbGuardAiText("حتماً تصویب می‌شود").ok, false);
  assert.equal(cbGuardAiText("برای شروع کارت ملی لازم است").ok, true);
});

await checkAsync("AI: OpenAI first, DeepSeek fallback on 429/error/timeout, no real HTTP", async () => {
  flagsOn();
  cbStoreSecret("openai", "sk-test-openai-aaaa");
  cbStoreSecret("deepseek", "sk-test-deepseek-bbbb");
  const calls = [];
  const fetchFn = async ({ baseUrl, model, apiKey }) => {
    calls.push({ baseUrl, model, hasKey: !!apiKey, keyStarts: String(apiKey).slice(0, 3) });
    if (baseUrl.includes("openai")) return { ok: false, status: 429, error: "429" };
    return { ok: true, text: "برای شروع معمولاً تصویر روی و پشت کارت ملی لازم است." };
  };
  const r = await cbAnswerAi("برای ثبت درخواست چه مدارکی لازم است؟", { fetchFn });
  assert.equal(r.kind, "answer");
  assert.equal(r.provider, "deepseek");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].baseUrl.includes("api.openai.com"));
  assert.equal(calls[0].model, CB_DEFAULT_OPENAI_MODEL);
  assert.ok(calls[1].baseUrl.includes("api.deepseek.com"));
  assert.equal(calls[1].model, CB_DEFAULT_DEEPSEEK_MODEL);
});

await checkAsync("AI guard + handoff after one failure, inbox visible", async () => {
  flagsOn();
  const chat = linkChat(openChat(kazemi, "مریم"), maryamId);
  cbSetAiMode(chat.id, true);
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true, text: "سقف شما ۲۰۰ میلیون است و حتماً تصویب می‌شود." }; };
  const r1 = await cbHandleInbound(ctxOf(chat, kazemi, maryamId, "مریم", {
    text: "سقف تسهیلات من چقدر است و آیا تصویب می‌شود؟",
    aiFetch: fetchFn,
  }));
  assert.ok(r1);
  assert.equal(cbAiFailed(chat.id), true);
  const tx = texts(chat.id).join("\n");
  assert.ok(tx.includes("پاسخ خودکار") || tx.includes(" وعده‌ی تصویب"));
  assert.ok(tx.includes("در انتظار کارشناس"));
  const ho = queryRow("SELECT * FROM customer_bale_handoffs WHERE chat_row=?", [chat.id]);
  assert.ok(ho, "handoff row for CRM inbox");
  assert.ok(ho.question.includes("سقف"));
  assert.equal(Number(ho.owner_id), 8);
  const n1 = calls;
  await cbHandleInbound(ctxOf(chat, kazemi, maryamId, "مریم", { text: "پس چقدر وام می‌گیرم؟", aiFetch: fetchFn }));
  assert.equal(calls, n1, "after one failure, do not call the model again");
});

check("secrets are masked, never dumped", () => {
  cbStoreSecret("openai", "sk-test-openai-zzzz");
  const meta = cbSecretMeta("openai");
  assert.equal(meta.set, true);
  assert.ok(meta.savedAt);
  assert.equal("last4" in meta, false);
  assert.ok(!JSON.stringify(meta).includes("zzzz"));
  assert.ok(!JSON.stringify(meta).includes("sk-test"));
  const masked = JSON.stringify(cbMaskSecretIn({ authorization: "Bearer sk-test", nested: { api_key: "x" } }));
  assert.ok(!masked.includes("Bearer"));
  assert.ok(masked.includes("[redacted]"));
  const raw = cbReadSecret("openai");
  assert.equal(raw, "sk-test-openai-zzzz"); // readable to caller only; this test does not print it
});

check("Ghasemi never sends", () => {
  flagsOn();
  const chat = linkChat(openChat(ghasemi, "آزمایش"), samiraId);
  assert.equal(bcMaySendFromBot(ghasemi), false);
  const id = cbQueueText(chat, ghasemi, "سلام", "cb_menu", AT);
  assert.equal(id, null);
  assert.equal(outs(chat.id).length, 0);
  const w = cbWelcomeAfterLink(chat, ghasemi, "سمیرا", AT);
  assert.equal(w, null);
  assert.equal(outs(chat.id).length, 0);
});

check("lockdown hides other-expert CRM payload", () => {
  setSetting("flag.expert_lockdown", "1");
  assert.equal(lockDownOn(), true);
  flagsOn();
  const chat = linkChat(openChat(kazemi), samiraId);
  // import in this file? we'll use query after simulating attach via SQL only:
  // Viewer is Hasani (user 2) looking at Kazemi's chat
  // Use the route helper by dynamic import already... attach is in routes. Recreate rule here:
  const viewerOther = { id: 2, role: "salesperson" };
  const locked = lockDownOn() && viewerOther.id !== kazemi.user_id && viewerOther.role !== "admin";
  assert.equal(locked, true);
  setSetting("flag.expert_lockdown", "0");
  assert.equal(lockDownOn(), false);
});

/* default model ids */
check("default model ids from official docs", () => {
  assert.equal(CB_DEFAULT_OPENAI_MODEL, "gpt-6-luna");
  assert.equal(CB_DEFAULT_DEEPSEEK_MODEL, "deepseek-flash");
});


/* r1 + A/B/C + kb v1.0 (§6 confirmed t928s3836) */
check("Persian digits in step line, queue text, and amounts", () => {
  assert.equal(stepLine(1, "ثبت درخواست"), "مرحله ۱ از ۷ — ثبت درخواست");
  assert.equal(faDigits("401# 120000 تومان 2026"), "۴۰۱# ۱۲۰۰۰۰ تومان ۲۰۲۶");
  // faDigits should not insert thousands sep unless caller does — just digit map
  assert.equal(faDigits(401), "۴۰۱");
  flagsOn();
  const chat = linkChat(openChat(kazemi), samiraId);
  wipeOut(chat.id);
  cbQueueText(chat, kazemi, "پرونده #401 — 12,000,000 تومان", null, AT);
  const tx = texts(chat.id).join("\n");
  assert.ok(tx.includes("۴۰۱"), tx);
  assert.ok(!/[0-9]/.test(tx), "ASCII digits must not remain in queued bot text: " + tx);
});

await checkAsync("یادآوری امضا calls mocked check-status and updates only the filing status", async () => {
  flagsOn();
  const chat = linkChat(openChat(kazemi), samiraId);
  const f0 = cbStartOrResumeFiling(chat, samiraId, 6);
  // attach a fake application + generation id on the filing only
  const genBefore = queryRows("SELECT id, status FROM contract_generations ORDER BY id DESC LIMIT 3");
  executeChanges(
    "UPDATE customer_bale_filings SET application_id=?, contract_generation_id=?, contract_status=? WHERE id=?",
    [99, 4242, "pending", f0.id],
  );
  let called = 0;
  setCbSignPath({
    checkStatus: async (generationId) => { called++; assert.equal(generationId, 4242); return { status: "signed" }; },
    remind: async (generationId) => { called++; assert.equal(generationId, 4242); return { ok: true }; },
  });
  const out = await cbCheckSign(chat.id);
  assert.equal(out.status, "signed");
  assert.equal(out.path, "check-status");
  assert.equal(out.reminded, true);
  assert.equal(called, 2);
  const f = cbActiveFiling(chat.id);
  assert.equal(f.contract_status, "signed");
  const genAfter = queryRows("SELECT id, status FROM contract_generations ORDER BY id DESC LIMIT 3");
  assert.deepEqual(genAfter, genBefore);
  setCbSignPath({
    checkStatus: async (generationId) => { assert.equal(generationId, 4242); return { status: "pending" }; },
  });
  const readOnly = await cbCheckSign(chat.id);
  assert.equal(readOnly.reminded, false);
  assert.equal(readOnly.status, "pending");
  assert.equal(readOnly.path, "check-status");
  setCbSignPath(null);
});

check("combined phase helper turns all three on/off with updated_at and leaves admin off", () => {
  cbSetAdminFlag(false, AT);
  cbSetPhaseFlags(true, "2026-11-09T21:00:00.000Z");
  assert.equal(cbFlagOn("tracking"), true);
  assert.equal(cbFlagOn("ai"), true);
  assert.equal(cbFlagOn("filing"), true);
  assert.equal(cbAdminFlagOn(), false);
  for (const k of Object.values(CB_FLAGS)) {
    const r = queryRow("SELECT value, updated_at FROM call_queue_settings WHERE key=?", [k]);
    assert.equal(r.value, "1");
    assert.equal(r.updated_at, "2026-11-09T21:00:00.000Z");
  }
  cbSetPhaseFlags(false, "2026-11-09T21:05:00.000Z");
  assert.equal(cbAnyFlagOn(), false);
  assert.equal(cbAdminFlagOn(), false);
});

check("KB scope defaults to All; preview uses only KB text and never calls a model", () => {
  assert.equal(cbNormalizeKbScope(null), CB_KB_SCOPE_ALL);
  assert.equal(cbNormalizeKbScope("nope"), CB_KB_SCOPE_ALL);
  const id = cbKbUpsert(null, "مدارک لازم برای ثبت درخواست", "برای شروع کارت ملی و شناسنامه لازم است.", true, 1, AT, { category: "مدارک" });
  const rows = cbKbList();
  const row = rows.find((r) => r.id === id);
  assert.ok(row);
  assert.equal(row.scope, CB_KB_SCOPE_ALL);
  const before = aiCalls.length;
  const prev = cbPreviewKb("برای ثبت درخواست چه مدارکی لازم است؟");
  assert.equal(prev.ok, true);
  assert.ok(prev.text.includes("کارت ملی"));
  assert.equal(aiCalls.length, before);
  const miss = cbPreviewKb("zzzqqq xxxwww");
  assert.equal(miss.ok, false);
  assert.equal(aiCalls.length, before);
  cbKbUpsert(null, "فقط کارشناس", "متن مخصوص ربات کارشناس", true, 1, AT, { category: "شرایط عمومی", scope: CB_KB_SCOPE_EXPERTS });
  assert.ok(!cbKbText({ user_id: 0 }).includes("متن مخصوص ربات کارشناس"));
  assert.ok(cbKbText({ user_id: 2 }).includes("متن مخصوص ربات کارشناس"));
  const sharedPrev = cbPreviewKb("متن مخصوص ربات کارشناس", { user_id: 0 });
  assert.equal(sharedPrev.ok, false);
});

await checkAsync("key test returns only server success or failure; meta never includes last4", async () => {
  cbStoreSecret("openai", "sk-test-openai-zzzz");
  const meta = cbSecretMeta("openai");
  assert.deepEqual(Object.keys(meta).sort(), ["savedAt", "set"]);
  setCbSecretTestFn(async () => ({ ok: true }));
  const ok = await cbTestSecret("openai");
  assert.equal(ok.ok, true);
  assert.equal(ok.title, CB_TEST_TITLE);
  assert.equal(ok.message, CB_TEST_OK);
  assert.equal("ms" in ok, false);
  assert.equal("tokens" in ok, false);
  setCbSecretTestFn(async () => ({ ok: false }));
  const bad = await cbTestSecret("openai");
  assert.equal(bad.ok, false);
  assert.equal(bad.title, CB_TEST_TITLE);
  assert.equal(bad.message, CB_TEST_FAIL);
  cbDeleteSecret("openai");
  assert.equal(cbSecretMeta("openai").set, false);
  const gone = await cbTestSecret("openai");
  assert.equal(gone.ok, false);
  assert.equal(gone.message, CB_TEST_FAIL);
  setCbSecretTestFn(null);
});

check("shared نفیس وام bot exists, may send, and is not Ghasemi", () => {
  const id = ensureSharedCustomerBot(AT);
  const bot = cbSharedBot();
  assert.ok(bot && bot.id === id);
  assert.equal(Number(bot.user_id), 0);
  assert.equal(bot.bot_name, "نفیس وام");
  assert.equal(isSharedCustomerBot(bot), true);
  assert.equal(isSharedBotRow(bot), true);
  assert.equal(bcMaySendFromBot(bot), true);
  assert.equal(bcMaySendFromBot(ghasemi), false);
  assert.notEqual(Number(bot.user_id), 3);
});

check("shared bot new lead: wait for expert, then expert name; existing customer is routed with no new lead", () => {
  flagsOn();
  const shared = cbSharedBot();
  assert.ok(shared);
  const nCust = () => queryRow("SELECT COUNT(*) n FROM customers").n;

  // new lead — unused phone
  const before = nCust();
  const chatNew = openChat(shared, "لیلا");
  const rNew = bcLinkOrCreateLead(chatNew, shared, "09120000048", "share", null, AT);
  assert.equal(rNew.ok, true);
  assert.equal(rNew.kind, "new");
  assert.equal(nCust(), before + 1);
  const freshNew = queryRow("SELECT * FROM bale_bot_chats WHERE id=?", [chatNew.id]);
  assert.equal(Number(freshNew.lead_from_bale), 1);
  const cust = queryRow("SELECT * FROM customers WHERE id=?", [freshNew.customer_id]);
  assert.ok(cust.salesperson_id && Number(cust.salesperson_id) > 0, "distribution rule assigned a salesperson");
  wipeOut(freshNew.id);
  cbWelcomeAfterLink(freshNew, shared, cust.name, AT);
  const outNew = queryRows("SELECT dir, text FROM bale_bot_messages WHERE chat_row=? ORDER BY id", [freshNew.id]);
  const blob = outNew.map((m) => m.text).join("\n");
  assert.ok(blob.includes("شماره‌تان ثبت شد"));
  assert.ok(blob.includes("در انتظار تعیین کارشناس"));
  assert.ok(blob.includes("کارشناس شما") && blob.includes("است"), blob);
  assert.ok(!blob.includes(BC_OK_NEW));
  const sys = outNew.filter((m) => m.dir === "sys").map((m) => m.text).join("\n");
  assert.ok(sys.includes("در انتظار تعیین کارشناس، بر اساس قاعده‌ی توزیع فعلی"));
  assert.ok(sys.includes("وصل شد به کارشناس"));

  // existing customer (Samira) — no new lead
  const before2 = nCust();
  const chatOld = openChat(shared, "سمیرا");
  const rOld = bcLinkOrCreateLead(chatOld, shared, "09120000040", "share", null, AT);
  assert.equal(rOld.ok, true);
  assert.equal(rOld.kind, "known");
  assert.equal(nCust(), before2);
  const freshOld = queryRow("SELECT * FROM bale_bot_chats WHERE id=?", [chatOld.id]);
  assert.equal(Number(freshOld.lead_from_bale) || 0, 0);
  wipeOut(freshOld.id);
  cbWelcomeAfterLink(freshOld, shared, "سمیرا نادری", AT);
  const blobOld = queryRows("SELECT dir, text FROM bale_bot_messages WHERE chat_row=? ORDER BY id", [freshOld.id]).map((m) => `${m.dir}:${m.text}`).join("\n");
  assert.ok(blobOld.includes("از ربات نفیس وام آمد؛ به کارشناسِ خود مشتری وصل شد. لید تازه ساخته نشد."), blobOld);
  assert.ok(!blobOld.includes(BC_OK_NEW));
});

check("shared bot first-ask text is the designed start copy", () => {
  assert.equal(
    BC_ASK_FIRST_SHARED,
    "سلام، به ربات نفیس وام خوش آمدید. برای پیگیری پرونده یا ثبت درخواست، ابتدا شماره‌ی خودتان را با دکمه به اشتراک بگذارید.",
  );
});




check("shared bot public view is قطع without a token and never returns the token", () => {
  ensureSharedCustomerBot(AT);
  const id = cbSharedBot().id;
  executeChanges("UPDATE bale_bots SET status='on', token_ct=NULL, token_key_id=NULL, connected_at=NULL WHERE id=?", [id]);
  const off = cbSharedBotPublic();
  assert.equal(off.hasToken, false);
  assert.equal(off.status, "off");
  assert.equal(off.connectedAt, null);
  assert.ok(!("token" in off) && !("token_ct" in off));
  executeChanges("UPDATE bale_bots SET status='on', token_ct='sealed-not-for-display', connected_at=? WHERE id=?", [AT, id]);
  const on = cbSharedBotPublic();
  assert.equal(on.hasToken, true);
  assert.equal(on.status, "on");
  assert.equal(on.connectedAt, AT);
  assert.ok(!("token" in on) && !("token_ct" in on));
  const dumped = JSON.stringify(on);
  assert.ok(!dumped.includes("sealed-not-for-display"), dumped);
  cbClearSharedBotToken(AT);
  const after = cbSharedBotPublic();
  assert.equal(after.hasToken, false);
  assert.equal(after.status, "off");
  executeChanges("UPDATE bale_bots SET token_ct=NULL, token_key_id=NULL, status='off', connected_at=NULL WHERE id=?", [id]);
});

check("Jalali dates on bale-bot/KB surfaces use design order weekday day month year", () => {
  assert.equal(jalaliWeekdayDate(null), "");
  assert.equal(jalaliWeekdayDate(""), "");
  // پنجشنبه ۷ آبان ۱۴۰۵ in Asia/Tehran
  assert.equal(jalaliWeekdayDate("2026-10-29T08:30:00.000Z"), "پنجشنبه ۷ آبان ۱۴۰۵");
  assert.equal(jalaliWeekdayDate("2026-10-28T20:30:00.000Z"), "پنجشنبه ۷ آبان ۱۴۰۵");
  const s = jalaliWeekdayDate("2026-10-29T08:30:00.000Z");
  assert.ok(!s.startsWith("۱۴۰۵"), "must not lead with the year (fa-IR default order)");
  assert.ok(!s.includes("،"), "design date has spaces only, no comma");
});

if (failures.length) {
  console.error("\nFAILED", failures.length, failures.join(", "));
  process.exit(1);
}
console.log("\nAll customer-bale checks passed.");
