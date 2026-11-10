// bale-sign-reminder v1.0 fixture: scratch copy of a masked DB. No real Bale or SMS.
import assert from "node:assert/strict";
import { queryRow, queryRows, execute, executeChanges } from "../src/lib/crm-db.ts";
import { ensureBaleBotSchema, _resetSchemaFlagForTests, setBaleBotFetch } from "../src/lib/bale-bot.ts";
import { ensureBaleContactSchema, _resetBcSchemaFlagForTests, BC_GHASEMI_USER_ID } from "../src/lib/bale-contact.ts";
import {
  SR_FLAG, SR_HISTORY_ACTION, SR_TEXTS, SR_DEFAULT_LOCK_HOURS, SR_DEFAULT_SIGN_URL,
  _resetSrForTests, ensureSignReminderSchema, srFlagOn, srSetFlag, srSetLockHours,
  srFormatFa, srChatView, srPreview, srSend, srCustomerStartedBot, srConfigNotes,
  setSrStatusFn, setSrLinkFn, setSrDeliverFn, srLastSuccessful, srLockHours, srStoredSignStatus,
} from "../src/lib/bale-sign-reminder.ts";
import { planLabelForCustomer } from "../src/lib/customer-bale.ts";
import { historyActionLabel } from "../../crm-dashboard/src/lib/loan-history-fa.mjs";

if (!process.env.CRM_DATABASE_PATH) throw new Error("CRM_DATABASE_PATH required (scratch copy only)");
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

const AT = "2026-10-29T11:22:00.000Z"; // پنجشنبه ۷ آبان ۱۴۰۵، ساعت ۱۴:۵۲ Asia/Tehran
const NOW = new Date(AT);

const baleCalls = [];
const smsCalls = [];
const sendContractCalls = [];
setBaleBotFetch(async (url) => {
  const u = String(url);
  if (/sms|kavenegar|melipayamak|ghasedak|payam/i.test(u)) { smsCalls.push(u); throw new Error("sms must not be called"); }
  if (!u.includes("tapi.bale.ai")) throw new Error("unexpected network " + u);
  baleCalls.push(u.replace(/bot[^/]+/, "bot<redacted>"));
  return new Response(JSON.stringify({ ok: true, result: { message_id: 8000 + baleCalls.length } }), { headers: { "content-type": "application/json" } });
});
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/sms|kavenegar|melipayamak|ghasedak|payam/i.test(u)) { smsCalls.push(u); throw new Error("sms must not be called: " + u); }
  if (/sendContract/i.test(u)) { sendContractCalls.push(u.replace(/bot[^/]+/, "bot<redacted>")); throw new Error("sendContract must not be called"); }
  if (u.includes("tapi.bale.ai") || u.includes("core.emzame") || u.includes("emzame.com") || /emzame/i.test(u)) {
    throw new Error("unmocked provider/Bale HTTP: " + u.replace(/bot[^/]+/, "bot<redacted>"));
  }
  throw new Error("unexpected network " + u);
};
void realFetch;

_resetSchemaFlagForTests();
_resetBcSchemaFlagForTests();
_resetSrForTests();
ensureBaleBotSchema();
ensureBaleContactSchema();
ensureSignReminderSchema();

const setSetting = (key, value) => {
  if (value == null) executeChanges("DELETE FROM call_queue_settings WHERE key=?", [key]);
  else execute("INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [key, value, AT]);
};

const kazemiUser = queryRow("SELECT * FROM users WHERE id=8");
assert.ok(kazemiUser, "Kazemi user 8");
const hasaniUser = queryRow("SELECT * FROM users WHERE id=2");
assert.ok(hasaniUser, "Hasani user 2");
const ghasemiUser = queryRow("SELECT * FROM users WHERE id=?", [BC_GHASEMI_USER_ID]);
assert.ok(ghasemiUser, "Ghasemi user");
const adminUser = queryRow("SELECT * FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1");
assert.ok(adminUser, "admin user");
const kazemiBot = queryRow("SELECT * FROM bale_bots WHERE user_id=8");
const hasaniBot = queryRow("SELECT * FROM bale_bots WHERE user_id=2");
const ghasemiBot = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [BC_GHASEMI_USER_ID]);
assert.ok(kazemiBot && hasaniBot && ghasemiBot, "expert bots exist");

