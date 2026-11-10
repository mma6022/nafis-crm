/**
 * Screenshots of the real CRM (not /multi-case/index.html and not /multi-case-preview).
 *
 *   MC_BASE_URL=http://127.0.0.1:5173 \
 *   MC_USERNAME=... MC_PASSWORD=... \
 *   MC_CUSTOMER_ID=123 \
 *   MC_OUT_DIR=/tmp/mc-shots \
 *   node artifacts/crm-dashboard/scripts/multi-case-shots.mjs
 *
 * Login is the staff form: input-username, input-password, button-submit-login (cookie session).
 * Seed a DB copy first:
 *   node artifacts/api-server/scripts/multi-case-seed.mjs /path/to/customers.copy.db
 * The seed does not rename loan_plans. Point the API at that copy, turn the flag on (the seed does),
 * then pass the printed customer id as MC_CUSTOMER_ID.
 *
 * Optional:
 *   MC_OTHER_USERNAME MC_OTHER_PASSWORD MC_OTHER_CUSTOMER_ID   support / other-owner page
 *   MC_LOCKDOWN_EXPERTS='[{"username","password","ownCustomerId","otherCustomerId","key"}]'
 *     three lockdown experts (users 8 کاظمی, 2 حسنی, 3 قاسمی). Each gets own-customer and other-expert shots.
 *   MC_CHROME=/usr/bin/google-chrome
 *   MC_VIDEO=1   writes flow.webm when this Puppeteer build can record
 *   MC_SEED_MANIFEST=/path/to/customers.copy.db.multi-case-seed.json
 *     fills MC_CUSTOMER_ID from the first seeded expert when MC_CUSTOMER_ID is unset
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const base = (process.env.MC_BASE_URL || "").replace(/\/$/, "");
const user = process.env.MC_USERNAME || "";
const pass = process.env.MC_PASSWORD || "";
const out = process.env.MC_OUT_DIR || "";
if (!base || !user || !pass || !out) {
  console.error("required: MC_BASE_URL, MC_USERNAME, MC_PASSWORD, MC_OUT_DIR");
  process.exit(1);
}
let customerId = process.env.MC_CUSTOMER_ID || "";
if (!customerId && process.env.MC_SEED_MANIFEST) {
  const manifest = JSON.parse(readFileSync(process.env.MC_SEED_MANIFEST, "utf8"));
  customerId = String(manifest.experts?.find((row) => row.customerId)?.customerId || "");
}
if (!customerId) { console.error("required: MC_CUSTOMER_ID or MC_SEED_MANIFEST"); process.exit(1); }

const chrome = process.env.MC_CHROME || "/usr/bin/google-chrome";
mkdirSync(out, { recursive: true });
const puppeteer = await import(process.env.MC_PUPPETEER || "puppeteer-core");
const browser = await puppeteer.default.launch({
  executablePath: chrome, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const log = [];
const note = (msg) => { log.push(msg); console.log(msg); };

async function login(username, password) {
  const cookies = await page.cookies();
  if (cookies.length) await page.deleteCookie(...cookies);
  await page.goto(`${base}/login`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="input-username"]', { timeout: 20000 });
  await page.click('[data-testid="input-username"]', { clickCount: 3 });
  await page.type('[data-testid="input-username"]', username);
  await page.click('[data-testid="input-password"]', { clickCount: 3 });
  await page.type('[data-testid="input-password"]', password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 60000 }).catch(() => {}),
    page.click('[data-testid="button-submit-login"]'),
  ]);
  await page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 20000 });
}

async function shot(name, width) {
  const file = join(out, `${name}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true });
  note(`shot ${file}`);
}

async function at(width) {
  await page.setViewport({ width, height: width === 390 ? 844 : 900, deviceScaleFactor: width === 390 ? 2 : 1 });
}

async function both(name) {
  await at(1280); await shot(name, 1280);
  await at(390); await shot(name, 390);
}

let recorder;
if (process.env.MC_VIDEO === "1" && typeof page.screencast === "function") {
  recorder = await page.screencast({ path: join(out, "flow.webm") });
}

try {
  await login(user, pass);
  await page.goto(`${base}/customers/${customerId}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="customer-detail"]', { timeout: 20000 });
  const html = await page.$eval("html", (el) => ({ lang: el.lang, dir: el.dir }));
  note(`html lang=${html.lang} dir=${html.dir}`);
  await both("01-customer");

  const planText = await page.$$eval("[data-testid^='mc-plan-label-']", (nodes) => nodes.map((n) => n.textContent || ""));
  note(`plan labels from bank_name: ${planText.join(" | ") || "(none)"}`);

  await at(1280);
  const bell = await page.$('[data-testid="button-header-reminder"]');
  if (bell) {
    await bell.click();
    await page.waitForSelector('[data-testid="case-context-picker"]', { timeout: 15000 });
    await both("03-bell-picker");
    await page.click('[data-testid="mc-picker-close"]');
    await page.waitForSelector('[data-testid="case-context-picker"]', { hidden: true, timeout: 10000 }).catch(() => {});
    await at(1280);
    await shot("05-after-close", 1280);
  } else note("header bell not found");

  await page.goto(`${base}/customers/${customerId}`, { waitUntil: "networkidle0" });
  const call = await page.$('[data-testid="link-call-customer"]');
  if (call) {
    await call.click();
    await page.waitForSelector('[data-testid="case-context-picker"][data-mode="call"], [data-testid="case-context-picker"]', { timeout: 10000 }).catch(() => {});
    if (await page.$('[data-testid="case-context-picker"]')) { await both("04-call-picker"); await page.click('[data-testid="mc-picker-back"]'); }
    else note("call control did not open the picker");
  }
  const rem = await page.$('[data-testid="button-case-reminder"]');
  if (rem) {
    await rem.click();
    await page.waitForSelector('[data-testid="case-context-picker"]', { timeout: 10000 });
    await both("04-reminder-picker");
    await page.click('[data-testid="mc-picker-back"]');
    await at(1280);
    await shot("05-after-return", 1280);
  }

  const neu = await page.$('[data-testid="button-new-loan-from-customer"]');
  if (neu) {
    await neu.click();
    await page.waitForSelector('[data-testid="create-loan-application-wizard"]', { timeout: 20000 });
    const step = async () => page.$eval('[data-testid="wizard-stepper"]', (el) => el.getAttribute("aria-valuenow")).catch(() => "");
    for (let i = 0; i < 12; i++) {
      const n = await step();
      if (n === "2") { await both("02-wizard-step-2"); }
      if (n === "5" || await page.$("#mc-plans")) break;
      const next = await page.$('[data-testid="btn-next-1"], [data-testid="btn-next-2"], [data-testid="btn-next-2-0"], [data-testid="btn-next-2-1"]');
      if (!next) break;
      await next.click();
      await new Promise((r) => setTimeout(r, 400));
    }
    const plans = await page.$$("#mc-plans button");
    if (plans[0]) await plans[0].click();
    if (await page.$('[data-testid="same-plan-block"]')) await both("12-wizard-same-plan-blocked");
    else note("scene 12: same-plan box not shown (plan may not be eligible yet)");
    for (let i = 0; i < 16; i++) {
      if (await step() === "10") { await both("02-wizard-step-10"); break; }
      const next = await page.$('[data-testid="btn-next-3-0"]:not([aria-disabled="true"]), [data-testid="btn-next-3"]:not([aria-disabled="true"]), [data-testid="btn-next-4"], [data-testid="btn-next-5-0"]');
      if (!next) break;
      await next.click();
      await new Promise((r) => setTimeout(r, 400));
    }
    await page.keyboard.press("Escape");
  }

  if (process.env.MC_OTHER_USERNAME && process.env.MC_OTHER_PASSWORD) {
    await page.goto(`${base}/login`, { waitUntil: "networkidle0" });
    await login(process.env.MC_OTHER_USERNAME, process.env.MC_OTHER_PASSWORD);
    const otherId = process.env.MC_OTHER_CUSTOMER_ID || customerId;
    await page.goto(`${base}/customers/${otherId}`, { waitUntil: "networkidle0" });
    await both("07-other-owner");
  }

  const experts = process.env.MC_LOCKDOWN_EXPERTS ? JSON.parse(process.env.MC_LOCKDOWN_EXPERTS) : [];
  for (const expert of experts) {
    await login(expert.username, expert.password);
    await page.goto(`${base}/customers/${expert.ownCustomerId}`, { waitUntil: "networkidle0" });
    await both(`08-${expert.key || expert.username}-assigned`);
    await page.goto(`${base}/customers/${expert.otherCustomerId}`, { waitUntil: "networkidle0" });
    await both(`08-${expert.key || expert.username}-other`);
  }
} finally {
  if (recorder) await recorder.stop().catch(() => {});
  await browser.close();
  note(`done ${out}`);
}
