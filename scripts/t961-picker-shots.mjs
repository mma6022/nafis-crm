// t961 shots: «دسترسی این صفحه» picker for a locked/trainee expert, before vs after — local only, masked DB copy, no network, no live writes.
// Run (one viewport per run, the bundled runner has a 60 s cap): cd /workspace/page-access/api && PA_SHOTS_VP=1280|390 node scripts/run-bundled-fixture.mjs scripts/page-access-shots-phase2-r2.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const pwPath = process.env.PW_CORE || "/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/index.js";
const { chromium } = require(pwPath);
const srcDb = process.env.PA_SHOTS_DB || "/workspace/t861/masked.db";
if (fs.realpathSync(srcDb) === "/var/lib/nafisvam/customers.db") throw new Error("refusing live DB");
const uiDist = process.env.PA_SHOTS_UI || "/workspace/page-access/ui/artifacts/crm-dashboard/dist/public";
const shotsDir = process.env.PA_SHOTS_OUT || "/workspace/page-access/shots-t961";
fs.mkdirSync(shotsDir, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-shots-"));
const dbPath = path.join(dir, "crm.db"); fs.copyFileSync(srcDb, dbPath); fs.chmodSync(dbPath, 0o600);
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE|OPENAI|DEEPSEEK|KAVENEGAR|VOIP|ISSABEL/i.test(k)) delete process.env[k];
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "silent", DP_TEST_NO_BELLS: "1", BALE_BOT_WORKER: "0", SAB_FEEDER: "0", SMS_DISABLED: "1",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9", AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-placeholder", SESSION_SECRET: `shots-local-${crypto.randomBytes(8).toString("hex")}-not-real-0123456789abcdef` });
globalThis.fetch0 = globalThis.fetch;
let server, browser;
try {
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const db = await import("/workspace/page-access/api/src/lib/crm-db.ts");
  const auth = await import("/workspace/page-access/api/src/lib/auth.ts");
  const { leadAnnotatorMask } = await import("/workspace/page-access/api/src/lib/lead-annotator-mask.ts");
  const { makeRegistrarWriteGuard } = await import("/workspace/page-access/api/src/lib/registrar-view.ts");
  const { expertLockdownGuard } = await import("/workspace/page-access/api/src/lib/expert-lockdown.ts");
  const { filesCarouselGuard } = await import("/workspace/page-access/api/src/lib/files-carousel.ts");
  const { pageAccessGuard } = await import("/workspace/page-access/api/src/lib/page-access.ts");
  const { default: router } = await import("/workspace/page-access/api/src/routes/index.ts");
  const { default: authRouter } = await import("/workspace/page-access/api/src/routes/auth.ts");
  const { execute } = db;
  for (const [k, v] of [["flag.page_access_v1", "1"], ["flag.expert_lockdown", "1"], ["flag.multi_team_v1", "1"], ["flag.sales_manager_console_v1", "1"], ["flag.sales_admin_merge_v12", "1"]])
    execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const toks = {};
  for (const uid of [1, 7]) {
    const t = crypto.randomBytes(24).toString("base64url"); toks[uid] = t;
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", [crypto.createHmac("sha256", process.env.SESSION_SECRET).update(t).digest("hex"), uid, new Date(Date.now() + 864e5).toISOString(), new Date().toISOString()]);
  }
  const app = express();
  app.use(cookieParser()); app.use(express.json({ limit: "2mb" }));
  app.use("/api/auth", authRouter);
  app.use("/api", auth.requireAuth, leadAnnotatorMask, makeRegistrarWriteGuard(() => db.crmDb), expertLockdownGuard, filesCarouselGuard, pageAccessGuard, router);
  app.use(express.static(uiDist));
  app.use((_req, res) => res.sendFile(path.join(uiDist, "index.html")));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = async (m, p, body, uid = 1) => {
    const r = await globalThis.fetch0(`${baseUrl}/api${p}`, { method: m, headers: { cookie: `crm_session=${toks[uid]}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => null); if (!r.ok) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(j)}`); return j;
  };
  const ver = async (k) => (await api("GET", `/page-access/pages/${k}`)).version;
  // seed (synthetic, local copy only): registrar 7 gets «دفتر کل» view; 3 is blocked on «گزارش مشتریان»; 7 is blocked on «صفحه‌ی لینک‌ها».
  await api("POST", "/page-access/pages/ledger/grants", { subjectKind: "user", userIds: [7], level: "view", baseVersion: await ver("ledger") });
  await api("POST", "/page-access/pages/customer-segments/blocks", { userId: 3, baseVersion: await ver("customer-segments") });
  await api("POST", "/page-access/pages/links/blocks", { userId: 7, baseVersion: await ver("links") });

  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const newPage = async (w, h, url, uid = 1) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w <= 390 ? 2 : 1, locale: "fa-IR", timezoneId: "Asia/Tehran" });
    await ctx.addCookies([{ name: "crm_session", value: toks[uid], url: baseUrl }]);
    const page = await ctx.newPage(); globalThis.__cur = page;
    await page.goto(`${baseUrl}${url}`, { waitUntil: "domcontentloaded" });
    return { ctx, page };
  };
  const shot = async (page, name) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(shotsDir, name) }); console.log("shot", name); };
  const sheet = (page) => page.locator('[data-testid="pa-sheet"]');
  const openSheet = async (page, w) => { await page.locator(w <= 700 ? '[data-testid="pa-icon"]' : '[data-testid="pa-button"]').first().click(); await sheet(page).waitFor(); await page.locator(".pgac-sk").first().waitFor({ state: "detached", timeout: 15000 }).catch(() => {}); };
  const btn = (page, text) => sheet(page).locator(".pgac-ft, .pgac-bd").getByRole("button", { name: text, exact: true });

  const ready = async (page, w) => { await page.locator(w <= 700 ? '[data-testid="pa-icon"]' : '[data-testid="pa-button"]').first().waitFor({ timeout: 30000 }); if (w > 700) await page.locator('[data-testid="pa-chip"]').first().waitFor({ timeout: 15000 }); await page.waitForTimeout(600); };
  const closeDialogs = async (page) => { for (let i = 0; i < 3; i++) { const c = page.locator('[role="dialog"] button[aria-label="بستن"], [role="dialog"] button:has-text("بستن")').first(); if (await c.count()) await c.click().catch(() => {}); await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(300); } };
  const log = []; let picked = null;
  const pickAny = async (page) => { const el = page.locator('[data-testid="pa-pick-28"]'); await el.waitFor(); await el.click(); return "28"; };
  const bd = (page) => sheet(page).locator(".pgac-bd");
  const PFX = process.env.PA_SHOTS_PFX || "after";
  for (const [tag, w, h] of [["1280", 1280, 900], ["390", 390, 844]].filter(([t]) => !process.env.PA_SHOTS_VP || process.env.PA_SHOTS_VP === t)) {
    for (const [uid, nm] of [[31, "trainee-31"], [2, "locked-expert-2"]]) {
      const { ctx, page } = await newPage(w, h, "/sales-admin");
      await ready(page, w); await openSheet(page, w); await sheet(page).locator('[data-testid="pa-section-call-queue-discipline"]').click(); await page.locator('[data-testid="pa-back"]').waitFor(); await page.locator(".pgac-sk").first().waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
      await page.locator('[data-testid="pa-grant"]').waitFor({ timeout: 15000 });
      await page.locator('[data-testid="pa-grant"]').click();
      await page.locator('[data-testid="pa-tile-user"]').click(); await page.locator('[data-testid^="pa-pick-"]').first().waitFor();
      const el = page.locator(`[data-testid="pa-pick-${uid}"]`); await el.waitFor(); await el.click();
      await shot(page, `${PFX}-${tag}-picker-${nm}.png`);
      const n = await sheet(page).locator('[data-testid="pa-next"]').isDisabled();
      console.log(`${PFX} ${tag} ${nm}: next button disabled=${n}`);
      await ctx.close();
    }
  }
} finally { await browser?.close(); server?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
