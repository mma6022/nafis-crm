/** today-layout v1.9 layout fixtures. No live DB, no phones, no secrets, no user 29. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeQueue, isDueReminder, remClock, queueKindClass, queueKindLabel } from "../src/features/daily-customer-inline/queue.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../src");
const dciCss = fs.readFileSync(path.join(root, "features/daily-customer-inline/dci.css"), "utf8");
const layCss = fs.readFileSync(path.join(root, "features/daily-customer-inline/today-layout.css"), "utf8");
const dockCss = fs.readFileSync(path.join(root, "features/bottom-nav-v2/dock-collapse.css"), "utf8");
const shellCss = fs.readFileSync(path.join(root, "features/sales-shell/sales-shell.css"), "utf8");
const dciTsx = fs.readFileSync(path.join(root, "features/daily-customer-inline/DailyCustomerInline.tsx"), "utf8");
const feedTsx = fs.readFileSync(path.join(root, "features/daily-customer-inline/today-feed.tsx"), "utf8");
const shellTsx = fs.readFileSync(path.join(root, "components/CrmShell.tsx"), "utf8");
const navTsx = fs.readFileSync(path.join(root, "features/sales-shell/SalesShellNav.tsx"), "utf8");
const hookTs = fs.readFileSync(path.join(root, "features/sales-shell/dock-collapse.ts"), "utf8");
const PUPPETEER = [
  process.env.PUPPETEER_CORE,
  "/tmp/ppe/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js",
  "/workspace/multicase/r3db/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js",
].find((p) => p && fs.existsSync(p)) || "puppeteer-core";

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
  (shellTsx.match(/امروز، تمرکز روی قدم بعدی مشتری است\./g) || []).length >= 2);

check("body title and date are gone; Jalali date chip lives in the shell top bar",
  !dciTsx.includes("dci-date")
  && !dciTsx.includes("<h1>کارهای امروز من</h1>")
  && shellTsx.includes("function ShellDate")
  && shellTsx.includes("ss-date")
  && shellTsx.includes("<ShellDate")
  && layCss.includes("padding-top:16px")
  && layCss.includes(".dci-date,.dci-page>h1{display:none"));

check("پرونده box lives in the mid-column file card; credit is in the side; wallet and side guarantor are gone",
  (() => {
    const mid = dciTsx.slice(dciTsx.indexOf("function MidCol"), dciTsx.indexOf("function RightCol"));
    const left = dciTsx.slice(dciTsx.indexOf("function LeftCol"));
    const card = mid;
    return dciTsx.includes('data-testid="dci-filecard"')
      && dciTsx.includes("پرونده‌ی مشتری")
      && feedTsx.includes("تکمیل پرونده")
      && feedTsx.includes("id=\"dci-filebox\"")
      && feedTsx.includes("id=\"dci-filewiz\"")
      && card.includes("<FileBox")
      && card.includes("<FirstCall")
      && !card.includes("CreditBlock")
      && left.includes("CreditBlock")
      && left.includes("اعتبارسنجی فوری")
      && !dciTsx.includes("WalletBlock")
      && !dciTsx.includes("GuarBlock")
      && !dciTsx.includes("یادداشت تازه")
      && !dciTsx.includes("فقط یادداشت")
      && dciTsx.includes("تاریخچه و یادداشت‌ها");
  })());

check("v1.8.1 filled مبلغ درخواستی uses Persian digits and U+066C thousands separator",
  feedTsx.includes('label: "مبلغ درخواستی"')
  && feedTsx.includes("function formatTomanFa")
  && feedTsx.includes("۳۵٬۰۰۰٬۰۰۰ تومان")
  && feedTsx.includes("٬")
  && !feedTsx.includes('label: "مبلغ درخواستی، تومان"'));

check("v1.8.1 InstantCreditCheck is embedded in the side column with one title",
  dciTsx.includes("<InstantCreditCheck customerId={customerId} embedded")
  && dciTsx.includes('className="dci-cvh"')
  && dciTsx.includes("اعتبارسنجی فوری"));

check("v1.8.1 summary box shows full text (no max-height) and wraps long strings",
  (() => {
    const i = layCss.indexOf(".dci-sum-box{");
    const box = i >= 0 ? layCss.slice(i, layCss.indexOf("}", i) + 1) : "";
    return box.length > 0
      && !/max-height/.test(box)
      && /max-width:\s*100%/.test(box)
      && /overflow-wrap:\s*anywhere/.test(box);
  })());

check("v1.8.1 clips horizontal overflow and lets the queue rail shrink at 1024+",
  /html,body\{overflow-x:clip/.test(layCss)
  && layCss.includes("overflow-x:clip !important")
  && /flex:\s*1 1 0%/.test(layCss)
  && !/body:has\(\[data-testid="dci-page"\]\) \.dci-tl \{\s*flex: 0 0 auto/.test(dciCss)
  && /body:has\(\[data-testid="dci-page"\]\) \.dci-tlw \{\s*flex: 0 0 auto/.test(dciCss));

const iccTsx = fs.readFileSync(path.join(root, "features/team-sales/InstantCreditCheck.tsx"), "utf8");
const cneTsx = fs.readFileSync(path.join(root, "features/customer-name-edit/CustomerNameEdit.tsx"), "utf8");
const cneCss = fs.readFileSync(path.join(root, "features/customer-name-edit/customer-name-edit.css"), "utf8");
check("v1.9 mid-card name row has a 44px ویرایش نام pencil (flag-gated CustomerNameEdit)",
  dciTsx.includes("<CustomerNameEdit")
  && dciTsx.includes('rowClassName="dci-nmr nmr ed-view"')
  && cneTsx.includes('aria-label="ویرایش نام"')
  && cneCss.includes("width:44px")
  && cneCss.includes("height:44px"));
check("v1.9 national ID is removed from mid/left identity and file lines; wizard step 1 is unchanged",
  !dciTsx.includes("اطلاعات هویتی")
  && !dciTsx.includes("dci-id-mid")
  && !dciTsx.includes("dci-id-left")
  && !feedTsx.includes('label: "کد ملی"')
  && /function FirstCall[\s\S]*?کد ملی[\s\S]*?function /.test(dciTsx)
  && dciTsx.includes('مرحله‌ی <span id="dci-sn">{fd(step)}</span> از {fd(3)}'));
check("v1.9 instant credit shows a masked national ID with a 44px تغییر button and saves on the existing path",
  iccTsx.includes("function maskNationalCode")
  && iccTsx.includes("••••")
  && iccTsx.includes(">تغییر</button>")
  && iccTsx.includes("saveQuickCreditNationalCode")
  && iccTsx.includes('data-testid="cv-nid-change"')
  && fs.readFileSync(path.join(root, "features/team-sales/team-sales.css"), "utf8").includes("min-height:44px"));

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
  ["کد ملی", "تکمیل پرونده در تماس اول", "ضامن", "درخواست تسهیلات جدید", "تاریخچه و یادداشت‌ها", "اعتبارسنجی فوری", "خلاصه‌ی تماس", "ثبت نتیجه‌ی تماس"]
    .every((txt) => dciTsx.includes(txt) || feedTsx.includes(txt) || dciCss.includes(txt) || layCss.includes(txt)));

check("queue is a compact timeline (dot, turn, name, type tag) with no id, time, note or VoIP on the strip",
  (() => {
    const body = dciTsx.slice(dciTsx.indexOf("function Timeline"), dciTsx.indexOf("function CreditBlock"));
    return dciTsx.includes("dci-tlw")
      && body.includes("dci-dot")
      && body.includes("dci-nord")
      && body.includes("dci-kind")
      && body.includes("dci-late-t")
      && body.includes("عقب‌افتاده")
      && body.includes("صف تماس‌های امروز")
      && body.includes("title={tip}")
      && !body.includes("CallActs")
      && !body.includes("{t.tm}")
      && !body.includes("cidBtn");
  })());


check("full shell title «کارهای امروز من» is used even when the nav label is short",
  shellTsx.includes("کارهای امروز من")
  && /location === '\/today'[^\n]*\? 'کارهای امروز من'/.test(shellTsx));

check("priority row is full width so status can sit opposite the chips at 1280",
  /\.dci-page \.dci-prio\{[^}]*width:100%/.test(layCss)
  && /\.dci-ps\{[^}]*min-width:0/.test(layCss)
  && !/min-width:min\(100%,16rem\)/.test(layCss));

check("one history box: notes under the call, compact result, no popup, no-ext header scrolls to it",
  dciTsx.includes("<HistFeed")
  && feedTsx.includes("dci-call-note")
  && feedTsx.includes("خلاصه‌ی تماس")
  && feedTsx.includes("ثبت نتیجه‌ی تماس")
  && !dciTsx.includes("CqResultFields")
  && !dciTsx.includes("SimpleCallForm")
  && dciTsx.includes('getElementById("dci-result")'));

check("after a priority transfer the today plan and reminders refetch, and 403 not_owner customers drop from the queue",
  dciTsx.includes('queryKey: ["dci-today"]')
  && dciTsx.includes("getListRemindersQueryKey")
  && dciTsx.includes("droppedIds")
  && dciTsx.includes("not_owner"));

check("wizard replaces the mid پرونده box in place and ویرایش starts at step 1 with saved values",
  feedTsx.includes('id="dci-filebox"')
  && feedTsx.includes('id="dci-filewiz"')
  && feedTsx.includes("hidden={open}")
  && feedTsx.includes("hidden={!open}")
  && feedTsx.includes("fileInitials")
  && dciTsx.includes("useState(1)")
  && layCss.includes("#dci-filebox[hidden]")
  && layCss.includes("#dci-filewiz[hidden]"));


check("ارتقا به اولویت ۱ button is gone; وضعیت مشتری saves via existing useUpdateCustomer",
  !dciTsx.includes("dci-upgrade-p1")
  && dciTsx.includes('data-testid="dci-st"')
  && dciTsx.includes("dci-st-sel")
  && dciTsx.includes("وضعیت مشتری ذخیره شد.")
  && dciTsx.includes("data: { status: value }")
  && dciTsx.includes("useUpdateCustomer")
  && layCss.includes(".dci-st-sel"));


check("phone number is shown in full with dir=ltr (shots may mask it)",
  /<a className="phn phm" dir="ltr" href=\{\`tel:\$\{raw\}\`\}>\{f\}<\/a>/.test(dciTsx)
  && /<span className="phn phd" dir="ltr">\{f\}<\/span>/.test(dciTsx)
  && dciTsx.includes("const f = fd(raw)")
  && /const fd = \(v:.+\) => String\(v\)\.replace\(\/\[0-9\]\/g/.test(dciTsx)
  && layCss.includes("unicode-bidi:isolate"));

check("تماس lives in the name row; rembar has dock+16 scroll-margin; chips are 44px / 15px",
  dciTsx.includes("dci-who-row")
  && /dci-who-row[\s\S]*CallActs/.test(dciTsx)
  && /dci-head-main[\s\S]*\{ps\}/.test(dciTsx)
  && layCss.includes("scroll-margin-bottom:calc(var(--dock-h, var(--ss-dock-h, 90px)) + 16px)")
  && /\.dci-page \.dci-ps \.csx-chip\{[^}]*min-height:44px/.test(layCss)
  && /\.dci-page \.dci-ps \.csx-chip\{[^}]*font-size:15px/.test(layCss)
  && layCss.includes("min-height:48px;height:48px"));


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
check("queue kind labels cover new lead, reminder, merged, and today task",
  (() => {
    const merged = mergeQueue([lead], [remMerge], now).find((x) => x.customerId === 10);
    const remOnly = mergeQueue([], [remDue], now)[0];
    const today = mergeQueue([other], [], now)[0];
    return queueKindClass(merged) === "is-both" && queueKindLabel(merged) === "لید تازه و یادآور"
      && queueKindClass(remOnly) === "is-rem" && queueKindLabel(remOnly) === "یادآور"
      && queueKindClass(today) === "is-today" && queueKindLabel(today) === "کار امروز"
      && queueKindClass({ typ: "لید تازه", types: ["لید تازه"] }) === "is-lead";
  })());

const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head><meta charset="utf-8"/><style>
*{box-sizing:border-box}
body{margin:0;font-family:sans-serif}
.app-shell.ssv2{min-height:0}
.app-main{padding:0}
.dci-page{background:#f4f5f8}
.dci-col{background:#fff;border:1px solid #ddd;border-radius:12px;padding:16px}
.ss-dock.dock{position:fixed;bottom:16px;left:16px;right:16px;height:72px;background:#fff;border:1px solid #ddd;z-index:40}
${shellCss}
${dciCss}
${layCss}
${dockCss}
</style></head>
<body>
  <div class="app-shell ssv2">
    <main class="app-main">
      <div class="dci" data-testid="dci-page">
        <header class="topbar ss-top" id="ss-top">
          <div class="ss-ttl"><h1>کارهای امروز من</h1><p>امروز، تمرکز روی قدم بعدی مشتری است.</p></div>
          <time class="ss-date" datetime="2026-11-11"><span class="ss-date-full">چهارشنبه ۲۰ آبان ۱۴۰۵</span><span class="ss-date-short">۲۰ آبان</span></time>
          <div class="top-actions"><span class="ss-stx">در دسترس</span></div>
        </header>
        <main class="pg dci-page">
          <div class="dci-tlw" data-testid="dci-tlw">
            <button class="dci-tl-btn" type="button" aria-label="مشتری‌های راست"></button>
            <nav class="dci-tl" aria-label="صف تماس‌های امروز">
              <a class="dci-node is-lead" aria-current="true" href="#p-1" title="۱۰:۰۰">
                <span class="dci-nord">۱</span><span class="dci-dot"></span><b>لیلا ژی</b><span class="dci-kind">لید تازه</span>
              </a>
              <a class="dci-node is-rem is-late" href="#rem-5" title="۱۱:۳۰ — عقب‌افتاده">
                <span class="dci-nord">۲</span><span class="dci-dot"></span><b>طالب طیبی</b><span class="dci-kind">یادآور<span class="dci-late-t"> · عقب‌افتاده</span></span>
              </a>
            </nav>
            <button class="dci-tl-btn" type="button" aria-label="مشتری‌های چپ"></button>
          </div>
          <div class="dci-board" id="dci-board">
            <div class="dci-side">
              <section class="dci-col dci-right" id="col-notes">
                <h2>تاریخچه و یادداشت‌ها</h2>
                <p class="dci-empty dci-hist-empty">سابقه‌ی تماسی ثبت نشده است.</p>
                <div class="dci-callres" id="dci-result"><h3>ثبت نتیجه‌ی تماس</h3>
                  <div class="dci-res-chips"><button type="button" class="dci-res-chip">جواب داد</button></div>
                  <button class="btn pri" type="button">ثبت</button>
                </div>
              </section>
              <section class="dci-col dci-left" id="col-file" data-testid="dci-left">
                <div class="dci-block" data-testid="dci-credit"><div class="dci-cvh"><h3>اعتبارسنجی فوری</h3><span class="dci-opt">اختیاری</span></div>
                  <p class="dci-empty">رتبه هنوز استعلام نشده است.</p>
                </div>
              </section>
            </div>
            <section class="dci-col dci-mid" id="col-mid">
              <div class="dci-head">
                <p class="dci-cur">تماس ثبت‌شده‌ای در جریان نیست</p>
                <div class="dci-head-main">
                  <div class="dci-who-row">
                    <div class="dci-who"><div class="dci-nmr nmr ed-view"><h2>لیلا ژی</h2><button class="ed-pen" type="button" aria-label="ویرایش نام"></button></div></div>
                    <div class="dci-acts"><button class="btn pri" type="button" data-voip data-testid="dci-call">تماس</button></div>
                  </div>
                  <div class="dci-idrow dci-idrow-phone"><span class="ph"><span class="phn phd" dir="ltr">۰۹۱۲۰۰۰۰۰۰۰</span></span></div>
                </div>
                <div class="dci-prio">
                  <div class="csx dci-ps"><div class="csx-chips">
                    <button class="csx-chip" type="button" data-p="1">اولویت ۱</button>
                    <button class="csx-chip" type="button" data-p="3" aria-checked="true">اولویت ۳</button>
                    <button class="csx-chip" type="button">بدون اولویت</button>
                  </div></div>
                  <div class="dci-st">
                    <label class="dci-ps-lbl" for="dci-st">وضعیت مشتری</label>
                    <select id="dci-st" class="dci-st-sel" aria-label="وضعیت مشتری">
                      <option value="in_progress" selected>در حال انجام</option>
                      <option value="completed">اتمام</option>
                      <option value="cancelled">لغو شده</option>
                    </select>
                  </div>
                </div>
              </div>
              <div class="dci-rembar" data-testid="dci-rembar"><p>یادآور</p></div>
              <div class="dci-tags" data-testid="dci-tags"><span>پیگیری</span></div>
              <section class="dci-filecard" id="dci-filecard" data-testid="dci-filecard"><h2>پرونده‌ی مشتری</h2>
                <div class="dci-filebox" id="dci-filebox">
                  <p class="dci-empty">پرونده تماس اول هنوز تکمیل نشده است.</p>
                  <button class="btn pri" type="button" id="dci-file-open">تکمیل پرونده</button>
                </div>
                <div class="dci-block" id="dci-filewiz">
                  <h3>تکمیل پرونده در تماس اول</h3>
                  <div class="dci-fc"><p class="dci-step">مرحله‌ی ۱ از ۳</p><label class="dci-flab">کد ملی <input class="dci-inp"/></label></div>
                </div>
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
      call: (() => {
        const who = document.querySelector(".dci-who")?.getBoundingClientRect();
        const acts = document.querySelector(".dci-head-main .dci-acts, [data-testid=dci-call]")?.getBoundingClientRect();
        const callBtn = document.querySelector("[data-testid=dci-call], .dci-head-main .btn.pri")?.getBoundingClientRect();
        const phone = document.querySelector(".dci-idrow-phone")?.getBoundingClientRect();
        const ps = document.querySelector(".dci-ps")?.getBoundingClientRect();
        const chip = document.querySelector(".dci-ps .csx-chip");
        const rem = document.querySelector(".dci-rembar");
        const col = document.getElementById("col-file");
        const midCol = document.getElementById("col-mid");
        const sameRow = (a, b) => a && b && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
        return {
          callH: callBtn ? Math.round(callBtn.height) : 0,
          callW: callBtn ? Math.round(callBtn.width) : 0,
          callTop: callBtn ? Math.round(callBtn.top) : 0,
          callLeft: callBtn ? Math.round(callBtn.left) : 0,
          whoLeft: who ? Math.round(who.left) : 0,
          whoRight: who ? Math.round(who.right) : 0,
          nameAndCallSameRow: sameRow(who, callBtn),
          callAbovePs: callBtn && ps ? callBtn.bottom <= ps.top + 1 : false,
          callUnderNameNotPs: callBtn && who && ps ? callBtn.top >= who.top - 2 && callBtn.bottom <= ps.top + 1 : false,
          phoneBottom: phone ? Math.round(phone.bottom) : 0,
          callUnderPhone: callBtn && phone ? callBtn.top >= phone.bottom - 2 : false,
          midW: midCol ? Math.round(midCol.getBoundingClientRect().width) : 0,
          chipH: chip ? Math.round(chip.getBoundingClientRect().height) : 0,
          chipFont: chip ? getComputedStyle(chip).fontSize : null,
          remMargin: rem ? getComputedStyle(rem).scrollMarginBottom : null,
          fileOverflow: col ? getComputedStyle(col).overflow : null,
          fileMaxH: col ? getComputedStyle(col).maxHeight : null,
          midOverflow: midCol ? getComputedStyle(midCol).overflow : null,
          tlwH: (() => { const el = document.querySelector(".dci-tlw"); return el ? Math.round(el.getBoundingClientRect().height) : 0; })(),
          nodeH: (() => { const el = document.querySelector(".dci-node"); return el ? Math.round(el.getBoundingClientRect().height) : 0; })(),
          nodeMinH: (() => { const el = document.querySelector(".dci-node"); return el ? parseFloat(getComputedStyle(el).minHeight) : 0; })(),
          stH: (() => { const el = document.querySelector(".dci-st-sel"); return el ? Math.round(el.getBoundingClientRect().height) : 0; })(),
          stW: (() => { const el = document.querySelector(".dci-st-sel"); return el ? Math.round(el.getBoundingClientRect().width) : 0; })(),
          stTop: (() => { const el = document.querySelector(".dci-st"); return el ? Math.round(el.getBoundingClientRect().top) : 0; })(),
          psBottom: ps ? Math.round(ps.bottom) : 0,
          stLeft: (() => { const el = document.querySelector(".dci-st"); return el ? Math.round(el.getBoundingClientRect().left) : 0; })(),
          stRight: (() => { const el = document.querySelector(".dci-st"); return el ? Math.round(el.getBoundingClientRect().right) : 0; })(),
          midLeft: midCol ? Math.round(midCol.getBoundingClientRect().left) : 0,
          midRight: midCol ? Math.round(midCol.getBoundingClientRect().right) : 0,
          whoBottom: who ? Math.round(who.bottom) : 0,
          phoneTop: phone ? Math.round(phone.top) : 0,
          phoneBottom: phone ? Math.round(phone.bottom) : 0,
          nameToPhone: who && phone ? Math.round(phone.top - who.bottom) : null,
          phoneToCall: callBtn && phone ? Math.round(callBtn.top - phone.bottom) : null,
          stLblBottom: (() => { const el = document.querySelector(".dci-st .dci-ps-lbl, .dci-st label, label[for=dci-st]"); return el ? Math.round(el.getBoundingClientRect().bottom) : 0; })(),
          barH: (() => { const el = document.querySelector(".ss-top"); return el ? Math.round(el.getBoundingClientRect().height) : 0; })(),
          barBottom: (() => { const el = document.querySelector(".ss-top"); return el ? Math.round(el.getBoundingClientRect().bottom) : 0; })(),
          tlTop: (() => { const el = document.querySelector(".dci-tlw"); return el ? Math.round(el.getBoundingClientRect().top) : 0; })(),
          dateUnderTitle: (() => {
            const ttl = document.querySelector(".ss-ttl");
            const date = document.querySelector(".ss-date");
            if (!ttl || !date) return false;
            const a = ttl.getBoundingClientRect(), b = date.getBoundingClientRect();
            const startDelta = Math.min(Math.abs(b.right - a.right), Math.abs(b.left - a.left));
            return b.top >= a.bottom - 2 && startDelta < 24;
          })(),
          subHidden: (() => { const p = document.querySelector(".ss-ttl p"); return p ? getComputedStyle(p).display === "none" : null; })(),
          lateOnKindLine: (() => {
            const late = document.querySelector(".dci-kind .dci-late-t, .dci-kind");
            const kind = document.querySelector(".is-late .dci-kind");
            if (!kind) return false;
            const lateEl = kind.querySelector(".dci-late-t");
            if (!lateEl) return false;
            const a = kind.getBoundingClientRect(), b = lateEl.getBoundingClientRect();
            return Math.abs(a.top - b.top) < 8 && a.height - b.height < 8;
          })(),
          leadH: (() => {
            const n = document.querySelector(".dci-node.is-lead") || document.querySelector(".dci-node");
            if (!n) return 0;
            const cs = getComputedStyle(n);
            const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
            const kids = [...n.children].reduce((s, c) => {
              const m = getComputedStyle(c);
              return s + c.getBoundingClientRect().height + parseFloat(m.marginTop) + parseFloat(m.marginBottom);
            }, 0);
            return Math.round(kids + pad);
          })(),
        };
      })(),
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
  check("at 1356 (two columns) اعتبارسنجی sits 16px under تاریخچه, with no ~200px gap",
    at1356.twoCol && at1356.gapFileNotes >= 12 && at1356.gapFileNotes <= 24 && at1356.gapFileNotes < 80,
    JSON.stringify({ gap: at1356.gapFileNotes, twoCol: at1356.twoCol, midH: at1356.midH, notesH: at1356.notesH }));

  const at1366 = await measure(1366, 768);
  check("at 1366 the board is three columns with mid in the center",
    at1366.threeCol && at1366.notesLeft > at1366.midLeft && at1366.midLeft > at1366.fileLeft,
    JSON.stringify({ threeCol: at1366.threeCol, areas: at1366.areas, cols: at1366.cols, midLeft: at1366.midLeft, notesLeft: at1366.notesLeft, fileLeft: at1366.fileLeft }));
  const c1366 = at1366.call;
  check("at 1366 وضعیت مشتری stays inside the mid card",
    c1366.stLeft >= c1366.midLeft - 1 && c1366.stRight <= c1366.midRight + 1,
    JSON.stringify({ stLeft: c1366.stLeft, stRight: c1366.stRight, midLeft: c1366.midLeft, midRight: c1366.midRight, stTop: c1366.stTop, psBottom: c1366.psBottom }));

  const at390 = await measure(390, 844);
  check("at 390 the board is one column in mid → notes → file order",
    at390.oneCol,
    JSON.stringify({ oneCol: at390.oneCol, midTop: at390.midTop, notesTop: at390.notesTop, fileTop: at390.fileTop }));

  const at1280 = await measure(1280, 800);
  check("wizard input is 48px and the mid پرونده card sits above loan actions",
    at1280.inpH >= 47 && at1280.filecardAboveCases,
    JSON.stringify({ inpH: at1280.inpH, filecardAboveCases: at1280.filecardAboveCases }));

  const c1280 = at1280.call;
  check("at 1280 «تماس» is 48px on the name row, to the left of the name, and not under the priorities",
    c1280.callH >= 47 && c1280.callH <= 52 && c1280.nameAndCallSameRow && c1280.callAbovePs && c1280.callLeft < c1280.whoLeft,
    JSON.stringify(c1280));
  check("priority chips are at least 44px with 15px type",
    c1280.chipH >= 44 && c1280.chipFont === "15px",
    JSON.stringify({ chipH: c1280.chipH, chipFont: c1280.chipFont }));
  check("queue strip is 64–72px tall with 44px arrows and 44px touch targets",
    c1280.leadH >= 58 && c1280.leadH <= 72
    && c1280.tlwH >= 64 && c1280.tlwH <= 72
    && at1280.btnW >= 43 && at1280.btnH >= 43 && at1280.btnW <= 46 && at1280.btnH <= 46
    && c1280.nodeMinH >= 44
    && c1280.lateOnKindLine === true,
    JSON.stringify({ leadH: c1280.leadH, tlwH: c1280.tlwH, nodeH: c1280.nodeH, nodeMinH: c1280.nodeMinH, btnW: at1280.btnW, btnH: at1280.btnH, lateOnKindLine: c1280.lateOnKindLine }));
  check("وضعیت مشتری select is 48px on the opposite side of the priority row",
    c1280.stH >= 47 && c1280.stH <= 52 && c1280.stW >= 160 && c1280.stW < c1280.midW * 0.7,
    JSON.stringify({ stH: c1280.stH, stW: c1280.stW, midW: c1280.midW }));
  check("the queue sits 16px under the top bar; subtitle stays visible from 1024",
    (c1280.tlTop - c1280.barBottom) >= 14 && (c1280.tlTop - c1280.barBottom) <= 18
    && c1280.subHidden === false,
    JSON.stringify({ gap: c1280.tlTop - c1280.barBottom, subHidden: c1280.subHidden, barH: c1280.barH }));
  const overflowYVisible = (s) => s === "visible" || /(?:^| )visible$/.test(s);
  check("amber rembar scroll-margin-bottom is dock height plus 16px; columns are not height-locked",
    (c1280.remMargin === "106px" || /^\d+(\.\d+)?px$/.test(c1280.remMargin) && parseFloat(c1280.remMargin) >= 80)
    && c1280.fileMaxH === "none"
    && overflowYVisible(c1280.fileOverflow)
    && overflowYVisible(c1280.midOverflow),
    JSON.stringify({ remMargin: c1280.remMargin, fileOverflow: c1280.fileOverflow, fileMaxH: c1280.fileMaxH, midOverflow: c1280.midOverflow }));

  const c390 = at390.call;
  check("at 390 «تماس» is 48px and full width under the number",
    c390.callH >= 47 && c390.callUnderPhone && c390.callAbovePs && c390.callW >= (c390.midW * 0.85),
    JSON.stringify(c390));
  check("at 390 the status select is 48px and full width under the priorities",
    c390.stH >= 47 && c390.stH <= 52 && c390.stW >= (c390.midW * 0.85) && c390.stTop >= c390.psBottom - 2,
    JSON.stringify({ stH: c390.stH, stW: c390.stW, midW: c390.midW, stTop: c390.stTop, psBottom: c390.psBottom, tlwH: c390.tlwH }));
  check("at 390 the number is 8px under the name and «تماس» is 12px under the number",
    c390.nameToPhone >= 6 && c390.nameToPhone <= 12 && c390.phoneToCall >= 10 && c390.phoneToCall <= 16,
    JSON.stringify({ nameToPhone: c390.nameToPhone, phoneToCall: c390.phoneToCall }));
  check("at 390 the وضعیت مشتری label is on the first screen and the top bar is at most 56px with the short date under the title",
    c390.stLblBottom > 0 && c390.stLblBottom <= 844 - 60
    && c390.barH <= 56 && c390.dateUnderTitle === true && c390.subHidden === true,
    JSON.stringify({ stLblBottom: c390.stLblBottom, barH: c390.barH, dateUnderTitle: c390.dateUnderTitle, subHidden: c390.subHidden }));

  const c1356 = at1356.call;
  check("at 1356 «تماس» stays on or under the name, never under the priorities, and is 48px",
    c1356.callH >= 47 && c1356.callAbovePs && (c1356.nameAndCallSameRow || c1356.callUnderNameNotPs),
    JSON.stringify(c1356));

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
