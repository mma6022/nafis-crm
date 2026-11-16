import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// «درخواست تماس کارشناس»: public intake (type=callback) + staff API. Synthetic, disposable database only.
const temp = await mkdtemp(path.join(os.tmpdir(), "crm-callback-fixture-"));
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(temp, "fixture.sqlite");
const notifyLog = path.join(temp, "notify.log");
let child;
// Sat–Thu 09:00–18:00 Asia/Tehran: outside it a «همین الان» request is queued as next morning.
const effectiveNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tehran", hour: "numeric", hourCycle: "h23", weekday: "short" })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const h = Number(parts.hour) % 24;
  return [6, 0, 1, 2, 3, 4].includes(day) && h >= 9 && h < 18 ? "now" : "morning";
};

const fixtureDbModule = `
  import { DatabaseSync } from "node:sqlite";
  import path from "node:path";
  export const databasePath = path.resolve(process.env.CRM_DATABASE_PATH);
  export const crmDb = new DatabaseSync(databasePath);
  crmDb.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
  crmDb.function("crm_customer_mobile_key", value => {
    let digits=String(value??"").replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\\D/g,"");
    if(digits.startsWith("0098")&&digits.length===14)digits="0"+digits.slice(4);
    else if(digits.startsWith("98")&&digits.length===12)digits="0"+digits.slice(2);
    else if(digits.length===10&&digits.startsWith("9"))digits="0"+digits;
    return digits;
  });
  export const queryRow=(sql,params=[])=>crmDb.prepare(sql).get(...params);
  export const queryRows=(sql,params=[])=>crmDb.prepare(sql).all(...params);
  export const execute=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
  export const executeChanges=(sql,params=[])=>crmDb.prepare(sql).run(...params).changes;
  export const runTransaction=fn=>{crmDb.exec("BEGIN");try{const r=fn();crmDb.exec("COMMIT");return r}catch(e){crmDb.exec("ROLLBACK");throw e}};
  export const runImmediateTransaction=fn=>{crmDb.exec("BEGIN IMMEDIATE");try{const r=fn();crmDb.exec("COMMIT");return r}catch(e){crmDb.exec("ROLLBACK");throw e}};
`;
const notifyModule = `
  import { appendFileSync } from "node:fs";
  export async function notifyNewCustomer(id){ appendFileSync(process.env.NOTIFY_LOG, "customer:"+String(id)+"\\n"); }
  export function getNotificationSettings(){ return { ippanelEnabled: false }; }
  export async function notifyWebsiteCallback(alert){ appendFileSync(process.env.NOTIFY_LOG, "callback:"+JSON.stringify(alert)+"\\n"); return "sent"; }
`;


const workerSource = `
  import express from "express";
  import { mountPublicLeads } from "./src/routes/public-leads";
  import callbackRouter from "./src/routes/callback-requests";
  import { permissionsForRole } from "./src/lib/access-control";
  import { queryRow } from "./src/lib/crm-db";
  const app = express();
  mountPublicLeads(app);
  app.use(express.json());
  // Stand-in for requireAuth: the real role/permission tables decide what each fixture user may do.
  app.use("/api", (req, res, next) => {
    const u = queryRow("SELECT u.id,u.role,r.customer_scope FROM users u LEFT JOIN app_roles r ON r.slug=u.role WHERE u.id=? AND u.active=1", [Number(req.get("x-user"))]);
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    res.locals.authUser = { id: Number(u.id), role: u.role, permissions: permissionsForRole(u.role),
      customerScope: u.role === "admin" ? "all" : u.customer_scope === "assigned" ? "assigned" : "all" };
    next();
  }, callbackRouter);
  app.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("READY"));
`;

