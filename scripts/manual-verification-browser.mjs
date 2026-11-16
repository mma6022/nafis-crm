import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Run from the API package. The database is created from DDL below, never copied
// from a CRM database. No real provider URL or credentials are loaded.
const temp = await mkdtemp(path.join(os.tmpdir(), "manual-browser-"));
const databasePath = path.join(temp, "synthetic.sqlite");
const secret = randomBytes(32).toString("hex");
Object.assign(process.env, {
  CRM_DATABASE_PATH: databasePath, SESSION_SECRET: secret, NODE_ENV: "production",
  SAPI_API_BASE_URL: "https://manual-browser.invalid", SAPI_API_TOKEN: "fixture-only",
  SAPI_RELAY_URL: "", IR_RELAY_SHARED_SECRET: "",
});
const db = new DatabaseSync(databasePath);
db.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,mobile TEXT,telegram_id TEXT,role TEXT,salesperson_id INTEGER,active INTEGER DEFAULT 1,created_at TEXT,priority_colors TEXT);
  CREATE TABLE app_roles(slug TEXT PRIMARY KEY,name TEXT,description TEXT,customer_scope TEXT,is_system INTEGER,created_at TEXT);
  CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT,mobile TEXT,active INTEGER DEFAULT 1);
  CREATE TABLE customers(
    id INTEGER PRIMARY KEY,name TEXT,phone TEXT,description TEXT,national_code TEXT,
    credit_score REAL,credit_rank TEXT,credit_checked_at TEXT,birth_date_jalali TEXT,postal_code TEXT,
    father_name TEXT,address TEXT,email TEXT,first_name TEXT,last_name TEXT,
    verification_status TEXT DEFAULT 'unverified',verification_version INTEGER DEFAULT 0,
    verification_checked_at TEXT,identity_changed_at TEXT,verification_provider TEXT,shahkar_status TEXT,person_info_status TEXT,
    postal_code_info_status TEXT,sana_status TEXT,shahkar_ok INTEGER DEFAULT 0,
    person_info_ok INTEGER DEFAULT 0,postal_code_info_ok INTEGER DEFAULT 0,sana_ok INTEGER DEFAULT 0,
    official_first_name TEXT,official_last_name TEXT,official_father_name TEXT,official_address TEXT,
    official_postal_code TEXT,is_urgent INTEGER DEFAULT 0,created_at TEXT,salesperson_id INTEGER,
    merged_into_customer_id INTEGER,priority INTEGER,status TEXT DEFAULT 'in_progress'
  );
  CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,
    salesperson_name_snapshot TEXT,subject TEXT,customer_request TEXT,expert_notes TEXT,created_at TEXT);
  CREATE TABLE reminders(id INTEGER PRIMARY KEY,user_id INTEGER,customer_id INTEGER,done INTEGER);
  CREATE TABLE customer_tags(customer_id INTEGER,tag TEXT,created_at TEXT);
  CREATE TABLE customer_tag_catalog(tag TEXT PRIMARY KEY,label TEXT,created_at TEXT);
  CREATE TABLE customer_repeat_requests(id INTEGER PRIMARY KEY,customer_id INTEGER,status TEXT);
  CREATE TABLE customer_credit_checks(id INTEGER PRIMARY KEY,customer_id INTEGER);
  CREATE TABLE customer_verification_events(
    id INTEGER PRIMARY KEY,customer_id INTEGER,requested_by_user_id INTEGER,national_code TEXT,
    mobile TEXT,checks_json TEXT,canonical_json TEXT,status TEXT,error_message TEXT,
    created_at TEXT,input_json TEXT,is_current INTEGER DEFAULT 1
  );
  CREATE TABLE customer_manual_verification_requests(
    id INTEGER PRIMARY KEY,customer_id INTEGER,requested_by_user_id INTEGER,status TEXT,
    original_values_json TEXT,source_event_id INTEGER,source_failures_json TEXT,created_at TEXT,resolved_at TEXT
  );
  CREATE UNIQUE INDEX one_pending ON customer_manual_verification_requests(customer_id) WHERE status='pending';
  CREATE TABLE customer_manual_verification_decisions(
    id INTEGER PRIMARY KEY,request_id INTEGER,customer_id INTEGER,actor_user_id INTEGER,decision TEXT,
    source_failures_json TEXT,methods_json TEXT,reasons_json TEXT,original_values_json TEXT,
    corrected_values_json TEXT,created_at TEXT
  );
  CREATE TABLE auth_sessions(id INTEGER PRIMARY KEY,token_hash TEXT,user_id INTEGER,expires_at TEXT,created_at TEXT);
  CREATE TABLE customer_manual_check_decisions(
    id INTEGER PRIMARY KEY,request_id INTEGER,customer_id INTEGER,actor_user_id INTEGER,
    check_key TEXT,decision TEXT,reason TEXT,input_json TEXT,created_at TEXT
  );
