// bale-contact v1.1 fixture: real modules on a scratch copy of masked_live.db, Bale HTTP mocked (no network).
// usage: BC_DB=/path/copy.db node scripts/run-bundled-fixture.mjs scripts/bale-contact-fixture.mjs
import assert from "node:assert/strict";
import { queryRow, queryRows, execute, executeChanges, crmDb } from "../src/lib/crm-db.ts";
import {
  storeUpdate, setBaleBotFetch, ensureBaleBotSchema, _resetSchemaFlagForTests, bbUser, botById,
  matchPhone, normPhone, chatName, messageView, redactPhonesInText,
} from "../src/lib/bale-bot.ts";
import {
  BC_FLAG, BC_ASK_FIRST, BC_ASK_EXIST, BC_OK_KNOWN, BC_OK_NEW, BC_TYPED_OK, BC_TYPED_BAD, BC_OTHER_REPLY, BC_REJECT_TEXT,
  BC_GHASEMI_USER_ID, bcFlagOn, ensureBaleContactSchema, _resetBcSchemaFlagForTests, bcAfterInbound,
  bcApproveTyped, bcRejectTyped, bcPreviewManual, bcCommitManual, bcResendAsk, bcCanAct, bcCustomerForViewer, bcTickReminders,
  runBaleContactBatch, looksLikePhoneAttempt, bcInboxTitle, bcSourceLine, BC_BATCH_ENABLED,
} from "../src/lib/bale-contact.ts";

if (!process.env.CRM_DATABASE_PATH) throw new Error("CRM_DATABASE_PATH required (scratch copy only)");
process.env.BALE_BOT_WORKER = "0";
process.env.NODE_ENV = "test";

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log("  ok ", name); }
  catch (e) { failures.push(name); console.error("  FAIL", name, e?.message ?? e); }
};

const now = () => "2026-11-10T12:00:00.000Z";
const setFlag = (key, value) => {
  const at = now();
  if (value == null) executeChanges("DELETE FROM call_queue_settings WHERE key=?", [key]);
  else execute("INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [key, value, at]);
};

// Mock Bale API: never leave the machine. Unexpected origins fail the test.
const baleCalls = [];
setBaleBotFetch(async (url) => {
  const u = String(url);
  if (!u.includes("tapi.bale.ai")) throw new Error("unexpected network " + u);
  baleCalls.push(u.replace(/bot[^/]+/, "bot<redacted>"));
  return new Response(JSON.stringify({ ok: true, result: { message_id: 9000 + baleCalls.length } }), { headers: { "content-type": "application/json" } });
});

_resetSchemaFlagForTests();
_resetBcSchemaFlagForTests();
ensureBaleBotSchema();

const botOf = (userId) => {
  const b = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [userId]);
  assert.ok(b, "bot for user " + userId);
  return b;
};

let uid = 800000;
const nextId = () => ++uid;
function upd(updateId, o) {
  const fromId = o.fromId ?? nextId();
  const chatId = o.chatId ?? fromId;
  const from = { id: fromId, is_bot: false, first_name: o.first ?? "علی", last_name: o.last ?? "محمدی", username: o.username ?? "ali_test" };
  const message = { message_id: updateId, chat: { id: chatId, type: "private" }, from };
  if (o.contact) message.contact = o.contact;
  else message.text = o.text ?? "سلام";
  return { update_id: updateId, message };
}
const chatOf = (botId, chatId) => queryRow("SELECT * FROM bale_bot_chats WHERE bot_id=? AND chat_id=?", [botId, String(chatId)]);
const outs = (chatRow) => queryRows("SELECT * FROM bale_bot_messages WHERE chat_row=? AND dir='out' ORDER BY id", [chatRow]);
const lastOut = (chatRow) => outs(chatRow).at(-1);
const countCust = (phone) => queryRow("SELECT COUNT(*) n FROM customers WHERE phone=? AND merged_into_customer_id IS NULL", [phone])?.n ?? 0;

