import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Synthetic, disposable database only. Never opens production data.
const temp = await mkdtemp(path.join(os.tmpdir(), "crm-public-leads-fixture-"));
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = path.join(temp, "fixture.sqlite");
const notifyLog = path.join(temp, "notify.log");
let child;

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
  export async function notifyNewCustomer(id, options){ appendFileSync(process.env.NOTIFY_LOG, JSON.stringify({ id, options })+"\\n"); }
  export async function notifyWebsiteCallback(alert){ appendFileSync(process.env.NOTIFY_LOG, JSON.stringify({ callback: alert })+"\\n"); return "sent"; }
`;

const workerSource = `
  import express from "express";
  import cors from "cors";
  import { mountPublicLeads } from "./src/routes/public-leads";
  const app = express();
  // Same order as src/app.ts: public leads first, then the permissive global CORS and origin check.
  mountPublicLeads(app);
  app.use(cors({ credentials: true, origin: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    if (["GET","HEAD","OPTIONS"].includes(req.method) || !req.headers.origin) return next();
    const expected = req.headers["x-forwarded-host"] ?? req.headers.host;
    try { if (new URL(req.headers.origin).host !== expected) return res.status(403).json({ error: "Invalid request origin" }); }
    catch { return res.status(403).json({ error: "Invalid request origin" }); }
    next();
  });
  app.post("/api/other", (_req, res) => res.json({ ok: "other" }));
  app.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("READY"));