`);
const now = new Date().toISOString();
db.prepare("INSERT INTO app_roles(slug,name,customer_scope,created_at) VALUES('salesperson','فروش','assigned',?),('admin','مدیر','all',?)").run(now, now);
db.prepare("INSERT INTO salespersons VALUES(1,'کارشناس آزمایشی')").run();
db.prepare("INSERT INTO users(id,username,full_name,role,salesperson_id,created_at) VALUES(1,'fixture-sales','کارشناس آزمایشی','salesperson',1,?)").run(now);
db.prepare("INSERT INTO users(id,username,full_name,role,created_at) VALUES(2,'fixture-admin','مدیر آزمایشی','admin',?)").run(now);
const nationalCode = (prefix) => {
  const remainder = [...prefix].reduce((sum, digit, i) => sum + Number(digit) * (10 - i), 0) % 11;
  return prefix + (remainder < 2 ? remainder : 11 - remainder);
};
db.prepare(`INSERT INTO customers(id,name,phone,national_code,birth_date_jalali,postal_code,
  credit_score,credit_rank,credit_checked_at,created_at,salesperson_id)
  VALUES(1,'مشتری آزمایشی','09123456789',?,'1370/01/02','1234567890',612,'B',?, ?,1)`)
  .run(nationalCode("001234567"), now, now);
const cookies = {};
for (const [role, userId] of [["sales", 1], ["admin", 2]]) {
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
    .run(createHmac("sha256", secret).update(token).digest("hex"), userId, new Date(Date.now() + 600000).toISOString(), now);
  cookies[role] = `crm_session=${token}`;
}
db.close();

const dbModule = `
  import { DatabaseSync } from "node:sqlite";
  export const databasePath = process.env.CRM_DATABASE_PATH;
  export const crmDb = new DatabaseSync(databasePath);
  export const queryRow = (sql, params=[]) => crmDb.prepare(sql).get(...params);
  export const queryRows = (sql, params=[]) => crmDb.prepare(sql).all(...params);
  export const execute = (sql, params=[]) => Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
  export const executeChanges = (sql, params=[]) => crmDb.prepare(sql).run(...params).changes;
  export const runTransaction = (fn) => { crmDb.exec("BEGIN"); try { const result=fn(); crmDb.exec("COMMIT"); return result; } catch(error) { crmDb.exec("ROLLBACK"); throw error; } };
  export const runImmediateTransaction = (fn) => { crmDb.exec("BEGIN IMMEDIATE"); try { const result=fn(); crmDb.exec("COMMIT"); return result; } catch(error) { crmDb.exec("ROLLBACK"); throw error; } };
`;
const bundle = path.join(temp, "server.mjs");
await build({
  stdin: {
    contents: `
      import express from "express";
      import cookieParser from "cookie-parser";
      import auth from "./src/routes/auth";
      import crm from "./src/routes/crm";
      import { requireAuth } from "./src/lib/auth";
      export { crmDb } from "./src/lib/crm-db";
      export const app = express();
      app.use(express.json(),cookieParser());
      app.use("/api/auth",auth);
      app.get("/api/loan-applications",requireAuth,(_req,res)=>res.json({items:[],total:0,limit:20,offset:0}));
      app.get("/api/customers/:id/credit-checks",requireAuth,(_req,res)=>res.json([]));
      app.get("/api/loan-plans",requireAuth,(_req,res)=>res.json([]));
      app.get("/api/reminders",requireAuth,(_req,res)=>res.json({items:[],total:0}));
      app.use("/api",requireAuth,crm);
    `,
    resolveDir: process.cwd(), sourcefile: "manual-browser-server.ts",
  },
  bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(process.cwd(), "package.json")).href)});` },
  plugins: [{
    name: "synthetic-crm-db",
    setup(context) {
      context.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "synthetic-db", namespace: "fixture" }));
      context.onLoad({ filter: /^synthetic-db$/, namespace: "fixture" }, () => ({ contents: dbModule, loader: "js" }));
    },
  }],
});

