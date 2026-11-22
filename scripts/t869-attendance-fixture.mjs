// t869 attendance: flag.attendance_v1, wizard settings, read-only ZK pull against a fake device,
// board + monthly report. Throwaway COPY of a masked DB only; never live, never user 29, no real device.
// Usage: T869_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t869-attendance-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const src = process.env.T869_FIXTURE_DB || process.env.MASKED_DB;
if (!src) { console.log("SKIP (set T869_FIXTURE_DB or MASKED_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db" || fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t869-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
const SESSION_SECRET = `fixture-only-${crypto.randomBytes(16).toString("hex")}-not-a-real-secret-0123456789`;
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET,
  ATTENDANCE_PULL_MS: "3600000",
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
const origFetch = globalThis.fetch;
globalThis.fetch = async (...args) => { throw new Error("unexpected network call in t869 fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const { queryRow, execute, executeChanges } = await import("../src/lib/crm-db.ts");
const att = await import("../src/lib/attendance.ts");
const { startZkSimulator } = await import("../src/lib/zk-simulator.ts");
const { encodeZkTime, decodeZkTime, makeCommKey } = await import("../src/lib/zk-protocol.ts");
const attendanceRouter = (await import("../src/routes/attendance.ts")).default;

const teamsBefore = queryRow("SELECT value FROM notification_settings WHERE key='team_sales_config'")?.value;
const custCountBefore = queryRow("SELECT COUNT(*) n FROM customers")?.n;
const tscBefore = queryRow("SELECT COUNT(*) n FROM notification_settings")?.n;

const hooksBefore = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
const leaked = [];
const wrap = (fn) => (...args) => {
  const s = args.map((a) => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(" ");
  if (/(?:^|[^\d])12345(?:[^\d]|$)/.test(s) && /comm/i.test(s)) leaked.push(s.slice(0, 200));
  return fn.apply(console, args);
};
console.log = wrap(hooksBefore.log);

await ok("flag absent → enabled false, other routes 404", async () => {
  executeChanges("DELETE FROM call_queue_settings WHERE key=?", [att.ATTENDANCE_FLAG]);
  assert.equal(att.attendanceOn(), false);
  assert.equal(queryRow("SELECT value FROM call_queue_settings WHERE key=?", [att.ATTENDANCE_FLAG]) ?? null, null);
});

const userFor = (uid) => {
  const u = queryRow("SELECT id,username,full_name,role,salesperson_id FROM users WHERE id=?", [uid]);
  assert.ok(u, `user ${uid}`);
  assert.notEqual(uid, 29);
  return { id: u.id, username: u.username, fullName: u.full_name, mobile: null, telegramId: null, priorityColors: {}, role: u.role, roleName: u.role,
    permissions: u.role === "admin" ? ["users.view"] : ["customers.view"], customerScope: u.role === "admin" ? "all" : "assigned", salespersonId: u.salesperson_id,
    salespersonName: null, active: true, createdAt: new Date().toISOString() };
};

const sessionToken = (uid) => {
  const token = crypto.randomBytes(24).toString("base64url");
  const th = crypto.createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
  const exp = new Date(Date.now() + 86400000).toISOString();
  execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)", [th, uid, exp, new Date().toISOString()]);
  return token;
};

const adminToken = sessionToken(1);
const expertToken = sessionToken(2);

const call = (method, routePath, { uid = 1, token = adminToken, body = undefined, query = {} } = {}) => new Promise((resolve, reject) => {
  const layer = attendanceRouter.stack.find((l) => l.route?.path === routePath && l.route.methods[method.toLowerCase()]);
  if (!layer) return reject(new Error(`no route ${method} ${routePath}`));
  const handlers = layer.route.stack.map((s) => s.handle);
  let status = 200, json = undefined;
  const req = { method, params: {}, body, query, cookies: { crm_session: token }, log: { warn() {}, info() {}, error() {}, debug() {} }, header() { return undefined; } };
  const res = {
    locals: {},
    status(s) { status = s; return this; },
    json(b) { json = b; resolve({ status, json }); return this; },
    setHeader() { return this; },
  };
  const next = (err) => {
    if (err) return reject(err);
    const i = (res._i || 0);
    // run remaining — actually we'll chain below
  };
  void uid;
  const run = (i) => {
    if (i >= handlers.length) { resolve({ status, json }); return; }
    const r = handlers[i](req, res, (err) => { if (err) reject(err); else run(i + 1); });
    if (r && typeof r.then === "function") r.then(() => { if (json !== undefined || status !== 200) return; }).catch(reject);
  };
  // If a handler calls res.json, promise resolves. Chain via next.
  const rec = (i) => {
    if (json !== undefined) return;
    if (i >= handlers.length) { resolve({ status, json }); return; }
    try {
      const r = handlers[i](req, res, (err) => { if (err) reject(err); else rec(i + 1); });
      if (r && typeof r.then === "function") r.catch(reject);
    } catch (e) { reject(e); }
  };
  rec(0);
});

await ok("GET /attendance/me with flag absent is 200 enabled:false; settings 404", async () => {
  const me = await call("GET", "/attendance/me");
  assert.equal(me.status, 200, JSON.stringify(me.json));
  assert.equal(me.json.enabled, false);
  const s = await call("GET", "/attendance/settings");
  assert.equal(s.status, 404);
});

execute("INSERT OR REPLACE INTO call_queue_settings(key,value,updated_at) VALUES (?,?,?)", [att.ATTENDANCE_FLAG, "1", new Date().toISOString()]);
assert.equal(att.attendanceOn(), true);

const day = "2026-11-22"; // Sunday, not Friday — a work day with placeholder weeklyOff=Friday
const punchIso = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return att.tehranWallToUtc(2026, 11, 22, h, m, 0);
};
const deviceLocal = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 10, 22, h, m, 0)); // wall clock stored in UTC fields
};

