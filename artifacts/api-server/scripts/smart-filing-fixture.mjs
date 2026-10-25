// Synthetic smart-filing fixture: in-memory DB, fake customer, temp key file. Run: node scripts/run-bundled-fixture.mjs scripts/smart-filing-fixture.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import express from "express";
import { createSmartFiling, ensureSmartFilingSchema, hashRunnerToken, maskText } from "../src/lib/smart-filing.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sf-fx-"));
const keyFile = path.join(tmp, "k"); fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
const env = { SMART_FILING_KEY_FILE: keyFile };
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,first_name TEXT,last_name TEXT,father_name TEXT,national_code TEXT,birth_date_jalali TEXT,postal_code TEXT,address TEXT,city TEXT,email TEXT,salesperson_id INTEGER);
CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,customer_id INTEGER,plan_id INTEGER,plan_ids TEXT,requested_amount TEXT,approved_amount TEXT,duration_months INTEGER,requested_duration_months INTEGER,status TEXT,stage TEXT,deleted_at TEXT);
CREATE TABLE loan_application_documents(id INTEGER PRIMARY KEY,application_id INTEGER,requirement_key TEXT,label TEXT,mime_type TEXT,size_bytes INTEGER,storage_path TEXT,status TEXT);
CREATE TABLE customer_identity_documents(id INTEGER PRIMARY KEY,customer_id INTEGER,document_type TEXT,mime_type TEXT,size_bytes INTEGER,storage_path TEXT,is_latest INTEGER);
INSERT INTO salespersons VALUES(7,'کارشناس نمونه');
INSERT INTO loan_plans VALUES(7,'ترنم'),(8,'ترنم'),(21,'ترنم ( بازنشسته ها )'),(3,'طرح دیگر');
INSERT INTO customers VALUES(1,'مشتری نمونه','09120000000','مشتری','نمونه','پدر','0010000000','1370/01/01','1111111111','تهران','تهران',NULL,7);
INSERT INTO customers VALUES(2,'ناقص',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO loan_applications VALUES(10,1,7,NULL,'300000000',NULL,36,36,'reviewing','x',NULL);
INSERT INTO loan_applications VALUES(11,1,3,NULL,'1',NULL,12,12,'reviewing','x',NULL);
INSERT INTO loan_applications VALUES(12,2,NULL,'[8]','1',NULL,12,12,'reviewing','x',NULL);`);
const docDir = path.join(tmp, "docs"); fs.mkdirSync(docDir); fs.writeFileSync(path.join(docDir, "a.jpg"), "JPEG");
db.prepare("INSERT INTO customer_identity_documents VALUES(1,1,'national_card_front','image/jpeg',4,?,1)").run(path.join(docDir, "a.jpg"));
db.prepare("INSERT INTO customer_identity_documents VALUES(2,1,'national_card_back','image/jpeg',4,?,1)").run("/etc/passwd");
ensureSmartFilingSchema(db); ensureSmartFilingSchema(db);
assert.deepEqual(db.prepare("SELECT plan_id FROM smart_filing_panel_plans ORDER BY plan_id").all().map(r => r.plan_id), [7, 8, 21]);
const users = { 1: { id: 1, role: "admin", salespersonId: null, name: "مدیر" }, 2: { id: 2, role: "salesperson", salespersonId: 7, name: "کارشناس" }, 3: { id: 3, role: "salesperson", salespersonId: 9, name: "دیگری" } };
const sf = createSmartFiling({ db, env: () => env, filesRoot: path.join(tmp, "files"), docRoots: [docDir], actor: res => users[res.locals.uid] ?? null });
const app = express();
app.use("/api/smart-filing-runner", sf.runner);
app.use(express.json({ limit: "100kb" }));
app.use("/api", (req, res, next) => { res.locals.uid = Number(req.headers["x-user"] || 0); next(); }, sf.admin);
const srv = app.listen(0); const port = srv.address().port;
const token = crypto.randomBytes(32).toString("base64url");
db.prepare("INSERT INTO smart_filing_runner_tokens(name,token_hash,created_at) VALUES('t',?,'now')").run(hashRunnerToken(token));
const call = async (method, p, body, user, bearer) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json", ...(user ? { "x-user": String(user) } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j };
};
const A = (m, p, b) => call(m, `/api/smart-filing${p}`, b, 1);
const R = (m, p, b, tok = token) => call(m, `/api/smart-filing-runner${p}`, b, null, tok);
try {
  assert.equal((await A("PUT", "/panels/1", { baseUrl: "https://panel.example.test", username: "u1", password: "Sup3rSecretPw" })).s, 200);
  const panels = await A("GET", "/panels"); assert.equal(panels.j.panels[0].hasPassword, true); assert.ok(!JSON.stringify(panels.j).includes("Sup3rSecretPw"));
  assert.ok(!String(db.prepare("SELECT password_enc FROM smart_filing_panels").get().password_enc).includes("Sup3r"));
  assert.equal((await A("GET", "/eligibility/11")).j.eligible, false);
  assert.equal((await A("POST", "/jobs", { applicationId: 11 })).s, 409);
  assert.equal((await A("POST", "/jobs", { applicationId: 12 })).s, 422); // missing name/nid/mobile blocks real
  assert.equal((await call("POST", "/api/smart-filing/jobs", { applicationId: 10 }, 2)).s, 403); // expert cannot create
  const created = await A("POST", "/jobs", { applicationId: 10 }); assert.equal(created.s, 201); const id = created.j.id;
  assert.equal((await A("POST", "/jobs", { applicationId: 10 })).j.existing, true);
  assert.equal((await R("POST", "/claim", {}, "x".repeat(40))).s, 401);
  assert.equal((await R("GET", "/nope")).s, 404);
  const claim = await R("POST", "/claim", {}); assert.equal(claim.j.job.id, id); assert.equal(claim.j.case.nationalCode, "0010000000");
  assert.ok(!JSON.stringify(claim.j).includes("Sup3rSecretPw")); assert.ok(!JSON.stringify(claim.j).includes(docDir));
  assert.equal((await R("GET", `/jobs/${id}/documents/id-1`)).s, 200);
  assert.equal((await R("GET", `/jobs/${id}/documents/id-2`)).s, 404); // outside roots
  const cred = await R("GET", `/jobs/${id}/credentials`); assert.equal(cred.j.password, "Sup3rSecretPw");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600_000)]);
  const m1 = await R("POST", `/jobs/${id}/messages`, { text: "فرم با 09121234567 و 0012345678 و رمز Sup3rSecretPw پر شد", step: "فرم مشخصات", progress: 40, data: { nationalCode: "0012345678", mobile: "09121234567", ok: true }, screenshot: { base64: png.toString("base64") } });
  assert.equal(m1.s, 201);
  const big = await R("POST", `/jobs/${id}/messages`, { text: "x", screenshot: { base64: Buffer.alloc(1_600_000).toString("base64") } }); assert.equal(big.s, 413);
  const stored = db.prepare("SELECT body,data_json FROM smart_filing_messages WHERE id=?").get(m1.j.id);
  assert.ok(!/09121234567|0012345678|Sup3rSecretPw/.test(stored.body + stored.data_json), stored.body);
  assert.equal((await R("POST", `/jobs/${id}/messages`, { text: "submit", step: "final_submit" })).j.error, "final_submit_not_approved");
  assert.equal((await R("POST", `/jobs/${id}/status`, { status: "submitted" })).s, 409);
  // code flow
  assert.equal((await A("POST", `/jobs/${id}/code`, { code: "12345" })).s, 409);
  const cr = await R("POST", `/jobs/${id}/code-requests`, { target: "customer", expiresInSeconds: 120 }); assert.equal(cr.s, 201);
  assert.equal((await call("POST", `/api/smart-filing/jobs/${id}/code`, { code: "12345" }, 3)).s, 404); // other expert
  assert.equal((await call("POST", `/api/smart-filing/jobs/${id}/code`, { code: "۱۲۳۴۵" }, 2)).s, 200); // case expert, Persian digits
  const cv = await R("GET", `/jobs/${id}/code-requests/${cr.j.id}`); assert.equal(cv.j.code, "12345");
  const crow = db.prepare("SELECT status,code_enc,code_masked FROM smart_filing_code_requests WHERE id=?").get(cr.j.id);
  assert.deepEqual([crow.status, crow.code_enc, crow.code_masked], ["consumed", null, "1•••5"]);
  assert.equal((await R("GET", `/jobs/${id}/code-requests/${cr.j.id}`)).j.status, "consumed");
  // human message + approval gate
  assert.equal((await call("POST", `/api/smart-filing/jobs/${id}/messages`, { text: "بانک را اقتصاد نوین بزن" }, 2)).s, 201);
  const hm = await R("GET", `/jobs/${id}/messages?after=0`); assert.ok(hm.j.messages.some(m => m.body.includes("اقتصاد نوین")));
  assert.equal((await A("POST", `/jobs/${id}/approve-submit`)).s, 409);
  assert.equal((await R("POST", `/jobs/${id}/status`, { status: "ready_for_approval" })).s, 200);
  assert.equal((await call("POST", `/api/smart-filing/jobs/${id}/approve-submit`, {}, 2)).s, 403);
  assert.equal((await A("POST", `/jobs/${id}/approve-submit`)).s, 200);
  assert.equal((await R("POST", `/jobs/${id}/messages`, { text: "ok", step: "final_submit" })).s, 201);
  assert.equal((await R("POST", `/jobs/${id}/finish`, { status: "submitted", panelReference: "REF-1" })).s, 200);
  assert.equal((await R("GET", `/jobs/${id}/credentials`)).s, 409); // not running
  assert.equal((await A("POST", `/jobs/${id}/outcome`, { outcome: "approved" })).s, 200);
  const view = await A("GET", `/jobs/${id}`); assert.equal(view.j.job.status, "approved"); assert.ok(view.j.messages.some(m => m.screenshotUrl));
  const shot = await fetch(`http://127.0.0.1:${port}${view.j.messages.find(m => m.screenshotUrl).screenshotUrl}`, { headers: { "x-user": "1" } }); assert.equal(shot.status, 200);
  assert.equal((await call("GET", `/api/smart-filing/jobs/${id}`, null, 3)).s, 404);
  assert.equal((await call("GET", `/api/smart-filing/jobs`, null, 2)).j.jobs.length, 1);
  assert.equal((await call("GET", `/api/smart-filing/jobs`, null, 3)).j.jobs.length, 0);
  const audit = JSON.stringify(db.prepare("SELECT * FROM smart_filing_audit").all());
  assert.ok(!/Sup3rSecretPw|12345"|09121234567/.test(audit));
  assert.equal(maskText("۰۹۱۲۱۲۳۴۵۶۷"), "0912••••567");
  console.log("smart-filing fixture OK");
} finally { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
