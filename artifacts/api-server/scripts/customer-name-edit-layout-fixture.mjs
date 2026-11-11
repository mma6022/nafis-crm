/** Layout polish checks for customer-name-edit (Armita review of 63eb526).
 *  1) Desktop: «ذخیره» / «انصراف» on the same row as the fields, after «نام خانوادگی».
 *  2) Pencil hit area is at least 44×44 (icon stays 20px).
 *  3) Mobile sheet padding-bottom is 24px + safe-area inset.
 *  No live DB, no phones, no secrets. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(here, "../../crm-dashboard/src/features/customer-name-edit/customer-name-edit.css");
const jsxPath = path.resolve(here, "../../crm-dashboard/src/features/customer-name-edit/CustomerNameEdit.tsx");
const PUPPETEER = "/workspace/multicase/r3db/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const CHROME = "/usr/bin/google-chrome";

const css = fs.readFileSync(cssPath, "utf8");
const jsx = fs.readFileSync(jsxPath, "utf8");
let n = 0;
const check = (name, ok, detail = "") => {
  n += 1;
  if (!ok) throw new Error(`FAIL ${n} ${name}${detail ? `: ${detail}` : ""}`);
  console.log(`ok ${n} ${name}`);
};

// --- source CSS / JSX ---
check("pencil 44px in CSS",
  /\.ed-pen\s*\{[^}]*\bwidth\s*:\s*44px\b/.test(css)
  && /\.ed-pen\s*\{[^}]*\bheight\s*:\s*44px\b/.test(css)
  && /\.ed-pen\s*\{[^}]*\bmin-width\s*:\s*44px\b/.test(css)
  && /\.ed-pen\s*\{[^}]*\bmin-height\s*:\s*44px\b/.test(css)
  && /\.ed-pen \.i\s*\{[^}]*\bwidth\s*:\s*20px\b/.test(css));

check("sheet bottom padding is 24px + safe-area",
  /\.ed-sheet\s*\{[^}]*padding:[^;]*calc\(\s*24px\s*\+\s*env\(\s*safe-area-inset-bottom/.test(css)
  && !/\.ed-sheet\s*\{[^}]*calc\(\s*16px\s*\+\s*env\(\s*safe-area-inset-bottom/.test(css));

check("desktop acts sit in the field row in JSX",
  /<div className="ed-row">[\s\S]*نام خانوادگی[\s\S]*!mobile \? <div className="ed-acts">/.test(jsx)
  && /\{mobile \? <div className="ed-acts">/.test(jsx));

check("desktop CSS gives fields a 180px minimum and lets the actions wrap",
  css.includes(".ed-form.ed-desk .ed-row")
  && css.includes("flex-wrap:wrap")
  && css.includes("min-width:180px")
  && css.includes(".ed-form.ed-desk .ed-acts")
  && css.includes(".fdv1 .fhd-r1:has(.ed-form.ed-desk)")
  && css.includes("display:contents"));

// --- measured layout in a headless page ---
const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"/>
<style>
*,*::before,*::after{box-sizing:border-box}
.fdv1 button{cursor:pointer;border:0;background:none;padding:0}
.btn{min-height:48px;padding:0 16px;border-radius:14px;border:1px solid #ccc;font:inherit}
.btn.sm{padding:0 12px;white-space:nowrap}
.fdv1 .fhd{padding:16px 20px 14px;width:640px;border:1px solid #ddd}
.fdv1 .fhd-r1{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.fdv1 .fhd .who{flex:1;min-width:240px}
.fdv1 .fhd-act{display:flex;gap:8px;align-items:center}
.fdv1 .ph.big{display:flex;font-size:24px;gap:8px;margin-top:8px}
${css}
body{margin:0;font-family:sans-serif}
</style>
</head>
<body>
  <div class="fdv1" id="desk-host">
    <div class="nmr ed-view">
      <h2>سمیره نادری</h2>
      <button class="ed-pen" type="button" aria-label="ویرایش نام" data-testid="cne-pen">
        <svg class="i" width="20" height="20" viewBox="0 0 24 24"></svg>
      </button>
    </div>
    <div class="ed-form ed-desk">
      <div class="ed-row">
        <div class="ed-f"><label>نام</label><input autocomplete="given-name" value="سمیره"/></div>
        <div class="ed-f"><label>نام خانوادگی</label><input autocomplete="family-name" value="نادری"/></div>
        <div class="ed-acts">
          <button class="btn pri" type="button">ذخیره</button>
          <button class="btn gh" type="button">انصراف</button>
        </div>
      </div>
    </div>
    <div class="ed-form ed-desk" id="invalid-form">
      <div class="ed-row">
        <div class="ed-f"><label>نام</label><input autocomplete="given-name" value="سمیره"/></div>
        <div class="ed-f"><label>نام خانوادگی</label><input autocomplete="family-name" value="Naderi" aria-invalid="true"/><div class="ed-err">فقط حروف فارسی وارد کنید.</div></div>
        <div class="ed-acts">
          <button class="btn pri" type="button">ذخیره</button>
          <button class="btn gh" type="button">انصراف</button>
        </div>
      </div>
    </div>
  </div>
  <div class="fdv1" style="margin-top:40px">
  <section class="card fhd" id="header-host" aria-label="سربرگ پرونده">
    <div class="fhd-r1">
      <div class="who">
        <span class="eyb">پرونده‌ی تسهیلات ۹۲۰۰۰۱، مالی / ملی</span>
        <div class="ed-form ed-desk" id="header-form">
          <div class="ed-row">
            <div class="ed-f"><label>نام</label><input autocomplete="given-name" value="سمیره"/></div>
            <div class="ed-f"><label>نام خانوادگی</label><input autocomplete="family-name" value="نادری"/></div>
            <div class="ed-acts">
              <button class="btn pri" type="button">ذخیره</button>
              <button class="btn gh" type="button">انصراف</button>
            </div>
          </div>
        </div>
        <span class="ph big">۰۹۱۲***۰۰۲۱</span>
      </div>
      <div class="fhd-act">
        <a class="btn gh sm">پرونده‌ی مشتری</a>
        <a class="btn gh sm">ثبت تماس این پرونده</a>
      </div>
    </div>
  </section>
  </div>
  <div id="narrow-host" style="width:420px;max-width:420px;margin-top:40px">
    <div class="ed-form ed-desk" id="narrow-form">
      <div class="ed-row">
        <div class="ed-f"><label>نام</label><input autocomplete="given-name" value="سمیره"/></div>
        <div class="ed-f"><label>نام خانوادگی</label><input autocomplete="family-name" value="نادری"/></div>
        <div class="ed-acts">
          <button class="btn pri" type="button">ذخیره</button>
          <button class="btn gh" type="button">انصراف</button>
        </div>
      </div>
    </div>
  </div>
  <button type="button" class="ed-scrim" aria-label="بستن"></button>
  <div class="ed-sheet" role="dialog">
    <div class="grab"></div>
    <h3>ویرایش نام</h3>
    <div class="ed-row">
      <div class="ed-f"><label>نام</label><input/></div>
      <div class="ed-f"><label>نام خانوادگی</label><input/></div>
    </div>
    <div class="ed-acts"><button class="btn pri">ذخیره</button><button class="btn gh">انصراف</button></div>
  </div>
</body>
</html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

const puppeteer = await import(PUPPETEER);
const browser = await puppeteer.default.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });

  const desk = await page.evaluate(() => {
    const pen = document.querySelector("[data-testid='cne-pen']").getBoundingClientRect();
    const last = document.querySelector('.ed-form.ed-desk input[autocomplete="family-name"]').getBoundingClientRect();
    const first = document.querySelector('.ed-form.ed-desk input[autocomplete="given-name"]').getBoundingClientRect();
    const save = [...document.querySelectorAll(".ed-form.ed-desk .ed-acts .btn")].find((b) => b.textContent.trim() === "ذخیره").getBoundingClientRect();
    const cancel = [...document.querySelectorAll(".ed-form.ed-desk .ed-acts .btn")].find((b) => b.textContent.trim() === "انصراف").getBoundingClientRect();
    const sameRow = (a, b) => Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
    return {
      penW: pen.width, penH: pen.height,
      // RTL: نام on the right, then نام خانوادگی, then buttons further left ("after")
      firstW: first.width, lastW: last.width,
      firstRight: first.right, lastRight: last.right, lastLeft: last.left,
      saveRight: save.right, cancelRight: cancel.right,
      sameRowLastSave: sameRow(last, save),
      sameRowLastCancel: sameRow(last, cancel),
      buttonsAfterLast: save.right <= last.left + 1 && cancel.right <= last.left + 1,
    };
  });
  check("measured pencil hit area is at least 44×44",
    desk.penW >= 44 && desk.penH >= 44,
    `got ${desk.penW}×${desk.penH}`);
  check("desktop ذخیره/انصراف share the field row and sit after نام خانوادگی",
    desk.sameRowLastSave && desk.sameRowLastCancel && desk.buttonsAfterLast
    && desk.firstRight >= desk.lastRight,
    JSON.stringify(desk));
  check("desktop fields are at least 180px wide when space allows",
    desk.firstW >= 180 && desk.lastW >= 180,
    JSON.stringify({ firstW: desk.firstW, lastW: desk.lastW }));

  const narrow = await page.evaluate(() => {
    const root = document.getElementById("narrow-form");
    const first = root.querySelector('input[autocomplete="given-name"]').getBoundingClientRect();
    const last = root.querySelector('input[autocomplete="family-name"]').getBoundingClientRect();
    const save = [...root.querySelectorAll(".ed-acts .btn")].find((b) => b.textContent.trim() === "ذخیره").getBoundingClientRect();
    const cancel = [...root.querySelectorAll(".ed-acts .btn")].find((b) => b.textContent.trim() === "انصراف").getBoundingClientRect();
    const sameRow = (a, b) => Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
    return {
      firstW: first.width, lastW: last.width,
      wrapped: save.top >= last.bottom - 1 && cancel.top >= last.bottom - 1 && !sameRow(last, save),
    };
  });
  check("when the row is too narrow, fields stay at least 180px and the buttons wrap to the next line",
    narrow.firstW >= 180 && narrow.lastW >= 180 && narrow.wrapped,
    JSON.stringify(narrow));

  const header = await page.evaluate(() => {
    const root = document.getElementById("header-form");
    const first = root.querySelector('input[autocomplete="given-name"]').getBoundingClientRect();
    const last = root.querySelector('input[autocomplete="family-name"]').getBoundingClientRect();
    const save = [...root.querySelectorAll(".ed-acts .btn")].find((b) => b.textContent.trim() === "ذخیره").getBoundingClientRect();
    const sameRow = (a, b) => Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
    return {
      firstW: first.width, lastW: last.width,
      formW: root.getBoundingClientRect().width,
      fieldsSideBySide: sameRow(first, last),
      buttonsOnRow: sameRow(last, save),
      buttonsAfterLast: save.right <= last.left + 1,
      buttonsWrapped: !sameRow(last, save) && save.top >= last.bottom - 1,
    };
  });
  check("in the file header, the two fields stay side by side at least 180px wide",
    header.fieldsSideBySide && header.firstW >= 180 && header.lastW >= 180
    && (header.buttonsWrapped || (header.buttonsOnRow && header.buttonsAfterLast)),
    JSON.stringify(header));

  const inv = await page.evaluate(() => {
    const root = document.getElementById("invalid-form");
    const firstLab = root.querySelector(".ed-f:first-child label").getBoundingClientRect();
    const lastLab = root.querySelector(".ed-f:last-of-type label")
      ? null : null;
    const labels = [...root.querySelectorAll(".ed-f label")].map((el) => el.getBoundingClientRect());
    const first = root.querySelector('input[autocomplete="given-name"]').getBoundingClientRect();
    const last = root.querySelector('input[autocomplete="family-name"]').getBoundingClientRect();
    const err = root.querySelector(".ed-err").getBoundingClientRect();
    const save = [...root.querySelectorAll(".ed-acts .btn")].find((b) => b.textContent.trim() === "ذخیره").getBoundingClientRect();
    const sameRow = (a, b) => Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
    return {
      labelsAligned: Math.abs(labels[0].top - labels[1].top) <= 2,
      inputsAligned: Math.abs(first.top - last.top) <= 2,
      buttonsWithInputs: sameRow(last, save) && sameRow(first, save),
      buttonsAfterLast: save.right <= last.left + 1,
      errorBelowLast: err.top >= last.bottom - 1,
    };
  });
  check("desktop invalid: labels and inputs stay aligned; error sits under نام خانوادگی; buttons stay on the input row",
    inv.labelsAligned && inv.inputsAligned && inv.buttonsWithInputs && inv.buttonsAfterLast && inv.errorBelowLast,
    JSON.stringify(inv));

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.evaluate(() => document.body.classList.add("ed-open"));
  const pad = await page.evaluate(() => {
    const sheet = document.querySelector(".ed-sheet");
    const cs = getComputedStyle(sheet);
    return { pb: parseFloat(cs.paddingBottom), raw: cs.paddingBottom };
  });
  check("measured sheet padding-bottom is at least 24px (safe-area may add more)",
    pad.pb >= 24,
    `got ${pad.raw}`);
} finally {
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
}

console.log(`PASS (${n} layout checks)`);