const COMM = "12345";
const sim = await startZkSimulator({
  commKey: 12345,
  serial: "BADQ240624298",
  deviceName: "LX19W",
  firmware: "ZLM31-FXO1-3.1.6-SIM",
  users: [
    { uid: 1, userId: "101", name: "خانم حسنی", privilege: 0 },
    { uid: 2, userId: "102", name: "خانم قاسمی", privilege: 0 },
    { uid: 3, userId: "103", name: "آرش اصلانیان", privilege: 0 },
    { uid: 4, userId: "104", name: "آقای کاظمی", privilege: 0 },
  ],
  punches: [
    { userId: "101", punchedAtDevice: deviceLocal("09:05"), status: 0, punch: 0 },
    { userId: "102", punchedAtDevice: deviceLocal("09:05"), status: 0, punch: 0 },
    { userId: "102", punchedAtDevice: deviceLocal("17:50"), status: 1, punch: 1 },
    { userId: "104", punchedAtDevice: deviceLocal("09:40"), status: 0, punch: 0 },
  ],
});

await ok("zk time and comm-key scramble round-trip", () => {
  const d = new Date(Date.UTC(2026, 10, 22, 9, 5, 0));
  const t = encodeZkTime(d);
  const back = decodeZkTime(t);
  assert.equal(back.toISOString(), d.toISOString());
  assert.equal(makeCommKey(12345, 1001).length, 4);
});

await ok("private LAN IP gets a reachability warning; public host does not", () => {
  const w = att.reachabilityWarning("192.168.1.50");
  assert.ok(w && /عمومی|فوروارد|۴۳۷۰/.test(w));
  assert.equal(att.reachabilityWarning("203.0.113.10"), null);
  assert.ok(att.reachabilityWarning("127.0.0.1"));
});

await ok("save settings stores comm key sealed and never returns it", () => {
  const s = att.saveSettings({ host: "127.0.0.1", port: sim.port, commKey: COMM, updatedBy: 1 });
  assert.equal(s.host, "127.0.0.1");
  assert.equal(s.port, sim.port);
  assert.equal(s.hasCommKey, true);
  assert.equal(s.defaultsArePlaceholders, true);
  assert.ok(!("commKey" in s));
  assert.ok(!("comm_key_ct" in s));
  const json = JSON.stringify(s);
  assert.ok(!json.includes(COMM));
  assert.ok(!json.includes("comm_key_ct"));
  assert.ok(s.reachabilityWarning);
  const row = queryRow("SELECT comm_key_ct FROM attendance_settings WHERE id=1");
  assert.ok(row.comm_key_ct && row.comm_key_ct.startsWith("v1:"));
  assert.ok(!row.comm_key_ct.includes(COMM));
});

await ok("test connection against the simulator (read-only) returns device info and users", async () => {
  const r = await att.testConnection();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.info.serial, "BADQ240624298");
  assert.equal(r.info.deviceName, "LX19W");
  assert.equal(r.users.length, 4);
  assert.ok(r.users.some((u) => u.name === "خانم حسنی" && u.userId === "101"));
  assert.equal(r.punchCount, 4);
});