`;

const unitSource = `
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  import { publicPlanGuarantees, conditionGuaranteeTypes } from "./src/lib/public-plan-guarantees";
  import { trustedClientIp } from "./src/lib/client-ip";
  import { validatePublicLead, normalizeLeadPhone, leadDescription, newTrackingCode, AMOUNT_BANDS } from "./src/lib/public-leads";
  import { AttemptLimiter } from "./src/routes/public-leads";

  const req = (peer, realIp) => ({ socket: { remoteAddress: peer }, get: (h) => (h === "X-Real-IP" ? realIp : undefined) });
  assert.equal(trustedClientIp(req("127.0.0.1", "5.6.7.8")), "5.6.7.8");
  assert.equal(trustedClientIp(req("::ffff:127.0.0.1", "2a01::1")), "2a01::1");
  assert.equal(trustedClientIp(req("203.0.113.9", "5.6.7.8")), "203.0.113.9", "direct peers cannot spoof X-Real-IP");
  assert.equal(trustedClientIp(req("127.0.0.1", "1.2.3.4, 5.6.7.8")), "127.0.0.1", "malformed header falls back to peer");
  assert.equal(trustedClientIp(req("127.0.0.1", undefined)), "127.0.0.1");

  assert.equal(normalizeLeadPhone("۰۹۱۲۳۴۵۶۷۸۹"), "09123456789");
  assert.equal(normalizeLeadPhone("+98 912 345 6789"), "09123456789");
  assert.equal(normalizeLeadPhone("9123456789"), "09123456789");
  assert.equal(normalizeLeadPhone("02191090380"), undefined);
  assert.equal(normalizeLeadPhone("0912345678"), undefined);

  const now = 1_800_000_000_000;
  const good = { name: " علی  رضایی ", phone: "۰۹۱۲۳۴۵۶۷۸۹", need: "cash", amountBand: "100-300", contactTime: "morning",
    consent: true, startedAt: now - 20_000, website: "", src: "finder", planId: 10, term: 24, utm_source: "instagram" };
  const ok = validatePublicLead(good, now);
  assert.equal(ok.ok, true);
  assert.equal(ok.lead.name, "علی رضایی");
  assert.equal(ok.lead.phone, "09123456789");
  assert.deepEqual(ok.lead.utm, { utm_source: "instagram" });
  assert.match(leadDescription(ok.lead, "طرح خورشید"), /طرح خورشید \\(#10\\)، 24 ماهه/);
  const bad = (patch, code, fields) => {
    const r = validatePublicLead({ ...good, ...patch }, now);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.error, code, JSON.stringify(patch));
    if (fields) assert.deepEqual(r.fields, fields);
    assert.ok(!JSON.stringify(r).includes("0912"), "never echoes input");
  };
  bad({ website: "http://spam" }, "spam");
  bad({ startedAt: now - 500 }, "too_fast");
  bad({ startedAt: now - 2 * 24 * 3600_000 }, "expired");
  bad({ startedAt: now + 3600_000 }, "expired");
  bad({ startedAt: "x" }, "invalid", ["startedAt"]);
  bad({ name: "a" }, "invalid", ["name"]);
  bad({ name: "http://x.y" }, "invalid", ["name"]);
  bad({ name: "Ali\\u202e" }, "invalid", ["name"]);
  bad({ phone: "123" }, "invalid", ["phone"]);
  bad({ need: "loan" }, "invalid", ["need"]);
  bad({ amountBand: "1-2" }, "invalid", ["amountBand"]);
  bad({ contactTime: "night" }, "invalid", ["contactTime"]);
  bad({ consent: "yes" }, "invalid", ["consent"]);
  bad({ planId: -1 }, "invalid", ["planId"]);
  bad({ term: 999 }, "invalid", ["term"]);
  bad({ src: "<script>" }, "invalid", ["src"]);
  bad({ utm_campaign: "<b>" }, "invalid", ["utm_campaign"]);
  bad({ admin: true }, "invalid", ["unknown_field"]);
  assert.equal(validatePublicLead([], now).ok, false);
  assert.equal(validatePublicLead(null, now).ok, false);
  const minimal = { name: "Sara", phone: "09351234567", need: "help", amountBand: "unsure", contactTime: "any", consent: true, startedAt: now - 9000 };
  assert.equal(validatePublicLead(minimal, now).ok, true);
  // Site reqBands() keys (received amount, million toman) and the legacy coarse keys are both accepted.
  for (const amountBand of ["0-100", "100-200", "200-300", "300-500", "500-1000", "1000-up", "upto100", "100-300", "500plus", "unsure"]) {
    const r = validatePublicLead({ ...minimal, amountBand }, now);
    assert.equal(r.ok, true, amountBand);
    assert.doesNotMatch(leadDescription(r.lead), /undefined/, amountBand);
  }
  assert.equal(AMOUNT_BANDS.length, 10);
  bad({ amountBand: "1000-2000" }, "invalid", ["amountBand"]);

  // Tracking code: short, fixed shape, unambiguous alphabet, CSPRNG (no collisions in a large sample).
  const codes = new Set();
  for (let k = 0; k < 20000; k++) {
    const c = newTrackingCode();
    assert.match(c, /^NV-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/, c);
    codes.add(c);
  }
  assert.equal(codes.size, 20000, "no collisions");
  const seen = new Set([...codes].join("").replace(/NV|-/g, ""));
  assert.equal(seen.size, 30, "every symbol of the 30-char alphabet is used");

  const limiter = new AttemptLimiter(1000, 2);
  assert.equal(limiter.take("a", 0), 0);
  assert.equal(limiter.take("a", 10), 0);
  assert.ok(limiter.take("a", 20) > 0);
  assert.equal(limiter.take("b", 20), 0, "keys are independent");
  assert.equal(limiter.take("a", 1500), 0, "window slides");

  // Guarantee derivation, on condition shapes copied from the live public plan API (2026-10-23).
  const c = (collateralType, needsGuarantor, guarantorCollateralType) => ({ collateralType, needsGuarantor, guarantorCollateralType });
  assert.deepEqual(conditionGuaranteeTypes(c("none", false, "none")), ["none"]);
  assert.deepEqual(conditionGuaranteeTypes(c("none", true, "digital_check")), ["cheque", "guarantor"]);
  assert.deepEqual(conditionGuaranteeTypes(c("promissory", true, "promissory")), ["promissory", "guarantor"]);
  assert.deepEqual(conditionGuaranteeTypes(c("none", false, "physical_check")), ["none"], "guarantor collateral ignored without guarantor");
  assert.deepEqual(publicPlanGuarantees({ conditions: [c("physical_check", true, "physical_check"), c("physical_check", false, "none")] }),
    { guaranteeTypes: ["cheque", "guarantor"], guaranteeOptions: [["cheque", "guarantor"], ["cheque"]] });
  assert.deepEqual(publicPlanGuarantees({ conditions: [c("promissory", false, "none")] }),
    { guaranteeTypes: ["promissory"], guaranteeOptions: [["promissory"]] });
  assert.deepEqual(publicPlanGuarantees({ conditions: [c("none", false, "none"), c("none", true, "none")] }),
    { guaranteeTypes: ["guarantor", "none"], guaranteeOptions: [["none"], ["guarantor"]] });
  assert.deepEqual(publicPlanGuarantees({ customerCheck: "physical", conditions: [] }),
    { guaranteeTypes: ["cheque"], guaranteeOptions: [["cheque"]] }, "plan-level fallback");
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
    CREATE UNIQUE INDEX idx_customer_tag_catalog_canonical_label ON customer_tag_catalog(canonical_label);
    INSERT INTO customer_tag_catalog VALUES('repeat_request','درخواست چند باره','درخواست چند باره');
    CREATE TABLE customer_tags(customer_id INTEGER NOT NULL,tag TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(customer_id,tag),
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,FOREIGN KEY(tag) REFERENCES customer_tag_catalog(tag));
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    INSERT INTO loan_plans VALUES(10,'طرح خورشید');
    INSERT INTO salespersons(id,name,active) VALUES(1,'کارشناس نمونه',1);
    INSERT INTO allocation_programs(id,name,is_default,active) VALUES(1,'پیش‌فرض',1,1);
    INSERT INTO allocation_program_items(program_id,salesperson_id,quota) VALUES(1,1,5);
    INSERT INTO customers(id,name,phone,verification_status,created_at,status) VALUES(50,'مشتری قدیم','09350000001','verified','2026-01-01T00:00:00Z','in_progress');
    INSERT INTO customers(id,name,phone,verification_status,created_at,status) VALUES(60,'ادغام‌شده','09350000002','unverified','2026-01-01T00:00:00Z','in_progress');
    INSERT INTO customers(id,name,phone,verification_status,created_at,status,merged_into_customer_id) VALUES(61,'تکراری','+989350000002','unverified','2026-01-01T00:00:00Z','in_progress',NULL);
  `);
  // 61 is merged into 60; it is the only row matching its normalized mobile besides 60.
  db.exec("UPDATE customers SET merged_into_customer_id=60 WHERE id=61");
  db.close();
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const plugin = {
  name: "public-leads-fixture",
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
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  child = spawn(process.execPath, [workerOut], { env: { ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not start: " + logs)), 20000);
    const onData = (chunk) => { logs += chunk; if (logs.includes("READY")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`worker exited ${code}: ${logs}`)));
  });
  const base = `http://127.0.0.1:${port}/api/public/leads`;
  const site = "https://nafisvam.com";
  let ipSeq = 1;
  const post = (body, { origin = site, ip = `198.51.100.${ipSeq++}`, type = "application/json" } = {}) => fetch(base, {
    method: "POST",
    headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": type, "X-Real-IP": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const lead = (patch = {}) => ({ name: "مریم احمدی", phone: "09121112233", need: "cash", amountBand: "300-500",
    contactTime: "evening", consent: true, startedAt: Date.now() - 15000, website: "", src: "finder", planId: 10, term: 24,
    utm_source: "instagram", utm_campaign: "autumn", ...patch });
  const db = () => new DatabaseSync(databasePath, { readOnly: true });

  // Preflight: only the site origins and local previews, no credentials, nothing reflected for others.
  for (const origin of [site, "https://www.nafisvam.com", "http://localhost:4321", "http://127.0.0.1:4321"]) {
    const r = await fetch(base, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), origin);
    assert.equal(r.headers.get("access-control-allow-credentials"), null);
    assert.match(r.headers.get("access-control-allow-methods"), /POST/);
  }
  for (const origin of ["https://evil.example", "http://nafisvam.com", "https://nafisvam.com.evil.example", "https://crm.nafisvam.com", "null", "http://localhost:3000", "https://localhost:4321", "http://localhost"]) {
    const r = await fetch(base, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    assert.equal(r.status, 403, origin);
    assert.equal(r.headers.get("access-control-allow-origin"), null, origin);
    const p = await post(lead({ phone: "09129990000" }), { origin });
    assert.equal(p.status, 403, origin);
    assert.equal(p.headers.get("access-control-allow-origin"), null, origin);
  }
  assert.equal((await post(lead({ phone: "09129990001" }), { origin: null })).status, 403, "Origin is required");
  // The global permissive CORS still applies elsewhere (regression guard on mount order).
  const other = await fetch(`http://127.0.0.1:${port}/api/other`, { method: "OPTIONS", headers: { Origin: "https://x.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(other.headers.get("access-control-allow-origin"), "https://x.example");

  // Happy path: new customer, source='website', allocation applied, notification fired.
  const first = await post(lead());
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.deepEqual(Object.keys(firstBody).sort(), ["ok", "trackingCode"], "only ok + trackingCode, nothing echoed back");
  assert.equal(firstBody.ok, true);
  assert.match(firstBody.trackingCode, /^NV-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(!JSON.stringify(firstBody).includes("0912") && !JSON.stringify(firstBody).includes("مریم"), "no input echoed");
  assert.equal(first.headers.get("access-control-allow-origin"), site);
  assert.equal(first.headers.get("cache-control"), "no-store");
  {
    const d = db();
    const customer = d.prepare("SELECT * FROM customers WHERE phone='09121112233'").get();
    assert.ok(customer, "customer created");
    assert.equal(customer.name, "مریم احمدی");
    assert.equal(customer.verification_status, "unverified");
    assert.equal(customer.salesperson_id, 1, "default allocation program used");
    assert.match(customer.description, /درخواست از سایت nafisvam\.com/);
    assert.match(customer.description, /طرح خورشید \(#10\)، 24 ماهه/);
    assert.match(customer.description, /utm_source=instagram utm_campaign=autumn/);
    const row = d.prepare("SELECT * FROM public_leads WHERE customer_id=?").get(customer.id);
    assert.equal(row.source, "website");
    assert.equal(row.outcome, "new_customer");
    assert.equal(row.amount_band, "300-500");
    assert.equal(row.tracking_code, firstBody.trackingCode, "tracking code stored on the lead");
    assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes("198.51.100"), "raw IP never stored");
    assert.ok(d.prepare("SELECT 1 FROM customer_tags WHERE customer_id=? AND tag='website_lead'").get(customer.id));
    d.close();
  }
  await new Promise((r) => setTimeout(r, 100));
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(notifyLog, "utf8").trim().split("\n").filter(Boolean).length, 1, "new customer notified once");
  {
    const [call] = readFileSync(notifyLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(call.options, { customerSms: false, source: "website", kind: "request" }, "website lead: no customer SMS, Telegram labelled website");
  }

  // Double submit within minutes: success, but no duplicate row.
  const again = await post(lead({ phone: "۰۹۱۲۱۱۱۲۲۳۳" }));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true }, "duplicate: the earlier code is never re-issued");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM public_leads").get().n, 1);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM customers WHERE phone='09121112233'").get().n, 1);

  // Existing customer (and a merged duplicate) is linked, never recreated.
  const linkedA = await post(lead({ phone: "09350000001", name: "Ali", amountBand: "100-200" }));
  assert.equal(linkedA.status, 201);
  const codeA = (await linkedA.json()).trackingCode;
  const linkedB = await post(lead({ phone: "+98 935 000 0002", name: "Ali", amountBand: "1000-up" }));
  assert.equal(linkedB.status, 201);
  const codeB = (await linkedB.json()).trackingCode;
  assert.ok(codeA && codeB && codeA !== codeB && codeA !== firstBody.trackingCode, "a fresh code per lead");
  {
    const d = db();
    assert.equal(d.prepare("SELECT COUNT(*) n FROM customers").get().n, 4);
    const linked = d.prepare("SELECT customer_id,outcome FROM public_leads WHERE outcome='existing_customer' ORDER BY id").all();
    assert.deepEqual(linked.map((r) => Number(r.customer_id)), [50, 60], "merged duplicate resolves to survivor");
    assert.equal(d.prepare("SELECT name FROM customers WHERE id=50").get().name, "مشتری قدیم", "existing data untouched");
    assert.ok(d.prepare("SELECT 1 FROM customer_tags WHERE customer_id=50 AND tag='website_lead'").get());
    d.close();
  }
  // Existing customers now get exactly one staff alert each (marked «مشتری قبلی»), still never the customer SMS.
  await new Promise((r) => setTimeout(r, 100));
  {
    const calls = readFileSync(notifyLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.length, 3, "one alert per existing-customer lead");
    assert.deepEqual(calls.slice(1).map((c) => c.id), [50, 60], "alert targets the canonical (survivor) file");
    for (const call of calls.slice(1)) {
      assert.equal(call.options.customerSms, false, "existing customer: no SMS");
      assert.equal(call.options.source, "website");
      assert.equal(call.options.kind, "request");
      assert.equal(call.options.existingCustomer, true);
      assert.equal(call.options.preferredTime, "عصر");
      assert.match(call.options.requestDetails, /درخواست از سایت nafisvam\.com/);
      assert.match(call.options.requestDetails, /طرح خورشید \(#10\)/);
    }
    assert.match(calls[1].options.requestDetails, /حدود مبلغ/);
  }
  // Same existing customer again inside 10 minutes: 200, nothing stored, no second alert.
  const linkedDup = await post(lead({ phone: "09350000001", name: "Ali" }));
  assert.equal(linkedDup.status, 200);
  assert.deepEqual(await linkedDup.json(), { ok: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(readFileSync(notifyLog, "utf8").trim().split("\n").filter(Boolean).length, 3, "dedupe: no second alert");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM public_leads WHERE customer_id=50").get().n, 1);

  // Spam and validation: real errors, nothing stored, nothing echoed.
  const before = db().prepare("SELECT COUNT(*) n FROM public_leads").get().n;
  const expectFail = async (res, status, error) => {
    assert.equal(res.status, status);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, error);
    assert.ok(!JSON.stringify(body).includes("0912"));
  };
  await expectFail(await post(lead({ phone: "09124440001", website: "x" })), 400, "spam");
  await expectFail(await post(lead({ phone: "09124440002", startedAt: Date.now() - 100 })), 422, "too_fast");
  await expectFail(await post(lead({ phone: "bad" })), 400, "invalid");
  await expectFail(await post("{not json"), 400, "invalid");
  await expectFail(await post("name=x", { type: "application/x-www-form-urlencoded" }), 415, "unsupported_media_type");
  await expectFail(await post("text", { type: "text/plain" }), 415, "unsupported_media_type");
  await expectFail(await post(JSON.stringify(lead({ phone: "09124440003", utm_term: "a".repeat(100) })) + " ".repeat(5000)), 413, "payload_too_large");
  assert.equal(db().prepare("SELECT COUNT(*) n FROM public_leads").get().n, before);
  const get = await fetch(base, { headers: { Origin: site } });
  assert.equal(get.status, 405);

  // Per-IP attempt limit keyed on the proxy's X-Real-IP; other IPs unaffected.
  const ip = "203.0.113.77";
  const statuses = [];
  for (let i = 0; i < 9; i += 1) statuses.push((await post(lead({ phone: "bad" }), { ip })).status);
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(400));
  assert.equal(statuses[8], 429);
  const limited = await post(lead({ phone: "09125550000" }), { ip });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await post(lead({ phone: "09125550001" }), { ip: "203.0.113.78" })).status, 201);

  // Persistent daily cap per IP for accepted leads (survives the in-memory window).
  const capIp = "203.0.113.90";
  const capStatuses = [];
  for (let i = 0; i < 8; i += 1) capStatuses.push((await post(lead({ phone: `0912600000${i}` }), { ip: capIp })).status);
  assert.deepEqual(capStatuses, Array(8).fill(201));
  {
    const w = new DatabaseSync(databasePath);
    const hash = w.prepare("SELECT ip_hash FROM public_leads ORDER BY id DESC LIMIT 1").get().ip_hash;
    const stamp = new Date(Date.now() - 3600_000).toISOString();
    for (let i = 0; i < 3; i += 1) {
      w.prepare(`INSERT INTO public_leads(source,customer_id,outcome,name,phone,need,amount_band,contact_time,ip_hash,created_at)
        VALUES('website',NULL,'new_customer','x','0912700000${i}','cash','unsure','any',?,?)`).run(hash, stamp);
    }
    w.close();
  }
  // 11 accepted today for capIp → the DB cap (10/day) blocks with a real 429 from another worker window.
  const capped = await post(lead({ phone: "09126000099" }), { ip: capIp });
  assert.equal(capped.status, 429);

  console.log("public leads fixture ok");
} finally {
  child?.kill();
  await rm(temp, { recursive: true, force: true });
}
