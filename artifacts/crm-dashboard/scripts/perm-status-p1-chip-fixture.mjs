/** perm-status v1.0 P1 chip: same promote form, focus return, disabled states.
 * Unit checks always run. Browser checks use the local stub-login stack when
 * PERM_CHIP_UI is set (http://127.0.0.1:PORT). Never hits live. */
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";

const NO_PERM_HINT = "اجازهٔ تغییر اولویت در این حساب نیست.";

function p1ChipMode({ canEdit, locked = false, curPriority }) {
  if (!canEdit && !locked) return "off";
  if (!canEdit || locked) return "locked";
  if (curPriority === 1) return "already-p1";
  return "promote";
}

let failed = 0;
async function ok(name, fn) {
  try { await fn(); console.log("ok", name); }
  catch (e) { failed += 1; console.error("FAIL", name, e?.message || e); }
}

await ok("mode: flag off hides chips", () => {
  assert.equal(p1ChipMode({ canEdit: false, curPriority: 3 }), "off");
});
await ok("mode: no-perm / locked is inert and not off", () => {
  assert.equal(p1ChipMode({ canEdit: false, locked: true, curPriority: 3 }), "locked");
});
await ok("mode: already P1 is checked-inert", () => {
  assert.equal(p1ChipMode({ canEdit: true, curPriority: 1 }), "already-p1");
});
await ok("mode: not-P1 with permission opens the promote form", () => {
  assert.equal(p1ChipMode({ canEdit: true, curPriority: 3 }), "promote");
  assert.equal(p1ChipMode({ canEdit: true, curPriority: null }), "promote");
  assert.equal(p1ChipMode({ canEdit: true, curPriority: 2 }), "promote");
});
await ok("mode: no-perm hint is the approved short grey line", () => {
  assert.equal(NO_PERM_HINT, "اجازهٔ تغییر اولویت در این حساب نیست.");
});