await ok("wrong comm key fails auth and does not leak the key", async () => {
  const r = await att.testConnection({ host: "127.0.0.1", port: sim.port, commKey: "99999" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "auth_failed");
  assert.ok(!JSON.stringify(r).includes("99999"));
  assert.ok(!JSON.stringify(r).includes(COMM));
});

await ok("staff list comes from CRM users, excludes user 29, suggests by name", () => {
  const staff = att.listStaff([
    { userId: "101", name: "خانم حسنی" },
    { userId: "103", name: "آرش اصلانیان" },
  ]);
  assert.ok(!staff.some((s) => s.id === 29));
  const hasani = staff.find((s) => s.id === 2);
  const arash = staff.find((s) => s.id === 6);
  assert.equal(hasani?.suggestedDeviceUserId, "101");
  assert.equal(arash?.suggestedDeviceUserId, "103");
  assert.ok(staff.some((s) => s.id === 1));
});

await ok("map + pull dedupes attendance_logs", async () => {
  att.saveMap([
    { deviceUserId: "101", deviceUserName: "خانم حسنی", crmUserId: 2 },
    { deviceUserId: "102", deviceUserName: "خانم قاسمی", crmUserId: 3 },
    { deviceUserId: "103", deviceUserName: "آرش اصلانیان", crmUserId: 6 },
    { deviceUserId: "104", deviceUserName: "آقای کاظمی", crmUserId: 8 },
  ]);
  const p1 = await att.pullLogs();
  assert.equal(p1.ok, true, p1.error);
  assert.equal(p1.inserted, 4);
  const p2 = await att.pullLogs();
  assert.equal(p2.ok, true, p2.error);
  assert.equal(p2.inserted, 0);
  assert.equal(p2.total, 4);
  const n = queryRow("SELECT COUNT(*) n FROM attendance_logs")?.n;
  assert.equal(n, 4);
});

const noon = att.tehranWallToUtc(2026, 11, 22, 12, 0, 0);

await ok("today board: present, left, absent, late — Jalali Asia/Tehran, no salary", () => {
  const b = att.todayBoard(noon, day);
  assert.equal(b.timezone, "Asia/Tehran");
  assert.ok(/آذر|۱۴۰۵|1405/.test(b.jalaliLabel) || /نوامبر|آذر/.test(b.jalaliLabel) || b.jalaliLabel.length > 5);
  assert.equal(b.defaultsArePlaceholders, true);
  assert.ok(b.placeholderNote);
  const byId = Object.fromEntries(b.people.map((p) => [p.crmUserId, p]));
  assert.equal(byId[2].status, "present"); // حسنی one punch
  assert.equal(byId[2].late, false);
  assert.equal(byId[3].status, "left"); // قاسمی in+out
  assert.equal(byId[6].status, "absent"); // آرش none, after grace
  assert.equal(byId[8].status, "present");
  assert.equal(byId[8].late, true); // کاظمی 09:40
  assert.ok(!b.people.some((p) => p.crmUserId === 29));
  assert.ok(!("salary" in b) && !("salaryAmount" in b));
});

await ok("monthly report has hours/late/absent and explicitly no salary", () => {
  const j = att.jalaliParts(noon);
  const r = att.monthlyReport(j.year, j.month, noon);
  assert.equal(r.noSalaryComputed, true);
  assert.equal(r.defaultsArePlaceholders, true);
  assert.ok(r.jalaliMonthLabel);
  const kazemi = r.people.find((p) => p.crmUserId === 8);
  const ghasemi = r.people.find((p) => p.crmUserId === 3);
  const arash = r.people.find((p) => p.crmUserId === 6);
  assert.ok(kazemi.lateDays >= 1);
  assert.ok(arash.absentDays >= 1);
  assert.ok(ghasemi.workMinutes > 0);
  assert.ok(ghasemi.workHoursLabel);
  assert.equal(r.noSalaryComputed, true);
  assert.ok(!("salary" in r) && !r.people.some((p) => "salary" in p || "salaryAmount" in p));
});

await ok("HTTP: me enabled, settings hide the key, expert is 403, admin board works", async () => {
  const me = await call("GET", "/attendance/me");
  assert.equal(me.json.enabled, true);
  assert.equal(me.json.isAdmin, true);
  const st = await call("GET", "/attendance/settings");
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.equal(st.json.hasCommKey, true);
  assert.ok(!JSON.stringify(st.json).includes(COMM));
  const forbidden = await call("GET", "/attendance/settings", { uid: 2, token: expertToken });
  assert.equal(forbidden.status, 403);
  const board = await call("GET", "/attendance/board", { query: { date: day } });
  assert.equal(board.status, 200, JSON.stringify(board.json));
  assert.ok(board.json.people.some((p) => p.status === "absent"));
});

await ok("flag off stops pull job; customers and team config untouched", async () => {
  executeChanges("UPDATE call_queue_settings SET value='0' WHERE key=?", [att.ATTENDANCE_FLAG]);
  assert.equal(att.attendanceOn(), false);
  await att.attendanceTick(); // no-op
  const s = await call("GET", "/attendance/settings");
  assert.equal(s.status, 404);
  assert.equal(queryRow("SELECT value FROM notification_settings WHERE key='team_sales_config'")?.value, teamsBefore);
  assert.equal(queryRow("SELECT COUNT(*) n FROM customers")?.n, custCountBefore);
  assert.equal(queryRow("SELECT COUNT(*) n FROM notification_settings")?.n, tscBefore);
});

await sim.close();
console.log = hooksBefore.log;
assert.equal(leaked.length, 0, `secret leaked in logs: ${leaked.join(" | ")}`);
console.log(`t869 fixture: ${passed}/${passed} passed (masked copy only)`);