let api, vite, chrome, socket, fixture;
const nativeFetch = globalThis.fetch;
let failedChecks = new Set(["shahkarLite", "personInfo", "postalCodeInfo", "sana"]);
let providerCalls = [];
const keys = [...failedChecks];
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.startsWith("https://manual-browser.invalid/")) {
    const endpoint = target.split("/").at(-1);
    const check = { ShahkarLite: "shahkarLite", PersonInfo: "personInfo", PostalCodeInfo: "postalCodeInfo", Sana: "sana" }[endpoint];
    assert.ok(check, `Unexpected provider endpoint: ${endpoint}`);
    providerCalls.push(check);
    return failedChecks.has(check)
      ? Response.json({ error: "fixture unavailable" }, { status: 502 })
      : Response.json({ success: true, data: check === "personInfo" || check === "postalCodeInfo" ? {} : true });
  }
  if (target.startsWith("http://127.0.0.1:")) return nativeFetch(url, options);
  throw new Error(`External request blocked by fixture: ${target}`);
};
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await wait(100);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  fixture = await import(pathToFileURL(bundle).href);
  api = fixture.app.listen(0, "127.0.0.1");
  await new Promise(resolve => api.once("listening", resolve));
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  const dashboard = path.resolve("../crm-dashboard");
  process.env.PORT = "17435";
  process.env.BASE_PATH = "/";
  const requireDashboard = createRequire(path.join(dashboard, "package.json"));
  const { createServer } = await import(pathToFileURL(requireDashboard.resolve("vite")).href);
  vite = await createServer({
    configFile: path.join(dashboard, "vite.config.ts"),
    root: dashboard, base: "/", plugins: [],
    server: { port: 0, host: "127.0.0.1", strictPort: false, proxy: { "/api": apiOrigin } },
  });
  // The config requires these variables even for an isolated Vite instance.
  await vite.listen();
  const uiOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  assert.equal((await nativeFetch(`${uiOrigin}/manual-verifications`)).status, 200);

  const request = async (role, method, route, body, expected) => {
    const response = await nativeFetch(`${apiOrigin}/api${route}`, {
      method, headers: { Cookie: cookies[role], ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    assert.equal(response.status, expected, `${role} ${method} ${route}: ${JSON.stringify(data)}`);
    return data;
  };
  await request("sales", "GET", "/manual-verifications", undefined, 403);
  const creditBefore = fixture.crmDb.prepare("SELECT credit_score,credit_rank,credit_checked_at FROM customers WHERE id=1").get();
  const creditCountBefore = fixture.crmDb.prepare("SELECT count(*) AS n FROM customer_credit_checks").get().n;
  fixture.crmDb.prepare(`INSERT INTO customers(id,name,phone,national_code,birth_date_jalali,postal_code,created_at,salesperson_id)
    VALUES(2,'مشتری دوم آزمایشی','09123456788',?,'1370/01/02','1234567890',?,1)`).run(nationalCode("004567890"), now);
  failedChecks = new Set(["sana"]);
  const mixed = await request("sales", "POST", "/customers/2/verify", {}, 200);
  for (const key of keys) assert.equal(mixed.checks[key].ok, key !== "sana", `Mixed result isolates ${key}`);
  providerCalls = [];
  await request("sales", "POST", "/customers/2/verify", {}, 200);
  assert.deepEqual(providerCalls, ["sana"], "Only the failed provider is retried");
  const separate = await request("sales", "POST", "/customers/2/manual-verification-requests", {}, 201);
  const decisionPath = `/manual-verifications/${separate.id}/checks/sana/decision`;
  await request("sales", "POST", decisionPath, { decision: "approved", reason: "مدرک بررسی شد" }, 403);
  await request("admin", "POST", `/manual-verifications/${separate.id}/checks/personInfo/decision`, { decision: "approved", reason: "مدرک بررسی شد" }, 409);
  await request("admin", "POST", decisionPath, { decision: "approved", reason: "" }, 400);
  const rejected = await request("admin", "POST", decisionPath, { decision: "rejected", reason: "مدرک قابل تأیید نیست" }, 200);
  assert.equal(rejected.currentChecks.sana.status, "manual_rejected");
  assert.equal(rejected.currentChecks.personInfo.ok, true);
  assert.notEqual(fixture.crmDb.prepare("SELECT verification_status FROM customers WHERE id=2").get().verification_status, "verified");
  providerCalls = [];
  await request("sales", "POST", "/customers/2/verify", {}, 200);
  assert.deepEqual(providerCalls, [], "A manually rejected unchanged check cannot be overwritten by automatic inquiry");
  const accepted = await request("admin", "POST", decisionPath, { decision: "approved", reason: "مدرک معتبر بررسی شد" }, 200);
  assert.equal(accepted.status, "approved");
  const cached = await request("sales", "POST", "/customers/2/verify", {}, 200);
  assert.equal(cached.status, "verified");
  assert.equal(cached.checks.sana.providerStatus, "manual_verified");
  assert.deepEqual(providerCalls, [], "Manual verification survives without another provider request");
  assert.equal(fixture.crmDb.prepare("SELECT COUNT(*) AS n FROM customer_manual_check_decisions WHERE customer_id=2").get().n, 2);
  await request("sales", "PATCH", "/customers/2", { birthDateJalali: "1371/01/02" }, 200);
  assert.notEqual(fixture.crmDb.prepare("SELECT verification_status FROM customers WHERE id=2").get().verification_status, "verified", "Changing identity invalidates prior verification");
  fixture.crmDb.prepare(`INSERT INTO customers(id,name,phone,national_code,birth_date_jalali,postal_code,created_at,salesperson_id)
    VALUES(3,'مشتری سوم آزمایشی','09123456787',?,'1370/01/02','1234567890',?,1)`).run(nationalCode("005678901"), now);
  failedChecks = new Set(["personInfo", "sana"]);
  await request("sales", "POST", "/customers/3/verify", {}, 200);
  const partialRequest = await request("sales", "POST", "/customers/3/manual-verification-requests", {}, 201);
  const partialPath = `/manual-verifications/${partialRequest.id}/checks`;
  const partial = await request("admin", "POST", `${partialPath}/personInfo/decision`, { decision: "approved", reason: "مدرک بررسی شد" }, 200);
  assert.equal(partial.status, "pending", "One unresolved check prevents aggregate verification");
  assert.equal(partial.currentChecks.personInfo.status, "manual_verified");
  providerCalls = [];
  const retried = await request("sales", "POST", "/customers/3/verify", {}, 200);
  assert.deepEqual(providerCalls, ["sana"], "Partially approved manual checks survive retries");
  assert.equal(retried.checks.personInfo.providerStatus, "manual_verified");
  assert.equal((await request("admin", "POST", `${partialPath}/sana/decision`, { decision: "approved", reason: "مدرک معتبر بررسی شد" }, 200)).status, "approved");
  failedChecks = new Set(keys);

  chrome = spawn("/repl/tools/bin/chromium", [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--remote-debugging-port=0", `--user-data-dir=${path.join(temp, "chrome")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let debugUrl, debugOutput = "";
  chrome.stderr.on("data", data => {
    debugOutput += String(data);
    debugUrl ||= debugOutput.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  });
  await until(() => debugUrl, "Chromium debugger");
  const endpoint = new URL(debugUrl);
  const tab = await (await nativeFetch(`http://${endpoint.host}/json/new?${encodeURIComponent(uiOrigin + "/loan-applications")}`, { method: "PUT" })).json();
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let commandId = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(expression + "\n" + result.exceptionDetails.text + " " + JSON.stringify(result.result));
    return result.result.value;
  };
  const exists = selector => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  const click = selector => evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error(${JSON.stringify(`Missing ${selector}`)}); el.click(); return true })()`);
  const fill = (selector, value) => evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error(${JSON.stringify(`Missing ${selector}`)}); const setter=Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
  const navigate = async route => {
    await cdp("Page.navigate", { url: uiOrigin + route });
    await until(() => evaluate("document.readyState === 'complete'"), "navigation");
  };
  await until(() => exists("body"), "browser page");
  // Authenticate the sales session without ever using the real login service.
  if (!process.env.DIRECT_ONLY) {
  await cdp("Network.setCookie", { name: "crm_session", value: cookies.sales.split("=")[1], url: uiOrigin });
  await navigate("/loan-applications");
  await until(() => exists("button") && evaluate(`document.body.innerText.includes('ثبت درخواست جدید')`), "loan page");
  await evaluate(`(() => { const button=[...document.querySelectorAll('button')].find(el=>el.textContent.includes('ثبت درخواست جدید')); if(!button) throw Error('New application button missing'); button.click() })()`);
  await until(() => exists('[data-testid="input-customer-search"]'), "wizard customer step");
  await until(() => evaluate(`document.body.innerText.includes('مشتری آزمایشی')`), "synthetic customer in wizard");
   await evaluate(`([...document.querySelectorAll('label')].find(el=>el.querySelector('input[name=customer]') && el.textContent.includes('09123456789'))).querySelector('input').click()`);
  await evaluate(`([...document.querySelectorAll('button')].find(el=>el.textContent.includes('تایید و ادامه'))).click()`);
  await until(() => exists('[data-testid="wizard-step-2"]'), "identity step");
  await click('[data-testid="btn-verify-identity"]');
  await until(() => exists('[data-testid="btn-manual-verification-request"]'), "failed inquiry");
  for (const key of keys) {
    assert.match(await text(`[data-testid="identity-check-${key}"]`), /تأیید نشد.*استعلام این سرویس ناموفق بود/s);
  }
  await click('[data-testid="btn-manual-verification-request"]');
  await until(() => evaluate(`document.querySelector('[data-testid="manual-verification-request-status"]')?.textContent.includes('در انتظار رسیدگی')`), "sent to manager").catch(async error => {
    throw new Error(`${error.message}; UI status=${await text('[data-testid="manual-verification-request-status"]')}; pending=${JSON.stringify(fixture.crmDb.prepare("SELECT id,status FROM customer_manual_verification_requests").all())}; verify=${await text('[data-testid="verify-error"]')}`);
  });
  const rows = await request("admin", "GET", "/manual-verifications", undefined, 200);
  const first = rows.find(row => row.status === "pending");
  assert.ok(first, "sent request is in admin queue");
  const approveBody = Object.fromEntries(keys.map(key => [key, { method: "manual", reason: "مدرک بررسی شد" }]));
  await request("sales", "POST", `/manual-verifications/${first.id}/approve`, { checks: approveBody }, 403);
  await request("sales", "GET", `/manual-verifications/${first.id}`, undefined, 403);
  await request("admin", "POST", `/manual-verifications/${first.id}/approve`, {
    checks: { ...approveBody, sana: { method: "manual" } },
  }, 400);

  // Invalid identity inputs show Persian errors immediately below their form
  // controls rather than only in a generic banner.
  await click('[data-testid="btn-edit-profile"]');
  await fill('[data-testid="input-national-code"]', "0000000000");
  await fill('[data-testid="input-phone"]', "123");
  await fill('[data-testid="input-postal-code"]', "123");
  await click('[data-testid="input-birth-date"]');
  await click('.persian-date-clear');
  await click('[data-testid="btn-save-profile"]');
  assert.deepEqual(await evaluate(`(() => {
    const fields=[...document.querySelectorAll('[data-testid="input-national-code"],[data-testid="input-phone"],[data-testid="input-postal-code"],[data-testid="input-birth-date"]')];
    return [fields.length, fields.filter(el=>/[\u0600-\u06FF]/.test(el.parentElement.querySelector('[role=alert]')?.textContent ?? '')).length];
  })()`), [4, 4], "each identity input displays its own Persian validation error");

  await navigate("/manual-verifications");
  await until(() => evaluate(`!location.pathname.includes('manual-verifications')`), "non-admin redirected");
  assert.equal(await exists('[data-testid="count-pending-verifications"]'), false);
  await cdp("Network.setCookie", { name: "crm_session", value: cookies.admin.split("=")[1], url: uiOrigin });
  await navigate("/manual-verifications");
  await until(() => exists(`[data-testid="button-open-manual-verification-${first.id}"]`), "admin queue");
  await click(`[data-testid="button-open-manual-verification-${first.id}"]`);
  await until(() => exists('[data-testid="check-manual-shahkarLite"]'), "manager decision dialog");
  for (const key of keys) assert.equal(await exists(`[data-testid="textarea-manual-reason-${key}"]`), true);
  await click('[data-testid="button-approve-manual-verification"]');
  for (const key of keys) assert.match(await text(`[data-testid="error-manual-reason-${key}"]`), /دلیل فارسی/);
  assert.equal((await request("admin", "GET", `/manual-verifications/${first.id}`, undefined, 200)).status, "pending");

  // Correct a field, re-query the actual provider adapter and ensure the
  // previous pending decision cannot be reused against the new inputs.
  await fill('[data-testid="input-manual-nationalCode"]', nationalCode("009876543"));
  failedChecks = new Set(["sana"]);
  await click('[data-testid="button-requery-manual-verification"]');
  await until(() => evaluate(`document.querySelector('[data-testid="notice-manual-verification"]')?.textContent.includes('درخواست جایگزین')`), "fresh request opened", 20000);
  assert.equal((await request("admin", "GET", `/manual-verifications/${first.id}`, undefined, 200)).status, "superseded");
  const refreshedRows = await request("admin", "GET", "/manual-verifications", undefined, 200);
  assert.equal(refreshedRows.filter(row => row.status === "pending").length, 1);
  assert.notEqual(refreshedRows.find(row => row.status === "pending").id, first.id);
  assert.deepEqual(refreshedRows.find(row => row.status === "pending").sourceFailures, ["sana"]);
  await request("admin", "POST", `/manual-verifications/${first.id}/approve`, { checks: approveBody }, 409);
  for (const key of keys.filter(key => key !== "sana")) {
    assert.equal(await evaluate(`document.querySelector('[data-testid="radio-system-${key}"]')?.checked`), true);
  }
  await click('[data-testid="button-approve-manual-verification"]');
  assert.match(await text('[data-testid="error-manual-reason-sana"]'), /دلیل فارسی/);
  await fill('[data-testid="textarea-manual-reason-sana"]', "مدرک هویت و تطابق مشخصات به صورت دستی بررسی شد");
  await click('[data-testid="button-reject-check-sana"]');
  await until(() => evaluate(`document.querySelector('[data-testid="check-manual-sana"]')?.textContent.includes('رد شده توسط ادمین')`), "only Sana rejected");
  for (const key of keys.filter(key => key !== "sana")) assert.match(await text(`[data-testid="check-manual-${key}"]`), /موفق/);
  await writeFile(path.resolve("../../attached_assets/manual-identity-review-synthetic.png"),
    Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await fill('[data-testid="textarea-manual-reason-sana"]', "مدرک معتبر بررسی شد و فقط این مشخصه تأیید می‌شود");
  await click('[data-testid="button-approve-check-sana"]');
  await until(() => exists('[data-testid="status-manual-verification-success"]'), "manager approved");
  await until(() => exists('[data-testid="empty-manual-verifications"]'), "queue emptied after approval");
  const after = fixture.crmDb.prepare("SELECT verification_status,credit_score,credit_rank,credit_checked_at,national_code FROM customers WHERE id=1").get();
  assert.equal(after.verification_status, "verified");
  assert.equal(after.national_code, nationalCode("009876543"));
  providerCalls = [];
  assert.equal((await request("sales", "POST", "/customers/1/verify", {}, 200)).status, "verified");
  assert.deepEqual(providerCalls, [], "Completed manual identity is not queried again");
  await cdp("Network.setCookie", { name: "crm_session", value: cookies.sales.split("=")[1], url: uiOrigin });
  await navigate("/loan-applications");
  await until(() => evaluate(`document.body.innerText.includes('ثبت درخواست جدید')`), "return to salesperson");
  await evaluate(`([...document.querySelectorAll('button')].find(el=>el.textContent.includes('ثبت درخواست جدید'))).click()`);
  await until(() => exists('[data-testid="input-customer-search"]'), "reopen wizard");
  await until(() => evaluate(`document.body.innerText.includes('09123456789')`), "verified synthetic customer");
  await evaluate(`([...document.querySelectorAll('label')].find(el=>el.querySelector('input[name=customer]') && el.textContent.includes('09123456789'))).querySelector('input').click()`);
  await evaluate(`([...document.querySelectorAll('button')].find(el=>el.textContent.includes('تایید و ادامه'))).click()`);
  await until(() => exists('[data-testid="wizard-step-2"]'), "reopened identity step");
  await until(() => evaluate(`document.querySelector('[data-testid="btn-verify-identity"]')?.disabled === true`), "manual verification persists in reopened wizard");
  for (const key of keys) {
    const row = await text(`[data-testid="identity-check-${key}"]`);
    assert.match(row, /تأیید/);
    assert.doesNotMatch(row, /ناموفق|تأیید نشد/);
  }
  assert.deepEqual(
    { credit_score: after.credit_score, credit_rank: after.credit_rank, credit_checked_at: after.credit_checked_at },
    { ...creditBefore },
    "identity review does not change credit rank or score",
  );
  assert.equal(fixture.crmDb.prepare("SELECT count(*) AS n FROM customer_credit_checks").get().n, creditCountBefore);
  const decision = fixture.crmDb.prepare("SELECT methods_json,reasons_json FROM customer_manual_verification_decisions ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(decision.methods_json).sana, "manual");
  assert.ok(JSON.parse(decision.reasons_json).sana);
  }
  // Exercise the direct customer-tab action against this isolated API/SQLite,
  // including a customer with no provider attempts and an already verified one.
  fixture.crmDb.prepare(`INSERT INTO customers(id,name,phone,national_code,birth_date_jalali,postal_code,created_at,salesperson_id)
    VALUES(900,'Direct synthetic customer','09121112233',?,'1370/01/02','1234567890',?,1)`)
    .run(nationalCode("008876541"), new Date().toISOString());
  await cdp("Network.setCookie", { name: "crm_session", value: cookies.sales.split("=")[1], url: uiOrigin });
  await navigate("/customers");
  await until(() => exists('[data-testid="button-edit-customer-900"]'), "sales customer list");
  assert.equal(await exists('[data-testid="button-manual-identity-900"]'), false, "salesperson has no direct approval action");
  await cdp("Network.setCookie", { name: "crm_session", value: cookies.admin.split("=")[1], url: uiOrigin });
  await navigate("/customers");
  await until(() => exists('[data-testid="button-manual-identity-900"]'), "admin customer action");
  await click('[data-testid="button-manual-identity-900"]');
  await until(() => exists('[data-testid="manual-identity-address"]'), "direct identity editor");
  assert.equal(await evaluate(`document.querySelector('[data-testid="manual-identity-mobile"]').value`), "09121112233");
  await fill('[data-testid="manual-identity-address"]', "Synthetic address reviewed by admin");
  await fill('[data-testid="manual-identity-fatherName"]', "Synthetic father");
  await fill('[data-testid="manual-identity-reason"]', "Synthetic documents checked by administrator");
  await click('[data-testid="manual-identity-confirm"]');
  providerCalls = [];
  await click('[data-testid="manual-identity-save"]');
  await until(() => evaluate(`!document.querySelector('[data-testid="manual-customer-identity"]')`), "direct approval saved");
  const directRow = fixture.crmDb.prepare("SELECT * FROM customers WHERE id=900").get();
  assert.equal(directRow.verification_status, "verified");
  assert.equal(directRow.address, "Synthetic address reviewed by admin");
  assert.equal(directRow.father_name, "Synthetic father");
  assert.deepEqual(providerCalls, [], "no provider or credit calls for direct approval");
  assert.equal(fixture.crmDb.prepare("SELECT COUNT(*) n FROM customer_credit_checks WHERE customer_id=900").get().n, 0);
  await navigate("/customers");
  await until(() => exists('[data-testid="button-manual-identity-900"]'), "persisted direct customer");
  await click('[data-testid="button-manual-identity-900"]');
  await until(() => exists('[data-testid="manual-identity-address"]'), "reopen verified customer");
  assert.equal(await evaluate(`document.querySelector('[data-testid="manual-identity-address"]').value`), directRow.address);
  await fill('[data-testid="manual-identity-address"]', "Revised synthetic address");
  await fill('[data-testid="manual-identity-reason"]', "Reviewed changed address");
  await click('[data-testid="manual-identity-confirm"]');
  await click('[data-testid="manual-identity-save"]');
  await until(() => evaluate(`!document.querySelector('[data-testid="manual-customer-identity"]')`), "verified customer corrected");
  assert.equal(fixture.crmDb.prepare("SELECT address FROM customers WHERE id=900").get().address, "Revised synthetic address");
  assert.equal(fixture.crmDb.prepare("SELECT COUNT(*) n FROM customer_manual_verification_decisions WHERE customer_id=900").get().n, 2);
  console.log(`Browser fixture passed: ${process.env.DIRECT_ONLY ? "" : "previous failed-check flow plus "}direct customer-tab approval, role isolation, edits, reopen persistence, no provider calls and unchanged credit.`);
} finally {
  if (socket) socket.close();
  if (chrome) { chrome.kill(); await new Promise(resolve => chrome.once("exit", resolve)); }
  if (vite) await vite.close();
  if (api) await new Promise(resolve => api.close(resolve));
  globalThis.fetch = nativeFetch;
  if (fixture?.crmDb) fixture.crmDb.close();
  await rm(temp, { recursive: true, force: true });
}