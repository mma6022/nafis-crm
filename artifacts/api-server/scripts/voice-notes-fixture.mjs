// crm-voice-notes fixture: config/flag/roles/limits/logging/providers/usage + migration/rollback + dashboard text helpers.
// Runs entirely on in-memory / temp SQLite with a mocked provider fetch. Never calls a real STT API, never touches live.
// Usage: node scripts/run-bundled-fixture.mjs scripts/voice-notes-fixture.mjs   (pnpm run test:voice-notes)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { DatabaseSync } from "node:sqlite";
import {
  monthlyUsage, readPlanVocab, cachedPlanVocab, PLAN_VOCAB_TTL_MS, XAI_MAX_KEYTERMS, PRIMARY_TIMEOUT_WITH_FALLBACK_MS,
  readSttConfig, ensureVoiceNotesSchema, createVoiceNotesRouter, keyterms, helperPrompt, activePlanNames, validateTranscript,
  tehranDay, jalaliMonth, VOICE_NOTES_TABLE, PRICE_PER_MINUTE_USD,
} from "../src/lib/voice-notes-core.ts";
import { TABLES, migrate, tableState } from "./voice-notes-migrate.mjs";
import { planTableRollback, backup, exportData, applyRollback } from "./voice-notes-rollback.mjs";
import { appendTranscript, pickRecorderType, uploadType, formatTimer, transcribeErrorMessage, micErrorMessage, MAX_RECORD_SECONDS }
  from "../../crm-dashboard/src/features/voice-notes/voice-note-text.ts";

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const FAKE_KEY = "fixture-not-a-real-key";

/* ---------- harness ---------- */
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE loan_plans (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)");
  db.prepare("INSERT INTO loan_plans (name, active) VALUES (?,?),(?,?),(?,?)").run("طرح مریخ", 1, "طرح ستاره آبی", 1, "طرح قدیمی", 0);
  return db;
}
const USERS = {
  sales: { id: 7, role: "salesperson", fullName: "کاظمی" },
  admin: { id: 1, role: "admin", fullName: "مدیر" },
  acct: { id: 9, role: "accountant", fullName: "حسابدار" },
};
async function start({ env, provider, now = () => new Date("2026-10-24T10:00:00+03:30"), db = makeDb() }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const fields = [...init.body.entries()];
    const file = fields.find(([k]) => k === "file")?.[1];
    calls.push({ url, auth: init.headers.Authorization, redirect: init.redirect, fields: fields.map(([k, v]) => [k, typeof v === "string" ? v : `<file ${v.type} ${v.size}>`]), fileBytes: file ? new Uint8Array(await file.arrayBuffer()) : null });
    const r = provider(url, fields);
    if (r.throw) throw Object.assign(new Error("simulated"), { name: r.throw });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const u = USERS[req.headers["x-user"]]; if (u) res.locals.authUser = u; next(); });
  app.use("/api", createVoiceNotesRouter({ db, env: () => env, fetch: fetchImpl, now, actor: (res) => res.locals.authUser ?? null }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const req = async (method, p, { user, body, type, headers = {} } = {}) => {
    const h = { ...headers }; if (user) h["x-user"] = user; if (type) h["content-type"] = type;
    const r = await fetch(base + p, { method, headers: h, body });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { db, calls, req, close: () => new Promise((r) => server.close(r)) };
}
const audio = (n = 4000) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31) & 255; return b; };
const ON = { STT_ENABLED: "1", STT_PROVIDER: "openai", OPENAI_API_KEY: FAKE_KEY }; // OpenAI fallback path
const openaiOk = (text = "مشتری برای طرح مریخ تماس گرفت.") => () => ({ body: { text, usage: { type: "tokens" } } });
const rows = (db) => db.prepare(`SELECT * FROM ${VOICE_NOTES_TABLE} ORDER BY id`).all();
const post = (t, user, q, body = audio(), type = "audio/webm") => t.req("POST", `/voice-notes/transcribe?${q}`, { user, body, type });

