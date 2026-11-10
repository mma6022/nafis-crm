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
 *   MC_PUPPETEER=/abs/path/to/puppeteer-core.js
 *     optional. The dashboard lists puppeteer-core as a devDependency, so a normal
 *     install resolves "puppeteer-core". Set MC_PUPPETEER only when that package
 *     is not installed in this app (for example a copy under another node_modules).
 *   MC_VIDEO=1   writes flow.webm when this Puppeteer build can record
 *   MC_HIDE_OVERLAYS=1
 *     script-only. Hides the after-call modal and ReminderMust while shooting.
 *     Product code does not read this flag.
 *   MC_SEED_MANIFEST=/path/to/customers.copy.db.multi-case-seed.json
 *     fills MC_CUSTOMER_ID from the first seeded expert when MC_CUSTOMER_ID is unset.
 *     When the manifest has flow.customerId, the script also opens that synthetic
 *     customer (verified identity, fresh credit, an open plan whose primary contract
 *     is present) and walks #mc-plans, scene 12, scene 13 (disabled plan tile),
 *     a plan condition, review, and the customer page created banner. That walk is
 *     inside the same recording as the rest of the script, so MC_VIDEO=1 includes
 *     it in flow.webm.
 *   Design scene 10 (general in-call, «در حال تماس») is the voip in-call screen.
 *   This script does not open it: there is no product surface for that state apart
 *   from the accepted voip-task-hold gap.
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
let flowCustomerId = process.env.MC_FLOW_CUSTOMER_ID || "";
let openPlanId = process.env.MC_OPEN_PLAN_ID || "";
let freePlanId = process.env.MC_FREE_PLAN_ID || "";
let unreadyPlanId = process.env.MC_UNREADY_PLAN_ID || "17";
if (process.env.MC_SEED_MANIFEST) {
  const manifest = JSON.parse(readFileSync(process.env.MC_SEED_MANIFEST, "utf8"));
  if (!customerId) customerId = String(manifest.experts?.find((row) => row.customerId)?.customerId || "");
  if (!flowCustomerId && manifest.flow?.customerId) flowCustomerId = String(manifest.flow.customerId);
  if (!openPlanId && manifest.flow?.openPlanId) openPlanId = String(manifest.flow.openPlanId);
  if (!freePlanId && manifest.flow?.freePlanId) freePlanId = String(manifest.flow.freePlanId);
  if (!process.env.MC_UNREADY_PLAN_ID && manifest.flow?.unreadyPlanId) unreadyPlanId = String(manifest.flow.unreadyPlanId);
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
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="input-username"]', { timeout: 20000 });
  await page.click('[data-testid="input-username"]', { clickCount: 3 });
  await page.type('[data-testid="input-username"]', username);
  await page.click('[data-testid="input-password"]', { clickCount: 3 });
  await page.type('[data-testid="input-password"]', password);
  await page.click('[data-testid="button-submit-login"]');
  await page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 });
  await dismissPopups();
}