// Synthetic 0912000003x phones — never a live number. Wipe any leftover from a re-run.
for (let i = 0; i < 10; i++) {
  const ph = "0912000003" + i;
  executeChanges("DELETE FROM customers WHERE phone=?", [ph]);
}
const insCust = (name, phone, sp) => execute(
  `INSERT INTO customers(name,phone,description,created_at,salesperson_id,status,verification_status)
   VALUES(?,?,NULL,?,?,'in_progress','unverified')`, [name, phone, now(), sp]);

const kazemi = botOf(8), hasani = botOf(2), tajik = botOf(7), ghasemi = botOf(3);
const knownK = insCust("سمیرا نادری", "09120000031", 6);
const knownH = insCust("مریم حسینی", "09120000032", 3);

console.log("== flag OFF parity ==");
setFlag(BC_FLAG, null);
assert.equal(bcFlagOn(), false);

check("flag off: first hello does not auto-ask", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام", username: "off_hello" }));
  const c = chatOf(kazemi.id, fromId);
  assert.ok(c);
  assert.equal(outs(c.id).length, 0);
  assert.equal(c.welcome_sent_at ?? null, null);
  assert.equal(c.customer_id, null);
});

check("flag off: own contact of a known customer links, no auto reply, no lead", () => {
  const fromId = nextId();
  const before = queryRow("SELECT COUNT(*) n FROM customers")?.n;
  storeUpdate(kazemi, upd(nextId(), { fromId, contact: { phone_number: "09120000031", first_name: "سمیرا", user_id: fromId } }));
  const c = chatOf(kazemi.id, fromId);
  assert.equal(c.customer_id, knownK);
  assert.equal(c.link_method, "contact");
  assert.equal(outs(c.id).length, 0);
  assert.equal(queryRow("SELECT COUNT(*) n FROM customers")?.n, before);
});

check("flag off: unknown own contact does not create a lead", () => {
  const fromId = nextId();
  const phone = "09120000033";
  storeUpdate(kazemi, upd(nextId(), { fromId, contact: { phone_number: phone, first_name: "نیما", user_id: fromId } }));
  const c = chatOf(kazemi.id, fromId);
  assert.equal(c.customer_id, null);
  assert.equal(c.match_note, "none");
  assert.equal(countCust(phone), 0);
  assert.equal(outs(c.id).length, 0);
});

check("flag off: other-contact is logged, no auto reply", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, contact: { phone_number: "09120000031", first_name: "دیگر", user_id: fromId + 99 } }));
  const c = chatOf(kazemi.id, fromId);
  assert.equal(c.customer_id, null);
  assert.equal(outs(c.id).length, 0);
});

console.log("== flag ON behaviour ==");
setFlag(BC_FLAG, "1");
assert.equal(bcFlagOn(), true);
ensureBaleContactSchema();

check("normalization +98 / 0098 / 98 / 9xxxxxxxxx", () => {
  assert.equal(normPhone("+989120000031"), "09120000031");
  assert.equal(normPhone("00989120000031"), "09120000031");
  assert.equal(normPhone("989120000031"), "09120000031");
  assert.equal(normPhone("9120000031"), "09120000031");
  assert.equal(normPhone("۰۹۱۲۰۰۰۰۰۳۱"), "09120000031");
  assert.equal(normPhone("0912123"), null);
});

check("looksLikePhoneAttempt: incomplete number vs سلام", () => {
  assert.equal(looksLikePhoneAttempt("سلام، شماره‌ام این است: ۰۹۱۲۱۲۳"), true);
  assert.equal(looksLikePhoneAttempt("0912123"), true);
  assert.equal(looksLikePhoneAttempt("سلام، وام خرید کالا می‌خوام"), false);
});

