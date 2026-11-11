/**
 * ai-feature-toggles v1.0: two admin AI toggles, OpenAI-tab keyPresent, fail-safe,
 * audit, non-admin 403. Throwaway copy of a masked DB. No live DB, no real provider HTTP,
 * no secrets in logs or responses.
 *
 * Usage: node scripts/run-bundled-fixture.mjs scripts/ai-feature-toggles-fixture.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

const LIVE = "/var/lib/nafisvam/customers.db";
const candidates = [
  process.env.AI_TOGGLES_FIXTURE_DB, process.env.MASKED_DB,
  "/workspace/ai-master-switch/rel/masked-pkgtest.db",
  "/workspace/team-model/rel/masked-pkgtest.db",
  "/workspace/followups/db/fu-r2.db",
].filter((p) => p && fs.existsSync(p));
if (!candidates.length) { console.log("SKIP (set AI_TOGGLES_FIXTURE_DB to a masked DB copy)"); process.exit(0); }
const src = path.resolve(candidates[0]);
if (src === path.resolve(LIVE)) { console.error("Refusing live DB"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-toggles-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);

Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath,
  NODE_ENV: "production",
  LOG_LEVEL: "warn",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  XAI_API_KEY: "fixture-placeholder-not-a-key",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9",
  AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-placeholder",
  BALE_BOT_WORKER: "0",
});
delete process.env.NAFISVAM_AI_ENABLED_SEED;

let netCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("127.0.0.1")) return realFetch(url, init);
  const redacted = u.replace(/key=[^&]+/gi, "key=redacted");
  if (/api\.openai\.com|api\.deepseek\.com|api\.x\.ai|generativelanguage\.googleapis/i.test(u)) {
    netCalls.push(redacted);
    throw new Error("unmocked AI HTTP: " + redacted);
  }
  throw new Error("unexpected network " + redacted);
};

const { execute, queryRow, queryRows } = await import("../src/lib/crm-db.ts");
const am = await import("../src/lib/ai-master.ts");
const ft = await import("../src/lib/ai-feature-toggles.ts");
const cb = await import("../src/lib/customer-bale.ts");
const stt = await import("../src/lib/stt-v2.ts");
const tr = await import("../src/lib/recording-transcription.ts");
const sp = await import("../src/lib/recording-speech-provider.ts");
const { BB_FLAG, bbUserFlag } = await import("../src/lib/bale-bot.ts");
const { registerCustomerBaleRoutes } = await import("../src/routes/customer-bale.ts");
const bb = await import("../src/lib/bale-bot.ts");

cb._resetCustomerBaleSchemaFlag();
am._resetAiMasterSchemaFlag();
ft._resetAiTogglesSchemaFlag();
cb.ensureCustomerBaleSchema();
am.ensureAiMasterSchema();
ft.ensureAiTogglesSchema();

const SECRET = "sk-test-fixture-secret-NEVER-LEAK-9f3a2c";
const setSetting = (key, value) => {
  if (value == null) execute("DELETE FROM call_queue_settings WHERE key=?", [key]);
  else execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [key, value, "2026-11-10T20:00:00.000Z"]);
};

setSetting(BB_FLAG, "1");
setSetting(bbUserFlag(1), "1");
setSetting(bbUserFlag(8), "1");
setSetting(cb.CB_ADMIN_FLAG, "1");
setSetting(cb.CB_FLAGS.ai, "1");
setSetting(ft.AI_TOGGLE_SETTINGS.cbAnswerAi, null);
setSetting(ft.AI_TOGGLE_SETTINGS.sttV2, null);
cb.cbDeleteSecret("openai");
cb.cbDeleteSecret("deepseek");
// Set master ON after deletes so aiAutoOffIfNoKey does not clear it. Turning the
// switch on via aiSetEnabled would be rejected without a key.
setSetting(am.AI_ENABLED_SETTING, "1");

const actors = {
  admin: { id: 1, role: "admin", base_role: "admin", salesperson_id: null, active: 1, full_name: "نوری", username: "nouri" },
  kazemi: { id: 8, role: "salesperson", base_role: "salesperson", salesperson_id: 6, active: 1, full_name: "کاظمی", username: "kazemi" },
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const a = actors[req.headers["x-actor"]];
  if (!a) return res.sendStatus(401);
  res.locals.bbUser = a;
  next();
});
const r = express.Router();
registerCustomerBaleRoutes(r, { kick() {} });
app.use("/api", r);
const server = http.createServer(app);
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const port = server.address().port;
const call = async (actor, method, url, body) => {
  const r = await realFetch(`http://127.0.0.1:${port}/api${url}`, {
    method, headers: { "x-actor": actor, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { s: r.status, b: json, raw: text };
};

const blobHasSecret = (v) => JSON.stringify(v).includes("sk-test") || JSON.stringify(v).includes("NEVER-LEAK") || JSON.stringify(v).includes(SECRET);
const failures = [];
const ok = async (name, fn) => {
  const before = netCalls.length;
  try {
    await fn();
    if (netCalls.length !== before) throw new Error("unexpected provider HTTP: " + netCalls.slice(before).join(","));
    console.log("ok  " + name);
  } catch (e) {
    failures.push(name);
    console.error("FAIL " + name + ": " + (e && e.message ? e.message : e));
  }
};

const empty = (id, keyPresent) => ({ saved: false, effective: false, keyPresent, lastEnabledAt: null });

try {
  await ok("OFF by default (absent rows); keyPresent false without a tab OpenAI key", async () => {
    const st = ft.aiTogglesStatus();
    assert.equal(st.masterEnabled, true);
    assert.equal(st.cbAnswerAi.saved, false);
    assert.equal(st.cbAnswerAi.effective, false);
    assert.equal(st.cbAnswerAi.keyPresent, false);
    assert.equal(st.cbAnswerAi.lastEnabledAt, null);
    assert.equal(st.sttV2.saved, false);
    assert.equal(st.sttV2.effective, false);
    assert.equal(st.sttV2.keyPresent, false);
    assert.equal(tr.transcriptionSpeechOpts(), undefined);
  });

  await ok("GET /admin/ai/features matches status and never leaks a key", async () => {
    const r = await call("admin", "GET", "/bale-bot/customer-bot/admin/ai/features");
    assert.equal(r.s, 200);
    assert.equal(r.b.masterEnabled, true);
    assert.deepEqual(r.b.cbAnswerAi, empty("cbAnswerAi", false));
    assert.deepEqual(r.b.sttV2, empty("sttV2", false));
    assert.ok(!blobHasSecret(r.b));
  });

  await ok("GET /admin includes aiFeatures; DeepSeek alone is not keyPresent", async () => {
    cb.cbStoreSecret("deepseek", SECRET + "-ds");
    const r = await call("admin", "GET", "/bale-bot/customer-bot/admin");
    assert.equal(r.s, 200);
    assert.equal(r.b.aiFeatures.cbAnswerAi.keyPresent, false);
    assert.equal(r.b.ai.has_key, true, "master still sees any registered key");
    assert.ok(!blobHasSecret(r.b));
    const on = await call("admin", "PATCH", "/bale-bot/customer-bot/admin/ai/features", { id: "cbAnswerAi", enabled: true });
    assert.equal(on.s, 409);
    assert.equal(on.b.error, ft.AI_TOGGLE_NO_KEY_CODE);
    assert.equal(on.b.message, ft.AI_TOGGLE_NO_KEY_MSG);
    cb.cbDeleteSecret("deepseek");
  });

  await ok("ON without a key is rejected; cbAnswerAi does not call; STT stays on the v1 path", async () => {
    cb.cbDeleteSecret("openai");
    setSetting(am.AI_ENABLED_SETTING, "1");
    const r = await call("admin", "PATCH", "/bale-bot/customer-bot/admin/ai/features", { id: "sttV2", enabled: true });
    assert.equal(r.s, 409);
    assert.equal(r.b.error, "openai_key_missing");
    let called = 0;
    const ans = await cb.cbAnswerAi("ساعات پاسخگویی چیست؟", { fetchFn: async () => { called++; return { ok: true, text: "سلام" }; } });
    assert.equal(called, 0);
    assert.equal(ans.kind, "handoff");
    setSetting(ft.AI_TOGGLE_SETTINGS.sttV2, "1"); // forced saved ON, no key
    assert.equal(ft.aiToggleEffective("sttV2"), false);
    assert.equal(tr.transcriptionSpeechOpts(), undefined);
    setSetting(ft.AI_TOGGLE_SETTINGS.sttV2, null);
  });

  await ok("ON with a stub key: PATCH writes audit, effective true, lastEnabledAt set, cbAnswerAi calls the stub, STT v2 opts used", async () => {
    cb.cbStoreSecret("openai", SECRET);
    am.aiSetEnabled(true, 1);
    const at = "2026-11-11T06:30:00.000Z";
    const st = ft.aiSetToggle("cbAnswerAi", true, 1, at);
    assert.equal(st.cbAnswerAi.saved, true);
    assert.equal(st.cbAnswerAi.effective, true);
    assert.equal(st.cbAnswerAi.keyPresent, true);
    assert.equal(st.cbAnswerAi.lastEnabledAt, at);
    const audit = queryRow("SELECT user_id, toggle, action, at FROM ai_feature_toggle_audit ORDER BY id DESC LIMIT 1");
    assert.equal(audit.user_id, 1);
    assert.equal(audit.toggle, "cbAnswerAi");
    assert.equal(audit.action, "on");
    assert.equal(audit.at, at);
    assert.ok(!blobHasSecret(audit));
    let called = 0;
    const ans = await cb.cbAnswerAi("ساعات پاسخگویی چیست؟", {
      fetchFn: async ({ apiKey }) => { called++; assert.equal(apiKey, SECRET); return { ok: true, text: "UNKNOWN" }; },
    });
    assert.equal(called, 1);
    assert.equal(ans.kind, "handoff");
    ft.aiSetToggle("sttV2", true, 1, at);
    const opts = tr.transcriptionSpeechOpts();
    assert.ok(opts && opts.v2);
    assert.match(opts.prompt, /نفیس وام/);
    assert.equal(opts.key, SECRET);
    const httpOn = await call("admin", "PATCH", "/bale-bot/customer-bot/admin/ai/features", { id: "sttV2", enabled: false });
    assert.equal(httpOn.s, 200);
    assert.equal(httpOn.b.sttV2.saved, false);
    assert.equal(httpOn.b.sttV2.lastEnabledAt, at, "lastEnabledAt is kept when turning off");
    assert.ok(!blobHasSecret(httpOn.b));
  });

  await ok("non-admin gets 403 on GET and PATCH", async () => {
    const g = await call("kazemi", "GET", "/bale-bot/customer-bot/admin/ai/features");
    assert.equal(g.s, 403);
    const p = await call("kazemi", "PATCH", "/bale-bot/customer-bot/admin/ai/features", { id: "cbAnswerAi", enabled: false });
    assert.equal(p.s, 403);
  });

  await ok("ON is rejected when the master switch is off; saved is unchanged", async () => {
    cb.cbStoreSecret("openai", SECRET);
    ft.aiSetToggle("cbAnswerAi", false, 1);
    am.aiSetEnabled(false, 1);
    const r = await call("admin", "PATCH", "/bale-bot/customer-bot/admin/ai/features", { id: "cbAnswerAi", enabled: true });
    assert.equal(r.s, 409);
    assert.equal(r.b.error, "master_off");
    assert.equal(ft.aiToggleSaved("cbAnswerAi"), false);
    am.aiSetEnabled(true, 1);
  });

  await ok("deleting the OpenAI key auto-offs saved toggles and shows effective false; DeepSeek left alone does not keep them on", async () => {
    cb.cbStoreSecret("openai", SECRET);
    cb.cbStoreSecret("deepseek", SECRET + "-ds");
    am.aiSetEnabled(true, 1);
    ft.aiSetToggle("cbAnswerAi", true, 1);
    ft.aiSetToggle("sttV2", true, 1);
    cb.cbDeleteSecret("openai", 1);
    assert.equal(ft.aiToggleSaved("cbAnswerAi"), false);
    assert.equal(ft.aiToggleSaved("sttV2"), false);
    assert.equal(ft.aiToggleEffective("cbAnswerAi"), false);
    const row = queryRow("SELECT toggle, action, user_id FROM ai_feature_toggle_audit WHERE action='auto_off_no_key' ORDER BY id DESC LIMIT 1");
    assert.ok(row);
    assert.equal(row.user_id, 1);
    assert.ok(!blobHasSecret(queryRows("SELECT * FROM ai_feature_toggle_audit")));
    cb.cbDeleteSecret("deepseek");
  });

  await ok("a Bale voice message does not go through stt_v2 even when the toggle is ON", async () => {
    cb.cbStoreSecret("openai", SECRET);
    am.aiSetEnabled(true, 1);
    ft.aiSetToggle("sttV2", true, 1);
    assert.equal(ft.aiToggleEffective("sttV2"), true);
    assert.ok(tr.transcriptionSpeechOpts()?.v2);

    let speechCalls = 0;
    sp.setSpeechRequestOverride(async () => { speechCalls++; throw new Error("stt_v2 must not run for Bale voice"); });
    bb.setBaleBotFetch(async (url) => { throw new Error("unexpected Bale HTTP " + String(url).replace(/bot[^/]+/, "bot<redacted>")); });
    bb._resetSchemaFlagForTests();
    bb.ensureBaleBotSchema();

    const at = "2026-11-11T06:40:00.000Z";
    const existing = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [1]);
    const botId = existing?.id ?? execute(
      "INSERT INTO bale_bots(user_id,status,token_ct,created_at,updated_at) VALUES(1,'on',NULL,?,?)",
      [at, at],
    );
    const bot = queryRow("SELECT * FROM bale_bots WHERE id=?", [botId]);
    const fromId = 910001;
    const updateId = 910001;
    execute("DELETE FROM bale_bot_updates WHERE bot_id=? AND update_id=?", [bot.id, updateId]);
    const pending = bb.storeUpdate(bot, {
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: fromId, type: "private" },
        from: { id: fromId, is_bot: false, first_name: "نمونه" },
        voice: { file_id: "file-fixture-not-real", file_size: 12000, duration: 3, mime_type: "audio/ogg" },
      },
    });
    const chat = queryRow("SELECT id, last_preview FROM bale_bot_chats WHERE bot_id=? AND chat_id=?", [bot.id, String(fromId)]);
    assert.ok(chat);
    const msg = queryRow("SELECT kind, file_name, mime, duration, text FROM bale_bot_messages WHERE chat_row=? ORDER BY id DESC LIMIT 1", [chat.id]);
    assert.equal(msg.kind, "voice");
    assert.equal(msg.file_name, "voice.ogg");
    assert.equal(msg.mime, "audio/ogg");
    assert.equal(msg.duration, 3);
    assert.equal(msg.text, null);
    assert.equal(chat.last_preview, "پیام صوتی");
    assert.equal(speechCalls, 0, "Bale voice must not call the speech client");
    assert.ok(Array.isArray(pending), "storeUpdate still returns file-copy ids; no transcription");
    sp.setSpeechRequestOverride(null);
    ft.aiSetToggle("sttV2", false, 1);
    cb.cbDeleteSecret("openai");
  });

  await ok("normalize + mergeMicroSpeakers (no provider call)", async () => {
    assert.equal(stt.normalizeSttV2Text("نفیسوام می رود"), "نفیس وام می‌رود");
    const segs = [
      { speaker: "A", start: 0, end: 20, text: "سلام" },
      { speaker: "B", start: 20, end: 21, text: "آه" },
      { speaker: "A", start: 21, end: 40, text: "خوبی؟" },
    ];
    const m = stt.mergeMicroSpeakers(segs, 40);
    assert.equal(m[1].speaker, "A");
    assert.equal(m.filter((s) => s.speaker === "B").length, 0);
  });

} finally {
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures.length) {
  console.error(`\n== ai-feature-toggles fixture: ${failures.length} failed ==`);
  process.exit(1);
}
console.log("\n== ai-feature-toggles fixture: all passed ==");