const plan = queryRow("SELECT id, bank_name FROM loan_plans WHERE bank_name LIKE '%اقتصاد نوین%' AND (active=1 OR active IS NULL) ORDER BY id LIMIT 1")
  || queryRow("SELECT id, bank_name FROM loan_plans ORDER BY id LIMIT 1");
assert.ok(plan, "a loan plan");
const tmpl = queryRow("SELECT id FROM contract_templates ORDER BY id LIMIT 1");
assert.ok(tmpl, "a contract template");

let uid = 920000;
const nextId = () => ++uid;
const insCust = (name, phone, sp) => execute(
  `INSERT INTO customers(name,first_name,phone,description,created_at,salesperson_id,status,verification_status,credit_rank)
   VALUES(?,?,?,NULL,?,?,'in_progress','verified','A1')`,
  [name, name.split(" ")[0], phone, AT, sp],
);
const kazemiSp = kazemiUser.salesperson_id;
const hasaniSp = hasaniUser.salesperson_id;

const samiraId = insCust("سمیرا نادری", "09120000021", kazemiSp);
const nimaId = insCust("نیما اکبری", "09120000035", kazemiSp);
const signedCust = insCust("مریم حسینی", "09120000018", kazemiSp);
const expiredCust = insCust("رضا محمدی", "09120000022", kazemiSp);
const notStartedCust = insCust("آوا کریمی", "09120000023", kazemiSp);
const ghasemiCust = insCust("حامد قاسمی‌تست", "09120000024", ghasemiUser.salesperson_id);

function openChat(bot, first, last, customerId, withInbound = true) {
  const chatId = String(nextId());
  execute(
    `INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,last_name,username,customer_id,link_method,created_at,last_at)
     VALUES(?,?,?,?,?,?, 'contact', ?, ?)`,
    [bot.id, chatId, first, last, "sample_u", customerId, AT, AT],
  );
  const row = queryRow("SELECT * FROM bale_bot_chats WHERE bot_id=? AND chat_id=?", [bot.id, chatId]);
  if (withInbound) {
    execute(`INSERT INTO bale_bot_messages(chat_row,dir,kind,text,status,created_at) VALUES(?,'in','text','/start','sent',?)`, [row.id, AT]);
  }
  return row;
}

function makeApp(customerId, stage = "primary_contract_pending_signature") {
  const cid = execute("INSERT INTO consultation_forms(customer_id,requested_amount,updated_at) VALUES(?,?,?)", [customerId, 0, AT]);
  return execute(
    `INSERT INTO loan_applications(consultation_id,customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,stage,status,created_at,updated_at,salesperson_id_snapshot)
     VALUES(?,?,?,?,?,?,?, 'requested',?,?,?)`,
    [cid, customerId, kazemiUser.id, JSON.stringify([plan.id]), plan.id, "100000000", stage, AT, AT, kazemiSp],
  );
}
function makeGen(appId, customerId, status = "sent", providerStatus = "readyForSign") {
  const id = execute(
    `INSERT INTO contract_generations(template_id,customer_id,loan_application_id,docx_path,docx_sha256,manual_values_json,status,provider_contract_id,provider_status,created_by,created_at,updated_at,sent_at)
     VALUES(?,?,?,'/tmp/sr-fixture.docx','abc','{}',?,?,?,?,?,?,?)`,
    [tmpl.id, customerId, appId, status, "prov-" + nextId(), providerStatus, kazemiUser.id, AT, AT, AT],
  );
  try { executeChanges("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?", [id, appId]); } catch { /* column may be missing on older copies */ }
  return id;
}