async function openCustomer(id) {
  await page.goto(`${base}/customers/${id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="customer-detail"], [data-testid="mc-hero"], [data-testid="mc-support-view"], [data-testid="mc-other-owner"], [data-testid="el-customer-closed"]', { timeout: 20000 });
  await dismissPopups();
}

async function hideShotOverlays() {
  if (process.env.MC_HIDE_OVERLAYS !== "1") return;
  await page.addStyleTag({ content: '[data-testid="modal-after-call"],[data-testid="rm-overlay"],.rmm-root{display:none!important}' }).catch(() => {});
  await page.evaluate(() => {
    document.querySelector('[data-testid="modal-after-call"]')?.closest(".modal-backdrop")?.remove();
    document.querySelector('[data-testid="rm-overlay"]')?.remove();
    document.querySelectorAll(".rmm-root").forEach((node) => node.remove());
  }).catch(() => {});
}

async function dismissPopups() {
  await hideShotOverlays();
  await page.evaluate(() => {
    document.querySelectorAll('[role="dialog"], [data-testid="due-reminder"]').forEach((node) => {
      if (node.getAttribute("data-testid") === "case-context-picker" || node.closest("[data-testid='case-context-picker']")) return;
      const btn = [...node.querySelectorAll("button")].find((b) => /بستن|انصراف|بعدا/.test(`${b.textContent || ""} ${b.getAttribute("aria-label") || ""}`));
      btn?.click();
    });
  }).catch(() => {});
}

async function clickSel(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.click();
    return true;
  }, selector);
}

async function shot(name, width) {
  const file = join(out, `${name}-${width}.png`);
  await page.screenshot({ path: file, fullPage: false });
  note(`shot ${file}`);
}

async function at(width) {
  await page.setViewport({ width, height: width === 390 ? 844 : 900, deviceScaleFactor: width === 390 ? 2 : 1 });
}

const PLAN_BTN = "#mc-plans button:not([disabled]):not([aria-disabled='true'])";

async function shotDisabledPlan() {
  const exists = await page.$("#mc-plans .mc-plan-off");
  if (!exists) { note("scene 13: disabled plan tile was not in the plan list"); return; }
  let shown = "";
  for (const width of [1280, 390]) {
    await at(width);
    shown = await page.evaluate((prefer) => {
      const tiles = [...document.querySelectorAll("#mc-plans .mc-plan-off")];
      const tile = tiles.find((el) => el.getAttribute("data-plan-id") === prefer) || tiles[tiles.length - 1];
      if (!(tile instanceof HTMLElement)) return "";
      tile.scrollIntoView({ block: "center", inline: "nearest" });
      return tile.getAttribute("data-plan-id") || "";
    }, unreadyPlanId);
    await shot("13-wizard-plan-disabled", width);
  }
  if (shown && shown !== unreadyPlanId) note(`scene 13: showed plan ${shown}; plan ${unreadyPlanId} was not in the list`);
}

async function both(name, scrollCases) {
  for (const width of [1280, 390]) {
    await at(width);
    await shot(name, width);
    if (!scrollCases) continue;
    await page.evaluate(() => document.querySelector("[data-testid='mc-cases']")?.scrollIntoView({ block: "start" }));
    await shot(`${name}-cases`, width);
  }
}

let recorder;
if (process.env.MC_VIDEO === "1" && typeof page.screencast === "function") {
  recorder = await page.screencast({ path: join(out, "flow.webm") });
}

try {
  await login(user, pass);
  await openCustomer(customerId);
  const html = await page.$eval("html", (el) => ({ lang: el.lang, dir: el.dir }));
  note(`html lang=${html.lang} dir=${html.dir}`);
  await both("01-customer", true);

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

  await openCustomer(customerId);
  if (await clickSel('[data-testid="link-call-customer"]')) {
    await page.waitForSelector('[data-testid="case-context-picker"]', { timeout: 10000 }).catch(() => {});
    if (await page.$('[data-testid="case-context-picker"]')) { await both("04-call-picker"); await clickSel('[data-testid="mc-picker-close"]'); }
    else note("call control did not open the picker");
  }
  if (await clickSel('[data-testid="button-header-reminder"]')) {
    await page.waitForSelector('[data-testid="case-context-picker"]', { timeout: 10000 }).catch(() => {});
    if (await page.$('[data-testid="case-context-picker"]')) {
      await both("04-reminder-picker");
      await clickSel('[data-testid="mc-picker-close"]');
      await at(1280);
      await shot("05-after-return", 1280);
    }
  }

  if (await clickSel('[data-testid="button-new-loan-from-customer"]')) {
    await page.waitForSelector('[data-testid="create-loan-application-wizard"]', { timeout: 20000 });
    if (await page.$('[data-testid="mc-second-start"]')) {
      await both("03-second-case-start");
      await clickSel('[data-testid="mc-second-start-continue"]');
      await new Promise((r) => setTimeout(r, 400));
    }
    const step = async () => page.$eval('[role="progressbar"]', (el) => el.getAttribute("aria-valuenow")).catch(() => "");
    const advance = async () => clickSel('[data-testid="btn-next-1"], [data-testid="btn-save-profile"], [data-testid="btn-next-2"], [data-testid="btn-next-2-0"], [data-testid="btn-next-2-1"], [data-testid="btn-next-2-2"]');
    for (let i = 0; i < 14; i++) {
      const n = await step();
      if (n === "2") await both("02-wizard-step-2");
      if (n === "5" || await page.$("#mc-plans")) break;
      if (!(await advance())) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const plansReady = await page.waitForSelector(PLAN_BTN, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!plansReady) note("scene 12: wizard did not reach a selectable plan list");
    else {
      await shotDisabledPlan();
      const opened = await page.$$eval(PLAN_BTN, (nodes) => nodes.map((n) => n.getAttribute("data-plan-id"))).catch(() => []);
      const order = openPlanId && opened.includes(openPlanId) ? [openPlanId, ...opened.filter((id) => id !== openPlanId)] : opened;
      for (const id of order) {
        await clickSel(`#mc-plans [data-plan-id="${id}"]`);
        const shown = await page.waitForSelector('[data-testid="same-plan-block"]', { timeout: 2500 }).then(() => true).catch(() => false);
        if (shown) break;
      }
      if (await page.$('[data-testid="same-plan-block"]')) await both("12-wizard-same-plan-blocked");
      else note("scene 12: same-plan box not shown (no selectable plan already has an open case)");
    }
    await page.keyboard.press("Escape");
  } else note("new-case button not found");

  if (flowCustomerId) {
    await openCustomer(flowCustomerId);
    if (await clickSel('[data-testid="button-new-loan-from-customer"]')) {
      await page.waitForSelector('[data-testid="create-loan-application-wizard"]', { timeout: 20000 });
      if (await page.$('[data-testid="mc-second-start"]')) {
        await both("03-flow-second-case-start");
        await clickSel('[data-testid="mc-second-start-continue"]');
      }
      const step = async () => page.$eval('[role="progressbar"]', (el) => el.getAttribute("aria-valuenow")).catch(() => "");
      const early = async () => clickSel('[data-testid="btn-next-1"], [data-testid="btn-save-profile"], [data-testid="btn-next-2"], [data-testid="btn-next-2-0"], [data-testid="btn-next-2-1"], [data-testid="btn-next-2-2"]');
      for (let i = 0; i < 16 && !(await page.$("#mc-plans")); i++) {
        if ((await step()) === "2") await both("02-flow-wizard-step-2");
        if (!(await early())) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (await page.$("#mc-plans")) {
        await both("02-wizard-plans");
        await shotDisabledPlan();
        const ids = await page.$$eval(PLAN_BTN, (nodes) => nodes.map((node) => node.getAttribute("data-plan-id"))).catch(() => []);
        const prefer = openPlanId && ids.includes(openPlanId) ? [openPlanId, ...ids.filter((id) => id !== openPlanId)] : ids;
        let blockedId = "";
        for (const id of prefer) {
          await clickSel(`#mc-plans [data-plan-id="${id}"]`);
          const shown = await page.waitForSelector('[data-testid="same-plan-block"]', { timeout: 2500 }).then(() => true).catch(() => false);
          if (shown) { blockedId = id; break; }
        }
        if (blockedId) await both("12-wizard-same-plan-blocked");
        else note("scene 12: open plan tile was not selectable (primary contract missing)");
        await clickSel('[data-testid="button-choose-other-plan"]');
        const freeId = freePlanId && ids.includes(freePlanId) && freePlanId !== blockedId
          ? freePlanId
          : ids.find((id) => id && id !== blockedId);
        if (freeId) {
          await clickSel(`#mc-plans [data-plan-id="${freeId}"]`);
          await new Promise((r) => setTimeout(r, 300));
          await clickSel('[data-testid^="condition-"]:not([disabled])');
          await new Promise((r) => setTimeout(r, 300));
          await clickSel('[data-testid="btn-next-3-0"]');
          await new Promise((r) => setTimeout(r, 400));
          await page.evaluate(() => {
            const amount = document.querySelector('[data-testid="input-amount"]');
            if (amount instanceof HTMLInputElement) {
              const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              set?.call(amount, "10000000");
              amount.dispatchEvent(new Event("input", { bubbles: true }));
            }
            const duration = document.querySelector('[data-testid^="duration-"]');
            if (duration instanceof HTMLElement) duration.click();
          }).catch(() => {});
          await clickSel('[data-testid="btn-next-3"]');
        }
      } else note("flow wizard: #mc-plans was not reached");
      for (let i = 0; i < 12 && !(await page.$('[data-testid="mc-review"]')); i++) {
        if (await page.$('[data-testid="btn-pay-filing-fee"]')) {
          await clickSel('[data-testid="btn-pay-filing-fee"]');
          await page.waitForSelector('[data-testid="btn-next-fee"]', { timeout: 20000 }).catch(() => note("flow wizard: filing fee did not complete"));
        }
        await page.evaluate(() => {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          document.querySelectorAll('[data-testid^="contract-variable-"]').forEach((node) => {
            if (!(node instanceof HTMLInputElement) || !set) return;
            set.call(node, "آزمایش");
            node.dispatchEvent(new Event("input", { bubbles: true }));
          });
        }).catch(() => {});
        const moved = await clickSel('[data-testid="btn-next-fee"], [data-testid="btn-next-4"], [data-testid="btn-next-5-0"], [data-testid="btn-next-3"]');
        if (!moved) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (await page.$('[data-testid="mc-review"]')) {
        await both("05-wizard-review");
        if (await clickSel('[data-testid="btn-submit-wizard"]')) {
          await page.waitForSelector('[data-testid="mc-created-banner"]', { timeout: 30000 }).catch(async () => {
            const err = await page.$eval('[role="alert"], .form-error', (el) => (el.textContent || "").trim()).catch(() => "");
            note(`flow wizard: created banner did not appear on the customer page${err ? ` (${err})` : ""}`);
          });
          if (await page.$('[data-testid="mc-created-banner"]')) await both("06-second-case-created");
        }
      } else note(`flow wizard stopped at step ${await step()}`);
      await page.keyboard.press("Escape");
    } else note("flow customer: new-case button not found");
  }

  if (process.env.MC_OTHER_USERNAME && process.env.MC_OTHER_PASSWORD) {
    await login(process.env.MC_OTHER_USERNAME, process.env.MC_OTHER_PASSWORD);
    await openCustomer(process.env.MC_OTHER_CUSTOMER_ID || customerId);
    await both("07-other-owner");
  }

  const experts = process.env.MC_LOCKDOWN_EXPERTS ? JSON.parse(process.env.MC_LOCKDOWN_EXPERTS) : [];
  for (const expert of experts) {
    await login(expert.username, expert.password);
    await openCustomer(expert.ownCustomerId);
    await both(`08-${expert.key || expert.username}-assigned`, true);
    await openCustomer(expert.otherCustomerId);
    await both(`08-${expert.key || expert.username}-other`);
  }
} finally {
  if (recorder) await recorder.stop().catch(() => {});
  await browser.close();
  note(`done ${out}`);
}