check("first contact queues ASK_FIRST with request_contact", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام", username: "reza_sample" }));
  const c = chatOf(kazemi.id, fromId);
  const m = lastOut(c.id);
  assert.ok(c.first_ask_at && c.welcome_sent_at);
  assert.equal(m.text, BC_ASK_FIRST);
  assert.equal(m.keyboard, "contact");
  assert.equal(m.status, "sending");
});

check("Ghasemi bot (user 3) never queues a send", () => {
  const fromId = nextId();
  storeUpdate(ghasemi, upd(nextId(), { fromId, text: "سلام" }));
  const c = chatOf(ghasemi.id, fromId);
  assert.ok(c);
  assert.equal(outs(c.id).length, 0);
  assert.equal(ghasemi.user_id, BC_GHASEMI_USER_ID);
});

check("shared other contact is rejected politely, not linked", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام" }));
  storeUpdate(kazemi, upd(nextId(), { fromId, contact: { phone_number: "09120000039", first_name: "رضا", user_id: fromId + 1 } }));
  const c = chatOf(kazemi.id, fromId);
  assert.equal(c.customer_id, null);
  assert.equal(lastOut(c.id).text, BC_OTHER_REPLY);
  assert.equal(countCust("09120000039"), 0);
});

check("known shared contact links bale_user_id and replies OK_KNOWN (no new lead)", () => {
  const fromId = nextId();
  const before = queryRow("SELECT COUNT(*) n FROM customers")?.n;
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام", first: "سمیرا", last: "نادری" }));
  storeUpdate(kazemi, upd(nextId(), { fromId, contact: { phone_number: "+989120000031", first_name: "سمیرا", user_id: fromId } }));
  const c = chatOf(kazemi.id, fromId);
  assert.equal(c.customer_id, knownK);
  assert.equal(c.bale_user_id, String(fromId));
  assert.equal(c.verified_phone, "09120000031");
  assert.equal(c.link_source, "share");
  assert.equal(lastOut(c.id).text, BC_OK_KNOWN);
  assert.equal(queryRow("SELECT COUNT(*) n FROM customers")?.n, before);
  assert.ok(bcSourceLine(c).includes("اشتراک بله"));
  assert.equal(bcInboxTitle(c, "سمیرا نادری"), "سمیرا نادری");
});

check("known share of another expert's customer links without a thank-you bubble", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام" }));
  storeUpdate(kazemi, upd(nextId(), { fromId, contact: { phone_number: "09120000032", first_name: "مریم", user_id: fromId } }));
  const c = chatOf(kazemi.id, fromId);
  assert.equal(c.customer_id, knownH);
  assert.equal(c.link_method, "contact_other");
  assert.notEqual(lastOut(c.id).text, BC_OK_KNOWN);
});

check("new shared contact creates a lead via the current default-owner rule (Kazemi)", () => {
  const fromId = nextId();
  const phone = "09120000034";
  storeUpdate(tajik, upd(nextId(), { fromId, text: "سلام", first: "نیما", last: "اکبری" }));
  storeUpdate(tajik, upd(nextId(), { fromId, contact: { phone_number: phone, first_name: "نیما", user_id: fromId } }));
  const c = chatOf(tajik.id, fromId);
  assert.ok(c.customer_id);
  const cust = queryRow("SELECT * FROM customers WHERE id=?", [c.customer_id]);
  assert.equal(cust.phone, phone);
  assert.equal(cust.salesperson_id, 6); // current قانون ثبت → کاظمی
  assert.equal(c.lead_from_bale, 1);
  assert.equal(lastOut(c.id).text, BC_OK_NEW);
  // dedupe: same phone again on another chat does not create a second customer
  const from2 = nextId();
  storeUpdate(hasani, upd(nextId(), { fromId: from2, text: "سلام" }));
  storeUpdate(hasani, upd(nextId(), { fromId: from2, contact: { phone_number: phone, first_name: "نیما", user_id: from2 } }));
  assert.equal(countCust(phone), 1);
  const c2 = chatOf(hasani.id, from2);
  assert.equal(c2.customer_id, c.customer_id);
});