/* ---------- config ---------- */
await ok("config defaults: flag OFF, xai, grok-voice-transcribe-2.0, 60 min/day, 120 s max", () => {
  const c = readSttConfig({});
  assert.equal(c.enabled, false); assert.equal(c.provider, "xai"); assert.equal(c.model, "grok-voice-transcribe-2.0");
  assert.equal(c.baseUrl, "https://api.x.ai/v1"); assert.equal(c.hasKey, false);
  assert.equal(readSttConfig({ OPENAI_API_KEY: FAKE_KEY }).hasKey, false, "default xAI never uses the OpenAI key");
  for (const v of ["XAI", " xai ", "bogus"]) assert.equal(readSttConfig({ STT_PROVIDER: v }).provider, "xai", v);
  assert.equal(c.dailyLimitSeconds, 3600); assert.equal(c.maxSeconds, 120);
  for (const v of ["0", "false", "off", "", "maybe"]) assert.equal(readSttConfig({ STT_ENABLED: v }).enabled, false, v);
  for (const v of ["1", "true", "ON", "yes"]) assert.equal(readSttConfig({ STT_ENABLED: v }).enabled, true, v);
});
await ok("provider switch: xai → grok-voice-transcribe-2.0 on api.x.ai with XAI_API_KEY only; openai fallback → gpt-4o-transcribe; max seconds clamped to 120", () => {
  const o = readSttConfig({ STT_PROVIDER: "openai" });
  assert.equal(o.provider, "openai"); assert.equal(o.model, "gpt-4o-transcribe"); assert.equal(o.baseUrl, "https://api.openai.com/v1");
  const x = readSttConfig({ STT_PROVIDER: "xai", OPENAI_API_KEY: FAKE_KEY, STT_MAX_SECONDS: "999" });
  assert.equal(x.provider, "xai"); assert.equal(x.model, "grok-voice-transcribe-2.0"); assert.equal(x.baseUrl, "https://api.x.ai/v1");
  assert.equal(x.hasKey, false, "OpenAI key never used for xAI"); assert.equal(x.maxSeconds, 120);
  assert.equal(readSttConfig({ STT_PROVIDER: "xai", XAI_API_KEY: FAKE_KEY }).hasKey, true);
  assert.equal(readSttConfig({ STT_PROVIDER: "openai", STT_API_KEY: FAKE_KEY }).hasKey, true);
  assert.equal(readSttConfig({ STT_PROVIDER: "openai", STT_API_BASE_URL: "http://evil.example" }).baseUrl, "https://api.openai.com/v1", "non-https base ignored");
});
await ok("vocabulary: active plan names without «طرح», ≤100 keyterms each ≤50 chars, prompt carries plans + terms", () => {
  const db = makeDb(); const plans = activePlanNames(db);
  assert.deepEqual(plans, ["مریخ", "ستاره آبی"]);
  const k = keyterms(plans); assert.ok(k.length <= 100 && k.every((t) => t.length <= 50)); assert.ok(k.includes("مریخ") && k.includes("چک صیادی"));
  assert.deepEqual(k.slice(0, 3), ["طرح", "ضامن", "صیادی"]);
  const many = keyterms(Array.from({ length: 150 }, (_, i) => `طرح${i}`)); assert.equal(many.length, 100); assert.deepEqual(many.slice(0, 3), ["طرح", "ضامن", "صیادی"]);
  const p = helperPrompt(plans); assert.match(p, /مریخ، ستاره آبی/); assert.match(p, /رفع سوء اثر/); assert.match(p, /بلوبانک/);
});
await ok("repetition guard rejects runaway output; normal text trimmed", () => {
  assert.equal(validateTranscript("  سلام  "), "سلام");
  assert.throws(() => validateTranscript(Array(20).fill("قسط").join(" ")), /تکراری/);
  assert.throws(() => validateTranscript(42));
});