const samiraChat = openChat(kazemiBot, "سمیرا", "نادری", samiraId, true);
const samiraApp = makeApp(samiraId);
const samiraGen = makeGen(samiraApp, samiraId);

const nimaChat = openChat(kazemiBot, "نیما", "اکبری", nimaId, true);
const nimaApp = makeApp(nimaId);
makeGen(nimaApp, nimaId);

const signedChat = openChat(kazemiBot, "مریم", "حسینی", signedCust, true);
const signedApp = makeApp(signedCust, "customer_documents_review");
makeGen(signedApp, signedCust, "signed", "signed");

const expiredChat = openChat(kazemiBot, "رضا", "محمدی", expiredCust, true);
const expiredApp = makeApp(expiredCust);
makeGen(expiredApp, expiredCust, "sent", "expired");

const notStartedChat = openChat(kazemiBot, "آوا", "کریمی", notStartedCust, false);
const notStartedApp = makeApp(notStartedCust);
makeGen(notStartedApp, notStartedCust);

const ghasemiChat = openChat(ghasemiBot, "حامد", "تست", ghasemiCust, true);
const ghasemiApp = makeApp(ghasemiCust);
makeGen(ghasemiApp, ghasemiCust);

const kazemi = { id: kazemiUser.id, role: kazemiUser.role, salesperson_id: kazemiUser.salesperson_id };
const hasani = { id: hasaniUser.id, role: hasaniUser.role, salesperson_id: hasaniUser.salesperson_id };
const admin = { id: adminUser.id, role: "admin", salesperson_id: adminUser.salesperson_id };

const deliveries = [];
setSrDeliverFn(async ({ chatRow, botId, text, keyboard, authorUserId, at }) => {
  deliveries.push({ chatRow, botId, text, keyboard, authorUserId, at });
  if (/sms/i.test(text)) throw new Error("SMS text leaked into Bale deliver");
  const id = execute(
    `INSERT INTO bale_bot_messages(chat_row,dir,kind,text,keyboard,status,author_user_id,created_at,sent_at)
     VALUES(?,'out','text',?,?, 'sent', ?, ?, ?)`,
    [chatRow, text, keyboard, authorUserId, at, at],
  );
  return { ok: true, messageId: Number(id) };
});
setSrLinkFn(() => "https://web.emzame.ir/");
setSrStatusFn(async (generationId) => {
  const g = queryRow("SELECT status, provider_status FROM contract_generations WHERE id=?", [generationId]);
  if (g?.status === "signed" || /^(signed|accept|accepted)$/i.test(String(g?.provider_status ?? "")) || /امضا شد/.test(String(g?.provider_status ?? ""))) return "signed";
  if (/expir|منقضی/i.test(String(g?.provider_status ?? ""))) return "expired";
  return "pending";
});

check("flag defaults OFF when the key is absent", () => {
  setSetting(SR_FLAG, null);
  assert.equal(srFlagOn(), false);
});

await checkAsync("flag OFF hides the view and rejects send", async () => {
  srSetFlag(false, AT);
  assert.equal(srFlagOn(), false);
  assert.equal(await srChatView(samiraChat.id, kazemi, NOW), null);
  const send = await srSend(samiraChat.id, kazemi, NOW);
  assert.equal(send.ok, false);
  assert.equal(send.status, 404);
  assert.equal(send.error, "flag_off");
  assert.equal(deliveries.length, 0);
});

srSetFlag(true, AT);
srSetLockHours(SR_DEFAULT_LOCK_HOURS, AT);
assert.equal(srFlagOn(), true);
assert.equal(srLockHours(), 24);

check("Jalali formatToParts matches the design order and clock", () => {
  const s = srFormatFa(AT);
  assert.equal(s, "پنجشنبه ۷ آبان ۱۴۰۵، ساعت ۱۴:۵۲");
  assert.ok(!s.startsWith("۱۴۰۵"));
  const until = srFormatFa(new Date(NOW.getTime() + 24 * 3600_000).toISOString());
  assert.equal(until, "جمعه ۸ آبان ۱۴۰۵، ساعت ۱۴:۵۲");
});

