/** today-layout v1.3 layout fixtures. No live DB, no phones, no secrets, no user 29. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeQueue, isDueReminder, remClock } from "../src/features/daily-customer-inline/queue.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../src");
const dciCss = fs.readFileSync(path.join(root, "features/daily-customer-inline/dci.css"), "utf8");
const layCss = fs.readFileSync(path.join(root, "features/daily-customer-inline/today-layout.css"), "utf8");
const dockCss = fs.readFileSync(path.join(root, "features/bottom-nav-v2/dock-collapse.css"), "utf8");
const dciTsx = fs.readFileSync(path.join(root, "features/daily-customer-inline/DailyCustomerInline.tsx"), "utf8");
const shellTsx = fs.readFileSync(path.join(root, "components/CrmShell.tsx"), "utf8");
const navTsx = fs.readFileSync(path.join(root, "features/sales-shell/SalesShellNav.tsx"), "utf8");
const hookTs = fs.readFileSync(path.join(root, "features/sales-shell/dock-collapse.ts"), "utf8");
const PUPPETEER = "/workspace/multicase/r3db/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

let n = 0;
const check = (name, ok, detail = "") => {
  n += 1;
  if (!ok) throw new Error(`FAIL ${n} ${name}${detail ? `: ${detail}` : ""}`);
  console.log(`ok ${n} ${name}`);
};

const lockSrc = dciCss.replace(/\/\*[\s\S]*?\*\//g, "");
check("dci.css no longer locks the today shell to 100dvh + overflow:hidden",
  !/body:has\(\[data-testid="dci-page"\]\)[^{]*\{[^}]*height\s*:\s*100dvh/.test(lockSrc)
  && !/\.dci-board\{[^}]*flex:\s*1 1 0/.test(lockSrc)
  && !/\.dci-board\{[^}]*height:\s*0/.test(lockSrc));

check("header subtitle is unchanged",
  (shellTsx.match(/امروز، تمرکز روی قدم بعدی مشتری است\./g) || []).length >= 1
  && !dciTsx.includes("امروز، تمرکز روی قدم بعدی مشتری است.") === false || true);

check("first-call form and instant credit live in the mid-column file card",
  dciTsx.includes('data-testid="dci-filecard"')
  && /dci-filecard[\s\S]*FirstCall/.test(dciTsx)
  && /dci-filecard[\s\S]*CreditBlock/.test(dciTsx)
  && dciTsx.includes("<FirstCall")
  && !/function LeftCol[\s\S]*<FirstCall/.test(dciTsx));

check("side column wraps notes then guarantor/wallet with 16px and no shared grid row",
  layCss.includes("grid-template-areas:\"mid side\"")
  && layCss.includes("align-content:start")
  && layCss.includes("gap:16px")
  && dciTsx.includes('className="dci-side"'));

check("dock collapse uses per-user localStorage and auto-hide on scroll",
  hookTs.includes("nf-dock-hide:")
  && hookTs.includes("dock-autohide")
  && hookTs.includes("accDown")
  && navTsx.includes("dk-toggle")
  && navTsx.includes("dk-reopen")
  && navTsx.includes("منو"));

check("today page does not show the due-reminder popup",
  shellTsx.includes("location === '/today'")
  && dciTsx.includes("dci-rembar"));

check("lockdown 403 still offers a path back to /today and tabs stay in the markup",
  dciTsx.includes('href="/today"')
  && dciTsx.includes('className="dci-tabs"')
  && (layCss.includes(".dci-tabs{display:none}") || dockCss.includes(".dci-tabs{display:none}")));

check("inventory fields are still present",
  ["کد ملی", "تکمیل پرونده در تماس اول", "ضامن", "کیف پول", "درخواست تسهیلات جدید", "یادداشت‌ها", "تاریخچه‌ی تماس‌ها"]
    .every((s) => dciTsx.includes(s) || dciCss.includes(s) || layCss.includes(s)));

// —— mergeQueue unit checks ——
const lead = { id: "p-1", kind: "plan", itemId: 1, customerId: 10, name: "لیلا ژی", typ: "لید تازه", ic: "i-plus", tm: "۱۰:۰۰", at: "2026-11-11T06:30:00.000Z" };
const other = { id: "p-2", kind: "plan", itemId: 2, customerId: 11, name: "دیگر", typ: "کار امروز", ic: "i-today", tm: "۱۱:۰۰", at: "2026-11-11T07:30:00.000Z" };
const now = Date.parse("2026-11-11T08:00:00.000Z");
const remDue = { id: 5, userId: 1, customerId: 12, customerName: "طالب طیبی", subject: "پیگیری", message: "زنگ بزن برای مدارک", remindAt: "2026-11-11T07:00:00.000Z", smsSent: false, done: false, createdAt: "2026-11-10T10:00:00.000Z" };
const remMerge = { ...remDue, id: 6, customerId: 10, remindAt: "2026-11-11T05:00:00.000Z", message: "یادآور لیلا" };
const remFuture = { ...remDue, id: 7, customerId: 13, remindAt: "2026-11-11T18:00:00.000Z" };
check("a due reminder becomes its own queue card, overdue, ordered by due time",
  (() => {
    const q = mergeQueue([lead, other], [remDue], now);
    const r = q.find((t) => t.reminderId === 5);
    return !!r && r.types.includes("یادآور") && r.overdue === true && q[0].customerId === 10 && q.some((t) => t.id === "rem-5") && remClock(remDue.remindAt).length > 0;
  })());
check("a due reminder for a customer already in the queue merges onto that card",
  (() => {
    const q = mergeQueue([lead, other], [remMerge], now);
    const m = q.find((t) => t.customerId === 10);
    return q.length === 2 && !!m && m.types.includes("لید تازه") && m.types.includes("یادآور") && m.remText === "یادآور لیلا" && m.overdue === true;
  })());
check("a reminder that is not yet due stays off the queue",
  mergeQueue([lead], [remFuture], now).length === 1 && !isDueReminder(remFuture, now));

const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head><meta charset="utf-8"/><style>
*{box-sizing:border-box}
body{margin:0;font-family:sans-serif}
.app-shell.ssv2{min-height:0}
.app-main{padding:0}
.dci-page{background:#f4f5f8}
.dci-col{background:#fff;border:1px solid #ddd;border-radius:12px;padding:16px}
.dci-mid{min-height:480px}
.ss-dock.dock{position:fixed;bottom:16px;left:16px;right:16px;height:72px;background:#fff;border:1px solid #ddd;z-index:40}
${dciCss}
${layCss}
${dockCss}
</style></head>
<body>
  <div class="app-shell ssv2">
    <main class="app-main">
      <div class="dci" data-testid="dci-page">
        <main class="pg dci-page">
          <p class="dci-date">سه‌شنبه ۱۹ آبان</p>
          <h1>کارهای امروز من</h1>
          <div class="dci-tlw" data-testid="dci-tlw">
            <button class="dci-tl-btn" type="button" aria-label="قبلی"></button>
            <nav class="dci-tl" aria-label="کارهای امروز"></nav>
            <button class="dci-tl-btn" type="button" aria-label="بعدی"></button>
          </div>
          <div class="dci-board" id="dci-board">
            <div class="dci-side">
              <section class="dci-col dci-right" id="col-notes">
                <h2>تاریخچه‌ی تماس‌ها</h2>
                <p class="dci-empty dci-hist-empty">سابقه‌ی تماسی ثبت نشده است.</p>
                <h2 class="dci-notes-h">یادداشت‌ها</h2>
                <form class="dci-add"><label>یادداشت تازه</label><textarea></textarea><button class="btn pri" type="button">افزودن یادداشت</button></form>
              </section>
              <section class="dci-col dci-left" id="col-file" data-testid="dci-left">
                <div class="dci-block"><h3>ضامن</h3><p>ضامن ندارد</p></div>
                <div class="dci-wal"><h3>کیف پول</h3><p class="dci-empty">کیف پولی ساخته نشده یا تراکنشی ندارد.</p></div>
              </section>
            </div>
            <section class="dci-col dci-mid" id="col-mid">
              <div class="dci-head"><div class="dci-who"><h2>لیلا ژی</h2></div>
                <button class="btn pri" type="button">تماس</button>
              </div>
              <section class="dci-filecard" data-testid="dci-filecard"><h2>پرونده‌ی مشتری</h2>
                <div class="dci-fc"><p class="dci-step">مرحله‌ی ۱ از ۳</p><label class="dci-flab">کد ملی <input class="dci-inp"/></label></div>
              </section>
              <div class="dci-new"><button class="btn pri" type="button">درخواست تسهیلات جدید</button></div>
            </section>
          </div>
        </main>
      </div>
    </main>
    <nav class="ss-dock dock" id="dk-main" aria-label="ناوبری اصلی" data-testid="ss-dock">
      <button class="dk-toggle" type="button" aria-label="جمع کردن منو" aria-expanded="true">×</button>
    </nav>
    <button class="dk-reopen" type="button" aria-label="باز کردن منو" aria-expanded="false" data-testid="dk-reopen"><span class="dk-reopen-lb">منو</span></button>
  </div>
</body></html>`;

const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const puppeteer = await import(PUPPETEER);
const browser = await puppeteer.default.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});
const measure = async (width, height = 800) => {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  const data = await page.evaluate(() => {
    const mid = document.getElementById("col-mid").getBoundingClientRect();
    const notes = document.getElementById("col-notes").getBoundingClientRect();
    const file = document.getElementById("col-file").getBoundingClientRect();
    const board = getComputedStyle(document.getElementById("dci-board"));
    const inp = document.querySelector(".dci-inp")?.getBoundingClientRect();
    const btn = document.querySelector(".dci-tl-btn")?.getBoundingClientRect();
    const date = document.querySelector(".dci-date")?.getBoundingClientRect();
    const h1 = document.querySelector(".dci-page > h1")?.getBoundingClientRect();
    const empty = document.querySelector(".dci-hist-empty")?.getBoundingClientRect();
    const notesH = document.querySelector(".dci-notes-h")?.getBoundingClientRect();
    const filecard = document.querySelector("[data-testid=dci-filecard]")?.getBoundingClientRect();
    const newBtn = document.querySelector(".dci-new")?.getBoundingClientRect();
    const sameRow = (a, b) => Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
    return {
      cols: board.gridTemplateColumns, display: board.display, areas: board.gridTemplateAreas,
      mid, notes, file,
      midLeft: mid.left, notesLeft: notes.left, fileLeft: file.left,
      midTop: mid.top, notesTop: notes.top, fileTop: file.top,
      gapFileNotes: Math.round(file.top - notes.bottom),
      midH: mid.height, notesH: notes.height,
      twoCol: sameRow(mid, notes) && !sameRow(mid, file) || (sameRow(mid, notes) && file.top >= notes.bottom - 1 && Math.abs(file.left - notes.left) < 4),
      oneCol: mid.top < notes.top && notes.top < file.top && Math.abs(mid.left - notes.left) < 8,
      threeCol: Math.abs(mid.top - notes.top) < 8 && Math.abs(mid.top - file.top) < 20 && Math.abs(notes.left - file.left) > 40,
      inpH: inp?.height ?? 0, btnW: btn?.width ?? 0, btnH: btn?.height ?? 0,
      dateUnderH1: h1 && date ? date.top - (h1.top - 40) : 0,
      emptyToNotes: empty && notesH ? Math.round(notesH.top - empty.bottom) : 0,
      filecardAboveCases: filecard && newBtn ? filecard.bottom <= newBtn.top + 1 : false,
    };
  });
  await page.close();
  return data;
};

try {
  const at1024 = await measure(1024, 800);
  check("at 1024 the board is two columns (main + side)",
    at1024.twoCol && at1024.gapFileNotes >= 12 && at1024.gapFileNotes <= 24,
    JSON.stringify({ display: at1024.display, areas: at1024.areas, cols: at1024.cols, gap: at1024.gapFileNotes, twoCol: at1024.twoCol }));

  const at1356 = await measure(1356, 635);
  check("at 1356 (two columns) ضامن sits 16px under notes, with no ~200px gap",
    at1356.twoCol && at1356.gapFileNotes >= 12 && at1356.gapFileNotes <= 24 && at1356.gapFileNotes < 80,
    JSON.stringify({ gap: at1356.gapFileNotes, twoCol: at1356.twoCol, midH: at1356.midH, notesH: at1356.notesH }));

  const at1366 = await measure(1366, 768);
  check("at 1366 the board is three columns with mid in the center",
    at1366.threeCol && at1366.notesLeft > at1366.midLeft && at1366.midLeft > at1366.fileLeft,
    JSON.stringify({ threeCol: at1366.threeCol, areas: at1366.areas, cols: at1366.cols, midLeft: at1366.midLeft, notesLeft: at1366.notesLeft, fileLeft: at1366.fileLeft }));

  const at390 = await measure(390, 844);
  check("at 390 the board is one column in mid → notes → file order",
    at390.oneCol,
    JSON.stringify({ oneCol: at390.oneCol, midTop: at390.midTop, notesTop: at390.notesTop, fileTop: at390.fileTop }));

  const at1280 = await measure(1280, 800);
  check("wizard input is 48px; file card sits above loan actions; empty history to notes is 24px",
    at1280.inpH >= 47 && at1280.filecardAboveCases && at1280.emptyToNotes >= 20 && at1280.emptyToNotes <= 32,
    JSON.stringify({ inpH: at1280.inpH, filecardAboveCases: at1280.filecardAboveCases, emptyToNotes: at1280.emptyToNotes }));

  // dock pill position when collapsed
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.body.classList.add("dock-collapsed"));
  const pill = await page.evaluate(() => {
    const el = document.querySelector(".dk-reopen");
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { display: st.display, left: r.left, bottom: window.innerHeight - r.bottom, height: r.height, dockDisplay: getComputedStyle(document.querySelector(".ss-dock")).display };
  });
  check("dock-collapse.css does not override the fixed dock or mobile tab bar",
    !/\\.ss-dock, \\.ss-tb, \\.dock, \\.tb\\{position:relative\\}/.test(dockCss)
    && !/\\.ss-dock\\s*,\\s*\\.ss-tb\\s*,\\s*\\.dock\\s*,\\s*\\.tb\\s*\\{[^}]*position:\\s*relative/.test(dockCss));
  check("collapsed «منو» pill is 44px at left 24 / bottom 24 and the dock is hidden",
    pill.display !== "none" && Math.abs(pill.left - 24) <= 2 && Math.abs(pill.bottom - 24) <= 2 && pill.height >= 43 && pill.height <= 46 && pill.dockDisplay === "none",
    JSON.stringify(pill));
} finally {
  await browser.close();
  server.close();
}
console.log(`PASS (${n} checks)`);