/* ---------- HTTP ---------- */
await ok("flag OFF: config {enabled:false} for everyone; transcribe 404; provider never called; no table rows", async () => {
  const t = await start({ env: { OPENAI_API_KEY: FAKE_KEY }, provider: openaiOk() });
  try {
    for (const u of ["sales", "admin"]) assert.deepEqual((await t.req("GET", "/voice-notes/config", { user: u })).json, { enabled: false });
    assert.equal((await post(t, "sales", "field=call_note&duration=5")).status, 404);
    assert.equal(t.calls.length, 0);
  } finally { await t.close(); }
});
await ok("roles: salesperson + admin allowed; accountant → config disabled + 403; anonymous → 401", async () => {
  const t = await start({ env: ON, provider: openaiOk() });
  try {
    const c = (await t.req("GET", "/voice-notes/config", { user: "sales" })).json;
    assert.deepEqual(c, { enabled: true, maxSeconds: 120, dailyLimitSeconds: 3600, remainingSeconds: 3600 });
    assert.equal((await t.req("GET", "/voice-notes/config", { user: "admin" })).json.enabled, true);
    assert.deepEqual((await t.req("GET", "/voice-notes/config", { user: "acct" })).json, { enabled: false });
    assert.equal((await post(t, "acct", "field=call_note&duration=5")).status, 403);
    assert.equal((await post(t, undefined, "field=call_note&duration=5")).status, 401);
    assert.equal(t.calls.length, 0);
  } finally { await t.close(); }
});
await ok("validation: 415 type, 413 size/duration, 400 duration/empty — provider not called", async () => {
  const t = await start({ env: { ...ON, STT_MAX_BYTES: "65536" }, provider: openaiOk() });
  try {
    assert.equal((await post(t, "sales", "duration=5", audio(), "text/plain")).status, 415);
    assert.equal((await post(t, "sales", "duration=5", audio(), "image/png")).status, 415);
    assert.equal((await post(t, "sales", "duration=5", audio(70000))).status, 413);
    assert.equal((await post(t, "sales", "duration=200")).status, 413);
    assert.equal((await post(t, "sales", "duration=0")).status, 400);
    assert.equal((await post(t, "sales", "duration=abc")).status, 400);
    assert.equal((await post(t, "sales", "duration=5", audio(50))).status, 400);
    assert.equal(t.calls.length, 0);
  } finally { await t.close(); }
});
await ok("openai success: model/language/temperature/prompt, file LAST with exact bytes, bearer key, no redirects; webm + mp4", async () => {
  const t = await start({ env: ON, provider: openaiOk("  ضامن داره و سفته میده.  ") });
  try {
    const a = audio(5000);
    const r = await post(t, "sales", "field=call_note&duration=12.4", a, "audio/webm;codecs=opus");
    assert.equal(r.status, 200); assert.deepEqual(r.json, { text: "ضامن داره و سفته میده.", seconds: 12 });
    const c = t.calls[0];
    assert.equal(c.url, "https://api.openai.com/v1/audio/transcriptions"); assert.equal(c.auth, `Bearer ${FAKE_KEY}`); assert.equal(c.redirect, "error");
    const f = Object.fromEntries(c.fields);
    assert.equal(f.model, "gpt-4o-transcribe"); assert.equal(f.language, "fa"); assert.equal(f.temperature, "0"); assert.match(f.prompt, /مریخ/);
    assert.equal(c.fields.at(-1)[0], "file"); assert.match(c.fields.at(-1)[1], /^<file audio\/webm 5000>$/);
    assert.deepEqual(c.fileBytes, a);
    assert.equal((await post(t, "sales", "field=first_call_note&duration=3", audio(), "audio/mp4")).status, 200);
    assert.match(t.calls[1].fields.at(-1)[1], /audio\/mp4/);
  } finally { await t.close(); }
});
await ok("log rows: user/role/field/model/seconds/bytes/day/month — never audio or transcript text", async () => {
  const text = "متن محرمانهٔ یادداشت";
  const t = await start({ env: ON, provider: openaiOk(text) });
  try {
    await post(t, "sales", "field=customer_description&duration=30");
    const [row] = rows(t.db);
    assert.equal(row.user_id, 7); assert.equal(row.user_name, "کاظمی"); assert.equal(row.role, "salesperson");
    assert.equal(row.field, "customer_description"); assert.equal(row.provider, "openai"); assert.equal(row.model, "gpt-4o-transcribe");
    assert.equal(row.audio_seconds, 30); assert.equal(row.audio_bytes, 4000); assert.equal(row.ok, 1);
    assert.equal(row.day_tehran, "2026-10-24"); assert.equal(row.month_jalali, "1405-08");
    const cols = Object.keys(row); assert.ok(!cols.some((c) => /text|audio_data|blob|transcript/.test(c)), cols.join());
    assert.ok(!JSON.stringify(rows(t.db)).includes(text));
  } finally { await t.close(); }
});
await ok("seconds = max(provider duration, client duration), clamped to 120", async () => {
  let dur = 50;
  const t = await start({ env: ON, provider: () => ({ body: { text: "سلام", duration: dur } }) });
  try {
    assert.equal((await post(t, "sales", "duration=10")).json.seconds, 50);
    dur = 124; assert.equal((await post(t, "sales", "duration=10")).json.seconds, 120, "within tolerance → clamped");
  } finally { await t.close(); }
});
await ok("server 2-min rule: provider says 500 s while client said 10 → 413, no text, real length counts toward the daily cap", async () => {
  const t = await start({ env: ON, provider: () => ({ body: { text: "متن طولانی", duration: 500 } }) });
  try {
    const r = await post(t, "sales", "field=call_note&duration=10");
    assert.equal(r.status, 413); assert.equal(r.json.code, "too_long"); assert.equal(r.json.text, undefined);
    const row = rows(t.db).at(-1); assert.equal(row.ok, 0); assert.equal(row.error_code, "too_long"); assert.equal(row.audio_seconds, 500);
    const cfg = (await t.req("GET", "/voice-notes/config", { user: "sales" })).json;
    assert.equal(cfg.enabled, true); assert.equal(cfg.remainingSeconds, 3600 - 500);
  } finally { await t.close(); }
});
await ok("daily cap: 429 once today's seconds would exceed limit (logged as daily_limit); next Tehran day resets", async () => {
  let clock = new Date("2026-10-24T23:00:00+03:30");
  const t = await start({ env: { ...ON, STT_DAILY_LIMIT_MINUTES: "3" }, provider: openaiOk(), now: () => clock });
  try {
    assert.equal((await post(t, "sales", "duration=100")).status, 200);
    assert.equal((await post(t, "sales", "duration=60")).status, 200);
    const r = await post(t, "sales", "duration=30");
    assert.equal(r.status, 429); assert.match(r.json.error, /سقف روزانه/);
    assert.equal(t.calls.length, 2);
    assert.equal(rows(t.db).at(-1).error_code, "daily_limit");
    assert.equal((await t.req("GET", "/voice-notes/config", { user: "sales" })).json.remainingSeconds, 20);
    assert.equal((await post(t, "admin", "duration=30")).status, 200, "cap is per user");
    clock = new Date("2026-10-25T00:30:00+03:30");
    assert.equal((await post(t, "sales", "duration=30")).status, 200);
  } finally { await t.close(); }
});
await ok("xai: /stt with model, language=fa, repeated keyterm, file LAST; XAI key only", async () => {
  const t = await start({ env: { STT_ENABLED: "on", STT_PROVIDER: "xai", XAI_API_KEY: FAKE_KEY + "-x", OPENAI_API_KEY: FAKE_KEY },
    provider: () => ({ body: { text: "طرح مریخ", duration: 4.2 } }) });
  try {
    const r = await post(t, "admin", "field=call_note&duration=4");
    assert.equal(r.status, 200); assert.equal(r.json.text, "طرح مریخ");
    const c = t.calls[0];
    assert.equal(c.url, "https://api.x.ai/v1/stt"); assert.equal(c.auth, `Bearer ${FAKE_KEY}-x`);
    const names = c.fields.map(([k]) => k);
    assert.equal(names[0], "model"); assert.equal(c.fields[0][1], "grok-voice-transcribe-2.0"); assert.equal(names.at(-1), "file");
    const kt = c.fields.filter(([k]) => k === "keyterm").map(([, v]) => v);
    assert.ok(kt.includes("مریخ") && kt.includes("ستاره آبی") && kt.length <= 100);
    assert.equal(rows(t.db)[0].provider, "xai");
  } finally { await t.close(); }
});
await ok("plan vocabulary: ALL loan_plans names (active first), read at request time, cached 60 s; ≤100 keyterms incl. «طرح»/«ضامن»/«صیادی»", () => {
  const db = makeDb();
  assert.deepEqual(readPlanVocab(db), { active: ["مریخ", "ستاره آبی"], inactive: ["قدیمی"] });
  const k = keyterms(["مریخ", "ستاره آبی"], ["قدیمی"]);
  assert.deepEqual(k.slice(0, 7), ["طرح", "ضامن", "صیادی", "مریخ", "طرح مریخ", "ستاره آبی", "طرح ستاره آبی"]); assert.deepEqual(k.slice(-2), ["قدیمی", "طرح قدیمی"]);
  assert.equal(XAI_MAX_KEYTERMS, 100);
  const big = keyterms(Array.from({ length: 200 }, (_, i) => `پلن${i}`), ["قدیمی"]); assert.equal(big.length, 100); assert.ok(!big.includes("قدیمی"));
  const t0 = 1_000_000; const v1 = cachedPlanVocab(db, t0);
  db.prepare("INSERT INTO loan_plans (name, active) VALUES (?, 1)").run("طرح جدید");
  assert.deepEqual(cachedPlanVocab(db, t0 + 1000), v1, "cached within TTL");
  assert.ok(cachedPlanVocab(db, t0 + PLAN_VOCAB_TTL_MS + 1).active.includes("جدید"), "refreshed after TTL");
  db.prepare("INSERT INTO loan_plans (name, active) VALUES (?, 1)").run("x".repeat(51));
  assert.ok(!readPlanVocab(db).active.includes("x".repeat(51)), ">50 chars dropped (xAI limit)");
});
const XON = { STT_ENABLED: "1", XAI_API_KEY: FAKE_KEY + "-x", OPENAI_API_KEY: FAKE_KEY }; // default provider = xAI
const isX = (url) => url.startsWith("https://api.x.ai/");
await ok("fallback: xAI error/timeout/network → ONE retry with OpenAI gpt-4o-transcribe + prompt; row logs provider that served", async () => {
  for (const [xresp, code] of [[{ status: 500, body: {} }, "provider_500"], [{ throw: "TimeoutError" }, "timeout"], [{ throw: "TypeError" }, "network"], [{ status: 401, body: {} }, "provider_auth"], [{ status: 200, body: { text: Array(30).fill("وام").join(" ") } }, "repetitive_text"]]) {
    const t = await start({ env: XON, provider: (url) => (isX(url) ? xresp : { body: { text: "ضامن داره." } }) });
    try {
      const r = await post(t, "sales", "field=call_note&duration=5");
      assert.equal(r.status, 200, code); assert.equal(r.json.text, "ضامن داره.");
      assert.equal(t.calls.length, 2); assert.ok(isX(t.calls[0].url));
      assert.equal(t.calls[1].url, "https://api.openai.com/v1/audio/transcriptions"); assert.equal(t.calls[1].auth, `Bearer ${FAKE_KEY}`);
      const f = Object.fromEntries(t.calls[1].fields); assert.equal(f.model, "gpt-4o-transcribe"); assert.ok(f.prompt.includes("مریخ")); assert.equal(f.language, "fa");
      const row = rows(t.db); assert.equal(row.length, 1); assert.equal(row[0].provider, "openai"); assert.equal(row[0].model, "gpt-4o-transcribe");
      assert.equal(row[0].ok, 1); assert.equal(row[0].error_code, `fallback_from_xai:${code}`); assert.ok(row[0].audio_seconds > 0);
      assert.deepEqual(monthlyUsage(t.db, row[0].month_jalali).providers.map((p) => [p.provider, p.served, p.fallbacks]), [["openai", 1, 1]]);
    } finally { await t.close(); }
  }
});
await ok("fallback: xAI success → no OpenAI call, row provider xai; both fail → 502 Persian, logged ok=0 as openai; no retry when disabled or no OpenAI key; xAI timeout shortened", async () => {
  let t = await start({ env: XON, provider: () => ({ body: { text: "طرح مریخ", duration: 3 } }) });
  try { const r = await post(t, "sales", "duration=3"); assert.equal(r.status, 200); assert.equal(t.calls.length, 1); const row = rows(t.db)[0]; assert.equal(row.provider, "xai"); assert.equal(row.error_code, null); }
  finally { await t.close(); }
  t = await start({ env: XON, provider: (url) => (isX(url) ? { throw: "TimeoutError" } : { status: 500, body: {} }) });
  try {
    const r = await post(t, "sales", "duration=3"); assert.equal(r.status, 502); assert.match(r.json.error, /[\u0600-\u06ff]/); assert.equal(t.calls.length, 2);
    const row = rows(t.db)[0]; assert.equal(row.ok, 0); assert.equal(row.provider, "openai"); assert.equal(row.error_code, "fallback_failed:timeout>provider_500");
    assert.ok(!JSON.stringify(r.json).includes(FAKE_KEY));
  } finally { await t.close(); }
  for (const env of [{ ...XON, STT_FALLBACK: "off" }, { STT_ENABLED: "1", XAI_API_KEY: FAKE_KEY + "-x" }]) {
    t = await start({ env, provider: () => ({ status: 500, body: {} }) });
    try { const r = await post(t, "sales", "duration=3"); assert.equal(r.status, 502); assert.equal(t.calls.length, 1); assert.equal(rows(t.db)[0].provider, "xai"); assert.equal(rows(t.db)[0].error_code, "provider_500"); }
    finally { await t.close(); }
  }
  // xAI key missing but OpenAI present → fallback serves
  t = await start({ env: { STT_ENABLED: "1", OPENAI_API_KEY: FAKE_KEY }, provider: () => ({ body: { text: "سلام" } }) });
  try { const r = await post(t, "sales", "duration=3"); assert.equal(r.status, 200); assert.equal(t.calls.length, 1); assert.equal(rows(t.db)[0].error_code, "fallback_from_xai:no_key"); }
  finally { await t.close(); }
  assert.equal(readSttConfig({}).fallback, true); assert.equal(readSttConfig({ STT_PROVIDER: "openai" }).fallback, false);
  assert.ok(PRIMARY_TIMEOUT_WITH_FALLBACK_MS + 30_000 < 60_000, "primary + fallback under nginx 60 s");
});
await ok("provider errors → Persian message + code, logged ok=0; key never in response; no key → 503", async () => {
  const cases = [
    [{ status: 401, body: { error: "bad key" } }, "provider_auth"],
    [{ status: 429, body: { error: { type: "insufficient_quota" } } }, "provider_quota"],
    [{ status: 429, body: { error: { type: "rate" } } }, "provider_rate_limit"],
    [{ status: 400, body: { error: "bad audio" } }, "provider_rejected"],
    [{ status: 500, body: {} }, "provider_500"],
    [{ status: 200, body: { text: Array(30).fill("وام").join(" ") } }, "repetitive_text"],
  ];
  for (const [resp, code] of cases) {
    const t = await start({ env: ON, provider: () => resp });
    try {
      const r = await post(t, "sales", "duration=5");
      assert.equal(r.status, 502, code); assert.equal(r.json.code, code); assert.match(r.json.error, /[\u0600-\u06ff]/);
      assert.ok(!JSON.stringify(r.json).includes(FAKE_KEY));
      const row = rows(t.db)[0]; assert.equal(row.ok, 0); assert.equal(row.error_code, code);
    } finally { await t.close(); }
  }
  const t = await start({ env: { STT_ENABLED: "1" }, provider: openaiOk() });
  try { const r = await post(t, "sales", "duration=5"); assert.equal(r.status, 503); assert.equal(r.json.code, "no_key"); assert.equal(t.calls.length, 0); }
  finally { await t.close(); }
});
await ok("usage: admin only; monthly per-user totals + est. cost; config shows hasKey but never the key", async () => {
  const t = await start({ env: ON, provider: () => ({ body: { text: "سلام", duration: 60 } }) });
  try {
    await post(t, "sales", "duration=60"); await post(t, "sales", "duration=60"); await post(t, "admin", "duration=30");
    assert.equal((await t.req("GET", "/voice-notes/usage", { user: "sales" })).status, 403);
    assert.equal((await t.req("GET", "/voice-notes/usage")).status, 401);
    const r = await t.req("GET", "/voice-notes/usage?month=1405-08", { user: "admin" });
    assert.equal(r.status, 200); assert.deepEqual(r.json.months, ["1405-08"]);
    assert.equal(r.json.totals.count, 3); assert.equal(r.json.totals.minutes, 3);
    assert.equal(r.json.totals.estCostUsd, Math.round(3 * PRICE_PER_MINUTE_USD["gpt-4o-transcribe"] * 1000) / 1000);
    assert.equal(r.json.users[0].name, "کاظمی"); assert.equal(r.json.users[0].minutes, 2);
    assert.deepEqual(r.json.config, { enabled: true, provider: "openai", model: "gpt-4o-transcribe", hasKey: true, dailyLimitMinutes: 60, pricePerMinuteUsd: 0.006 });
    assert.ok(!JSON.stringify(r.json).includes(FAKE_KEY));
    assert.equal((await t.req("GET", "/voice-notes/usage?month=1405-07", { user: "admin" })).json.totals.count, 0);
  } finally { await t.close(); }
});
await ok("Tehran day / Jalali month boundaries", () => {
  assert.equal(tehranDay(new Date("2026-10-24T20:29:00Z")), "2026-10-24");
  assert.equal(tehranDay(new Date("2026-10-24T20:31:00Z")), "2026-10-25");
  assert.equal(jalaliMonth(new Date("2026-10-22T12:00:00Z")), "1405-07");
  assert.equal(jalaliMonth(new Date("2026-10-23T12:00:00Z")), "1405-08");
});