const unitSource = `
  import assert from "node:assert/strict";
  import { validatePublicCallback, validatePublicLead, publicIntakeType, effectiveContactTime } from "./src/lib/public-leads";
  import { isWorkingHours, CALLBACK_CONFIG } from "./src/lib/callback-config";
  import {
    canTransition, compareCallbacks, CALLBACK_TRANSITIONS, callbackDescription, attemptState, isLate, maskPhone, can, canSeePhone,
  } from "./src/lib/callback-requests";

  const now = 1_800_000_000_000;
  // Exactly what the site's buildCallbackPayload sends.
  const good = { kind: "callback", name: " سارا  محمدی ", phone: "۰۹۱۲۳۴۵۶۷۸۹", contactTime: "now", need: "goods", planId: 12,
    consent: true, startedAt: now - 8000, website: "", src: "finder-result", utm_source: "google" };
  const ok = validatePublicCallback(good, now);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.callback, { name: "سارا محمدی", phone: "09123456789", contactTime: "now", need: "goods", planId: 12, src: "finder-result", utm: { utm_source: "google" } });
  assert.equal(validatePublicCallback({ ...good, need: undefined }, now).callback.need, null, "need is optional");
  assert.equal(validatePublicCallback({ ...good, need: "" }, now).callback.need, null);
  assert.equal(validatePublicCallback({ ...good, planId: undefined }, now).callback.planId, null);
  for (const t of ["now", "morning", "evening"]) assert.equal(validatePublicCallback({ ...good, contactTime: t }, now).ok, true, t);
  const bad = (patch, code, fields) => {
    const r = validatePublicCallback({ ...good, ...patch }, now);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.error, code, JSON.stringify(patch));
    if (fields) assert.deepEqual(r.fields, fields, JSON.stringify(patch));
    assert.ok(!JSON.stringify(r).includes("0912"));
  };
  bad({ website: "x" }, "spam");
  bad({ startedAt: now - 1000 }, "too_fast");
  bad({ startedAt: now - 3 * 86400_000 }, "expired");
  // Device clock running ahead (2026-10-24 bug: every submit was «too_fast»): accepted.
  for (const ahead of [1_000, 30_000, 90_000, 3600_000]) {
    assert.equal(validatePublicCallback({ ...good, startedAt: now + ahead }, now).ok, true, "clock ahead " + ahead);
  }
  bad({ startedAt: now + 15 * 3600_000 }, "expired");
  assert.equal(validatePublicCallback({ ...good, startedAt: now + 60_000, fillMs: 9_000 }, now).ok, true);
  bad({ fillMs: 1_200 }, "too_fast");
  bad({ fillMs: 1.5 }, "invalid", ["fillMs"]);
  bad({ startedAt: "1" }, "invalid", ["startedAt"]);
  bad({ name: "x" }, "invalid", ["name"]);
  bad({ phone: "02112345678" }, "invalid", ["phone"]);
  bad({ contactTime: "night" }, "invalid", ["contactTime"]);
  bad({ contactTime: undefined }, "invalid", ["contactTime"]);
  bad({ need: "house" }, "invalid", ["need"]);
  bad({ planId: "abc" }, "invalid", ["planId"]);
  bad({ consent: undefined }, "invalid", ["consent"]);
  bad({ amountBand: "unsure" }, "invalid", ["unknown_field"]);
  bad({ preferredTime: "now" }, "invalid", ["unknown_field"]);
  bad({ src: "<x>" }, "invalid", ["src"]);
  assert.equal(publicIntakeType({ kind: "callback" }), "callback");
  assert.equal(publicIntakeType({ kind: "lead" }), undefined, "only kind=callback is a known kind");
  assert.equal(publicIntakeType({}), "lead");
  assert.equal(publicIntakeType({ type: "lead" }), "lead");
  assert.equal(publicIntakeType({ type: "x" }), undefined);
  // The request wizard (no kind) keeps working and rejects callback-only fields.
  const lead = { name: "Ali", phone: "09351234567", need: "help", amountBand: "unsure", contactTime: "any", consent: true, startedAt: now - 9000 };
  assert.equal(validatePublicLead(lead, now).ok, true);
  assert.equal(validatePublicLead({ ...lead, type: "lead" }, now).ok, true);
  assert.equal(validatePublicLead({ ...lead, kind: "callback" }, now).ok, false, "a lead never carries kind");

  // Status transitions.
  assert.ok(canTransition("new", "in_progress") && canTransition("new", "no_answer") && canTransition("new", "called") && canTransition("new", "cancelled"));
  assert.ok(canTransition("no_answer", "no_answer"), "another unanswered attempt");
  assert.ok(canTransition("called", "in_progress") && canTransition("cancelled", "in_progress"), "reopen");
  for (const from of Object.keys(CALLBACK_TRANSITIONS)) assert.equal(canTransition(from, "new"), false, "never back to new: " + from);
  assert.equal(canTransition("called", "no_answer"), false);
  assert.equal(canTransition("cancelled", "called"), false);
  assert.equal(canTransition("in_progress", "in_progress"), false);

  // Queue order: new+now (oldest first), other new (oldest first), then the rest by last activity.
  const r = (id, status, contactTime, createdAt, lastActivityAt = createdAt) => ({ id, status, contactTime, createdAt, lastActivityAt });
  const rows = [
    r(1, "new", "morning", "2026-10-20T08:00:00Z"),
    r(2, "new", "now", "2026-10-22T08:00:00Z"),
    r(3, "in_progress", "evening", "2026-10-19T08:00:00Z", "2026-10-22T09:00:00Z"),
    r(4, "new", "now", "2026-10-21T08:00:00Z"),
    r(5, "no_answer", "now", "2026-10-21T08:00:00Z", "2026-10-23T09:00:00Z"),
    r(6, "new", "evening", "2026-10-19T08:00:00Z"),
  ];
  assert.deepEqual([...rows].sort(compareCallbacks).map(x => x.id), [4, 2, 6, 1, 5, 3]);

  // Attempts: cap 3 then suggest cancelling (never automatic); at least 60 minutes apart.
  assert.equal(CALLBACK_CONFIG.maxAttempts, 3);
  assert.equal(CALLBACK_CONFIG.minAttemptGapMinutes, 60);
  assert.equal(CALLBACK_CONFIG.slaMinutes, 15);
  const at = new Date("2026-10-21T10:00:00Z");
  assert.deepEqual(attemptState({ status: "new", attempts: 0, lastAttemptAt: null }, at), { canRetry: true, nextAttemptAt: null, suggestCancel: false });
  assert.deepEqual(attemptState({ status: "no_answer", attempts: 1, lastAttemptAt: "2026-10-21T09:30:00Z" }, at),
    { canRetry: false, nextAttemptAt: "2026-10-21T10:30:00.000Z", suggestCancel: false });
  assert.equal(attemptState({ status: "no_answer", attempts: 2, lastAttemptAt: "2026-10-21T08:59:00Z" }, at).canRetry, true);
  assert.deepEqual(attemptState({ status: "no_answer", attempts: 3, lastAttemptAt: "2026-10-21T05:00:00Z" }, at), { canRetry: false, nextAttemptAt: null, suggestCancel: true });
  assert.equal(attemptState({ status: "cancelled", attempts: 3, lastAttemptAt: null }, at).suggestCancel, false);

  // Internal SLA (15 min) only for «همین الان» still «جدید».
  assert.equal(isLate({ status: "new", contactTime: "now", createdAt: "2026-10-21T09:44:00Z" }, at), true);
  assert.equal(isLate({ status: "new", contactTime: "now", createdAt: "2026-10-21T09:46:00Z" }, at), false);
  assert.equal(isLate({ status: "new", contactTime: "morning", createdAt: "2026-10-20T09:00:00Z" }, at), false);
  assert.equal(isLate({ status: "in_progress", contactTime: "now", createdAt: "2026-10-20T09:00:00Z" }, at), false);

  assert.equal(maskPhone("09120000001"), "0912 ••• 0001");
  const actor = (role, permissions = []) => ({ id: 9, role, permissions, customerScope: "all" });
  assert.ok(can(actor("admin"), "callbacks.assign") && canSeePhone(actor("admin")));
  assert.equal(can(actor("registrar", ["callbacks.manage"]), "callbacks.assign"), false);
  assert.equal(canSeePhone(actor("x", ["callbacks.view"])), false, "phones follow customers.view");

  const desc = callbackDescription({ contactTime: "evening", need: "cash", planId: 7, planName: "طرح طلایی", src: "home-callback", trackingCode: "NV-AAAA-BBBB" }, ["اول", "دوم"]);
  assert.match(desc, /عصر[\\s\\S]*وام نقدی[\\s\\S]*طرح طلایی[\\s\\S]*یادداشت کارشناس: اول[\\s\\S]*یادداشت کارشناس: دوم/);

  // Working hours: Sat–Thu 09:00–18:00 Asia/Tehran (UTC+3:30), independent of the server's own zone.
  // 2026-10-21 is a Wednesday, 2026-10-22 Thursday, 2026-10-24 Saturday.
  assert.equal(isWorkingHours(new Date("2026-10-21T05:29:00Z")), false, "Wed 08:59");
  assert.equal(isWorkingHours(new Date("2026-10-21T05:30:00Z")), true, "Wed 09:00");
  assert.equal(isWorkingHours(new Date("2026-10-21T14:29:00Z")), true, "Wed 17:59");
  assert.equal(isWorkingHours(new Date("2026-10-21T14:30:00Z")), false, "Wed 18:00");
  // Thursday is a working day (Sat–Thu, confirmed 2026-10-23); Friday is the only day off.
  assert.deepEqual([...CALLBACK_CONFIG.workDays].sort(), [0, 1, 2, 3, 4, 6]);
  assert.equal(isWorkingHours(new Date("2026-10-22T05:29:00Z")), false, "Thu 08:59");
  assert.equal(isWorkingHours(new Date("2026-10-22T05:30:00Z")), true, "Thu 09:00");
  assert.equal(isWorkingHours(new Date("2026-10-22T08:00:00Z")), true, "Thu 11:30");
  assert.equal(isWorkingHours(new Date("2026-10-22T14:29:00Z")), true, "Thu 17:59");
  assert.equal(isWorkingHours(new Date("2026-10-22T14:30:00Z")), false, "Thu 18:00");
  assert.equal(isWorkingHours(new Date("2026-10-23T05:30:00Z")), false, "Fri 09:00");
  assert.equal(isWorkingHours(new Date("2026-10-23T08:00:00Z")), false, "Fri 11:30");
  assert.equal(isWorkingHours(new Date("2026-10-24T05:30:00Z")), true, "Sat 09:00");
  // Next-slot handling: «همین الان» is kept only inside working hours, otherwise queued for the next working morning.
  assert.equal(effectiveContactTime("now", new Date("2026-10-22T08:00:00Z")), "now", "Thu 11:30 keeps now");
  assert.equal(effectiveContactTime("now", new Date("2026-10-21T15:00:00Z")), "morning", "Wed 18:30 -> Thu morning");
  assert.equal(effectiveContactTime("now", new Date("2026-10-22T15:00:00Z")), "morning", "Thu 18:30 -> Sat morning");
  assert.equal(effectiveContactTime("now", new Date("2026-10-23T08:00:00Z")), "morning", "Fri -> Sat morning");
  assert.equal(effectiveContactTime("evening", new Date("2026-10-23T08:00:00Z")), "evening", "explicit slot untouched");
  assert.equal(isWorkingHours(new Date("2026-10-23T08:00:00Z")), false, "Friday");
  assert.equal(isWorkingHours(new Date("2026-10-24T08:00:00Z")), true, "Saturday");
  assert.equal(effectiveContactTime("now", new Date("2026-10-21T20:00:00Z")), "morning");
  assert.equal(effectiveContactTime("now", new Date("2026-10-21T08:00:00Z")), "now");
  assert.equal(effectiveContactTime("evening", new Date("2026-10-21T20:00:00Z")), "evening");
  console.log("units ok");
`;