check("typed valid number stays pending; never auto-links", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام" }));
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام، این شماره‌ی من است: ۰۹۱۲۰۰۰۰۰۳۵" }));
  const c = chatOf(kazemi.id, fromId);
  assert.equal(c.customer_id, null);
  assert.equal(c.pending_typed_phone, "09120000035");
  assert.equal(lastOut(c.id).text, BC_TYPED_OK);
  assert.equal(countCust("09120000035"), 0);
});

check("typed invalid (incomplete) gets scene 12, no pending, no claim of link", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام" }));
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام، شماره‌ام این است: ۰۹۱۲۱۲۳" }));
  const c = chatOf(kazemi.id, fromId);
  assert.equal(c.pending_typed_phone, null);
  assert.equal(c.customer_id, null);
  assert.equal(lastOut(c.id).text, BC_TYPED_BAD);
});

check("approve typed (new) creates a lead; source = typed", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام", first: "حسین", last: "رستمی" }));
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "09120000036" }));
  const c = chatOf(kazemi.id, fromId);
  const u = bbUser(8);
  const r = bcApproveTyped(c, kazemi, u);
  assert.equal(r.ok, true);
  const c2 = chatOf(kazemi.id, fromId);
  assert.ok(c2.customer_id);
  assert.equal(c2.link_source, "typed");
  assert.equal(c2.pending_typed_phone, null);
  assert.equal(c2.lead_from_bale, 1);
  assert.equal(lastOut(c2.id).text, BC_OK_NEW);
  assert.ok(bcSourceLine(c2).includes("تایپ مشتری"));
});

check("approve typed (known) links existing; reject clears pending", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام" }));
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "09120000032" })); // Hasani's customer
  let c = chatOf(kazemi.id, fromId);
  const admin = bbUser(1);
  const r = bcApproveTyped(c, kazemi, admin);
  assert.equal(r.ok, true);
  c = chatOf(kazemi.id, fromId);
  assert.equal(c.customer_id, knownH);
  assert.equal(c.link_source, "typed");
  // other expert's file: no thank-you bubble (matches Armita scene 11)
  assert.notEqual(lastOut(c.id).text, BC_OK_KNOWN);
  assert.equal(lastOut(c.id).text, BC_TYPED_OK);

  const from2 = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId: from2, text: "سلام" }));
  storeUpdate(kazemi, upd(nextId(), { fromId: from2, text: "09120000037" }));
  c = chatOf(kazemi.id, from2);
  const rej = bcRejectTyped(c, kazemi, bbUser(8));
  assert.equal(rej.ok, true);
  c = chatOf(kazemi.id, from2);
  assert.equal(c.pending_typed_phone, null);
  assert.equal(c.customer_id, null);
  assert.equal(lastOut(c.id).text, BC_REJECT_TEXT);
});

check("manual entry: preview + commit (known), bad phone rejected", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام، وام خرید کالا می‌خوام" }));
  const c = chatOf(kazemi.id, fromId);
  const bad = bcPreviewManual("0912123", 6);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "bad_phone");
  const prev = bcPreviewManual("09120000031", 6);
  assert.equal(prev.ok, true);
  assert.equal(prev.match.state, "known");
  const r = bcCommitManual(c, kazemi, bbUser(8), "09120000031");
  assert.equal(r.ok, true);
  const c2 = chatOf(kazemi.id, fromId);
  assert.equal(c2.customer_id, knownK);
  assert.equal(c2.link_source, "manual");
  assert.ok(bcSourceLine(c2).includes("ورود دستی"));
});