/* ---------- migration / rollback ---------- */
const norm = (s) => s.replace(/\s+/g, " ").replace(/IF NOT EXISTS /g, "").trim();
const schemaOf = (db) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE '%voice_note%' ORDER BY name").all().map((r) => ({ ...r, sql: norm(r.sql) }));
await ok("migration: dry-run state, additive + idempotent, same DDL as server ensureVoiceNotesSchema", () => {
  const a = makeDb(); const b = makeDb();
  assert.deepEqual(tableState(a), [{ table: "voice_note_transcriptions", present: false }]);
  const before = a.prepare("SELECT count(*) n FROM loan_plans").get().n;
  assert.deepEqual(migrate(a), { applied: true, added: ["table voice_note_transcriptions"], skipped: [] });
  assert.equal(migrate(a).applied, false);
  ensureVoiceNotesSchema(b);
  assert.deepEqual(schemaOf(a), schemaOf(b));
  assert.equal(schemaOf(a).length, 3);
  assert.equal(a.prepare("SELECT count(*) n FROM loan_plans").get().n, before);
  assert.equal(TABLES.length, 1);
});
await ok("rollback: backup (integrity-checked) + JSON export, then drop; other tables untouched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vn-fx-"));
  try {
    const file = path.join(dir, "crm.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE loan_plans (id INTEGER PRIMARY KEY, name TEXT, active INTEGER); INSERT INTO loan_plans VALUES (1,'طرح مریخ',1);");
    migrate(db);
    db.prepare(`INSERT INTO ${VOICE_NOTES_TABLE} (user_id,role,provider,model,audio_seconds,ok,day_tehran,month_jalali,created_at) VALUES (7,'salesperson','openai','gpt-4o-transcribe',12,1,'2026-10-24','1405-08','x')`).run();
    assert.deepEqual(planTableRollback(db), [{ table: VOICE_NOTES_TABLE, present: true, rows: 1 }]);
    const bak = path.join(dir, "bak.db"); backup(db, bak); assert.throws(() => backup(db, bak), /exists/);
    assert.equal(exportData(db)[`table ${VOICE_NOTES_TABLE}`].length, 1);
    assert.deepEqual(applyRollback(db), { applied: true, dropped: [`table ${VOICE_NOTES_TABLE}`] });
    assert.equal(tableState(db)[0].present, false); assert.equal(db.prepare("SELECT count(*) n FROM loan_plans").get().n, 1);
    assert.equal(applyRollback(db).applied, false);
    const b = new DatabaseSync(bak, { readOnly: true }); assert.equal(b.prepare(`SELECT count(*) n FROM ${VOICE_NOTES_TABLE}`).get().n, 1); b.close();
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------- dashboard pure helpers ---------- */
await ok("appendTranscript: appends on a new line, never replaces or trims existing text, cuts only the appended part", () => {
  assert.equal(appendTranscript("", " سلام "), "سلام");
  assert.equal(appendTranscript("قبلی", "جدید"), "قبلی\nجدید");
  assert.equal(appendTranscript("قبلی\n", "جدید"), "قبلی\nجدید");
  assert.equal(appendTranscript("قبلی  ", "جدید"), "قبلی\nجدید");
  assert.equal(appendTranscript("قبلی", "   "), "قبلی");
  assert.equal(appendTranscript("abcd", "efgh", 7), "abcd\nef");
  assert.equal(appendTranscript("abcdefgh", "x", 5), "abcdefgh", "existing text over the max is never cut");
});
await ok("recorder type: webm/opus first, mp4 fallback (iOS), none → ''; upload type strips codecs", () => {
  assert.equal(pickRecorderType(() => true), "audio/webm;codecs=opus");
  assert.equal(pickRecorderType((t) => t.startsWith("audio/mp4")), "audio/mp4;codecs=mp4a.40.2");
  assert.equal(pickRecorderType(() => false), "");
  assert.equal(pickRecorderType(() => { throw new Error("x"); }), "");
  assert.equal(uploadType("audio/webm;codecs=opus"), "audio/webm"); assert.equal(uploadType(""), "audio/webm");
});
await ok("timer + Persian error messages", () => {
  assert.equal(MAX_RECORD_SECONDS, 120);
  assert.equal(formatTimer(0), "۰:۰۰"); assert.equal(formatTimer(75.9), "۱:۱۵"); assert.equal(formatTimer(120), "۲:۰۰");
  assert.match(micErrorMessage({ name: "NotAllowedError" }), /اجازه/);
  assert.match(transcribeErrorMessage(0, null), /متن قبلی سر جایش است/);
  assert.equal(transcribeErrorMessage(502, "سرویس پاسخ نداد"), "سرویس پاسخ نداد");
  assert.match(transcribeErrorMessage(500, "Internal error"), /متن قبلی/);
});

console.log(`\nvoice-notes fixture: ${passed} passed`);