check("history label is the exact design sentence", () => {
  assert.equal(historyActionLabel(SR_HISTORY_ACTION), "یادآوری امضا در بله فرستاده شد");
});

check("message text uses لندتک / bank and the first name", () => {
  const label = planLabelForCustomer(plan.bank_name);
  assert.match(label, /^لندتک \//);
  const body = SR_TEXTS.body("سمیرا", label.includes("اقتصاد نوین") ? "لندتک / اقتصاد نوین" : label);
  assert.match(body, /^سلام سمیرا، قرارداد «لندتک \//);
  assert.ok(!/پیامک/.test(body));
});

await checkAsync("ready state for the owner, with preview text from the server", async () => {
  const view = await srChatView(samiraChat.id, kazemi, NOW);
  assert.ok(view);
  assert.equal(view.enabled, true);
  assert.equal(view.state, "ready");
  assert.equal(view.canSend, true);
  assert.equal(view.otherExpert, false);
  const prev = await srPreview(samiraChat.id, kazemi);
  assert.equal(prev.ok, true);
  assert.equal(prev.messageText, view.messageText);
  assert.equal(prev.buttonLabel, "امضای قرارداد");
  assert.ok(prev.notes.some((n) => n.includes("پیامک فرستاده نمی‌شود")));
});

await checkAsync("successful send records history, lock, and exactly one Bale deliver", async () => {
  deliveries.length = 0;
  const before = deliveries.length;
  const r = await srSend(samiraChat.id, kazemi, NOW);
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  assert.equal(r.state, "cooldown");
  assert.equal(r.lastSentFa, "پنجشنبه ۷ آبان ۱۴۰۵، ساعت ۱۴:۵۲");
  assert.equal(r.lockUntilFa, "جمعه ۸ آبان ۱۴۰۵، ساعت ۱۴:۵۲");
  assert.equal(r.idempotent, false);
  assert.equal(deliveries.length, before + 1);
  assert.ok(deliveries[0].keyboard.startsWith("sr_sign:"));
  assert.equal(deliveries[0].keyboard.slice("sr_sign:".length), "https://web.emzame.ir/");
  const hist = queryRow("SELECT * FROM loan_application_stage_history WHERE application_id=? AND action=? ORDER BY id DESC LIMIT 1", [samiraApp, SR_HISTORY_ACTION]);
  assert.ok(hist, "history row");
  assert.equal(Number(hist.actor_id), kazemi.id);
  assert.equal(hist.reason, "کارشناس فروش");
  const view = await srChatView(samiraChat.id, kazemi, NOW);
  assert.equal(view.state, "cooldown");
  assert.equal(view.canSend, false);
  assert.equal(view.lastSentFa, r.lastSentFa);
});

await checkAsync("double-click is idempotent and does not deliver twice", async () => {
  const start = deliveries.length;
  const again = await srSend(samiraChat.id, kazemi, NOW);
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(deliveries.length, start);
  const a = srSend(nimaChat.id, kazemi, NOW);
  const b = srSend(nimaChat.id, kazemi, NOW);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  const sent = [ra, rb];
  assert.ok(sent.filter((x) => !x.idempotent).length === 1);
  assert.ok(sent.filter((x) => x.idempotent).length === 1);
});

await checkAsync("other expert is read-only and cannot send", async () => {
  const view = await srChatView(samiraChat.id, hasani, NOW);
  assert.ok(view);
  assert.equal(view.canSend, false);
  assert.equal(view.otherExpert, true);
  assert.equal(view.canRefresh, true);
  assert.equal(view.state, "cooldown");
  assert.match(view.reason, /ارسال دوباره از/);
  const start = deliveries.length;
  const send = await srSend(samiraChat.id, hasani, NOW);
  assert.equal(send.ok, false);
  assert.equal(send.status, 403);
  assert.equal(send.error, "forbidden");
  assert.equal(deliveries.length, start);
});

await checkAsync("admin may send for another expert's customer once the lock lapses", async () => {
  // nima already sent above; wait until after lock
  const later = new Date(NOW.getTime() + 25 * 3600_000);
  const view = await srChatView(nimaChat.id, admin, later);
  assert.equal(view.canSend, true);
});

await checkAsync("not-started disables send and returns the design reason", async () => {
  assert.equal(srCustomerStartedBot(notStartedCust), false);
  const view = await srChatView(notStartedChat.id, kazemi, NOW);
  assert.equal(view.state, "bot_not_started");
  assert.equal(view.canSend, false);
  assert.equal(view.reason, SR_TEXTS.botNotStarted);
  const start = deliveries.length;
  const send = await srSend(notStartedChat.id, kazemi, NOW);
  assert.equal(send.ok, false);
  assert.equal(send.error, "bot_not_started");
  assert.equal(deliveries.length, start);
});

check("unsigned is not treated as signed", () => {
  const base = { applicationId: 1, generationId: 1, customerId: 1, stage: "primary_contract_pending_signature", planLabel: "لندتک / اقتصاد نوین", firstName: "سمیرا", customerName: "سمیرا نادری" };
  assert.equal(srStoredSignStatus({ ...base, generationStatus: "sent", providerStatus: "unsigned" }), "pending");
  assert.equal(srStoredSignStatus({ ...base, generationStatus: "sent", providerStatus: "readyForSign" }), "pending");
  assert.equal(srStoredSignStatus({ ...base, generationStatus: "signed", providerStatus: "accept" }), "signed");
  assert.equal(srStoredSignStatus({ ...base, generationStatus: "sent", providerStatus: "signed" }), "signed");
  assert.equal(srStoredSignStatus({ ...base, generationStatus: "sent", providerStatus: "expired" }), "expired");
});

await checkAsync("signed contract hides the reminder button", async () => {
  const view = await srChatView(signedChat.id, kazemi, NOW);
  assert.equal(view.state, "already_signed");
  assert.equal(view.canSend, false);
  assert.equal(view.reason, SR_TEXTS.signed);
  const send = await srSend(signedChat.id, kazemi, NOW);
  assert.equal(send.ok, false);
  assert.equal(send.error, "already_signed");
});

await checkAsync("expired link is refused and does not send", async () => {
  const view = await srChatView(expiredChat.id, kazemi, NOW);
  assert.equal(view.state, "link_expired");
  assert.equal(view.canSend, false);
  assert.equal(view.reason, SR_TEXTS.expired);
  const start = deliveries.length;
  const send = await srSend(expiredChat.id, kazemi, NOW);
  assert.equal(send.ok, false);
  assert.equal(send.error, "link_expired");
  assert.equal(deliveries.length, start);
});

await checkAsync("Ghasemi's bot never receives a reminder send", async () => {
  const start = deliveries.length;
  const view = await srChatView(ghasemiChat.id, admin, NOW);
  // started, but only on Ghasemi's unsending bot → treat as not started
  assert.equal(view.state, "bot_not_started");
  const send = await srSend(ghasemiChat.id, admin, NOW);
  assert.equal(send.ok, false);
  assert.equal(deliveries.length, start);
  assert.ok(deliveries.every((d) => d.botId !== ghasemiBot.id));
});


await checkAsync("default: send only in a chat the customer started, not the unstarted viewing chat", async () => {
  const startedOnly = insCust("کیان رضایی", "09120000025", kazemiSp);
  const started = openChat(kazemiBot, "کیان", "رضایی", startedOnly, true);
  const viewing = openChat(kazemiBot, "کیان", "رضایی", startedOnly, false);
  const appId = makeApp(startedOnly);
  const genId = makeGen(appId, startedOnly);
  const gensBefore = queryRows("SELECT id, status, provider_status, provider_contract_id, updated_at, superseded_at FROM contract_generations WHERE id=?", [genId]);
  const genCountBefore = queryRow("SELECT COUNT(*) n FROM contract_generations WHERE customer_id=?", [startedOnly]).n;
  const start = deliveries.length;
  const view = await srChatView(viewing.id, kazemi, NOW);
  assert.equal(view.state, "ready");
  assert.equal(view.canSend, true);
  const r = await srSend(viewing.id, kazemi, NOW);
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  assert.equal(deliveries.length, start + 1);
  assert.equal(deliveries.at(-1).chatRow, started.id);
  assert.notEqual(deliveries.at(-1).chatRow, viewing.id);
  const gensAfter = queryRows("SELECT id, status, provider_status, provider_contract_id, updated_at, superseded_at FROM contract_generations WHERE id=?", [genId]);
  assert.deepEqual(gensAfter, gensBefore);
  assert.equal(queryRow("SELECT COUNT(*) n FROM contract_generations WHERE customer_id=?", [startedOnly]).n, genCountBefore);
  assert.equal(sendContractCalls.length, 0);
});

await checkAsync("no-token is inert: no send, no deliver, no sendContract, no SMS", async () => {
  const tokenCust = insCust("نادر توکلی", "09120000026", kazemiSp);
  const tokenChat = openChat(kazemiBot, "نادر", "توکلی", tokenCust, true);
  makeApp(tokenCust);
  makeGen(queryRow("SELECT id FROM loan_applications WHERE customer_id=? ORDER BY id DESC LIMIT 1", [tokenCust]).id, tokenCust);
  const botId = kazemiBot.id;
  const prev = queryRow("SELECT token_ct, token_key_id FROM bale_bots WHERE id=?", [botId]);
  assert.ok(prev, "bot row");
  const start = deliveries.length;
  try {
    executeChanges("UPDATE bale_bots SET token_ct=NULL, token_key_id=NULL WHERE id=?", [botId]);
    const view = await srChatView(tokenChat.id, kazemi, NOW);
    assert.equal(view.state, "no_token");
    assert.equal(view.canSend, false);
    assert.equal(view.reason, SR_TEXTS.noToken);
    const send = await srSend(tokenChat.id, kazemi, NOW);
    assert.equal(send.ok, false);
    assert.equal(send.status, 409);
    assert.equal(send.error, "no_token");
    assert.equal(deliveries.length, start);
    assert.equal(sendContractCalls.length, 0);
    assert.equal(smsCalls.length, 0);
  } finally {
    executeChanges("UPDATE bale_bots SET token_ct=?, token_key_id=? WHERE id=?", [prev.token_ct, prev.token_key_id, botId]);
  }
});

check("no sendContract and no SMS after all cases", () => {
  assert.equal(sendContractCalls.length, 0);
  assert.equal(smsCalls.length, 0);
  assert.equal(baleCalls.length, 0, "deliver stub must prevent live Bale HTTP");
});

check("no SMS HTTP was ever attempted", () => {
  assert.equal(smsCalls.length, 0);
  assert.equal(baleCalls.length, 0, "deliver stub must prevent live Bale HTTP");
});

check("§6 defaults are documented and lock hours are a server setting", () => {
  const notes = srConfigNotes();
  assert.ok(notes.some((n) => n.key === SR_FLAG && /OFF/.test(n.defaultValue)));
  const lock = notes.find((n) => n.key === "bale_sign_reminder.lock_hours");
  assert.equal(lock.defaultValue, "24");
  assert.equal(SR_DEFAULT_SIGN_URL, "https://web.emzame.ir/");
  srSetLockHours(12, AT);
  assert.equal(srLockHours(), 12);
  srSetLockHours(24, AT);
});

if (failures.length) {
  console.error("\nFAILED", failures.length, failures.join(", "));
  process.exit(1);
}
console.log("\nAll bale-sign-reminder checks passed.");