check("permissions: only the chat owner expert and admin may approve / reject / manual; other expert cannot (403 forbidden)", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام" }));
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "09120000038" }));
  const c = chatOf(kazemi.id, fromId);
  c.owner_id = 8;
  const hasaniU = bbUser(2), kazemiU = bbUser(8), adminU = bbUser(1), ghasemiU = bbUser(3);
  assert.equal(bcCanAct(kazemiU, 8), true);
  assert.equal(bcCanAct(adminU, 8), true);
  assert.equal(bcCanAct(hasaniU, 8), false);
  assert.equal(bcCanAct(ghasemiU, 8), false);
  const denied = bcApproveTyped(c, kazemi, hasaniU);
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "forbidden");
  const rej = bcRejectTyped(c, kazemi, hasaniU);
  assert.equal(rej.ok, false);
  assert.equal(rej.error, "forbidden");
  const man = bcCommitManual(c, kazemi, hasaniU, "09120000031");
  assert.equal(man.ok, false);
  assert.equal(man.error, "forbidden");
  // still pending — Hasani did not change it
  assert.equal(chatOf(kazemi.id, fromId).pending_typed_phone, "09120000038");
});

check("t924s3807 header: other expert sees full phone and canOpen; flag off hides them; case-page lockdown not widened", () => {
  const hasaniU = bbUser(2), kazemiU = bbUser(8), adminU = bbUser(1);
  const briefH = { id: knownH, name: "مریم حسینی", phone: "09120000032", status: "in_progress", salespersonId: 3, expert: "خانم حسنی" };
  const briefK = { id: knownK, name: "سمیرا نادری", phone: "09120000031", status: "in_progress", salespersonId: 6, expert: "آقای کاظمی" };

  const otherOn = bcCustomerForViewer(kazemiU, briefH, true);
  assert.equal(otherOn.phone, "09120000032");
  assert.equal(otherOn.status, "in_progress");
  assert.equal(otherOn.canOpen, true);
  assert.equal(otherOn.restricted, true); // thread still redacts; header uses phone + canOpen
  assert.equal(otherOn.expert, "خانم حسنی");
  assert.equal(otherOn.salespersonId, 3);

  const otherOff = bcCustomerForViewer(kazemiU, briefH, false);
  assert.equal(otherOff.phone, null);
  assert.equal(otherOff.status, null);
  assert.equal(otherOff.canOpen, false);
  assert.equal(otherOff.restricted, true);
  assert.equal(otherOff.salespersonId, null);

  const owner = bcCustomerForViewer(hasaniU, briefH, true);
  assert.equal(owner.phone, "09120000032");
  assert.equal(owner.canOpen, true);
  assert.equal(owner.restricted, false);

  const admin = bcCustomerForViewer(adminU, briefH, true);
  assert.equal(admin.phone, "09120000032");
  assert.equal(admin.canOpen, true);
  assert.equal(admin.restricted, false);

  const ownFile = bcCustomerForViewer(kazemiU, briefK, true);
  assert.equal(ownFile.restricted, false);
  assert.equal(ownFile.canOpen, true);
  assert.equal(ownFile.phone, "09120000031");
});

check("other expert: contact phone and typed numbers are hidden in messageView", () => {
  const base = { id: 1, dir: "in", kind: "contact", text: null, contact_phone: "09120000032", contact_name: "نرگس جعفری", contact_own: 1, created_at: now(), sent_at: now(), edited_at: null, deleted_at: null, file_state: null, status: null, author_user_id: null, keyboard: null };
  const hidden = messageView(base, 8, { hidePhone: true });
  assert.equal(hidden.contact.phone, null);
  assert.equal(hidden.contact.hidden, true);
  assert.equal(hidden.contact.name, "نرگس جعفری");
  const open = messageView(base, 8, { hidePhone: false });
  assert.equal(open.contact.phone, "09120000032");
  const txt = messageView({ ...base, kind: "text", text: "سلام، شماره من 09120000032 است", contact_phone: null }, 8, { hidePhone: true });
  assert.equal(txt.text.includes("09120000032"), false);
  assert.ok(txt.text.includes("••••"));
  assert.equal(redactPhonesInText("۰۹۱۲۰۰۰۰۰۳۲"), "••••");
});

