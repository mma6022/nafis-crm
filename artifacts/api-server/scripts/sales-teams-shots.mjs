/**
 * Local shots of the team-builder on a disposable masked copy.
 * No live DB, no staff login (x-actor stub). Writes SHOTS_OUT or /workspace/team-model/shots/.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

const LIVE = "/var/lib/nafisvam/customers.db";
const OUT = process.env.SHOTS_OUT || "/workspace/team-model/shots";
const ROOT = "/workspace/team-model/src/artifacts/api-server";
const UI = "/workspace/team-model/src/artifacts/crm-dashboard/src/features/sales-teams/sales-teams-ui.ts";
const STANDALONE = "/workspace/nafis-design/screens/sales-teams/index.html";
const PUPPETEER = "/workspace/team-model/src/artifacts/crm-dashboard/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const ALL_SCENES = "list empty create-name create-members create-priorities create-review err-unowned err-duplicate add-pick add-priorities add-review lead-mark deactivate readonly intake intake-edit loading error intake-err".split(" ");
const sceneFilter = (process.env.SHOTS_SCENES || "").split(",").map((x) => x.trim()).filter(Boolean);
const SCENES = sceneFilter.length ? ALL_SCENES.filter((sc) => sceneFilter.includes(sc)) : ALL_SCENES;
const sceneNo = (sc) => String(ALL_SCENES.indexOf(sc) + 1).padStart(2, "0");
const ACTOR = { deactivate: "admin", readonly: "kazemi" };

const candidates = [
  process.env.MULTI_TEAM_FIXTURE_DB,
  "/tmp/dci-r3-masked-848350.db",
  "/tmp/dci-masked-r2-20261110T145303Z.db",
  "/tmp/dci-masked-20261110T143804Z.db",
].filter((p) => p && fs.existsSync(p));
if (!candidates.length) { console.error("No masked DB copy"); process.exit(2); }
const src = path.resolve(candidates[0]);
if (src === LIVE) { console.error("Refusing to use the live database."); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sales-teams-shots-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

const { execute } = await import("../src/lib/crm-db.ts");
const mt = await import("../src/lib/multi-team.ts");
const router = (await import("../src/routes/sales-teams.ts")).default;
mt.resetMultiTeamSchemaCache();
mt.migrateMultiTeam();
execute(`INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  [mt.MT_FLAG, "1", new Date().toISOString()]);

const bundle = path.join(dir, "sales-teams-ui.js");
const esbuildBin = "/workspace/team-model/src/artifacts/api-server/node_modules/esbuild/bin/esbuild";
const bundled = spawnSync(esbuildBin, [UI, "--bundle", "--format=iife", `--outfile=${bundle}`, "--global-name=SalesTeamsUI", "--platform=browser"], { encoding: "utf8" });
if (bundled.status !== 0) { console.error(bundled.stdout, bundled.stderr); process.exit(1); }

const standalone = fs.readFileSync(STANDALONE, "utf8");
const style = standalone.slice(standalone.indexOf("<style>"), standalone.indexOf("</style>") + 8);
const bodyStart = standalone.indexOf("<body>") + 6;
const scriptStart = standalone.indexOf("<script>", bodyStart);
const svg = standalone.slice(bodyStart, scriptStart).trim();

const actors = {
  admin: { id: 1, role: "admin", baseRole: "admin", username: "admin", fullName: "مدیر سامانه", permissions: [], displayName: "مدیر سامانه", roleLabel: "مدیر سامانه", enabled: true, canManage: true, canDisable: true, canEnable: true, canView: true, readonly: false, userId: 1, salespersonId: null, teamId: null },
  manager: { id: 5, role: "admin", baseRole: "sales_manager", salesManager: true, username: "mhmab", fullName: "محمدحسین مهرپور", permissions: [], displayName: "محمدحسین مهرپور", roleLabel: "مدیر فروش", enabled: true, canManage: true, canDisable: false, canEnable: false, canView: true, readonly: false, userId: 5, salespersonId: null, teamId: null },
  kazemi: { id: 8, role: "salesperson", baseRole: "salesperson", salespersonId: 6, username: "kazemi", fullName: "آقای کاظمی", permissions: [], displayName: "آقای کاظمی", roleLabel: "کارشناس فروش", enabled: true, canManage: false, canDisable: false, canEnable: false, canView: true, readonly: true, userId: 8, teamId: 1 },
};

function pageHtml(sc, as) {
  const me = actors[as];
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>تیم‌های فروش، نفیس وام</title>${style}
</head><body>
${svg}
<div id="st-root"></div>
<script src="/sales-teams-ui.js"></script>
<script>
document.documentElement.lang='fa';
document.documentElement.dir='rtl';
if (/shot=1/.test(location.search)) document.body.classList.add('rm');
const me = ${JSON.stringify(me)};
const sc = ${JSON.stringify(sc)};
SalesTeamsUI.mountSalesTeams({
  root: document.getElementById("st-root"),
  me,
  chrome: true,
  fixture: true,
  actorHeader: ${JSON.stringify(as)},
  forcedScene: sc,
  apiPrefix: '/api'
});
</script>
</body></html>`;
}

const app = express();
app.use(express.json());
app.get("/sales-teams-ui.js", (_req, res) => res.type("js").send(fs.readFileSync(bundle)));
app.get("/", (req, res) => {
  const sc = SCENES.includes(req.query.sc) ? req.query.sc : "list";
  const as = String(req.query.as || ACTOR[sc] || "manager");
  res.type("html").send(pageHtml(sc, as));
});
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  const a = actors[req.headers["x-actor"] || req.query.as || "manager"];
  if (!a) return res.sendStatus(401);
  res.locals.authUser = a;
  next();
});
app.use("/api", router);

const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log("shot server", base, "db", dbPath);

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
  { key: "390", w: 390, h: 844, scale: 1 },
  { key: "390@2x", w: 390, h: 844, scale: 2 },
  { key: "768", w: 768, h: 1024, scale: 1 },
  { key: "1280", w: 1280, h: 800, scale: 1 },
  { key: "1366x768", w: 1366, h: 768, scale: 1 },
  { key: "1920x1080", w: 1920, h: 1080, scale: 1 },
];
const sizeFilter = (process.env.SHOTS_SIZES || "").split(",").map((x) => x.trim()).filter(Boolean);
const sizes = sizeFilter.length ? allSizes.filter((sz) => sizeFilter.includes(sz.key)) : allSizes;

const files = [];
const page = await browser.newPage();
for (let i = 0; i < SCENES.length; i++) {
  const sc = SCENES[i];
  const n = sceneNo(sc);
  const as = ACTOR[sc] || "manager";
  for (const sz of sizes) {
    const file = `${n}-${sc}-${sz.key}.png`;
    const dest = path.join(OUT, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { files.push({ file, scene: sc, n: Number(n), size: sz.key, actor: as, text: "" }); process.stdout.write("s"); continue; }
    await page.setViewport({ width: sz.w, height: sz.h, deviceScaleFactor: sz.scale });
    const url = `${base}/?sc=${sc}&shot=1&as=${as}`;
    let text = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
        await page.waitForSelector("main.st-page, .st-skel, .st-state, .st-wiz, .st-team, .st-empty", { timeout: 10000 });
        await new Promise((r) => setTimeout(r, 180));
        // Grow the frame to the document height so the fixed dock sits at the
        // bottom of the PNG (Armita official 01-list is 1280x1350, not 800).
        // `.pg` already reserves dock-h + gap + 32px (28px + safe-area on mobile).
        const contentH = await page.evaluate(() => Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0,
        ));
        const fitH = Math.max(sz.h, Math.ceil(contentH));
        await page.setViewport({ width: sz.w, height: fitH, deviceScaleFactor: sz.scale });
        await new Promise((r) => setTimeout(r, 120));
        await page.screenshot({ path: dest, fullPage: false, type: "png" });
        text = await page.evaluate(() => document.body.innerText);
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    files.push({ file, scene: sc, n: i + 1, size: sz.key, actor: as, text });
    process.stdout.write(".");
  }
}
await page.close();
console.log("");
await browser.close();
await new Promise((r) => server.close(r));

const titles = {
  list: "فهرست دو تیم و بخش تقسیم (دید مدیر فروش؛ هر دو منبع به تیم فروش ۱)",
  empty: "هنوز تیمی نیست؛ «تیم جدید»",
  "create-name": "ویزارد ساخت، مرحلهٔ ۱، نام",
  "create-members": "مرحلهٔ ۲، انتخاب اعضا (عضو تیم دیگر خاکستری؛ نشان کارآموز از سرور)",
  "create-priorities": "مرحلهٔ ۳، اولویت‌ها و قالب سریع و سرپرست",
  "create-review": "مرحلهٔ ۴، بررسی و ثبت",
  "err-unowned": "اعتبار: اولویت بدون مسئول",
  "err-duplicate": "اعتبار: اولویت تکراری",
  "add-pick": "ویزارد عضو جدید، مرحلهٔ ۱ (نشان کارآموز سرور و خط عمومی خروج)",
  "add-priorities": "عضو جدید، مرحلهٔ ۲",
  "add-review": "عضو جدید، مرحلهٔ ۳ (گرفتن اولویت و خط عمومی خروج از کارآموز)",
  "lead-mark": "ویرایش سرپرست و اولویت‌های تیم فروش ۱",
  deactivate: "غیرفعال کردن تیم فروش ۱ مسدود است چون سهمش بیش از ۰٪ است (دید مدیر سامانه)",
  readonly: "تیم من، فقط مشاهده (دید آقای کاظمی)",
  intake: "بخش تقسیم با درصد پیش‌فرض ۱۰۰/۰ و برچسب بدون سهم ورودی",
  "intake-edit": "ویرایش درصد هر تیم در هر منبع؛ جمع زنده؛ ثبت فقط با جمع ۱۰۰٪",
  "intake-err": "جمع مشتری جدید ۹۰٪؛ خطای سرخ کنار منبع و کنار ثبت",
  loading: "اسکلت بارگذاری",
  error: "فهرست تیم‌ها الآن نیامد",
};

const lines = [
  `# Team-builder shots (sales-teams v1.2${sceneFilter.length ? ", r2" : ""})`,
  "",
  "Taken locally on a disposable masked copy of the CRM database. No live writes and no staff login (stub `x-actor` auth).",
  `Source dump: \`${src}\`. Flag \`flag.multi_team_v1\` was turned on only in the copy.`,
  "The page is the team-builder UI in \`artifacts/crm-dashboard/src/features/sales-teams/\`, wrapped in Armita's v1.2 sales-shell chrome for these shots.",
  "",
  `Widths this run: ${sizes.map((sz) => "**" + sz.key + "**").join(", ")}. Scene numbers follow the official v1.2 list (19 scenes). Height is at least the named frame and grows to the document so the fixed dock sits under the content.`,
  "",
  "Actor: list and wizard scenes as sales manager (محمدحسین مهرپور); scene 13 as admin (مدیر سامانه); scene 14 as آقای کاظمی.",
  "",
  "| Scene | Name | What it shows | Files |",
  "| ---: | --- | --- | --- |",
];
for (const sc of SCENES) {
  const n = sceneNo(sc);
  const names = sizes.map((sz) => `\`${n}-${sc}-${sz.key}.png\``).join(", ");
  lines.push(`| ${Number(n)} | \`${sc}\` | ${titles[sc]} | ${names} |`);
}
lines.push("", "## Notes", "");
lines.push("- Display name «حسین خردکار» comes from the team-UI override, not a users-table write.");
lines.push("- «کارشناس ۲۲» (user 31 / sp 22) is a server-flagged trainee; scenes 4 and 9 show the کارآموز badge, and selecting a trainee shows the generic leaving-traineeship line.");
lines.push("- Scene 4 does not select people already on another team (حسین خردکار and آرش اصلانیان stay grey, are not counted, and «بعدی» stays disabled until two valid picks).");
lines.push("- Intake is per-source percentages (100/0 seed). Scene 19 shows the 90% sum error. A 409 on disable is scene 13's blocked state.");
lines.push("- Production CRM chrome (CrmShell / sales-shell v2 when that flag is on) is not identical to this shot wrap; the page body (`.st-page`) is the same UI.");
lines.push("");
fs.writeFileSync(path.join(OUT, "INDEX.md"), lines.join("\n"));
console.log("wrote", files.length, "shots + INDEX.md in", OUT);
