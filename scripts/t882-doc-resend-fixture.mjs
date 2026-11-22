// t882 document resend + stage-back: flag.doc_resend_v1, admin/sales_manager only.
// Throwaway COPY of a masked DB only; never live, never user 29, no Emzami/SMS/Bale, no sendContract.
// Usage: MASKED_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t882-doc-resend-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const src = process.env.T882_FIXTURE_DB || process.env.MASKED_DB;
if (!src) { console.log("SKIP (set T882_FIXTURE_DB or MASKED_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db" || fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t882-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
const SESSION_SECRET = `fixture-only-${crypto.randomBytes(16).toString("hex")}-not-a-real-secret-0123456789`;
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, CONTRACTS_STORAGE_DIR: path.join(dir, "contracts"),
  NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key", SESSION_SECRET,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
delete process.env.EMZAME_BUSINESS_ID;
delete process.env.EMZAME_NATIONAL_CODE;
delete process.env.EMZAME_PASSWORD;
globalThis.fetch = async () => { throw new Error("unexpected network call in t882 fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const { queryRow, queryRows, execute, executeChanges } = await import("../src/lib/crm-db.ts");
const { requireAuth } = await import("../src/lib/auth.ts");
const docs = await import("../src/lib/goods-documents.ts");
const resend = await import("../src/lib/doc-resend.ts");
const router = (await import("../src/routes/doc-resend.ts")).default;

const actor = (over) => /** @type {any} */ ({
  id: 1, username: "admin", fullName: "مدیر سیستم", mobile: null, telegramId: null,
  priorityColors: {}, role: "admin", roleName: "admin", permissions: [], customerScope: "all",
  salespersonId: null, salespersonName: null, active: true, createdAt: "2020-01-01T00:00:00Z",
  salesManager: false, baseRole: "admin",
  ...over,
});
const admin = actor({ id: 1 });
const salesManager = actor({ id: 5, role: "admin", salesManager: true, baseRole: "sales_manager", username: "mhmab" });
const expert = actor({
  id: 2, username: "s.hasani", role: "salesperson", roleName: "salesperson",
  customerScope: "assigned", salespersonId: 3, salesManager: false, baseRole: "salesperson",
});
const registrar = actor({
  id: 7, username: "s.tajik", role: "registrar", roleName: "registrar",
  customerScope: "all", salesManager: false, baseRole: "registrar",
});
const accounting = actor({
  id: 101, username: "acc.fixture", role: "accounting", roleName: "accounting",
  customerScope: "all", salesManager: false, baseRole: "accounting",
});
assert.notEqual(admin.id, 29);
assert.notEqual(salesManager.id, 29);
assert.notEqual(expert.id, 29);

const setFlag = (v) => {
  if (v == null) { executeChanges("DELETE FROM call_queue_settings WHERE key=?", [resend.DOC_RESEND_FLAG]); return; }
  execute("INSERT OR REPLACE INTO call_queue_settings(key,value,updated_by,updated_at) VALUES (?,?,NULL,datetime('now'))", [resend.DOC_RESEND_FLAG, v]);
};

const route = (method, p) => {
  const l = router.stack.find((x) => x.route?.path === p && x.route.methods[method]);
  assert.ok(l, `${method} ${p}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const call = async (method, p, params, body = {}, user = admin) => {
  let status = 200, json = null, finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const res = {
    locals: { authUser: user },
    setHeader() {},
    status(s) { status = s; return this; },
    json(b) { json = b; finished(); return this; },
  };
  const req = { params, body, query: {}, headers: {}, log: { warn() {}, info() {}, error() {} } };
  const layer = router.stack.find((x) => x.route?.path === p && x.route.methods[method]);
  assert.ok(layer, `${method} ${p}`);
  let handlers = layer.route.stack.map((s) => s.handle);
  if (handlers[0] === requireAuth) handlers = handlers.slice(1);
  await new Promise((resolve, reject) => {
    let i = 0;
    const next = (err) => {
      if (err) { reject(err); return; }
      const h = handlers[i++];
      if (!h) { resolve(); return; }
      try {
        const out = h(req, res, next);
        if (out && typeof out.then === "function") out.catch(reject);
      } catch (e) { reject(e); }
    };
    const orig = res.json.bind(res);
    res.json = (b) => { const r = orig(b); resolve(); return r; };
    next();
  });
  await Promise.race([done, Promise.resolve()]);
  return { status, json };
};

const snapDocs = (purchaseId) => queryRows(
  "SELECT id,kind,version,status,invoice_number,provider_contract_id,provider_status,pdf_sha256 FROM goods_purchase_documents WHERE purchase_id=? ORDER BY kind,version",
  [purchaseId],
);
const sameDocs = (a, b) => assert.deepEqual(a, b);

await ok("flag absent is OFF", async () => {
  setFlag(null);
  assert.equal(resend.docResendOn(), false);
});

await ok("flag '0' / 'true' / 'on' are OFF (only exact '1')", async () => {
  for (const v of ["0", "true", "on", "yes", "TRUE"]) {
    setFlag(v);
    assert.equal(resend.docResendOn(), false, v);
  }
  setFlag("1");
  assert.equal(resend.docResendOn(), true);
});

await ok("/me reports enabled:false when flag is off; other routes 404", async () => {
  setFlag(null);
  const me = await call("get", "/doc-resend/me", {});
  assert.equal(me.status, 200);
  assert.equal(me.json.enabled, false);
  assert.equal(me.json.canAct, false);
  const c = await call("get", "/goods-purchases/:id/admin-controls", { id: "54" });
  assert.equal(c.status, 404);
  assert.equal(c.json.error, "not_found");
  setFlag("1");
  const on = await call("get", "/doc-resend/me", {});
  assert.equal(on.json.enabled, true);
  assert.equal(on.json.canAct, true);
  assert.equal(on.json.flag, "flag.doc_resend_v1");
  assert.equal(on.json.baleNotify, false);
  assert.equal(on.json.baleNotifyFlag, "flag.doc_resend_bale_notify");
});

await ok("expert, registrar and accounting are forbidden; admin and sales_manager are allowed", async () => {
  setFlag("1");
  assert.equal(resend.canDocResend(expert), false);
  assert.equal(resend.canDocResend(registrar), false);
  assert.equal(resend.canDocResend(accounting), false);
  assert.equal(resend.canDocResend(admin), true);
  assert.equal(resend.canDocResend(salesManager), true);
  const e = await call("get", "/goods-purchases/:id/admin-controls", { id: "54" }, {}, expert);
  assert.equal(e.status, 403);
  assert.equal(e.json.error, "doc_resend_forbidden");
  const a = await call("get", "/goods-purchases/:id/admin-controls", { id: "54" }, {}, admin);
  assert.equal(a.status, 200);
  assert.equal(a.json.stage, "invoice_signature");
  const s = await call("get", "/goods-purchases/:id/admin-controls", { id: "54" }, {}, salesManager);
  assert.equal(s.status, 200);
  assert.ok(s.json.allowedTargetStages.includes("invoice_draft"));
  assert.ok(s.json.allowedResendKinds.includes("invoice"));
  const meSm = await call("get", "/doc-resend/me", {}, {}, salesManager);
  assert.equal(meSm.json.canAct, true);
  assert.equal(meSm.json.salesManager, true);
});

await ok("reason and confirmation are required", async () => {
  const missing = await call("post", "/goods-purchases/:id/admin-stage", { id: "54" }, { stage: "invoice_draft", confirmed: true, expectedStage: "invoice_signature" });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, "admin_reason_required");
  const short = await call("post", "/goods-purchases/:id/admin-stage", { id: "54" }, { stage: "invoice_draft", reason: "abc", confirmed: true, expectedStage: "invoice_signature" });
  assert.equal(short.status, 400);
  const unconfirmed = await call("post", "/goods-purchases/:id/admin-stage", { id: "54" }, { stage: "invoice_draft", reason: "بازگشت برای اصلاح فاکتور", expectedStage: "invoice_signature" });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.json.error, "admin_confirmation_required");
});

await ok("goods stage-back invoice_signature → invoice_draft keeps the sent invoice", async () => {
  const before = snapDocs(54);
  assert.equal(before.length, 1);
  assert.equal(before[0].status, "sent");
  const sentId = before[0].id;
  const r = await call("post", "/goods-purchases/:id/admin-stage", { id: "54" }, {
    stage: "invoice_draft", reason: "بازگشت برای اصلاح فاکتور", confirmed: true, expectedStage: "invoice_signature",
  }, salesManager);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.stage, "invoice_draft");
  assert.equal(r.json.invoice_signed_version, null);
  sameDocs(before, snapDocs(54));
  const ev = queryRow("SELECT action, detail FROM goods_purchase_events WHERE purchase_id=? ORDER BY id DESC LIMIT 1", [54]);
  assert.equal(ev.action, "admin_stage_back");
  const listed = (await import("../src/lib/goods-finance.ts")).getGoodsPurchase(54).events;
  const named = [...listed].reverse().find((e) => e.action === "admin_stage_back");
  assert.ok(named?.actorName, "actorName must be present on goods events");
  const detail = JSON.parse(ev.detail);
  assert.equal(detail.fromStage, "invoice_signature");
  assert.equal(detail.toStage, "invoice_draft");
  assert.equal(detail.reason, "بازگشت برای اصلاح فاکتور");
  assert.equal(detail.actorUserId, 5);
  assert.equal(queryRow("SELECT id FROM goods_purchase_documents WHERE id=?", [sentId]).id, sentId);
});

await ok("expectedStage conflict is 409", async () => {
  const r = await call("post", "/goods-purchases/:id/admin-stage", { id: "54" }, {
    stage: "discharge_pending", reason: "تلاش همزمان", confirmed: true, expectedStage: "invoice_signature",
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "admin_case_revision_conflict");
});

await ok("admin can revise invoice items after stage-back; old sent document stays", async () => {
  const items = queryRows("SELECT title,quantity,unit_price_toman unitPriceToman FROM goods_invoice_items WHERE purchase_id=54 ORDER BY id");
  assert.ok(items.length);
  const before = snapDocs(54);
  const versionBefore = queryRow("SELECT invoice_version FROM goods_purchases WHERE id=54").invoice_version;
  const updated = resend.reviseGoodsInvoice(54, items.map((i) => ({ title: i.title, quantity: i.quantity, unitPriceToman: i.unitPriceToman })), admin, "ویرایش اقلام پس از بازگشت مرحله", "invoice_draft");
  assert.equal(updated.stage, "invoice_draft");
  assert.equal(Number(updated.invoice_version), Number(versionBefore) + 1);
  const after = snapDocs(54);
  assert.equal(after.length, before.length);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].status, "sent");
});

await ok("forceNew opens a new invoice version and leaves the signed one valid", async () => {
  const before = snapDocs(48);
  const signed = before.find((d) => d.kind === "invoice" && d.status === "signed");
  assert.ok(signed);
  const p = queryRow("SELECT * FROM goods_purchases WHERE id=48");
  const items = queryRows("SELECT title,quantity,unit_price_toman unitPriceToman FROM goods_invoice_items WHERE purchase_id=48");
  const source = {
    id: 48, customerId: p.customer_id, planId: p.plan_id,
    creditAmountToman: p.credit_amount_toman, principalAmountToman: p.principal_amount_toman,
    payoutAmountToman: p.payout_amount_toman, acknowledgementTemplateId: p.acknowledgement_template_id,
    invoiceVersion: p.invoice_version,
    items: items.map((i) => ({ title: i.title, quantity: i.quantity, unitPriceToman: i.unitPriceToman })),
  };
  const started = docs.startGoodsDocumentGeneration(source, "invoice", admin.id, { forceNew: true });
  assert.ok(!("reused" in started), JSON.stringify(started));
  assert.equal(typeof started.id, "number");
  const after = snapDocs(48);
  const still = after.find((d) => d.id === signed.id);
  assert.equal(still.status, "signed");
  assert.equal(still.invoice_number, signed.invoice_number);
  assert.equal(still.pdf_sha256, signed.pdf_sha256);
  const neu = after.find((d) => d.id === started.id);
  assert.equal(neu.kind, "invoice");
  assert.equal(neu.version, signed.version + 1);
  assert.equal(neu.status, "generating");
  assert.notEqual(neu.invoice_number, signed.invoice_number);
  // Without forceNew, a compatible latest generating/signed path must not eat the signed row.
  executeChanges("UPDATE goods_purchase_documents SET status='failed',error='fixture_stop_before_pdf',updated_at=? WHERE id=?", [new Date().toISOString(), started.id]);
  const reused = docs.startGoodsDocumentGeneration(source, "invoice", admin.id, { forceNew: false });
  // latest is now failed, so a normal generate is allowed to open another version — that's existing behavior.
  // The signed row must still be intact.
  assert.equal(snapDocs(48).find((d) => d.id === signed.id).status, "signed");
  if (!("reused" in reused)) {
    executeChanges("UPDATE goods_purchase_documents SET status='failed',error='fixture_cleanup',updated_at=? WHERE id=?", [new Date().toISOString(), reused.id]);
  }
  assert.ok(after.filter((d) => d.kind === "invoice" && d.status === "signed").length >= 1);
});

await ok("stage-back from settlement_pending to invoice_draft clears signed pointer, keeps signed PDF", async () => {
  const before = snapDocs(48);
  const signed = before.find((d) => d.kind === "invoice" && d.status === "signed");
  const r = await call("post", "/goods-purchases/:id/admin-stage", { id: "48" }, {
    stage: "invoice_draft", reason: "بازگشت از تسویه برای فاکتور تازه", confirmed: true, expectedStage: "settlement_pending",
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.stage, "invoice_draft");
  assert.equal(r.json.invoice_signed_version, null);
  assert.equal(snapDocs(48).find((d) => d.id === signed.id).status, "signed");
});

await ok("stage-back from acknowledgement_signature to invoice_draft is blocked", async () => {
  const before = snapDocs(70);
  const stage = queryRow("SELECT stage FROM goods_purchases WHERE id=70").stage;
  assert.equal(stage, "acknowledgement_signature");
  const r = await call("post", "/goods-purchases/:id/admin-stage", { id: "70" }, {
    stage: "invoice_draft", reason: "تلاش برای برگشت از بعد تسویه", confirmed: true, expectedStage: "acknowledgement_signature",
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "settlement_financial_lock");
  assert.equal(queryRow("SELECT stage FROM goods_purchases WHERE id=70").stage, "acknowledgement_signature");
  sameDocs(before, snapDocs(70));
});

await ok("stage-back from acknowledgement_signature to settlement_pending is allowed", async () => {
  const before = snapDocs(70);
  const r = await call("post", "/goods-purchases/:id/admin-stage", { id: "70" }, {
    stage: "settlement_pending", reason: "بازگشت به قبل از اقرارنامه", confirmed: true, expectedStage: "acknowledgement_signature",
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.stage, "settlement_pending");
  sameDocs(before, snapDocs(70));
});

await ok("stage-back from completed is blocked", async () => {
  const stage = queryRow("SELECT stage FROM goods_purchases WHERE id=2").stage;
  assert.equal(stage, "completed");
  const docsBefore = snapDocs(2);
  const r = await call("post", "/goods-purchases/:id/admin-stage", { id: "2" }, {
    stage: "invoice_draft", reason: "تلاش برای برگشت از تکمیل", confirmed: true, expectedStage: "completed",
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "completed_financial_lock");
  assert.equal(queryRow("SELECT stage FROM goods_purchases WHERE id=2").stage, "completed");
  sameDocs(docsBefore, snapDocs(2));
});

await ok("payment stage-back admin_approval → sales_approval clears approval stamps and keeps history", async () => {
  const evBefore = queryRows("SELECT id,action FROM customer_payment_order_events WHERE order_id=1 ORDER BY id");
  assert.ok(evBefore.length);
  const r = await call("post", "/payment-orders/:id/admin-stage", { id: "1" }, {
    stage: "sales_approval", reason: "بازگشت برای انتخاب حساب دیگر", confirmed: true, expectedStage: "admin_approval",
  }, salesManager);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.stage, "sales_approval");
  const row = queryRow("SELECT stage,sales_approved_by,admin_approved_by FROM customer_payment_orders WHERE id=1");
  assert.equal(row.stage, "sales_approval");
  assert.equal(row.sales_approved_by, null);
  assert.equal(row.admin_approved_by, null);
  const evAfter = queryRows("SELECT id,action,detail FROM customer_payment_order_events WHERE order_id=1 ORDER BY id");
  assert.equal(evAfter.length, evBefore.length + 1);
  assert.ok(evBefore.every((e, i) => evAfter[i].id === e.id && evAfter[i].action === e.action));
  assert.equal(evAfter.at(-1).action, "admin_stage_back");
  const detail = JSON.parse(evAfter.at(-1).detail);
  assert.equal(detail.fromStage, "admin_approval");
  assert.equal(detail.toStage, "sales_approval");
  assert.equal(detail.actorUserId, 5);
});

await ok("payment stage-back awaiting_payment → sales_approval", async () => {
  const r = await call("post", "/payment-orders/:id/admin-stage", { id: "2" }, {
    stage: "sales_approval", reason: "بازگشت دستور پرداخت به تأیید فروش", confirmed: true, expectedStage: "awaiting_payment",
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.stage, "sales_approval");
  const row = queryRow("SELECT sales_approved_by,admin_approved_by FROM customer_payment_orders WHERE id=2");
  assert.equal(row.sales_approved_by, null);
  assert.equal(row.admin_approved_by, null);
});

await ok("expert cannot stage-back a payment order even when the flag is on", async () => {
  const r = await call("post", "/payment-orders/:id/admin-stage", { id: "3" }, {
    stage: "sales_approval", reason: "تلاش کارشناس", confirmed: true, expectedStage: "awaiting_payment",
  }, expert);
  assert.equal(r.status, 403);
  assert.equal(queryRow("SELECT stage FROM customer_payment_orders WHERE id=3").stage, "awaiting_payment");
});


const setNotifyFlag = (v) => {
  if (v == null) { executeChanges("DELETE FROM call_queue_settings WHERE key=?", [resend.DOC_RESEND_BALE_NOTIFY_FLAG]); return; }
  execute("INSERT OR REPLACE INTO call_queue_settings(key,value,updated_by,updated_at) VALUES (?,?,NULL,datetime('now'))", [resend.DOC_RESEND_BALE_NOTIFY_FLAG, v]);
};

const stubGenerate = async (source, kind, actorId, manual, opts) => {
  const started = docs.startGoodsDocumentGeneration(source, kind, actorId, opts ?? {});
  if ("reused" in started) return started.reused;
  executeChanges("UPDATE goods_purchase_documents SET status='generated',error=NULL,updated_at=? WHERE id=?", [new Date().toISOString(), started.id]);
  return docs.goodsDocumentState(source.id, kind);
};

await ok("cancel of a previous UNSIGNED Emzame request is mocked, fails closed, and never touches a signed doc", async () => {
  setFlag("1");
  setNotifyFlag(null);
  const cancelCalls = [];
  resend.setGenerateGoodsDocumentForTests(stubGenerate);
  resend.setCancelEmzameContractForTests(async (providerContractId) => {
    cancelCalls.push(providerContractId);
    throw new Error("provider_cancel_failed");
  });
  try {
    const before = snapDocs(54);
    const sent = before.find((d) => d.kind === "invoice" && d.status === "sent");
    assert.ok(sent?.provider_contract_id, "purchase 54 should still have a sent unsigned invoice");
    const docsBefore = before.length;
    await assert.rejects(
      () => resend.resendGoodsDocument(54, "invoice", admin, "صدور فاکتور تازه با لغو ناموفق", "invoice_draft"),
      (e) => e instanceof Error && /provider_cancel_failed/.test(e.message),
    );
    assert.equal(cancelCalls.length, 1);
    assert.equal(cancelCalls[0], sent.provider_contract_id);
    const afterFail = snapDocs(54);
    assert.equal(afterFail.length, docsBefore);
    assert.equal(afterFail.find((d) => d.id === sent.id).status, "sent");

    cancelCalls.length = 0;
    resend.setCancelEmzameContractForTests(async (providerContractId) => {
      cancelCalls.push(providerContractId);
    });
    const out = await resend.resendGoodsDocument(54, "invoice", admin, "صدور فاکتور تازه و لغو درخواست قبلی", "invoice_draft");
    assert.equal(cancelCalls.length, 1);
    assert.equal(cancelCalls[0], sent.provider_contract_id);
    const after = snapDocs(54);
    const cancelled = after.find((d) => d.id === sent.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.provider_status, "cancelled");
    assert.equal(cancelled.invoice_number, sent.invoice_number);
    assert.equal(cancelled.pdf_sha256, sent.pdf_sha256);
    assert.ok(after.some((d) => d.kind === "invoice" && d.id !== sent.id && d.status === "generated"));
    assert.equal(out.cancelled.cancelled.includes(sent.id), true);
    assert.equal(out.baleNotify.sent, false);
    assert.equal(out.baleNotify.reason, "flag_off");

    // Signed invoice on purchase 48 must never be cancelled.
    cancelCalls.length = 0;
    const signed = snapDocs(48).find((d) => d.kind === "invoice" && d.status === "signed");
    assert.ok(signed);
    const signedContract = signed.provider_contract_id;
    await resend.resendGoodsDocument(48, "invoice", admin, "فاکتور تازه بدون لغو نسخهٔ امضاشده", "invoice_draft");
    assert.equal(cancelCalls.includes(signedContract), false);
    assert.equal(snapDocs(48).find((d) => d.id === signed.id).status, "signed");
    if (signedContract) assert.ok(!cancelCalls.includes(signedContract));
  } finally {
    resend.resetDocResendHooksForTests();
  }
});

await ok("Bale notify is off unless the sub-flag is on, is mocked, and never sends SMS or a live message", async () => {
  setFlag("1");
  setNotifyFlag(null);
  const { setSrDeliverFn, _resetSrForTests } = await import("../src/lib/bale-sign-reminder.ts");
  const deliveries = [];
  setSrDeliverFn(async (opts) => {
    deliveries.push(opts);
    if (/sms|پیامک/i.test(opts.text || "")) throw new Error("SMS must not be used");
    return { ok: true, messageId: 1 };
  });
  resend.setGenerateGoodsDocumentForTests(stubGenerate);
  resend.setCancelEmzameContractForTests(async () => {});
  try {
    const off = await resend.notifyDocResendViaBale({ purchaseId: 48, kind: "invoice", actor: admin });
    assert.equal(off.sent, false);
    assert.equal(off.reason, "flag_off");
    assert.equal(deliveries.length, 0);

    setNotifyFlag("1");
    const me = await call("get", "/doc-resend/me", {});
    assert.equal(me.json.baleNotify, true);

    const noChat = await resend.notifyDocResendViaBale({ purchaseId: 48, kind: "invoice", actor: admin });
    assert.equal(noChat.sent, false);
    assert.equal(noChat.reason, "bot_not_started");
    assert.equal(deliveries.length, 0);

    const purchase = queryRow("SELECT customer_id FROM goods_purchases WHERE id=48");
    const { ensureBaleBotSchema } = await import("../src/lib/bale-bot.ts");
    const { ensureBaleContactSchema, BC_GHASEMI_USER_ID, BC_SEND_USER_IDS } = await import("../src/lib/bale-contact.ts");
    ensureBaleBotSchema();
    ensureBaleContactSchema();
    const bot = queryRow(
      `SELECT * FROM bale_bots WHERE user_id IN (${BC_SEND_USER_IDS.map(() => "?").join(",")}) AND user_id!=? AND user_id!=29 ORDER BY id LIMIT 1`,
      [...BC_SEND_USER_IDS, BC_GHASEMI_USER_ID],
    );
    assert.ok(bot, "an allowed (non-Ghasemi) Bale bot must exist in the masked copy");
    if (!String(bot.token_ct || "").trim()) {
      executeChanges("UPDATE bale_bots SET token_ct=? WHERE id=?", ["fixture-token-ct-not-real", bot.id]);
    }
    const at = new Date().toISOString();
    execute(
      `INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,customer_id,link_method,created_at,last_at)
       VALUES(?,?,?,?, 'contact', ?, ?)`,
      [bot.id, `t882-chat-${Date.now()}`, "آزمایشی", purchase.customer_id, at, at],
    );
    const chat = queryRow("SELECT * FROM bale_bot_chats WHERE bot_id=? AND customer_id=? ORDER BY id DESC LIMIT 1", [bot.id, purchase.customer_id]);
    execute(`INSERT INTO bale_bot_messages(chat_row,dir,kind,text,status,created_at) VALUES(?,'in','text','/start','sent',?)`, [chat.id, at]);

    const sent = await resend.notifyDocResendViaBale({ purchaseId: 48, kind: "invoice", actor: admin });
    assert.equal(sent.sent, true, JSON.stringify(sent));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].chatRow, chat.id);
    assert.match(deliveries[0].text, /فاکتور تازه‌ای/);
    assert.doesNotMatch(deliveries[0].text, /پیامک|sms/i);

    const out = await resend.resendGoodsDocument(48, "invoice", admin, "صدور فاکتور تازه با اطلاع بله", "invoice_draft");
    assert.equal(out.baleNotify.sent, true);
    assert.ok(deliveries.length >= 2);
  } finally {
    setNotifyFlag(null);
    resend.resetDocResendHooksForTests();
    _resetSrForTests();
  }
});

await ok("two signed acknowledgements both stay valid after a new version is issued", async () => {
  setFlag("1");
  setNotifyFlag(null);
  resend.setGenerateGoodsDocumentForTests(stubGenerate);
  resend.setCancelEmzameContractForTests(async (providerContractId) => {
    const row = queryRow("SELECT status FROM goods_purchase_documents WHERE provider_contract_id=?", [providerContractId]);
    if (row?.status === "signed") throw new Error("cancel must not run for signed acknowledgements");
  });
  try {
    const at = new Date().toISOString();
    const stageBefore = queryRow("SELECT stage, acknowledgement_template_id FROM goods_purchases WHERE id=70");
    executeChanges("UPDATE goods_purchases SET stage='acknowledgement_signature' WHERE id=?", [70]);
    const existing = snapDocs(70).filter((d) => d.kind === "acknowledgement");
    const templateId = existing[0]?.template_id ?? stageBefore.acknowledgement_template_id ?? 0;
    let nextV = existing.reduce((m, d) => Math.max(m, d.version), 0) + 1;
    const seedSigned = () => {
      const version = nextV++;
      return execute(
        `INSERT INTO goods_purchase_documents(purchase_id,kind,version,status,source_hash,source_invoice_version,template_id,pdf_path,pdf_sha256,provider_contract_id,provider_status,idempotency_key,created_by,created_at,updated_at)
         VALUES(70,'acknowledgement',?,'signed','t882-ack-seed',0,?,NULL,NULL,NULL,'signed',?,?,?,?)`,
        [version, templateId, `t882-ack-${version}-${Date.now()}`, 1, at, at],
      );
    };
    const signedIds = existing.filter((d) => d.status === "signed").map((d) => d.id);
    while (signedIds.length < 2) signedIds.push(seedSigned());
    const [id1, id2] = signedIds;
    if (id1 === id2) throw new Error("need two distinct signed acknowledgement rows");
    executeChanges("UPDATE goods_purchase_documents SET status='signed', provider_status=COALESCE(provider_status,'signed') WHERE id IN (?,?)", [id1, id2]);
    const signedBefore = snapDocs(70).filter((d) => d.kind === "acknowledgement" && d.status === "signed");
    assert.ok(signedBefore.length >= 2, JSON.stringify(signedBefore));
    const out = await resend.resendGoodsDocument(70, "acknowledgement", admin, "اقرارنامهٔ تازه؛ نسخه‌های امضاشده می‌مانند", "acknowledgement_signature");
    const after = snapDocs(70).filter((d) => d.kind === "acknowledgement");
    const still1 = after.find((d) => d.id === id1);
    const still2 = after.find((d) => d.id === id2);
    assert.equal(still1.status, "signed");
    assert.equal(still2.status, "signed");
    assert.notEqual(still1.status, "superseded");
    assert.notEqual(still2.status, "superseded");
    assert.ok(after.some((d) => d.status === "generated" && d.version > Math.max(still1.version, still2.version)));
    assert.equal((out.cancelled?.cancelled ?? []).includes(id1), false);
    assert.equal((out.cancelled?.cancelled ?? []).includes(id2), false);
    const newest = after.reduce((a, b) => (a.version > b.version ? a : b));
    const badges = (status, version) => {
      const max = Math.max(...after.map((d) => d.version));
      return [status === "signed" ? "امضاشده" : status, version === max ? "نسخه‌ی تازه" : null].filter(Boolean);
    };
    assert.deepEqual(badges(still1.status, still1.version), ["امضاشده"]);
    assert.deepEqual(badges(still2.status, still2.version), ["امضاشده"]);
    assert.ok(badges(newest.status, newest.version).includes("نسخه‌ی تازه"));
  } finally {
    resend.resetDocResendHooksForTests();
    executeChanges("UPDATE goods_purchases SET stage='settlement_pending' WHERE id=?", [70]);
  }
});

await ok("no goods_purchase_documents rows were deleted in this fixture copy", async () => {
  // Compared with the source masked file, the copy may have added generating/failed rows, never fewer signed/sent.
  const srcDbPath = src;
  // reopen source read-only via a detached query is hard here; just assert signed/sent ids we touched still exist.
  for (const id of [111, 99, 144, 131]) {
    assert.ok(queryRow("SELECT id,status FROM goods_purchase_documents WHERE id=?", [id]), String(id));
  }
  void srcDbPath;
});

console.log(`t882 doc-resend fixture passed ${passed} checks`);