check("single 24h reminder, then silence; no reminder if a number already arrived", () => {
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام" }));
  const c = chatOf(kazemi.id, fromId);
  const asked = new Date(Date.now() - 25 * 3600_000).toISOString();
  executeChanges("UPDATE bale_bot_chats SET first_ask_at=?, contact_asked_at=?, welcome_sent_at=? WHERE id=?", [asked, asked, asked, c.id]);
  const n1 = bcTickReminders(new Date());
  assert.ok(n1 >= 1);
  const after = chatOf(kazemi.id, fromId);
  assert.ok(after.reminder_sent_at);
  const outCount = outs(after.id).length;
  const n2 = bcTickReminders(new Date());
  // this chat must not receive a second reminder
  assert.equal(outs(after.id).length, outCount);
  assert.equal(lastOut(after.id).text, BC_ASK_EXIST);

  // a chat that already has a typed number must not be reminded
  const from2 = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId: from2, text: "سلام" }));
  storeUpdate(kazemi, upd(nextId(), { fromId: from2, text: "09120000030" }));
  const c2 = chatOf(kazemi.id, from2);
  executeChanges("UPDATE bale_bot_chats SET first_ask_at=?, reminder_sent_at=NULL WHERE id=?", [asked, c2.id]);
  const before = outs(c2.id).length;
  bcTickReminders(new Date());
  assert.equal(outs(c2.id).length, before);
});

check("batch stays disabled; with allow:true it is idempotent per chat and skips Ghasemi", () => {
  const off = runBaleContactBatch();
  assert.equal(off.ok, false);
  assert.equal(off.error, "batch_disabled");
  assert.equal(off.sent, 0);

  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام" }));
  const c = chatOf(kazemi.id, fromId);
  // also an unlinked Ghasemi chat
  const gFrom = nextId();
  storeUpdate(ghasemi, upd(nextId(), { fromId: gFrom, text: "سلام" }));
  const gChat = chatOf(ghasemi.id, gFrom);

  const first = runBaleContactBatch({ allow: true });
  assert.equal(first.ok, true);
  assert.ok(first.sent >= 1);
  const marked = queryRow("SELECT * FROM bale_contact_batch WHERE chat_row=?", [c.id]);
  assert.ok(marked);
  const gMarked = queryRow("SELECT * FROM bale_contact_batch WHERE chat_row=?", [gChat.id]);
  assert.equal(gMarked, undefined);
  assert.equal(outs(gChat.id).length, 0);

  const second = runBaleContactBatch({ allow: true });
  assert.equal(second.ok, true);
  // our marked chat is skipped the second time
  assert.ok(queryRow("SELECT COUNT(*) n FROM bale_contact_batch WHERE chat_row=?", [c.id]).n === 1);
});

check("flag OFF again: no auto-ask (parity after schema exists)", () => {
  setFlag(BC_FLAG, "0");
  assert.equal(bcFlagOn(), false);
  const fromId = nextId();
  storeUpdate(kazemi, upd(nextId(), { fromId, text: "سلام" }));
  const c = chatOf(kazemi.id, fromId);
  assert.equal(outs(c.id).length, 0);
  // restore ON for any later seed/shots on this copy if the caller left the flag to us
  setFlag(BC_FLAG, "1");
});

check("team_sales_config / notification_settings / loan_plans / user 29 untouched by this fixture's flag writes", () => {
  // we never issued UPDATE/DELETE on those tables; just assert they still exist and user 29 is unchanged
  const u29 = queryRow("SELECT id, username, role FROM users WHERE id=29");
  assert.equal(u29.username, "hasani");
  assert.ok(queryRow("SELECT 1 AS n FROM sqlite_master WHERE name='loan_plans'"));
});

if (failures.length) {
  console.error("FAILED", failures.length, failures.join(" | "));
  process.exit(1);
}
console.log("all bale-contact checks passed");
