/**
 * t790u: every staff route must be user-scrollable. Unscoped today-layout.css
 * height/overflow unlocks used to disable .app-main scrolling while .app-shell
 * stayed overflow:hidden, so long pages (گزارش عملکرد فروش and others) could
 * not scroll. This fixture checks the CSS stays scoped and then, against the
 * local masked copy, actually scrolls each route as admin and as a locked expert.
 * Never the live DB. No tokens, phones, or national IDs are printed.
 *
 *   node --experimental-strip-types scripts/page-scroll-fixture.mjs
 * Optional: SCROLL_FIXTURE_BASE=http://127.0.0.1:42620  (default: v20 ports file)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EL_ALLOWED_PAGES } from "../src/features/expert-lockdown/guard.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../src");
const layCss = fs.readFileSync(path.join(root, "features/daily-customer-inline/today-layout.css"), "utf8");

let n = 0;
const check = (name, ok, detail = "") => {
  n += 1;
  if (!ok) throw new Error(`FAIL ${n} ${name}${detail ? `: ${detail}` : ""}`);
  console.log(`ok ${n} ${name}`);
};

const unscopedHeight = /^html, body, \.app-shell\.ssv2, \.app-main/m.test(layCss);
const unscopedOverflow = /^\.app-shell\.ssv2, \.app-main, \.dci, \.dci-page/m.test(layCss);
const unscopedHtmlBody = /^html,body\{overflow-x:clip/m.test(layCss)
  || /^html, body\{/.test(layCss);
const scopedUnlock = /html:has\(\[data-testid="dci-page"\]\)/.test(layCss)
  && /html:has\(\[data-testid="dci-page"\]\) \.app-main/.test(layCss)
  && /html:has\(\[data-testid="dci-page"\]\) #root/.test(layCss)
  && layCss.includes("overflow-x:clip !important")
  && /overflow-y:\s*visible !important/.test(layCss);

check("today-layout height/overflow unlocks are scoped to /today",
  scopedUnlock && !unscopedHeight && !unscopedOverflow && !unscopedHtmlBody,
  `scoped=${scopedUnlock} unscopedHeight=${unscopedHeight} unscopedOverflow=${unscopedOverflow} unscopedHtmlBody=${unscopedHtmlBody}`);

const ADMIN_ROUTES = [
  "/sales-performance", "/sales-reports", "/customers", "/calls", "/reminders",
  "/loan-applications", "/consultations", "/payment-orders", "/contracts",
  "/users", "/accounting", "/loan-plans", "/callback-requests", "/daily-plans",
  "/chat", "/my-queue", "/today", "/settings/notifications", "/sales-teams",
  "/mobile-calls", "/goods-purchases", "/wallet-management", "/call-center",
  "/my-performance", "/my-transfers", "/messengers", "/internal-chat",
];
const EXPERT_ROUTES = [
  "/today", "/sales-performance", "/loan-applications", "/payment-orders",
  "/messengers", "/internal-chat", "/customers", "/calls", "/my-performance",
  "/chat", "/reminders",
];
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
];

function readPorts() {
  const envPath = "/workspace/today-layout/run/ports-v20.env";
  const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const ports = Object.fromEntries(
    raw.split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2)),
  );
  return {
    base: process.env.SCROLL_FIXTURE_BASE || (ports.UI_PORT ? `http://127.0.0.1:${ports.UI_PORT}` : ""),
  };
}

function tokenOf(role) {
  const p = `/workspace/today-layout/run/v20/${role}.token`;
  if (!fs.existsSync(p)) throw new Error(`missing local ${role} token`);
  return fs.readFileSync(p, "utf8").trim();
}

const MEASURE = `() => {
  const oy = (el) => el ? getComputedStyle(el).overflowY : "";
  const isUserOy = (v) => v === "auto" || v === "scroll" || v === "overlay";
  const tryMove = (set, get) => {
    const from = get();
    set(from + 500);
    const mid = get();
    set(from);
    return { from, mid, moved: Math.abs(mid - from) >= 1 };
  };
  const shell = document.querySelector(".app-shell");
  const main = document.querySelector("main.app-main, .app-main");
  const root = document.querySelector("#root");
  const win = tryMove((y) => window.scrollTo(0, y), () => window.scrollY || document.documentElement.scrollTop || 0);
  const body = tryMove(
    (y) => { document.documentElement.scrollTop = y; document.body.scrollTop = y; },
    () => document.documentElement.scrollTop || document.body.scrollTop || 0,
  );
  const mainMove = main ? tryMove((y) => { main.scrollTop = y; }, () => main.scrollTop) : { moved: false };
  const shellMove = shell ? tryMove((y) => { shell.scrollTop = y; }, () => shell.scrollTop) : { moved: false };
  const rootMove = root ? tryMove((y) => { root.scrollTop = y; }, () => root.scrollTop) : { moved: false };
  const userMain = !!(main && isUserOy(oy(main)) && mainMove.moved);
  const userShell = !!(shell && isUserOy(oy(shell)) && shellMove.moved);
  const userRoot = !!(root && isUserOy(oy(root)) && rootMove.moved);
  const userWin = !!(win.moved || body.moved);
  const taller = !!(
    (main && main.scrollHeight - main.clientHeight > 2)
    || (shell && shell.scrollHeight - shell.clientHeight > 2)
    || (root && root.scrollHeight - root.clientHeight > 2)
    || (document.documentElement.scrollHeight - window.innerHeight > 2)
  );
  return {
    href: location.pathname,
    hasDci: !!document.querySelector('[data-testid="dci-page"]'),
    hasSsv2: !!(shell && shell.classList.contains("ssv2")),
    mainOY: oy(main),
    shellOY: oy(shell),
    rootOY: oy(root),
    htmlOY: oy(document.documentElement),
    mainSH: main ? main.scrollHeight : 0,
    mainCH: main ? main.clientHeight : 0,
    shellSH: shell ? shell.scrollHeight : 0,
    shellCH: shell ? shell.clientHeight : 0,
    taller,
    canScroll: userWin || userMain || userShell || userRoot,
    via: { win: userWin, main: userMain, shell: userShell, root: userRoot },
  };
}`;

const WITH_SPACER = `() => {
  const main = document.querySelector("main.app-main, .app-main") || document.body;
  const sp = document.createElement("div");
  sp.setAttribute("data-scroll-fixture-spacer", "1");
  sp.style.cssText = "height:2200px;width:100%;flex:none;pointer-events:none";
  main.appendChild(sp);
}`;

const DROP_SPACER = `() => {
  document.querySelectorAll("[data-scroll-fixture-spacer]").forEach((el) => el.remove());
}`;

const DROP_SSV2 = `() => {
  const shell = document.querySelector(".app-shell");
  if (shell) shell.classList.remove("ssv2");
  document.documentElement.classList.remove("ssv2-on");
}`;

async function login(page, base, token) {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.setCookie({
    name: "crm_session",
    value: token,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  });
}

async function measureRoute(page, base, pathName, dropSsv2) {
  await page.goto(`${base}${pathName}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await new Promise((r) => setTimeout(r, 900));
  if (dropSsv2) await page.evaluate(DROP_SSV2);
  await page.evaluate(WITH_SPACER);
  const data = await page.evaluate(MEASURE);
  await page.evaluate(DROP_SPACER);
  return data;
}

async function runBrowser() {
  const { base } = readPorts();
  if (!base) {
    console.log("page-scroll-fixture: no local UI base, static checks only");
    return;
  }
  let up = false;
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(2000) });
    up = r.ok || r.status === 200 || r.status === 304;
  } catch {
    up = false;
  }
  if (!up) {
    console.log("page-scroll-fixture: local UI not up, static checks only");
    return;
  }

  const PUPPETEER = [
    process.env.PUPPETEER_CORE,
    "/tmp/ppe/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js",
    "/workspace/multicase/r3db/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js",
  ].find((p) => p && fs.existsSync(p)) || "puppeteer-core";
  const puppeteer = await import(PUPPETEER);
  const browser = await puppeteer.default.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const failures = [];
  const runRole = async (role, routes, locked) => {
    const token = tokenOf(role === "locked-expert" ? "expert" : role);
    // One viewport pass at 1280 for every route (ssv2 on + off), plus 1366/390 for key pages.
    const plans = [
      { vp: VIEWPORTS[0], routes, modes: [false, true] },
      { vp: VIEWPORTS[1], routes: ["/sales-performance", "/customers", "/loan-applications", "/today"], modes: [false, true] },
      { vp: VIEWPORTS[2], routes: ["/sales-performance", "/customers", "/loan-applications", "/today"], modes: [false, true] },
    ];
    for (const plan of plans) {
      const page = await browser.newPage();
      await page.setViewport({ ...plan.vp, deviceScaleFactor: 1 });
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const method = req.method();
        const url = req.url();
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          req.respond({ status: 200, contentType: "application/json", body: '{"ok":true}' });
          return;
        }
        if (locked && method === "GET" && url.includes("/api/expert-lockdown/me")) {
          req.respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ locked: true, allowedPages: [...EL_ALLOWED_PAGES] }),
          });
          return;
        }
        req.continue();
      });
      await login(page, base, token);
      for (const pathName of plan.routes) {
        for (const dropSsv2 of plan.modes) {
          let data;
          try {
            data = await measureRoute(page, base, pathName, dropSsv2);
          } catch (e) {
            failures.push(`${role} ${pathName} ${plan.vp.width} ssv2Off=${dropSsv2} error=${e.name}`);
            continue;
          }
          const mode = dropSsv2 ? "ssv2-off" : "as-is";
          if (data.taller && !data.canScroll) {
            failures.push(`${role} ${pathName} ${plan.vp.width} ${mode} stuck mainOY=${data.mainOY} shellOY=${data.shellOY} main=${data.mainSH}/${data.mainCH} shell=${data.shellSH}/${data.shellCH}`);
          }
        }
      }
      await page.close();
    }
  };

  try {
    await runRole("admin", ADMIN_ROUTES, false);
    await runRole("locked-expert", EXPERT_ROUTES, true);
  } finally {
    await browser.close();
  }

  check("every tall staff route can be scrolled as admin and as a locked expert",
    failures.length === 0,
    failures.slice(0, 20).join(" | "));
}

await runBrowser();
console.log(`page-scroll-fixture: ok (${n} checks)`);
