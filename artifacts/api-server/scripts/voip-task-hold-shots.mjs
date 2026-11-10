/**
 * Local masked-copy shots of voip-task-hold (flag.voip_task_hold_v1).
 * No live DB, no staff login. Writes SHOTS_OUT or /workspace/voip-task-hold/shots/.
 * Page chrome is file-detail v1.1 CSS + the production VTH / reminder-voip CSS.
 * Names and phones come from a disposable masked copy (already masked).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { DatabaseSync } from "node:sqlite";

const LIVE = "/var/lib/nafisvam/customers.db";
const OUT = process.env.SHOTS_OUT || "/workspace/voip-task-hold/shots";
const ROOT = "/workspace/voip-task-hold/src/artifacts/crm-dashboard";
const PUPPETEER = "/workspace/voip-task-hold/src/artifacts/crm-dashboard/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const ALL_SCENES = [
  "file_idle",
  "file_active_notes",
  "mobile_notes",
  "disconnected_pending_status",
  "final_result",
  "task_done_next",
  "support_own",
  "support_other",
];
const sceneFilter = (process.env.SHOTS_SCENES || "").split(",").map((x) => x.trim()).filter(Boolean);
const SCENES = sceneFilter.length ? ALL_SCENES.filter((sc) => sceneFilter.includes(sc)) : ALL_SCENES;
const sceneNo = (sc) => String(ALL_SCENES.indexOf(sc) + 1).padStart(2, "0");

const candidates = [
  process.env.VTH_FIXTURE_DB,
  "/tmp/dci-r3-masked-848350.db",
  "/workspace/team-model/rel/masked-pkgtest.db",
].filter((p) => p && fs.existsSync(p));
if (!candidates.length) { console.error("No masked DB copy"); process.exit(2); }
const src = path.resolve(candidates[0]);
if (src === LIVE) { console.error("Refusing to use the live database."); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vth-shots-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
const db = new DatabaseSync(dbPath, { readOnly: true });
const own = db.prepare(`
  SELECT la.id AS file_id, la.customer_id, c.name, c.phone, sp.name AS owner
    FROM loan_applications la
    JOIN customers c ON c.id=la.customer_id
    LEFT JOIN salespersons sp ON sp.id=c.salesperson_id
   WHERE c.salesperson_id=6 AND c.merged_into_customer_id IS NULL
   ORDER BY la.id DESC LIMIT 1`).get();
const other = db.prepare(`
  SELECT la.id AS file_id, la.customer_id, c.name, c.phone, sp.name AS owner
    FROM loan_applications la
    JOIN customers c ON c.id=la.customer_id
    LEFT JOIN salespersons sp ON sp.id=c.salesperson_id
   WHERE c.salesperson_id=3 AND c.merged_into_customer_id IS NULL
   ORDER BY la.id DESC LIMIT 1`).get();
db.close();
if (!own?.file_id || !other?.file_id) { console.error("need kazemi and hasani files"); process.exit(2); }

const fa = (n) => String(n ?? "").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
const draft = "فیش حقوقی رسید؛ تصویر واضح‌تر را می‌خواهم.";

function I(name) {
  const p = 'class="i" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
  const d = {
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.32 1.6.57 2.36a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.76.25 1.55.44 2.36.57A2 2 0 0 1 22 16.92z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3.2-6.86"/><path d="M21 3v6h-6"/>',
    user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    chev: '<path d="m9 18 6-6-6-6"/>',
    chevr: '<path d="m15 18-6-6 6-6"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    send: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    paper: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/>',
    headset: '<path d="M3 11v5a2 2 0 0 0 2 2h1"/><path d="M21 11v5a2 2 0 0 1-2 2h-1"/><path d="M3 11a9 9 0 0 1 18 0"/><circle cx="5" cy="16" r="2"/><circle cx="19" cy="16" r="2"/>',
    eyeoff: '<path d="M10.733 5.076a10.74 10.74 0 0 1 11.27 6.18 10.75 10.75 0 0 1-4.44 5.32"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M17.94 17.94A10.75 10.75 0 0 1 1.99 11.26a10.73 10.73 0 0 1 5.2-4.69"/><line x1="2" x2="22" y1="2" y2="22"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  };
  return `<svg ${p}>${d[name] || ""}</svg>`;
}

function callBtn(label, disabled) {
  const dis = disabled ? " disabled aria-disabled=\"true\"" : "";
  const cls = disabled ? "btn gh vc-btn" : "btn btn-primary vc-btn";
  return `<span class="vth-head-call" data-testid="vth-head-call"><div class="vcx" data-testid="vc-box"><button type="button" class="${cls}" data-testid="vc-call"${dis}>${I("phone")}${label}</button></div></span>`;
}

function statusBlock(sc) {
  if (sc === "file_idle" || sc === "support_other") return "";
  if (sc === "file_active_notes" || sc === "mobile_notes" || sc === "support_own") {
    return `<section class="vh-status" role="status" data-testid="vth-status" data-phase="in_call">${I("phone")}<div>
      <b>در حال تماس</b><p>برای قطع از گوشی ویپ استفاده کنید</p>
      <small>گوشی کارشناس وصل است؛ پاسخ مشتری هنوز تأیید نشده.</small></div></section>`;
  }
  if (sc === "disconnected_pending_status") {
    return `<section class="vh-status err" role="status" data-testid="vth-status" data-phase="status_error">${I("phone")}<div>
      <b>تماس قطع شد؛ در انتظار وضعیت نهایی</b>
      <p>کار جاری حفظ شده؛ هنوز کار بعدی باز نمی‌شود.</p>
      <p>وضعیت نهایی دریافت نشد.</p>
      <button class="btn gh sm" type="button" data-testid="vth-retry">${I("refresh")}تلاش دوباره برای وضعیت</button>
    </div></section>`;
  }
  if (sc === "final_result") {
    return `<div class="vh-status ok" role="status" data-testid="vth-status" data-phase="final">${I("check")}
      <div><b>قطع کامل؛ وضعیت نهایی: پاسخ داد، ${fa(1)} دقیقه و ${fa(12)} ثانیه</b></div></div>`;
  }
  if (sc === "task_done_next") {
    return `<div class="vh-status ok" role="status" data-testid="vth-status" data-phase="saved">${I("check")}
      <div><b>نتیجه روی تماس #${fa(8462)} ثبت شد؛ کار جاری تمام شد</b></div></div>`;
  }
  return "";
}

function taskCard(sc) {
  const hold = ["file_active_notes", "mobile_notes", "disconnected_pending_status", "final_result", "support_own"].includes(sc);
  const saved = sc === "task_done_next";
  const entry = sc === "task_done_next" ? "گردونه‌ی پرونده‌ها" : "جزئیات پرونده";
  return `<section class="card vh-task" data-testid="vth-task">
    <div class="vh-task-head"><b>${entry}</b></div>
    ${hold ? '<button class="btn gh sm" type="button" disabled data-testid="vth-next-locked">کار بعدی؛ پس از وضعیت نهایی و ثبت نتیجه</button>' : ""}
    ${saved ? `<span class="chip s" data-testid="vth-saved-chip">${I("check")}انجام شد؛ آماده‌ی نمایش کار بعدی</span>` : ""}
  </section>`;
}

function supportCard(sc) {
  if (sc !== "support_own" && sc !== "support_other") return "";
  if (sc === "support_own") {
    return `<section class="card vh-task" data-testid="vth-support">
      <span class="chip b">پشتیبانی، داخلی ۲۲۰</span>
      <p>پرونده‌ی ثبت‌نام اکنون با شماست</p>
    </section>`;
  }
  return `<section class="card vh-task" data-testid="vth-support">
    <span class="chip b">پشتیبانی، داخلی ۲۲۰</span>
    <p>مشتری شما نیست؛ دسترسی نامعتبر یا مهلت پاسخ تمام شده</p>
    <p>کارشناس: ${other.owner} (فقط برای اطلاع)</p>
  </section>`;
}

function otherBanner(sc) {
  if (sc !== "support_other") return "";
  return `<div class="vh-status" data-testid="vth-other">${I("eyeoff")}
    <span>مشتری شما نیست؛ مجوز تماس یا مهلت پاسخ معتبر نیست.</span></div>`;
}

function resultForm(file) {
  return `<section class="rv-mdl vth-form" role="region" aria-labelledby="vth-rvT" data-testid="vth-form">
    <header class="rv-mh"><div class="rv-mt">
      <span class="chip s rv-auto" data-testid="vth-auto">${I("headset")}خودکار باز شد؛ قطع کامل و وضعیت نهایی تأیید شد</span>
      <h2 id="vth-rvT">ثبت نتیجه‌ی تماس</h2>
      <small>تماس ویپ #${fa(8462)}؛ پاسخ داد، ${fa(1)} دقیقه و ${fa(12)} ثانیه</small>
      <p class="rn"><b>${file.name}</b><span class="cid">#${fa(file.customer_id)}</span></p>
    </div><button class="ib" type="button" aria-label="بستن" data-testid="vth-form-close">${I("x")}</button></header>
    <div class="rv-mb">
      <div class="rv-fld"><span class="rv-lbl">نتیجه‌ی تماس<span class="req">*</span></span>
        <div class="rv-seg" role="radiogroup" aria-label="نتیجه‌ی تماس" aria-required="true">
          <button type="button" role="radio" aria-checked="true" class="on" data-testid="vth-out-answered">پاسخ داد</button>
          <button type="button" role="radio" aria-checked="false" data-testid="vth-out-no_answer">پاسخ نداد</button>
          <button type="button" role="radio" aria-checked="false" data-testid="vth-out-follow_up">پیگیری بعدی</button>
        </div></div>
      <div class="rv-fld"><div class="rv-fh"><label class="rv-lbl" for="vth-rvN">یادداشت یک‌خطی<span class="req">*</span> <small>تک‌خط، حداکثر ۸۰ نویسه</small></label>
        <span class="rv-cnt" dir="ltr"><b>${fa([...draft].length)}</b> / ۸۰</span></div>
        <input id="vth-rvN" class="rv-inp" maxLength="80" value="${draft}" aria-required="true" data-testid="vth-note" /></div>
    </div>
    <footer class="rv-mf">
      <button class="btn gh" type="button" data-testid="vth-save">${I("check")}ثبت نتیجه</button>
      <button class="btn gh" type="button" data-close data-testid="vth-cancel">انصراف</button>
    </footer>
  </section>`;
}

function notesCol(file, sc) {
  const showDraft = ["file_active_notes", "mobile_notes", "disconnected_pending_status", "final_result"].includes(sc);
  const ro = sc === "support_own" || sc === "support_other";
  return `<aside class="fchat" aria-label="یادداشت‌های پرونده" data-testid="fdv1-notes">
    <div class="chh"><button class="ib bkb" type="button" aria-label="برگشت به پرونده">${I("chevr")}</button>
      <div class="t"><div class="nmr"><span class="nm">یادداشت‌های پرونده</span>
        <span class="fno">پرونده‌ی ${fa(file.file_id)}، ${file.name}</span>
        <span class="chip in">${I("lock")}داخلی</span></div>
        <p>فقط همکاران می‌بینند؛ برای مشتری نمی‌رود</p></div>
    </div>
    <div class="cmsgs" tabindex="0" aria-label="یادداشت‌ها، تازه‌ترین پایین" data-testid="fdv1-notes-list">
      <div class="cempty"><b>هنوز یادداشتی ثبت نشده است.${ro ? "" : " اولین یادداشت را بنویسید."}</b></div>
    </div>
    <div class="cz">${ro ? `<div class="czro">${I("lock")}شما فقط اجازهٔ مشاهدهٔ یادداشت‌ها را دارید.</div>` : `
      ${showDraft ? '<small class="vh-draft" data-testid="vth-draft">پیش‌نویس؛ هنوز ثبت نشده</small>' : ""}
      <div class="row">
        <button class="ib" type="button" aria-label="پیوست فایل">${I("paper")}</button>
        <textarea id="fdv1-cmsg" class="ta3" rows="2" placeholder="یادداشت بنویسید…" data-testid="fdv1-note-input">${showDraft ? draft : ""}</textarea>
        <button class="snd" type="button" aria-label="ثبت یادداشت" data-testid="fdv1-note-send">${I("send")}</button>
      </div>`}
    </div>
  </aside>`;
}

function pageHtml(sc) {
  const support = sc === "support_own" || sc === "support_other";
  const file = sc === "support_other" ? other : own;
  const actor = support ? "خانم تاجیک" : "آقای کاظمی";
  const ext = support ? "۲۲۰" : "۲۱۲";
  const canCall = sc !== "support_other";
  const hold = ["file_active_notes", "mobile_notes", "disconnected_pending_status", "final_result", "support_own"].includes(sc);
  const showPhone = canCall;
  const notesTab = sc === "mobile_notes";
  const expertChip = support
    ? (sc === "support_own" ? `${file.owner} (فقط برای اطلاع)` : `${file.owner} (فقط برای اطلاع)`)
    : `${file.owner} (شما)`;
  const head = `<section class="card fhd" aria-label="سربرگ پرونده">
    <div class="crow"><nav class="crumb" aria-label="مسیر"><a href="#">${I("chevr")}پرونده‌های من</a></nav></div>
    <div class="fhd-r1"><div class="who"><span class="eyb">پرونده‌ی تسهیلات ${fa(file.file_id)}، طرح ثبت نشده</span>
      <div class="nmr"><h2>${file.name}</h2><button class="cid" type="button">#${fa(file.customer_id)}${I("copy")}</button></div>
      ${showPhone && file.phone ? `<span class="ph big"><a class="phn" href="#" dir="ltr">${file.phone}</a>
        <button class="phc" type="button">${I("copy")}<span>کپی</span></button></span>`
        : (sc === "support_other" ? '<p class="vh-hidden" data-testid="vth-hidden-phone">شماره نشان داده نمی‌شود</p>' : "")}
    </div>
      <div class="fhd-act">${canCall ? callBtn(hold ? "در حال تماس" : "تماس", hold) : '<span class="chip" data-testid="vth-not-yours">مشتری شما نیست</span>'}
        <a class="btn gh sm" href="#">${I("user")}پرونده‌ی مشتری</a>
        <button class="ib wb" type="button" aria-label="کارهای بیشتر">${I("more")}</button>
      </div></div>
    <div class="fhd-chips"><span class="chip b">در حال بررسی</span>
      <span class="chip g">${I("zap")}اقدام با شماست</span>
      <span class="chip">${I("user")}کارشناس فروش: ${expertChip}</span>
    </div>
  </section>`;
  const tabs = `<nav class="stabs" aria-label="بخش‌های پرونده">
    <a class="st-i" href="#ov" ${notesTab ? "" : 'aria-current="page"'} data-testid="fdv1-tab-ov">خلاصه</a>
    <a class="st-i" href="#docs" data-testid="fdv1-tab-docs">مدارک</a>
    <a class="st-i" href="#contract" data-testid="fdv1-tab-contract">قراردادها</a>
    <a class="st-i" href="#hist" data-testid="fdv1-tab-hist">تاریخچه</a>
    <a class="st-i mob" href="#chat" ${notesTab ? 'aria-current="page"' : ""} data-testid="fdv1-tab-chat">یادداشت‌ها</a>
  </nav>`;
  const body = `<div class="tabp">
    <section class="card nxa"><div class="t"><span class="eh">${I("flag")}تصمیم‌گیری</span><b>اقدام با شماست</b><span>بارگذاری مدارک</span></div></section>
    <section class="card sec" aria-labelledby="fdv1-amt"><div class="sh"><h3 id="fdv1-amt">${I("coins")}اطلاعات پایه</h3></div>
      <div class="kvg"><div><span>مشتری</span><b>${file.name}</b></div><div><span>شناسه</span><b>#${fa(file.customer_id)}</b></div></div>
    </section>
  </div>`;
  return `<!DOCTYPE html><html lang="fa" dir="rtl" class="fdv1-on${notesTab ? " fdv1-chv" : ""}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>حفظ کار در تماس ویپ — ${sc}</title>
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/fdv1.css">
<link rel="stylesheet" href="/reminder-voip.css">
<link rel="stylesheet" href="/voip-call.css">
<link rel="stylesheet" href="/voip-task-hold.css">
<style>
html,body{margin:0;background:var(--nf-surface,#F6F7FB);font-family:var(--nf-font-sans);color:var(--nf-ink-soft)}
.fdv1{min-height:100vh;background:var(--nf-surface,#F6F7FB);padding:16px 24px 40px}
@media(max-width:1023.98px){.fdv1{padding:12px 14px 32px}}
.shot-top{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.shot-top .me{margin-inline-start:auto;display:flex;align-items:center;gap:8px}
.shot-top .av{width:40px;height:40px;border-radius:50%;background:var(--nf-brand-100);color:var(--nf-brand-900);font-weight:800;display:grid;place-items:center}
.btn.btn-primary,.vc-btn.btn-primary{background:var(--nf-brand-600,#2f54eb);color:#fff;box-shadow:var(--nf-shadow-button,none)}
.btn.btn-ghost,.vc-btn.btn-ghost{background:#fff;border:1px solid var(--nf-line-strong,#d0d5dd);color:var(--nf-ink)}
.vcx .vc-btn{min-height:48px}
.chip.s{background:var(--nf-success-50,#ecfdf3);color:var(--nf-success,#067647)}
.vh-date{font-size:14px;color:var(--nf-ink-muted);margin-bottom:8px}
</style>
</head><body>
<div class="fdv1" data-testid="file-detail-v1" data-scene="${sc}">
  <div class="shot-top"><span class="vh-date">پنجشنبه ۷ آبان ۱۴۰۵</span>
    <div class="me"><span class="av">${actor.replace(/^(آقای|خانم)\s+/, "").slice(0, 1)}</span><span>${actor}، داخلی ${ext}</span></div>
  </div>
  <main class="pg fpg"><div class="fgrid">
    <div class="fmain">
      ${head}
      ${statusBlock(sc)}
      ${otherBanner(sc)}
      ${supportCard(sc)}
      ${taskCard(sc)}
      ${tabs}
      ${body}
      ${sc === "final_result" ? resultForm(file) : ""}
    </div>
    ${notesCol(file, sc)}
  </div></main>
</div>
</body></html>`;
}

const CSS = {
  "/tokens.css": "/workspace/nafis-design/tokens/tokens.css",
  "/fonts.css": path.join(ROOT, "src/fonts.css"),
  "/fdv1.css": path.join(ROOT, "src/features/file-detail-v1/fdv1.css"),
  "/reminder-voip.css": path.join(ROOT, "src/features/reminder-voip/reminder-voip.css"),
  "/voip-call.css": path.join(ROOT, "src/features/voip-call/voip-call.css"),
  "/voip-task-hold.css": path.join(ROOT, "src/features/voip-task-hold/voip-task-hold.css"),
};

const app = express();
app.get("/fonts/:file", (req, res) => {
  const f = path.join(ROOT, "public/fonts", path.basename(req.params.file));
  if (!f.startsWith(path.join(ROOT, "public/fonts")) || !fs.existsSync(f)) return res.sendStatus(404);
  res.type("woff2").send(fs.readFileSync(f));
});
for (const [url, file] of Object.entries(CSS)) {
  app.get(url, (_req, res) => res.type("css").send(fs.readFileSync(file)));
}
app.get("/", (req, res) => {
  const sc = ALL_SCENES.includes(req.query.sc) ? req.query.sc : "file_idle";
  res.type("html").send(pageHtml(sc));
});

const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log("shot server", base, "db", dbPath, "own", own.file_id, own.customer_id, "other", other.file_id);

const puppeteer = (await import(pathToFileURL(PUPPETEER).href)).default;
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  headless: "new",
});

fs.mkdirSync(OUT, { recursive: true });
if (process.env.RESET_SHOTS === "1") {
  for (const f of fs.readdirSync(OUT)) {
    if (f.endsWith(".png") || f === "INDEX.md") fs.rmSync(path.join(OUT, f), { force: true });
  }
}

const allSizes = [
  { key: "1280", w: 1280, h: 800, scale: 1 },
  { key: "390", w: 390, h: 844, scale: 1 },
  { key: "390@2x", w: 390, h: 844, scale: 2 },
];
const sizeFilter = (process.env.SHOTS_SIZES || "").split(",").map((x) => x.trim()).filter(Boolean);
const sizes = sizeFilter.length ? allSizes.filter((sz) => sizeFilter.includes(sz.key)) : allSizes;

const files = [];
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => { document.documentElement.style.setProperty("--vh", "100vh"); });
for (const sc of SCENES) {
  const n = sceneNo(sc);
  for (const sz of sizes) {
    const file = `${n}-${sc}-${sz.key}.png`;
    const dest = path.join(OUT, file);
    await page.setViewport({ width: sz.w, height: sz.h, deviceScaleFactor: sz.scale });
    await page.goto(`${base}/?sc=${sc}&shot=1`, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForSelector("[data-testid=file-detail-v1]", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 200));
    const contentH = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0));
    const fitH = Math.max(sz.h, Math.ceil(contentH));
    await page.setViewport({ width: sz.w, height: fitH, deviceScaleFactor: sz.scale });
    await new Promise((r) => setTimeout(r, 120));
    await page.screenshot({ path: dest, fullPage: false, type: "png" });
    files.push({ file, scene: sc, n: Number(n), size: sz.key });
    process.stdout.write(".");
  }
}
await page.close();
console.log("");
await browser.close();
await new Promise((r) => server.close(r));

const titles = {
  file_idle: "دکمه‌ی ویپ داخل پرونده‌ی تسهیلات (پرونده‌ی آقای کاظمی؛ فلگ روشن)",
  file_active_notes: "تماس خنثی، پرونده و ستون یادداشت، متن ثبت‌نشده («پیش‌نویس؛ هنوز ثبت نشده»)",
  mobile_notes: "همان تماس با زبانه‌ی یادداشت‌های پرونده در موبایل؛ وضعیت تماس بالای یادداشت می‌ماند",
  disconnected_pending_status: "قطع واقعی، انتظار وضعیت نهایی (حالت خطا با تلاش دوباره)؛ کار بعدی قفل است",
  final_result: "وضعیت نهایی معتبر و فرم نتیجه‌ی موجود خودکار باز؛ برچسب ذخیره «ثبت نتیجه» (ورودی پرونده)",
  task_done_next: "ذخیره‌ی موفق تماس گردونه و مجوز کار بعدی؛ مشتری بعدی آشکار نشده",
  support_own: "خانم تاجیک، داخلی ۲۲۰؛ مسیر assigned («پرونده‌ی ثبت‌نام اکنون با شماست»)؛ تماس مجاز",
  support_other: "خانم تاجیک؛ نامجاز، شماره پنهان، بدون دکمه‌ی تماس؛ نام و داخلی کارشناس فقط برای اطلاع",
};
const actors = {
  file_idle: "آقای کاظمی",
  file_active_notes: "آقای کاظمی",
  mobile_notes: "آقای کاظمی",
  disconnected_pending_status: "آقای کاظمی",
  final_result: "آقای کاظمی",
  task_done_next: "آقای کاظمی",
  support_own: "خانم تاجیک",
  support_other: "خانم تاجیک",
};

const lines = [
  "# voip-task-hold shots (v1.0, flag.voip_task_hold_v1)",
  "",
  "Taken locally on a disposable masked copy of the CRM database. No live writes and no staff login.",
  `Source dump: \`${src}\`. Flag \`flag.voip_task_hold_v1\` is shown as ON only in this shot page (the copy itself was not written for these shots; markup is the production file-detail + VTH CSS and copy).`,
  "The page body uses production CSS from `artifacts/crm-dashboard/src/features/{file-detail-v1,voip-task-hold,reminder-voip,voip-call}/` with Armita token CSS. Production CrmShell / sales-shell v2 chrome is not identical to this shot wrap; the file-detail body (`.fdv1`) and VTH widgets are the same UI.",
  "",
  `Widths this run: ${sizes.map((sz) => "**" + sz.key + "**").join(", ")}. Official design scenes 1–8 from \`/workspace/nafis-design/screens/voip-task-hold/\`. Height is at least the named frame and grows to the document.`,
  "",
  `Masked fixtures used: آقای کاظمی / پرونده ${own.file_id} / مشتری ${own.customer_id} (${own.name}, ${own.phone}); support-other uses ${other.owner} / پرونده ${other.file_id} / مشتری ${other.customer_id}. Phones are already masked in the dump.`,
  "",
  "| Scene | Name | What it shows | Actor | Files |",
  "| ---: | --- | --- | --- | --- |",
];
for (const sc of SCENES) {
  const n = sceneNo(sc);
  const names = sizes.map((sz) => `\`${n}-${sc}-${sz.key}.png\``).join(", ");
  lines.push(`| ${Number(n)} | \`${sc}\` | ${titles[sc]} | ${actors[sc]} | ${names} |`);
}
lines.push("", "## Notes", "");
lines.push("- Scene 4 is shown in the `status=error` variant (retry = CDR re-query only), which is the design’s delayed/error path of `disconnected_pending_status`.");
lines.push("- Scene 6 uses a carousel entry so the saved chip is «انجام شد؛ آماده‌ی نمایش کار بعدی». The next customer is not named or preloaded.");
lines.push("- User 7 in this masked dump is stored as «کاربر 7» (`s.tajik`, extension 220). The shots use the published display name «خانم تاجیک». The eligibility chip maps the published `open_filing` rule to the design label `assigned` / «پرونده‌ی ثبت‌نام اکنون با شماست» without changing the server rule.");
lines.push("- Call #۸۴۶۲ and the date «پنجشنبه ۷ آبان ۱۴۰۵» are the design sample identifiers, not live rows.");
lines.push("- No SMS, no contract writes, and no notification_settings writes were performed for these shots.");
lines.push("");
fs.writeFileSync(path.join(OUT, "INDEX.md"), lines.join("\n"));
console.log("wrote", files.length, "shots + INDEX.md in", OUT);