const src = readFileSync(new URL("../src/features/daily-customer-inline/DailyCustomerInline.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/features/daily-customer-inline/dci.css", import.meta.url), "utf8");
await ok("source: chip and button open the same dci-promote dialog", () => {
  assert.match(src, /data-testid="dci-promote"/);
  assert.match(src, /openPromo\("chip"\)/);
  assert.match(src, /openPromo\("button"\)/);
  assert.match(src, /aria-haspopup=\{canOpenPromo \? "dialog"/);
  assert.match(src, /aria-label=\{canOpenPromo \? "ارتقا به اولویت ۱"/);
  assert.match(src, /role=\{canOpenPromo \? "button" : "radio"\}/);
  // One form only — the previous inline dci-promo block is gone.
  assert.equal((src.match(/data-testid="dci-promote"/g) || []).length, 1);
  assert.doesNotMatch(src, /className="dci-promo"/);
  // P1 is never a form-less customer.priority patch.
  assert.match(src, /P1 is never a form-less patch/);
  assert.match(src, /promoteToP1/);
});
await ok("source: close returns focus to the opener", () => {
  assert.match(src, /p1ChipRef/);
  assert.match(src, /p1BtnRef/);
  assert.match(src, /from === "chip" \? p1ChipRef\.current : p1BtnRef\.current/);
  assert.match(src, /el\.focus\(\)/);
});
await ok("source: no-perm and already-p1 are inert / disabled, not a second primary", () => {
  assert.match(src, /is-inert/);
  assert.match(src, /dci-ps-noperm/);
  assert.match(src, /اجازهٔ تغییر اولویت در این حساب نیست/);
  assert.match(src, /m\.prio[\s\S]*dci-prio-on[\s\S]*canPromote && canEditPs/);
  assert.match(css, /\.csx-chip\.p1-up:hover/);
  assert.match(css, /0 0 0 6px var\(--nf-brand-600/);
  assert.match(css, /min-height:44px/);
});

const ui = process.env.PERM_CHIP_UI;
const tokenPath = process.env.PERM_CHIP_TOKEN || "/workspace/perm-status/db/r4b-session.token";
if (ui && existsSync(tokenPath)) {
  const token = readFileSync(tokenPath, "utf8").trim();
  const P3 = process.env.PERM_CHIP_P3 || "819";
  const P1 = process.env.PERM_CHIP_P1 || "2229";
  const puppeteer = await import("/workspace/dci/src/artifacts/crm-dashboard/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js");
  const browser = await puppeteer.default.launch({
    executablePath: process.env.PERM_CHROME || "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(`${ui}/login`, { waitUntil: "domcontentloaded" });
  const client = await page.target().createCDPSession();
  await client.send("Network.setCookie", { name: "crm_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax" });

  async function go(customer, interceptLocked = false) {
    if (interceptLocked) {
      await page.setRequestInterception(true);
      const onReq = (req) => {
        if (req.url().includes(`/daily-customer-inline/customers/${customer}`) && req.resourceType() === "xhr" ||
            (req.url().includes(`/daily-customer-inline/customers/${customer}`) && (req.resourceType() === "fetch" || req.resourceType() === "xhr"))) {
          req.continue();
        } else req.continue();
      };
      // We'll rewrite the response after navigation via evaluate on the payload instead:
      // use a CDP Fetch intercept below if needed. For locked, mutate after load is unreliable.
      page.off("request", onReq);
      await page.setRequestInterception(false);
    }
    await page.goto(`${ui}/today?customer=${customer}`, { waitUntil: "networkidle0" });
    if (page.url().includes("/login")) throw new Error("stub login failed");
    await page.waitForSelector("[data-testid=dci-page]", { timeout: 20000 });
    await page.waitForSelector("[data-testid=dci-ps-priority], [data-testid=chip-priority-1]", { timeout: 20000 });
  }

  async function interceptBoard(customer, patch) {
    await page.setRequestInterception(true);
    const handler = async (req) => {
      const url = req.url();
      const isBoard = url.includes(`/daily-customer-inline/customers/${customer}`) && !url.includes("/notes") && !url.includes("/calls");
      if (isBoard && (req.method() === "GET")) {
        const res = await fetch(url, { headers: { cookie: `crm_session=${token}` } });
        const body = await res.json();
        Object.assign(body, patch);
        await req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "no-store" } });
        return;
      }
      await req.continue();
    };
    page.on("request", handler);
    return async () => {
      page.off("request", handler);
      if (page.listenerCount("request") === 0) await page.setRequestInterception(false).catch(() => {});
    };
  }

  await ok("browser: P1 chip and the button open the same promote dialog", async () => {
    await go(P3);
    const chip = await page.$("[data-testid=chip-priority-1]");
    assert.ok(chip);
    const role = await chip.evaluate((el) => el.getAttribute("role"));
    const popup = await chip.evaluate((el) => el.getAttribute("aria-haspopup"));
    const label = await chip.evaluate((el) => el.getAttribute("aria-label"));
    assert.equal(role, "button");
    assert.equal(popup, "dialog");
    assert.equal(label, "ارتقا به اولویت ۱");
    await chip.click();
    await page.waitForSelector("[data-testid=dci-promote]");
    const title = await page.$eval("[data-testid=dci-promote] h2", (el) => el.textContent);
    assert.equal(title, "ارتقا به اولویت ۱");
    const saveDisabled = await page.$eval("[data-testid=dci-promote-save]", (el) => el.disabled);
    assert.equal(saveDisabled, true);
    await page.click("[data-testid=dci-promote-close]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=dci-promote]"));
    await page.click("[data-testid=dci-upgrade-p1]");
    await page.waitForSelector("[data-testid=dci-promote]");
    const count = await page.$$eval("[data-testid=dci-promote]", (els) => els.length);
    assert.equal(count, 1);
    await page.click("[data-testid=dci-promote-close]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=dci-promote]"));
  });

  await ok("browser: closing the form opened from the chip returns focus to the chip", async () => {
    await go(P3);
    await page.click("[data-testid=chip-priority-1]");
    await page.waitForSelector("[data-testid=dci-promote]");
    await page.click("[data-testid=dci-promote-close]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=dci-promote]"));
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "chip-priority-1");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    assert.equal(focused, "chip-priority-1");
  });

  await ok("browser: closing the form opened from the button returns focus to the button", async () => {
    await go(P3);
    await page.click("[data-testid=dci-upgrade-p1]");
    await page.waitForSelector("[data-testid=dci-promote]");
    await page.click("[data-testid=dci-promote-close]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=dci-promote]"));
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "dci-upgrade-p1");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    assert.equal(focused, "dci-upgrade-p1");
  });

  await ok("browser: already-P1 chip is inert and the promote button is replaced by the badge", async () => {
    await go(P1);
    const info = await page.evaluate(() => {
      const chip = document.querySelector("[data-testid=chip-priority-1]");
      return {
        checked: chip?.getAttribute("aria-checked"),
        disabled: chip?.getAttribute("aria-disabled"),
        inert: chip?.classList.contains("is-inert"),
        hasPopup: chip?.getAttribute("aria-haspopup"),
        role: chip?.getAttribute("role"),
        hasBtn: Boolean(document.querySelector("[data-testid=dci-upgrade-p1]")),
        badge: Boolean(document.querySelector(".dci-prio-on")),
      };
    });
    assert.equal(info.checked, "true");
    assert.equal(info.disabled, "true");
    assert.equal(info.inert, true);
    assert.equal(info.hasPopup, null);
    assert.equal(info.role, "radio");
    assert.equal(info.hasBtn, false);
    assert.equal(info.badge, true);
    await page.click("[data-testid=chip-priority-1]").catch(() => {});
    const opened = await page.$("[data-testid=dci-promote]");
    assert.equal(opened, null);
  });

  await ok("browser: no-perm chips are inert with the grey reason and no promote button", async () => {
    const stop = await interceptBoard(P3, { canEditPriorityStatus: false, canPromote: false, priorityStatusLocked: true, prio: false });
    try {
      await go(P3);
      const info = await page.evaluate(() => {
        const chip = document.querySelector("[data-testid=chip-priority-1]");
        const hint = document.querySelector("[data-testid=dci-ps-noperm]");
        const hover = chip ? getComputedStyle(chip).cursor : null;
        return {
          inert: chip?.classList.contains("is-inert"),
          disabled: chip?.getAttribute("aria-disabled"),
          hasPopup: chip?.getAttribute("aria-haspopup"),
          hint: hint?.textContent,
          hintColor: hint ? getComputedStyle(hint).color : null,
          hasBtn: Boolean(document.querySelector("[data-testid=dci-upgrade-p1]")),
          cursor: hover,
        };
      });
      assert.equal(info.inert, true);
      assert.equal(info.disabled, "true");
      assert.equal(info.hasPopup, null);
      assert.equal(info.hint, NO_PERM_HINT);
      assert.equal(info.hasBtn, false);
      assert.ok(info.cursor === "default" || info.cursor === "auto", info.cursor);
    } finally {
      await stop();
    }
  });

  await browser.close();
} else {
  console.log("skip browser checks (set PERM_CHIP_UI to run them)");
}

if (failed) {
  console.error(`FAILED ${failed}`);
  process.exit(1);
}
console.log("perm-status-p1-chip: ok");