function seed() {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT NOT NULL,mobile TEXT,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE allocation_programs(id INTEGER PRIMARY KEY,name TEXT,is_default INTEGER DEFAULT 0,active INTEGER DEFAULT 1,
      cursor_item_index INTEGER DEFAULT 0,cursor_item_used INTEGER DEFAULT 0,updated_at TEXT);
    CREATE TABLE allocation_program_items(id INTEGER PRIMARY KEY,program_id INTEGER,salesperson_id INTEGER,quota INTEGER,sort_order INTEGER DEFAULT 0);
    CREATE TABLE customers(
      id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT NOT NULL,description TEXT,national_code TEXT,
      birth_date_jalali TEXT,postal_code TEXT,father_name TEXT,address TEXT,email TEXT,verification_status TEXT,
      is_urgent INTEGER DEFAULT 0,created_at TEXT NOT NULL,salesperson_id INTEGER REFERENCES salespersons(id),
      priority INTEGER,status TEXT,merged_into_customer_id INTEGER REFERENCES customers(id),
      registered_by INTEGER,registration_source TEXT,source TEXT,credit_grade TEXT -- crm-default-owner (crm-db ensureColumn)
    );
    CREATE TABLE customer_tag_catalog(tag TEXT PRIMARY KEY,label_fa TEXT NOT NULL,canonical_label TEXT);
    CREATE TABLE customer_tags(customer_id INTEGER NOT NULL,tag TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(customer_id,tag),
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,FOREIGN KEY(tag) REFERENCES customer_tag_catalog(tag));
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    INSERT INTO loan_plans(id,name) VALUES(7,'طرح طلایی');
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT NOT NULL,full_name TEXT,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,
      salesperson_id INTEGER REFERENCES salespersons(id),created_at TEXT NOT NULL DEFAULT '2026-01-01');
    INSERT INTO salespersons(id,name,active) VALUES(1,'کارشناس پیش‌فرض',1),(2,'نگار فروش',1);
    INSERT INTO allocation_programs(id,name,is_default,active) VALUES(1,'پیش‌فرض',1,1);
    INSERT INTO allocation_program_items(program_id,salesperson_id,quota) VALUES(1,1,5);
    INSERT INTO customers(id,name,phone,verification_status,created_at,status) VALUES(50,'مشتری قدیم','09350000001','verified','2026-01-01T00:00:00Z','in_progress');
    INSERT INTO users(id,username,full_name,role) VALUES
      (1,'admin','مدیر','admin'),(2,'reg','رضا ثبت‌نام','registrar'),(3,'sales','نگار فروش','salesperson'),
      (4,'fund','تأمین','funder'),(5,'acc','حسابدار','accounting'),(6,'viewer','فقط تماس','callbacks_only');
    UPDATE users SET salesperson_id=2 WHERE id=3;
  `);
  db.close();
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
const plugin = {
  name: "callback-fixture",
  setup(ctx) {
    ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fx" }));
    ctx.onLoad({ filter: /^db$/, namespace: "fx" }, () => ({ contents: fixtureDbModule, loader: "js" }));
    ctx.onResolve({ filter: /\/customer-notifications$/ }, () => ({ path: "notify", namespace: "fx" }));
    ctx.onLoad({ filter: /^notify$/, namespace: "fx" }, () => ({ contents: notifyModule, loader: "js" }));
  },
};
const banner = { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` };
async function bundle(source, out) {
  await build({ stdin: { contents: source, resolveDir: apiRoot, sourcefile: path.basename(out) + ".ts", loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent", banner, plugins: [plugin] });
}

async function startWorker(env, workerOut) {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  const proc = spawn(process.execPath, [workerOut], { env: { ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not start: " + logs)), 20000);
    const onData = (chunk) => { logs += chunk; if (logs.includes("READY")) { clearTimeout(timer); resolve(); } };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.once("exit", (code) => reject(new Error(`worker exited ${code}: ${logs}`)));
  });
  return { proc, port };
}

try {
  seed();
  await writeFile(notifyLog, "");
  const env = { ...process.env, CRM_DATABASE_PATH: databasePath, NOTIFY_LOG: notifyLog, SESSION_SECRET: "fixture-secret-".padEnd(48, "x"), NODE_ENV: "production", LOG_LEVEL: "silent" };

  const unitOut = path.join(temp, "units.mjs");
  await bundle(unitSource, unitOut);
  const units = spawnSync(process.execPath, [unitOut], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(units.status, 0, units.stderr + units.stdout);
  console.log(units.stdout.trim());

  const workerOut = path.join(temp, "worker.mjs");
  await bundle(workerSource, workerOut);
  let w = await startWorker(env, workerOut);
  child = w.proc;
  const db = () => new DatabaseSync(databasePath, { readOnly: true, timeout: 3000 });
  const one = (sql, ...p) => { const d = db(); try { return d.prepare(sql).get(...p); } finally { d.close(); } };
  const all = (sql, ...p) => { const d = db(); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
  const write = (sql) => { const d = new DatabaseSync(databasePath, { timeout: 3000 }); try { d.exec(sql); } finally { d.close(); } };
  const notifyLines = () => readFileSync(notifyLog, "utf8").split("\n").filter(Boolean);
  const settle = () => new Promise((r) => setTimeout(r, 150));

  // ---- Public intake (kind=callback) ----
  const base = () => `http://127.0.0.1:${w.port}`;
  let ipSeq = 1;
  const post = (body, { ip = `198.51.100.${ipSeq++}` } = {}) => fetch(`${base()}/api/public/leads`, {
    method: "POST", headers: { Origin: "https://nafisvam.com", "Content-Type": "application/json", "X-Real-IP": ip }, body: JSON.stringify(body),
  });
  const cb = (patch = {}) => ({ kind: "callback", name: "سارا محمدی", phone: "09121230001", contactTime: "morning", need: "cash", planId: 7,
    consent: true, startedAt: Date.now() - 6000, website: "", src: "home-callback", utm_source: "google", ...patch });

  const first = await post(cb());
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.deepEqual(Object.keys(firstBody).sort(), ["ok", "trackingCode"]);
  assert.match(firstBody.trackingCode, /^NV-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  let row = one("SELECT * FROM callback_requests WHERE tracking_code=?", firstBody.trackingCode);
  assert.equal(row.status, "new");
  assert.equal(row.contact_time, "morning");
  assert.equal(row.need, "cash");
  assert.equal(row.plan_id, 7);
  assert.equal(row.src, "home-callback");
  assert.equal(row.utm_source, "google");
  assert.equal(row.customer_id, null);
  assert.equal(row.last_activity_at, row.created_at);
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  assert.equal(one("SELECT COUNT(*) n FROM customers").n, 1, "a callback never creates a customer by itself");
  assert.equal(one("SELECT COUNT(*) n FROM public_leads").n, 0);
  // Staff Telegram «درخواست تماس» with the contact time; never the customer SMS.
  await settle();
  let lines = notifyLines();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("callback:"), "callback alert, not notifyNewCustomer");
  const alert = JSON.parse(lines[0].slice("callback:".length));
  assert.equal(alert.phone, "09121230001");
  assert.equal(alert.contactTimeFa, "صبح (۹ تا ۱۳)");
  assert.match(alert.description, /درخواست تماس[\s\S]*وام نقدی[\s\S]*طرح طلایی[\s\S]*home-callback/);
  const notifyEvent = one("SELECT * FROM callback_request_events WHERE callback_id=? AND action='notify'", row.id);
  assert.equal(notifyEvent.user_id, null);
  assert.equal(notifyEvent.to_value, "sent");

  // Duplicate window (10 min) is shared: same phone again, or the request wizard right after → 200, no code, nothing stored.
  const dup = await post(cb({ phone: "۰۹۱۲۱۲۳۰۰۰۱", contactTime: "now" }));
  assert.equal(dup.status, 200);
  assert.deepEqual(await dup.json(), { ok: true });
  const dupLead = await post({ name: "سارا محمدی", phone: "09121230001", need: "cash", amountBand: "unsure", contactTime: "any", consent: true, startedAt: Date.now() - 9000 });
  assert.equal(dupLead.status, 200);
  assert.equal(one("SELECT COUNT(*) n FROM callback_requests").n, 1);
  assert.equal(one("SELECT COUNT(*) n FROM public_leads").n, 0);
  await settle();
  assert.equal(notifyLines().length, 1, "duplicates are not re-alerted");

  // Existing customer: linked, not modified. Minimal payload (no need/plan).
  const linked = await post(cb({ phone: "+98 935 000 0001", need: undefined, planId: undefined, contactTime: "now" }));
  assert.equal(linked.status, 201);
  row = one("SELECT * FROM callback_requests WHERE phone='09350000001'");
  assert.equal(row.customer_id, 50);
  assert.equal(row.need, null);
  assert.equal(row.plan_id, null);
  assert.equal(row.contact_time, effectiveNow(), "«همین الان» outside working hours is queued as next morning");
  await settle();
  {
    const alert = JSON.parse(notifyLines()[1].replace(/^callback:/, ""));
    assert.equal(alert.existingCustomerId, 50, "existing customer: file number passed for the «مشتری قبلی» marker");
    assert.equal(JSON.parse(notifyLines()[0].replace(/^callback:/, "")).existingCustomerId, null, "new phone: no marker");
    assert.equal(notifyLines().length, 2, "exactly one alert for the existing customer's callback");
  }

  // Anti-spam and validation: real errors, nothing stored.
  const before = one("SELECT COUNT(*) n FROM callback_requests").n;
  const expectFail = async (res, status, error, fields) => {
    assert.equal(res.status, status);
    const body = await res.json();
    assert.equal(body.error, error);
    if (fields) assert.deepEqual(body.fields, fields);
  };
  await expectFail(await post(cb({ phone: "09121230009", website: "bot" })), 400, "spam");
  await expectFail(await post(cb({ phone: "09121230009", startedAt: Date.now() - 200 })), 422, "too_fast");
  await expectFail(await post(cb({ phone: "09121230009", contactTime: "midnight" })), 400, "invalid", ["contactTime"]);
  await expectFail(await post(cb({ phone: "09121230009", amountBand: "unsure" })), 400, "invalid", ["unknown_field"]);
  await expectFail(await post(cb({ phone: "09121230009", consent: false })), 400, "invalid", ["consent"]);
  await expectFail(await post(cb({ phone: "09121230009", kind: "other" })), 400, "invalid");
  assert.equal(one("SELECT COUNT(*) n FROM callback_requests").n, before);

  // Daily caps are shared with leads: 3 per phone per day (older entries outside the 10-minute window).
  {
    const stamp = new Date(Date.now() - 3600_000).toISOString();
    write(`INSERT INTO public_leads(source,customer_id,outcome,name,phone,need,amount_band,contact_time,ip_hash,created_at)
      VALUES('website',NULL,'new_customer','x','09121239999','cash','unsure','any','h1','${stamp}');
      INSERT INTO callback_requests(name,phone,contact_time,ip_hash,created_at,updated_at,last_activity_at) VALUES('x','09121239999','now','h2','${stamp}','${stamp}','${stamp}');
      INSERT INTO callback_requests(name,phone,contact_time,ip_hash,created_at,updated_at,last_activity_at) VALUES('x','09121239999','now','h3','${stamp}','${stamp}','${stamp}');`);
  }
  const capped = await post(cb({ phone: "09121239999" }));
  assert.equal(capped.status, 429);
  assert.equal(capped.headers.get("retry-after"), "3600");

  // ---- Staff API ----
  const api = (user, method, p, body) => fetch(`${base()}/api${p}`, {
    method, headers: { "x-user": String(user), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async (res, status = 200) => { assert.equal(res.status, status, await res.clone().text()); return res.json(); };
  const errOf = async (res, status, error) => { assert.equal(res.status, status, await res.clone().text()); const b = await res.json(); assert.equal(b.error, error); return b; };

  // Permission mapping seeded once by access-control.ts; callbacks.assign is admin-only (implicit).
  const perms = (role) => all("SELECT permission FROM role_permissions WHERE role_slug=? AND permission LIKE 'callbacks.%' ORDER BY permission", role).map(r => r.permission);
  assert.deepEqual(perms("registrar"), ["callbacks.manage", "callbacks.view"]);
  assert.deepEqual(perms("salesperson"), ["callbacks.manage", "callbacks.view"]);
  assert.deepEqual(perms("funder"), []);
  assert.deepEqual(perms("accounting"), []);
  for (const u of [4, 5]) {
    assert.equal((await api(u, "GET", "/callback-requests")).status, 403);
    assert.equal((await api(u, "GET", "/callback-requests/badge")).status, 403);
  }
  assert.equal((await api(99, "GET", "/callback-requests")).status, 401);

  // Known queue (fake data).
  {
    const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
    write(`DELETE FROM callback_requests;
      INSERT INTO callback_requests(id,name,phone,contact_time,status,ip_hash,created_at,updated_at,last_activity_at) VALUES
      (101,'صبح قدیمی','09120000101','morning','new','h','${ago(3000)}','${ago(3000)}','${ago(3000)}'),
      (102,'الان جدیدتر','09120000102','now','new','h','${ago(10)}','${ago(10)}','${ago(10)}'),
      (103,'عصر قدیمی‌تر','09120000103','evening','in_progress','h','${ago(5000)}','${ago(5000)}','${ago(30)}'),
      (104,'الان قدیمی','09120000104','now','new','h','${ago(40)}','${ago(40)}','${ago(40)}'),
      (105,'بسته','09120000105','now','called','h','${ago(6000)}','${ago(6000)}','${ago(5)}'),
      (106,'مشتری قدیم','09350000001','morning','new','h','${ago(20)}','${ago(20)}','${ago(20)}');`);
  }
  let list = await json(await api(2, "GET", "/callback-requests"));
  assert.deepEqual(list.items.map(i => i.id), [104, 102, 101, 106, 105, 103], "new+now oldest first, other new oldest first, then recent activity");
  assert.deepEqual(list.counts, { all: 6, new: 4, in_progress: 1, called: 1, no_answer: 0, cancelled: 0 });
  assert.equal(list.meta.slaMinutes, 15);
  assert.equal(list.meta.canAssign, false);
  assert.equal(list.meta.canSeePhone, true);
  const i104 = list.items[0];
  assert.equal(i104.late, true, "now + new + 40 min > SLA");
  assert.equal(list.items[1].late, false, "10 min is within SLA");
  assert.equal(i104.phone, "09120000104");
  assert.equal(i104.phoneMasked, "0912 ••• 0104");
  assert.deepEqual((await json(await api(2, "GET", "/callback-requests?status=new"))).items.map(i => i.id), [104, 102, 101, 106]);
  assert.deepEqual((await json(await api(2, "GET", "/callback-requests?status=called"))).items.map(i => i.id), [105]);
  assert.deepEqual((await json(await api(2, "GET", "/callback-requests?q=قدیمی"))).items.map(i => i.id), [101, 104, 103].sort((a, b) => [104, 101, 103].indexOf(a) - [104, 101, 103].indexOf(b)));
  assert.deepEqual(await json(await api(2, "GET", "/callback-requests/badge")), { new: 4 });

  // Salesperson (assigned scope): sees unassigned + own, may «به من تخصیص بده» (assign to self) but not assign others.
  let sales = await json(await api(3, "GET", "/callback-requests"));
  assert.deepEqual(sales.items.map(i => i.id), [104, 102, 101, 106, 105, 103]);
  assert.equal(sales.meta.canAssign, false);
  await errOf(await api(3, "PATCH", "/callback-requests/101/assign", { userId: 2 }), 403, "forbidden");
  await errOf(await api(2, "PATCH", "/callback-requests/101/assign", { userId: 3 }), 403, "forbidden");
  let item = (await json(await api(3, "PATCH", "/callback-requests/101/assign", { userId: 3 }))).item;
  assert.equal(item.assignedUserId, 3);
  assert.equal(item.assignedUserName, "نگار فروش");
  await errOf(await api(2, "PATCH", "/callback-requests/101/assign", { userId: 2 }), 409, "already_assigned");
  await errOf(await api(3, "PATCH", "/callback-requests/101/assign", { userId: null }), 403, "forbidden");
  // Admin (callbacks.assign) gives one to registrar → it leaves the salesperson's view.
  const assignees = (await json(await api(1, "GET", "/callback-requests/assignees"))).items.map(u => u.id);
  assert.deepEqual([...assignees].sort(), [1, 2, 3], "only users who can see the page");
  await errOf(await api(1, "PATCH", "/callback-requests/103/assign", { userId: 4 }), 400, "invalid_assignee");
  assert.equal((await json(await api(1, "PATCH", "/callback-requests/103/assign", { userId: 2 }))).item.assignedUserId, 2);
  sales = await json(await api(3, "GET", "/callback-requests"));
  assert.ok(!sales.items.some(i => i.id === 103), "assigned to someone else: out of the salesperson's scope");
  assert.equal(sales.counts.in_progress, 0);
  assert.equal((await api(3, "GET", "/callback-requests/103")).status, 404);
  assert.deepEqual((await json(await api(3, "GET", "/callback-requests?who=me"))).items.map(i => i.id), [101]);
  assert.deepEqual((await json(await api(3, "GET", "/callback-requests?who=none"))).items.map(i => i.id), [104, 102, 106, 105]);
  assert.equal((await json(await api(3, "GET", "/callback-requests?who=me"))).counts.all, sales.counts.all, "counts ignore the who filter");

  // Outcome on an unassigned request auto-assigns the actor.
  item = (await json(await api(2, "PATCH", "/callback-requests/104/status", { status: "in_progress" }))).item;
  assert.equal(item.assignedUserId, 2);
  assert.equal(item.late, false);

  // «پاسخ نداد»: counts attempts, ≥ 60 minutes apart, capped at 3, then a cancel suggestion (never automatic).
  item = (await json(await api(3, "PATCH", "/callback-requests/101/status", { status: "no_answer" }))).item;
  assert.equal(item.status, "no_answer");
  assert.equal(item.attempts, 1);
  assert.ok(item.lastAttemptAt);
  assert.ok(item.nextAttemptAt);
  const soon = await errOf(await api(3, "PATCH", "/callback-requests/101/status", { status: "no_answer" }), 409, "too_soon");
  assert.equal(soon.retryAt, item.nextAttemptAt);
  const backdate = () => write(`UPDATE callback_requests SET last_attempt_at='${new Date(Date.now() - 61 * 60_000).toISOString()}' WHERE id=101`);
  backdate();
  assert.equal((await json(await api(3, "PATCH", "/callback-requests/101/status", { status: "no_answer" }))).item.attempts, 2);
  backdate();
  item = (await json(await api(3, "PATCH", "/callback-requests/101/status", { status: "no_answer" }))).item;
  assert.equal(item.attempts, 3);
  assert.equal(item.status, "no_answer", "never auto-cancelled");
  assert.equal(item.suggestCancel, true);
  backdate();
  await errOf(await api(3, "PATCH", "/callback-requests/101/status", { status: "no_answer" }), 409, "max_attempts");
  item = (await json(await api(3, "PATCH", "/callback-requests/101/status", { status: "called" }))).item;
  assert.equal(item.status, "called");
  assert.equal(item.attempts, 3);
  assert.equal(item.suggestCancel, false);
  await errOf(await api(3, "PATCH", "/callback-requests/101/status", { status: "no_answer" }), 409, "invalid_transition");
  await errOf(await api(3, "PATCH", "/callback-requests/101/status", { status: "new" }), 409, "invalid_transition");
  assert.equal((await api(3, "PATCH", "/callback-requests/101/status", { status: "bogus" })).status, 400);
  assert.equal((await json(await api(3, "PATCH", "/callback-requests/101/status", { status: "in_progress" }))).item.status, "in_progress", "reopen");
  assert.equal((await api(3, "PATCH", "/callback-requests/103/status", { status: "called" })).status, 404, "outside scope");
  assert.equal((await api(4, "PATCH", "/callback-requests/102/status", { status: "called" })).status, 403);

  // Cancelling needs a reason; reopening clears it.
  await errOf(await api(2, "PATCH", "/callback-requests/103/status", { status: "cancelled" }), 400, "cancel_reason_required");
  assert.equal((await api(2, "PATCH", "/callback-requests/103/status", { status: "cancelled", cancelReason: "spam" })).status, 400);
  item = (await json(await api(2, "PATCH", "/callback-requests/103/status", { status: "cancelled", cancelReason: "wrong_number" }))).item;
  assert.equal(item.cancelReason, "wrong_number");
  item = (await json(await api(2, "PATCH", "/callback-requests/103/status", { status: "in_progress" }))).item;
  assert.equal(item.cancelReason, null);
  await json(await api(2, "PATCH", "/callback-requests/103/status", { status: "cancelled", cancelReason: "duplicate" }));

  // Notes: several, each in the history; count on the item.
  await json(await api(3, "POST", "/callback-requests/101/notes", { text: "  عصر دوباره تماس بگیرم  " }));
  item = (await json(await api(3, "POST", "/callback-requests/101/notes", { text: "مدارک را آماده دارد" }))).item;
  assert.equal(item.notesCount, 2);
  assert.equal((await api(3, "POST", "/callback-requests/101/notes", { text: "x".repeat(2001) })).status, 400);
  assert.equal((await api(3, "POST", "/callback-requests/101/notes", { text: "   " })).status, 400);

  // Reveal / call are logged; phone only for roles that see customer phones.
  const reveal = await json(await api(3, "POST", "/callback-requests/101/reveal"));
  assert.equal(reveal.phone, "09120000101");
  const beforeCall = one("SELECT last_activity_at a FROM callback_requests WHERE id=101").a;
  await new Promise((r) => setTimeout(r, 5));
  await json(await api(3, "POST", "/callback-requests/101/call"));
  assert.ok(one("SELECT last_activity_at a FROM callback_requests WHERE id=101").a > beforeCall);
  const detail = await json(await api(3, "GET", "/callback-requests/101"));
  assert.deepEqual(detail.events.map(e => e.action),
    ["call", "reveal", "note", "note", "status", "status", "status", "status", "status", "assign"]);
  assert.equal(detail.events[2].toValue, "مدارک را آماده دارد");
  assert.equal(detail.events[3].toValue, "عصر دوباره تماس بگیرم");
  assert.equal(one("SELECT to_value v FROM callback_request_events WHERE callback_id=103 AND action='status' ORDER BY id DESC").v, "cancelled:duplicate");

  // A role with callbacks.* but without customers.view gets masked numbers only and cannot reveal.
  write(`INSERT INTO app_roles(slug,name,customer_scope,is_system,created_at) VALUES('callbacks_only','فقط تماس','all',0,'2026-10-23');
    INSERT INTO role_permissions VALUES('callbacks_only','callbacks.view'),('callbacks_only','callbacks.manage');`);
  const masked = await json(await api(6, "GET", "/callback-requests"));
  assert.equal(masked.meta.canSeePhone, false);
  assert.ok(masked.items.every(i => i.phone === null && /•••/.test(i.phoneMasked)));
  assert.ok(!JSON.stringify(masked).includes("09120000102"), "no full number anywhere in the response");
  await errOf(await api(6, "POST", "/callback-requests/102/reveal"), 403, "forbidden");
  assert.equal(one("SELECT COUNT(*) n FROM callback_request_events WHERE callback_id=102 AND action='reveal'").n, 0);

  // Conversion to a regular lead (customer).
  // ...without customers.create it cannot create customers...
  assert.equal((await api(6, "POST", "/callback-requests/102/convert")).status, 403);
  assert.equal(one("SELECT COUNT(*) n FROM customers").n, 1);
  // ...but may link an existing customer.
  const linkRes = await json(await api(6, "POST", "/callback-requests/106/convert"));
  assert.equal(linkRes.created, false);
  assert.equal(linkRes.item.customerId, 50);
  assert.ok(one("SELECT 1 hit FROM customer_tags WHERE customer_id=50 AND tag='website_lead'"));
  assert.equal(one("SELECT name FROM customers WHERE id=50").name, "مشتری قدیم");
  assert.equal((await api(6, "POST", "/callback-requests/106/convert")).status, 409, "only once");
  // New customer goes to the assignee's salesperson, notes carried into the description; no customer notification.
  const conv = await json(await api(3, "POST", "/callback-requests/101/convert"));
  assert.equal(conv.created, true);
  const created = one("SELECT * FROM customers WHERE id=?", conv.item.customerId);
  assert.equal(created.phone, "09120000101");
  assert.equal(created.verification_status, "unverified");
  assert.equal(created.salesperson_id, 2);
  assert.match(created.description, /درخواست تماس کارشناس از سایت/);
  assert.match(created.description, /یادداشت کارشناس: عصر دوباره تماس بگیرم\nیادداشت کارشناس: مدارک را آماده دارد/);
  // Unassigned: default allocation program.
  const conv2 = await json(await api(2, "POST", "/callback-requests/102/convert"));
  assert.equal(one("SELECT salesperson_id FROM customers WHERE id=?", conv2.item.customerId).salesperson_id, 1);
  assert.equal((await api(2, "POST", "/callback-requests/103/convert")).status, 409, "cancelled requests are not converted");
  await settle();
  assert.ok(notifyLines().every((l) => l.startsWith("callback:")), "no customer SMS/notify for callbacks (intake or conversion)");
  assert.equal(one("SELECT COUNT(*) n FROM public_leads").n, 1, "conversion does not fake a website lead row");

  // The permission seed runs once: an admin's later removal survives a restart.
  write("DELETE FROM role_permissions WHERE role_slug='registrar' AND permission='callbacks.manage'");
  child.kill();
  w = await startWorker(env, workerOut);
  child = w.proc;
  assert.deepEqual(perms("registrar"), ["callbacks.view"]);
  assert.equal((await api(2, "PATCH", "/callback-requests/104/status", { status: "called" })).status, 403);
  assert.equal((await api(2, "GET", "/callback-requests")).status, 200);

  console.log("callback requests fixture ok");
} finally {
  child?.kill();
  await rm(temp, { recursive: true, force: true });
}
