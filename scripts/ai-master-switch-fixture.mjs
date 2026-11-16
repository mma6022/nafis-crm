/**
 * ai-master-switch v1.0: master AI gate, admin GET/PATCH, key-deleted-while-on auto-off, non-admin 403.
 * Throwaway temp DB only. No live DB, no real provider HTTP, no secrets in logs or responses.
 *
 * Usage: node scripts/run-bundled-fixture.mjs scripts/ai-master-switch-fixture.mjs
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
  process.env.AI_MASTER_FIXTURE_DB, process.env.MASKED_DB,
  "/workspace/team-model/rel/masked-pkgtest.db",
  "/workspace/perm-status/masked_live.db",
].filter((p) => p && fs.existsSync(p));
if (!candidates.length) { console.log("SKIP (set AI_MASTER_FIXTURE_DB to a masked DB copy)"); process.exit(0); }
const src = path.resolve(candidates[0]);
if (src === path.resolve(LIVE)) { console.error("Refusing live DB"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-master-fx-"));
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
const cb = await import("../src/lib/customer-bale.ts");
const { BB_FLAG, bbUserFlag } = await import("../src/lib/bale-bot.ts");
const { registerCustomerBaleRoutes } = await import("../src/routes/customer-bale.ts");
const { summarizeCall, CallSummaryError } = await import("../src/lib/recording-call-summary.ts");
const { speechRequest, TranscriptionError } = await import("../src/lib/recording-speech-provider.ts");
const { extractItems, CsExtractError } = await import("../src/lib/call-summary-fields.ts");
const vn = await import("../src/lib/voice-notes-core.ts");
const { socialSummaryConfigured, summarizeSocialTranscript } = await import("../src/lib/social-thread-summary.ts");
const { invokeConsultationModel } = await import("../src/lib/consultation-engine.ts");

cb._resetCustomerBaleSchemaFlag();
am._resetAiMasterSchemaFlag();
cb.ensureCustomerBaleSchema();
am.ensureAiMasterSchema();
vn.setVoiceNotesAiGate(am.aiEnabled);
vn.setVoiceNotesOpenAiKey(() => am.aiOpenAiKey(["STT_API_KEY", "OPENAI_API_KEY"]));

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
    if (blobHasSecret({ netCalls, name })) throw new Error("secret leaked into test log state");
    console.log("ok -", name);
  } catch (e) {
    failures.push(name);
    console.error("FAIL", name, e?.message ?? e);
  } finally {
    netCalls.length = before;
  }
};

try {
  await ok("unset row follows last-resort / env seed (no row written)", async () => {
    setSetting(am.AI_ENABLED_SETTING, null);
    delete process.env[am.AI_ENABLED_SEED_ENV];
    assert.equal(am.aiEnabled(), am.AI_ENABLED_UNSET_DEFAULT === "1");
    process.env[am.AI_ENABLED_SEED_ENV] = "0";
    assert.equal(am.aiEnabled(), false);
    process.env[am.AI_ENABLED_SEED_ENV] = "1";
    assert.equal(am.aiEnabled(), true);
    delete process.env[am.AI_ENABLED_SEED_ENV];
  });

  await ok("seedAiEnabledIfAbsent writes once and never overwrites", async () => {
    setSetting(am.AI_ENABLED_SETTING, null);
    assert.equal(am.seedAiEnabledIfAbsent("0"), true);
    assert.equal(am.aiEnabled(), false);
    assert.equal(am.seedAiEnabledIfAbsent("1"), false);
    assert.equal(am.aiEnabled(), false);
  });

  await ok("GET /admin/ai: admin sees status, never a key", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    const r = await call("admin", "GET", "/bale-bot/customer-bot/admin/ai");
    assert.equal(r.s, 200);
    assert.equal(r.b.ai_enabled, false);
    assert.equal(r.b.has_key, false);
    assert.equal("openai" in r.b || "deepseek" in r.b || "key" in r.b || "sealed" in r.b, false);
    assert.ok(!blobHasSecret(r.b));
    assert.ok(!/sk-|last4|Bearer/i.test(r.raw));
  });

  await ok("non-admin GET and PATCH are 403 and never return a key", async () => {
    cb.cbStoreSecret("openai", SECRET);
    const g = await call("kazemi", "GET", "/bale-bot/customer-bot/admin/ai");
    const p = await call("kazemi", "PATCH", "/bale-bot/customer-bot/admin/ai", { ai_enabled: true });
    const a = await call("kazemi", "GET", "/bale-bot/customer-bot/admin");
    assert.equal(g.s, 403);
    assert.equal(p.s, 403);
    assert.equal(a.s, 403);
    for (const x of [g, p, a]) {
      assert.ok(!blobHasSecret(x.b));
      assert.ok(!/sk-test|NEVER-LEAK|last4/i.test(x.raw));
    }
    cb.cbDeleteSecret("openai");
  });

  await ok("PATCH on without a registered key is 409 with the exact message", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    const r = await call("admin", "PATCH", "/bale-bot/customer-bot/admin/ai", { ai_enabled: true });
    assert.equal(r.s, 409);
    assert.equal(r.b.error, "no_key");
    assert.equal(r.b.message, "حداقل یک کلید باید ثبت شده باشد");
    assert.equal(am.aiEnabled(), false);
  });

  await ok("DeepSeek-only is enough to turn the switch on; OpenAI-only too", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    cb.cbStoreSecret("deepseek", SECRET);
    const r = await call("admin", "PATCH", "/bale-bot/customer-bot/admin/ai", { ai_enabled: true });
    assert.equal(r.s, 200, r.raw);
    assert.equal(r.b.ai_enabled, true);
    assert.equal(r.b.has_key, true);
    assert.ok(!blobHasSecret(r.b));
    const audit = queryRows("SELECT action, user_id FROM ai_master_audit ORDER BY id DESC LIMIT 1");
    assert.equal(audit[0].action, "on");
    assert.equal(audit[0].user_id, 1);
    const off = await call("admin", "PATCH", "/bale-bot/customer-bot/admin/ai", { ai_enabled: false });
    assert.equal(off.s, 200);
    assert.equal(off.b.ai_enabled, false);
    cb.cbDeleteSecret("deepseek");
    cb.cbStoreSecret("openai", SECRET);
    const r2 = await call("admin", "PATCH", "/bale-bot/customer-bot/admin/ai", { ai_enabled: true });
    assert.equal(r2.s, 200);
    assert.equal(r2.b.ai_enabled, true);
    cb.cbDeleteSecret("openai", 1);
  });

  await ok("deleting the last key while on auto-offs and writes auto_off_no_key", async () => {
    cb.cbStoreSecret("openai", SECRET);
    cb.cbStoreSecret("deepseek", SECRET);
    am.aiSetEnabled(true, 1);
    assert.equal(am.aiEnabled(), true);
    cb.cbDeleteSecret("openai", 1);
    assert.equal(am.aiEnabled(), true, "one key remains");
    cb.cbDeleteSecret("deepseek", 1);
    assert.equal(am.aiEnabled(), false);
    assert.equal(am.aiHasRegisteredKey(), false);
    const row = queryRow("SELECT action, user_id FROM ai_master_audit ORDER BY id DESC LIMIT 1");
    assert.equal(row.action, "auto_off_no_key");
    assert.equal(row.user_id, 1);
    assert.ok(!blobHasSecret(queryRows("SELECT * FROM ai_master_audit")));
  });

  await ok("admin GET /admin includes ai status and key meta without the key", async () => {
    cb.cbStoreSecret("openai", SECRET);
    setSetting(am.AI_ENABLED_SETTING, "0");
    const r = await call("admin", "GET", "/bale-bot/customer-bot/admin");
    assert.equal(r.s, 200);
    assert.equal(r.b.ai.ai_enabled, false);
    assert.equal(r.b.ai.has_key, true);
    assert.equal(r.b.ai.openai_key_source, "tab");
    assert.equal(r.b.ai.xai_fallback_source, "env");
    assert.equal(r.b.openai.set, true);
    assert.equal(r.b.deepseek.set, false);
    assert.ok(!blobHasSecret(r.b));
    assert.ok(!/sk-test|NEVER-LEAK/i.test(r.raw));
    assert.equal(JSON.stringify(r.b.openai).includes("sealed"), false);
    cb.cbDeleteSecret("openai");
  });

  // ---- gates on every provider call site (flag.customer_bale_ai / env keys still on) ----
  const assertNoNet = (err) => {
    assert.equal(netCalls.length, 0, "provider HTTP must not fire while the master switch is off: " + netCalls.join(","));
    assert.match(String(err?.message ?? err), /هوش مصنوعی خاموش است|ai_off|handoff/);
  };

  await ok("gate: cbAnswerAi does not call the provider when master is off (phase flag still on)", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    setSetting(cb.CB_FLAGS.ai, "1");
    cb.cbStoreSecret("openai", SECRET);
    let called = 0;
    const r = await cb.cbAnswerAi("ساعات پاسخگویی چیست؟", { fetchFn: async () => { called++; throw new Error("should not fetch"); } });
    assert.equal(called, 0);
    assert.equal(r.kind, "handoff");
    cb.cbDeleteSecret("openai");
  });

  await ok("gate: defaultChatCompletions is blocked when off", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    const r = await cb.defaultChatCompletions({
      baseUrl: "https://api.openai.com", apiKey: SECRET, model: "x",
      messages: [{ role: "user", content: "hi" }], timeoutMs: 1000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "ai_off");
    assert.equal(netCalls.length, 0);
  });

  await ok("gate: summarizeCall (call summary) blocked when off", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    await assert.rejects(() => summarizeCall("سلام این یک متن مکالمه است."), (e) => { assertNoNet(e); return e instanceof CallSummaryError; });
  });

  await ok("gate: speechRequest (call-transcripts STT) blocked when off", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    await assert.rejects(() => speechRequest("/tmp/does-not-matter.mp3", { model: "x" }), (e) => { assertNoNet(e); return e instanceof TranscriptionError; });
  });

  await ok("gate: extractItems (call_summary_fields autofill) blocked when off", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    await assert.rejects(() => extractItems([{ speaker: "a", text: "سلام", start: 0 }], ["طرح یک"]), (e) => { assertNoNet(e); return e instanceof CsExtractError; });
  });

  await ok("gate: voice-notes transcribe blocked when off", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    await assert.rejects(() => vn.transcribe(
      { provider: "openai", model: "gpt-4o-transcribe", baseUrl: "https://api.openai.com/v1", timeoutMs: 1000 },
      process.env, { audio: Buffer.alloc(300), mime: "audio/webm", plans: [] }, globalThis.fetch,
    ), (e) => { assertNoNet(e); return e instanceof vn.VoiceNoteError && e.code === "ai_off"; });
  });

  await ok("gate: invokeConsultationModel (instagram / portal / consult) blocked when off", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    await assert.rejects(() => invokeConsultationModel([{ role: "user", content: "سلام" }]), (e) => { assertNoNet(e); return true; });
  });

  await ok("gate: social thread summary blocked / configured is false when off", async () => {
    setSetting(am.AI_ENABLED_SETTING, "0");
    assert.equal(socialSummaryConfigured(), false);
    await assert.rejects(() => summarizeSocialTranscript(["کارشناس: سلام"]), (e) => { assertNoNet(e); return true; });
  });

  await ok("gate: when master is on, cbAnswerAi is allowed to call the injected provider", async () => {
    cb.cbStoreSecret("openai", SECRET);
    am.aiSetEnabled(true, 1);
    let called = 0;
    const r = await cb.cbAnswerAi("ساعات پاسخگویی چیست؟", {
      fetchFn: async ({ apiKey }) => {
        called++;
        assert.equal(apiKey, SECRET);
        return { ok: true, text: "UNKNOWN" };
      },
    });
    assert.equal(called, 1);
    assert.equal(r.kind, "handoff"); // UNKNOWN → handoff, but the provider was reached
    am.aiSetEnabled(false, 1);
    cb.cbDeleteSecret("openai");
  });

  await ok("cbAiLive is the AND of the phase flag and the master switch", async () => {
    cb.cbStoreSecret("openai", SECRET);
    setSetting(cb.CB_FLAGS.ai, "1");
    am.aiSetEnabled(true, 1);
    assert.equal(cb.cbAiLive(), true);
    am.aiSetEnabled(false, 1);
    assert.equal(cb.cbAiLive(), false);
    setSetting(am.AI_ENABLED_SETTING, "1");
    setSetting(cb.CB_FLAGS.ai, "0");
    assert.equal(cb.cbAiLive(), false);
    cb.cbDeleteSecret("openai", 1);
  });

  // ---- tab-first OpenAI key, env fallback (STT / summary / voice-notes primary). Bale stays tab-only. ----
  const ENV_KEY = process.env.OPENAI_API_KEY;
  const bearer = (init) => {
    const h = init?.headers;
    const raw = h instanceof Headers ? h.get("Authorization") : (h && (h.Authorization || h.authorization)) || "";
    return String(raw).replace(/^Bearer\s+/i, "");
  };
  const withCapturedFetch = async (fn) => {
    let used = null;
    const prev = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (/api\.openai\.com|api\.x\.ai/i.test(u)) {
        used = bearer(init);
        return new Response(JSON.stringify({ error: "fixture-mock" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return prev(url, init);
    };
    try { await fn(() => used); } finally { globalThis.fetch = prev; }
  };
  const dummyAudio = path.join(dir, "dummy.mp3");
  fs.writeFileSync(dummyAudio, Buffer.alloc(32));

  await ok("status: tab present → openai_key_source=tab; tab empty → env", async () => {
    cb.cbStoreSecret("openai", SECRET);
    const tab = am.aiMasterStatus();
    assert.equal(tab.openai_key_source, "tab");
    assert.equal(tab.xai_fallback_source, "env");
    assert.equal(am.aiOpenAiKey()?.source, "tab");
    assert.equal(am.aiOpenAiKey()?.key, SECRET);
    cb.cbDeleteSecret("openai");
    const envS = am.aiMasterStatus();
    assert.equal(envS.has_key, false);
    assert.equal(envS.openai_key_source, "env");
    assert.equal(am.aiOpenAiKey()?.source, "env");
    assert.equal(am.aiOpenAiKey()?.key, ENV_KEY);
    assert.ok(!blobHasSecret(tab) && !blobHasSecret(envS));
  });

  await ok("tab present → summarizeCall / extractItems / speechRequest use the tab key, not env", async () => {
    cb.cbStoreSecret("openai", SECRET);
    setSetting(am.AI_ENABLED_SETTING, "1");
    await withCapturedFetch(async (get) => {
      await summarizeCall("سلام این یک متن مکالمه برای خلاصه است.").catch(() => {});
      assert.equal(get(), SECRET, "summarizeCall must use tab key");
    });
    await withCapturedFetch(async (get) => {
      await extractItems([{ speaker: "a", text: "سلام", start: 0 }], ["طرح یک"]).catch(() => {});
      assert.equal(get(), SECRET, "extractItems must use tab key");
    });
    await withCapturedFetch(async (get) => {
      await speechRequest(dummyAudio, { model: "gpt-transcribe" }).catch(() => {});
      assert.equal(get(), SECRET, "speechRequest must use tab key");
    });
    cb.cbDeleteSecret("openai");
  });

  await ok("tab empty → summarizeCall / extractItems / speechRequest use the env key", async () => {
    cb.cbDeleteSecret("openai");
    setSetting(am.AI_ENABLED_SETTING, "1");
    assert.equal(am.aiOpenAiKey()?.source, "env");
    await withCapturedFetch(async (get) => {
      await summarizeCall("سلام این یک متن مکالمه برای خلاصه است.").catch(() => {});
      assert.equal(get(), ENV_KEY, "summarizeCall must use env key");
    });
    await withCapturedFetch(async (get) => {
      await extractItems([{ speaker: "a", text: "سلام", start: 0 }], ["طرح یک"]).catch(() => {});
      assert.equal(get(), ENV_KEY, "extractItems must use env key");
    });
    await withCapturedFetch(async (get) => {
      await speechRequest(dummyAudio, { model: "gpt-transcribe" }).catch(() => {});
      assert.equal(get(), ENV_KEY, "speechRequest must use env key");
    });
  });

  await ok("voice-notes primary: tab present → tab key; tab empty → env; xAI path stays on env XAI_API_KEY", async () => {
    setSetting(am.AI_ENABLED_SETTING, "1");
    const cfgO = { provider: "openai", model: "gpt-4o-transcribe", baseUrl: "https://api.openai.com/v1", timeoutMs: 1000 };
    const cfgX = { provider: "xai", model: "grok-voice-transcribe-2.0", baseUrl: "https://api.x.ai/v1", timeoutMs: 1000 };
    const input = { audio: Buffer.alloc(300), mime: "audio/webm", plans: [] };
    cb.cbStoreSecret("openai", SECRET);
    await withCapturedFetch(async (get) => {
      await vn.transcribe(cfgO, process.env, input, globalThis.fetch).catch(() => {});
      assert.equal(get(), SECRET, "voice notes openai must use tab key");
    });
    cb.cbDeleteSecret("openai");
    // delete auto-offs; seed/release can still leave the switch on with an empty tab (env fallback).
    setSetting(am.AI_ENABLED_SETTING, "1");
    await withCapturedFetch(async (get) => {
      await vn.transcribe(cfgO, process.env, input, globalThis.fetch).catch(() => {});
      assert.equal(get(), ENV_KEY, "voice notes openai must fall back to env");
    });
    await withCapturedFetch(async (get) => {
      await vn.transcribe(cfgX, process.env, input, globalThis.fetch).catch(() => {});
      assert.equal(get(), process.env.XAI_API_KEY, "voice notes xAI must stay on env XAI_API_KEY");
    });
  });

  await ok("master off → still no provider call even when a tab or env key exists", async () => {
    cb.cbStoreSecret("openai", SECRET);
    setSetting(am.AI_ENABLED_SETTING, "0");
    netCalls.length = 0;
    await withCapturedFetch(async (get) => {
      await summarizeCall("سلام این یک متن مکالمه است.").catch((e) => {
        assert.ok(e instanceof CallSummaryError);
        assert.match(String(e.message), /هوش مصنوعی خاموش است/);
      });
      assert.equal(get(), null, "must not send a key when master is off");
    });
    assert.equal(netCalls.length, 0);
    cb.cbDeleteSecret("openai");
  });

  await ok("cbAnswerAi stays tab-only: empty tab does not fall back to env", async () => {
    cb.cbDeleteSecret("openai");
    cb.cbDeleteSecret("deepseek");
    setSetting(am.AI_ENABLED_SETTING, "1");
    setSetting(cb.CB_FLAGS.ai, "1");
    let called = 0;
    const r = await cb.cbAnswerAi("ساعات پاسخگویی چیست؟", { fetchFn: async ({ apiKey }) => { called++; return { ok: true, text: "سلام" }; } });
    assert.equal(called, 0, "Bale must not use the env OpenAI key");
    assert.equal(r.kind, "handoff");
  });

} finally {
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures.length) {
  console.error("\n" + failures.length + " failed:", failures.join(", "));
  process.exit(1);
}
console.log("\n== ai-master-switch fixture: all passed ==");
