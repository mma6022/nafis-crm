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
const effectiveNow = () => { const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tehran", hour: "numeric", hourCycle: "h23" }).format(new Date())) % 24; return h >= 9 && h < 18 ? "now" : "morning"; };

const fixtureDbModule = `
  import { DatabaseSync } from "node:sqlite";
  import path from "node:path";
  export const databasePath = path.resolve(process.env.CRM_DATABASE_PATH);
  export const crmDb = new DatabaseSync(databasePath);
  crmDb.exec("PRAGMA foreign_keys=ON");
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
  export async function notifyNewCustomer(id){ appendFileSync(process.env.NOTIFY_LOG, String(id)+"\\n"); }
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
  import { validatePublicCallback, validatePublicLead, publicIntakeType, isWorkingHours, effectivePreferredTime } from "./src/lib/public-leads";
  import { canTransition, compareCallbacks, CALLBACK_TRANSITIONS, callbackDescription } from "./src/lib/callback-requests";

  const now = 1_800_000_000_000;
  const good = { type: "callback", name: " سارا  محمدی ", phone: "۰۹۱۲۳۴۵۶۷۸۹", preferredTime: "now", topic: "goods",
    consent: true, startedAt: now - 8000, website: "", src: "home", utm_source: "google" };
  const ok = validatePublicCallback(good, now);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.callback, { name: "سارا محمدی", phone: "09123456789", preferredTime: "now", topic: "goods", src: "home", utm: { utm_source: "google" } });
  assert.equal(validatePublicCallback({ ...good, topic: undefined }, now).callback.topic, null, "topic is optional");
  assert.equal(validatePublicCallback({ ...good, topic: "" }, now).callback.topic, null);
  for (const t of ["now", "morning", "evening"]) assert.equal(validatePublicCallback({ ...good, preferredTime: t }, now).ok, true, t);
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
  bad({ startedAt: "1" }, "invalid", ["startedAt"]);
  bad({ name: "x" }, "invalid", ["name"]);
  bad({ phone: "02112345678" }, "invalid", ["phone"]);
  bad({ preferredTime: "night" }, "invalid", ["preferredTime"]);
  bad({ preferredTime: undefined }, "invalid", ["preferredTime"]);
  bad({ topic: "house" }, "invalid", ["topic"]);
  bad({ consent: undefined }, "invalid", ["consent"]);
  bad({ need: "cash" }, "invalid", ["unknown_field"]);
  bad({ src: "<x>" }, "invalid", ["src"]);
  assert.equal(publicIntakeType({ type: "callback" }), "callback");
  assert.equal(publicIntakeType({}), "lead");
  assert.equal(publicIntakeType({ type: "lead" }), "lead");
  assert.equal(publicIntakeType({ type: "x" }), undefined);
  // The request wizard rejects callback-only fields and keeps working without a type.
  const lead = { name: "Ali", phone: "09351234567", need: "help", amountBand: "unsure", contactTime: "any", consent: true, startedAt: now - 9000 };
  assert.equal(validatePublicLead(lead, now).ok, true);
  assert.equal(validatePublicLead({ ...lead, type: "lead" }, now).ok, true);
  assert.deepEqual(validatePublicLead({ ...lead, preferredTime: "now" }, now).fields, ["unknown_field"]);

  // Status transitions.
  assert.ok(canTransition("new", "in_progress") && canTransition("new", "no_answer") && canTransition("new", "called") && canTransition("new", "cancelled"));
  assert.ok(canTransition("no_answer", "no_answer"), "another unanswered attempt");
  assert.ok(canTransition("called", "in_progress") && canTransition("cancelled", "in_progress"), "reopen");
  for (const from of Object.keys(CALLBACK_TRANSITIONS)) assert.equal(canTransition(from, "new"), false, "never back to new: " + from);
  assert.equal(canTransition("called", "no_answer"), false);
  assert.equal(canTransition("cancelled", "called"), false);
  assert.equal(canTransition("in_progress", "in_progress"), false);

  // Sorting: «همین الان» first, then oldest first.
  const rows = [
    { id: 1, preferredTime: "morning", createdAt: "2026-10-20T08:00:00Z" },
    { id: 2, preferredTime: "now", createdAt: "2026-10-22T08:00:00Z" },
    { id: 3, preferredTime: "evening", createdAt: "2026-10-19T08:00:00Z" },
    { id: 4, preferredTime: "now", createdAt: "2026-10-21T08:00:00Z" },
    { id: 5, preferredTime: "now", createdAt: "2026-10-21T08:00:00Z" },
  ];
  assert.deepEqual([...rows].sort(compareCallbacks).map(r => r.id), [4, 5, 2, 3, 1]);
  assert.match(callbackDescription({ preferredTime: "evening", topic: "cash", src: "home", notes: null, trackingCode: "NV-AAAA-BBBB" }), /عصر[\\s\\S]*وام نقدی/);
  // Working hours 09:00–18:00 Asia/Tehran (UTC+3:30), independent of the server's own zone.
  assert.equal(isWorkingHours(new Date("2026-10-23T05:29:00Z")), false, "08:59 Tehran");
  assert.equal(isWorkingHours(new Date("2026-10-23T05:30:00Z")), true, "09:00 Tehran");
  assert.equal(isWorkingHours(new Date("2026-10-23T14:29:00Z")), true, "17:59 Tehran");
  assert.equal(isWorkingHours(new Date("2026-10-23T14:30:00Z")), false, "18:00 Tehran");
  assert.equal(isWorkingHours(new Date("2026-10-23T20:00:00Z")), false, "23:30 Tehran");
  assert.equal(effectivePreferredTime("now", new Date("2026-10-23T20:00:00Z")), "morning");
  assert.equal(effectivePreferredTime("now", new Date("2026-10-23T08:00:00Z")), "now");
  assert.equal(effectivePreferredTime("evening", new Date("2026-10-23T20:00:00Z")), "evening");
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
      priority INTEGER,status TEXT,merged_into_customer_id INTEGER REFERENCES customers(id)
    );
    CREATE TABLE customer_tag_catalog(tag TEXT PRIMARY KEY,label_fa TEXT NOT NULL,canonical_label TEXT);
    CREATE TABLE customer_tags(customer_id INTEGER NOT NULL,tag TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(customer_id,tag),
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,FOREIGN KEY(tag) REFERENCES customer_tag_catalog(tag));
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
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
  const db = () => new DatabaseSync(databasePath, { readOnly: true });
  const one = (sql, ...p) => { const d = db(); try { return d.prepare(sql).get(...p); } finally { d.close(); } };
  const all = (sql, ...p) => { const d = db(); try { return d.prepare(sql).all(...p); } finally { d.close(); } };

  // ---- Public intake (type=callback) ----
  const base = () => `http://127.0.0.1:${w.port}`;
  let ipSeq = 1;
  const post = (body, { ip = `198.51.100.${ipSeq++}` } = {}) => fetch(`${base()}/api/public/leads`, {
    method: "POST", headers: { Origin: "https://nafisvam.com", "Content-Type": "application/json", "X-Real-IP": ip }, body: JSON.stringify(body),
  });
  const cb = (patch = {}) => ({ type: "callback", name: "سارا محمدی", phone: "09121230001", preferredTime: "morning", topic: "cash",
    consent: true, startedAt: Date.now() - 6000, website: "", src: "home", ...patch });

  const first = await post(cb());
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.deepEqual(Object.keys(firstBody).sort(), ["ok", "trackingCode"]);
  assert.match(firstBody.trackingCode, /^NV-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  let row = one("SELECT * FROM callback_requests WHERE tracking_code=?", firstBody.trackingCode);
  assert.equal(row.status, "new");
  assert.equal(row.preferred_time, "morning");
  assert.equal(row.topic, "cash");
  assert.equal(row.customer_id, null);
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  assert.equal(one("SELECT COUNT(*) n FROM customers").n, 1, "a callback never creates a customer by itself");
  assert.equal(one("SELECT COUNT(*) n FROM public_leads").n, 0);

  // Duplicate window (10 min) is shared: same phone again, or the request wizard right after → 200, no code, nothing stored.
  const dup = await post(cb({ phone: "۰۹۱۲۱۲۳۰۰۰۱", preferredTime: "now" }));
  assert.equal(dup.status, 200);
  assert.deepEqual(await dup.json(), { ok: true });
  const dupLead = await post({ name: "سارا محمدی", phone: "09121230001", need: "cash", amountBand: "unsure", contactTime: "any", consent: true, startedAt: Date.now() - 9000 });
  assert.equal(dupLead.status, 200);
  assert.equal(one("SELECT COUNT(*) n FROM callback_requests").n, 1);
  assert.equal(one("SELECT COUNT(*) n FROM public_leads").n, 0);

  // Existing customer: linked, not modified.
  const linked = await post(cb({ phone: "+98 935 000 0001", topic: undefined, preferredTime: "now" }));
  assert.equal(linked.status, 201);
  row = one("SELECT * FROM callback_requests WHERE phone='09350000001'");
  assert.equal(row.customer_id, 50);
  assert.equal(row.topic, null);
  assert.equal(row.preferred_time, effectiveNow(), "late «همین الان» is queued as next morning");

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
  await expectFail(await post(cb({ phone: "09121230009", preferredTime: "midnight" })), 400, "invalid", ["preferredTime"]);
  await expectFail(await post(cb({ phone: "09121230009", amountBand: "unsure" })), 400, "invalid", ["unknown_field"]);
  await expectFail(await post(cb({ phone: "09121230009", type: "other" })), 400, "invalid", ["type"]);
  assert.equal(one("SELECT COUNT(*) n FROM callback_requests").n, before);

  // Daily caps are shared with leads: 3 per phone per day (older entries outside the 10-minute window).
  {
    const wdb = new DatabaseSync(databasePath);
    const stamp = new Date(Date.now() - 3600_000).toISOString();
    wdb.prepare(`INSERT INTO public_leads(source,customer_id,outcome,name,phone,need,amount_band,contact_time,ip_hash,created_at)
      VALUES('website',NULL,'new_customer','x','09121239999','cash','unsure','any','h1',?)`).run(stamp);
    wdb.prepare(`INSERT INTO callback_requests(name,phone,preferred_time,ip_hash,created_at,updated_at) VALUES('x','09121239999','now','h2',?,?)`).run(stamp, stamp);
    wdb.prepare(`INSERT INTO callback_requests(name,phone,preferred_time,ip_hash,created_at,updated_at) VALUES('x','09121239999','now','h3',?,?)`).run(stamp, stamp);
    wdb.close();
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

  // Permission mapping seeded once by access-control.ts.
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

  // Seed a known queue (fake data) for sorting.
  {
    const wdb = new DatabaseSync(databasePath);
    wdb.exec("DELETE FROM callback_requests");
    const ins = wdb.prepare(`INSERT INTO callback_requests(id,name,phone,preferred_time,status,ip_hash,created_at,updated_at) VALUES(?,?,?,?,?,'h',?,?)`);
    ins.run(101, 'صبح قدیمی', '09120000101', 'morning', 'new', '2026-10-20T05:00:00Z', '2026-10-20T05:00:00Z');
    ins.run(102, 'الان جدیدتر', '09120000102', 'now', 'new', '2026-10-22T05:00:00Z', '2026-10-22T05:00:00Z');
    ins.run(103, 'عصر قدیمی‌تر', '09120000103', 'evening', 'in_progress', '2026-10-19T05:00:00Z', '2026-10-19T05:00:00Z');
    ins.run(104, 'الان قدیمی', '09120000104', 'now', 'no_answer', '2026-10-21T05:00:00Z', '2026-10-21T05:00:00Z');
    ins.run(105, 'بسته', '09120000105', 'now', 'called', '2026-10-18T05:00:00Z', '2026-10-18T05:00:00Z');
    ins.run(106, 'مشتری قدیم', '09350000001', 'morning', 'new', '2026-10-23T05:00:00Z', '2026-10-23T05:00:00Z');
    wdb.close();
  }
  let list = await json(await api(2, "GET", "/callback-requests"));
  assert.deepEqual(list.items.map(i => i.id), [104, 102, 103, 101, 106], "now first, then oldest first; closed excluded");
  assert.deepEqual(list.counts, { new: 3, open: 5, closed: 1 });
  assert.deepEqual((await json(await api(2, "GET", "/callback-requests?view=closed"))).items.map(i => i.id), [105]);
  assert.deepEqual(await json(await api(2, "GET", "/callback-requests/badge")), { new: 3 });

  // Salesperson (assigned scope): sees only what is assigned to them, cannot assign.
  assert.deepEqual((await json(await api(3, "GET", "/callback-requests"))).items, []);
  assert.deepEqual(await json(await api(3, "GET", "/callback-requests/badge")), { new: 0 });
  assert.equal((await api(3, "GET", "/callback-requests/101")).status, 404);
  assert.equal((await api(3, "PATCH", "/callback-requests/101/assign", { userId: 3 })).status, 403);
  const assignees = (await json(await api(2, "GET", "/callback-requests/assignees"))).items.map(u => u.id);
  assert.deepEqual([...assignees].sort(), [1, 2, 3], "only users who can see the page");
  assert.equal((await api(2, "PATCH", "/callback-requests/101/assign", { userId: 4 })).status, 400, "funder is not an assignee");
  let item = (await json(await api(2, "PATCH", "/callback-requests/101/assign", { userId: 3 }))).item;
  assert.equal(item.assignedUserId, 3);
  assert.equal(item.assignedUserName, "نگار فروش");
  assert.deepEqual((await json(await api(3, "GET", "/callback-requests"))).items.map(i => i.id), [101]);
  assert.deepEqual(await json(await api(3, "GET", "/callback-requests/badge")), { new: 1 });

  // Status transitions with the attempt counter.
  item = (await json(await api(3, "PATCH", "/callback-requests/101/status", { status: "no_answer" }))).item;
  assert.equal(item.status, "no_answer");
  assert.equal(item.attempts, 1);
  assert.ok(item.lastAttemptAt);
  item = (await json(await api(3, "PATCH", "/callback-requests/101/status", { status: "no_answer" }))).item;
  assert.equal(item.attempts, 2, "each unanswered call counts");
  item = (await json(await api(3, "PATCH", "/callback-requests/101/status", { status: "called" }))).item;
  assert.equal(item.status, "called");
  assert.equal(item.attempts, 2);
  assert.equal((await api(3, "PATCH", "/callback-requests/101/status", { status: "no_answer" })).status, 409);
  assert.equal((await api(3, "PATCH", "/callback-requests/101/status", { status: "new" })).status, 409);
  assert.equal((await api(3, "PATCH", "/callback-requests/101/status", { status: "bogus" })).status, 400);
  assert.equal((await json(await api(3, "PATCH", "/callback-requests/101/status", { status: "in_progress" }))).item.status, "in_progress", "reopen");
  assert.equal((await api(3, "PATCH", "/callback-requests/102/status", { status: "called" })).status, 404, "outside scope");
  assert.equal((await api(4, "PATCH", "/callback-requests/102/status", { status: "called" })).status, 403);

  // Notes.
  item = (await json(await api(3, "PATCH", "/callback-requests/101/notes", { notes: "  عصر دوباره تماس بگیرم  " }))).item;
  assert.equal(item.notes, "عصر دوباره تماس بگیرم");
  assert.equal((await api(3, "PATCH", "/callback-requests/101/notes", { notes: "x".repeat(2001) })).status, 400);
  const detail = await json(await api(3, "GET", "/callback-requests/101"));
  assert.deepEqual(detail.events.map(e => e.action), ["notes", "status", "status", "status", "status", "assign"]);

  // Conversion to a regular lead (customer).
  // A role with callbacks.* but without customers.create cannot create customers through conversion...
  {
    const wdb = new DatabaseSync(databasePath);
    wdb.exec(`INSERT INTO app_roles(slug,name,customer_scope,is_system,created_at) VALUES('callbacks_only','فقط تماس','all',0,'2026-10-23');
      INSERT INTO role_permissions VALUES('callbacks_only','callbacks.view'),('callbacks_only','callbacks.manage');`);
    wdb.close();
  }
  assert.equal((await api(6, "POST", "/callback-requests/102/convert")).status, 403);
  assert.equal(one("SELECT COUNT(*) n FROM customers").n, 1);
  // ...but may link an existing customer.
  const linkRes = await json(await api(6, "POST", "/callback-requests/106/convert"));
  assert.equal(linkRes.created, false);
  assert.equal(linkRes.item.customerId, 50);
  assert.ok(one("SELECT 1 hit FROM customer_tags WHERE customer_id=50 AND tag='website_lead'"));
  assert.equal(one("SELECT name FROM customers WHERE id=50").name, "مشتری قدیم");
  assert.equal((await api(6, "POST", "/callback-requests/106/convert")).status, 409, "only once");
  // New customer goes to the assignee's salesperson; no customer notification.
  const conv = await json(await api(3, "POST", "/callback-requests/101/convert"));
  assert.equal(conv.created, true);
  const created = one("SELECT * FROM customers WHERE id=?", conv.item.customerId);
  assert.equal(created.phone, "09120000101");
  assert.equal(created.verification_status, "unverified");
  assert.equal(created.salesperson_id, 2);
  assert.match(created.description, /درخواست تماس کارشناس از سایت/);
  assert.match(created.description, /یادداشت کارشناس: عصر دوباره تماس بگیرم/);
  // Unassigned: default allocation program.
  const conv2 = await json(await api(2, "POST", "/callback-requests/102/convert"));
  assert.equal(one("SELECT salesperson_id FROM customers WHERE id=?", conv2.item.customerId).salesperson_id, 1);
  await json(await api(2, "PATCH", "/callback-requests/103/status", { status: "cancelled" }));
  assert.equal((await api(2, "POST", "/callback-requests/103/convert")).status, 409, "cancelled requests are not converted");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(readFileSync(notifyLog, "utf8").trim(), "", "no customer SMS/notify for callback leads (intake or conversion)");
  assert.equal(one("SELECT COUNT(*) n FROM public_leads").n, 1, "conversion does not fake a website lead row");

  // The permission seed runs once: an admin's later removal survives a restart.
  {
    const wdb = new DatabaseSync(databasePath);
    wdb.exec("DELETE FROM role_permissions WHERE role_slug='registrar' AND permission='callbacks.manage'");
    wdb.close();
  }
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
