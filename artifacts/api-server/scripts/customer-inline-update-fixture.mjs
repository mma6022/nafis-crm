// Exercise the actual PATCH handler with synthetic data and real SQLite guards.
// Never import the running CRM database or read customer records.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installCustomerIdentityGuards, normalizeCustomerMobile, normalizeCustomerNationalCode } from "../src/lib/customer-integrity.ts";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { build, transform } = require("esbuild");
const express = require("express");
const source = fs.readFileSync(path.join(root, "src/routes/crm.ts"), "utf8");
const handlerStart = source.indexOf('router.patch(\n  "/customers/:id",');
assert(handlerStart > 0);
const route = source.slice(handlerStart, source.indexOf("\nrouter.patch(", handlerStart + 1));
const helpers = source.slice(source.indexOf("function normalizeCustomerIdentity("), source.indexOf("function compareCustomerIdentity("))
  + source.slice(source.indexOf("function findActiveCustomerIdentityConflict("), source.indexOf("function hasActiveCustomerIdentityConflict("));
const schemas = await build({
  stdin: { contents: 'export { UpdateCustomerBody, UpdateCustomerParams } from "@workspace/api-zod";', resolveDir: root },
  bundle: true, platform: "node", format: "iife", globalName: "__schemas", write: false,
});
const { UpdateCustomerBody, UpdateCustomerParams } = new Function(schemas.outputFiles[0].text + "\nreturn __schemas;")();
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
  INSERT INTO salespersons VALUES(11,'Synthetic Old'),(22,'Synthetic New');
  CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,national_code TEXT,status TEXT,
    merged_into_customer_id INTEGER,salesperson_id INTEGER,priority INTEGER,
    birth_date_jalali TEXT,postal_code TEXT,verification_status TEXT,verification_version INTEGER DEFAULT 1,
    identity_changed_at TEXT,verification_checked_at TEXT,verification_provider TEXT,
    shahkar_ok INTEGER,person_info_ok INTEGER,postal_code_info_ok INTEGER,sana_ok INTEGER,
    shahkar_status TEXT,person_info_status TEXT,postal_code_info_status TEXT,sana_status TEXT);
  CREATE TABLE loan_cases(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id_snapshot INTEGER);
  INSERT INTO customers(id,name,phone,status,salesperson_id,verification_status) VALUES
    (1,'Unique','09120000001','cancelled',11,'verified'),
    (2,'Active duplicate','09120000002','in_progress',11,'verified'),
    (3,'Cancelled duplicate','+989120000002','cancelled',11,'verified');
  INSERT INTO loan_cases VALUES(1,1,11);`);
installCustomerIdentityGuards(db);
const queryRows = (sql, params = []) => db.prepare(sql).all(...params);
const queryRow = (sql, params = []) => db.prepare(sql).get(...params);
const getCustomer = (id, user) => {
  const row = queryRow("SELECT * FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [id]);
  if (!row || (user.customerScope === "assigned" && row.salesperson_id !== user.salespersonId)) return undefined;
  return { id: row.id, name: row.name, phone: row.phone, nationalCode: row.national_code,
    birthDateJalali: row.birth_date_jalali, postalCode: row.postal_code, status: row.status,
    salespersonId: row.salesperson_id, verificationStatus: row.verification_status };
};
const icsSource = fs.readFileSync(path.join(root, "src/lib/ics24.ts"), "utf8");
const phoneHelpers = ["normalizeMobile", "normalizeDigits"].map(name => {
  const start = icsSource.indexOf(`export function ${name}(`);
  assert(start >= 0);
  return icsSource.slice(start, icsSource.indexOf("\n}", start) + 2).replace(/^export /, "");
}).join("\n");
const actualPhoneHelpers = new Function((await transform(phoneHelpers, { loader: "ts" })).code + "\nreturn {normalizeMobile, normalizeDigits};")();
const bindings = {
  Router: express.Router, UpdateCustomerBody, UpdateCustomerParams, UpdateCustomerResponse: { parse: v => v },
  normalizeCustomerMobile, normalizeCustomerNationalCode, queryRow, queryRows, getCustomer,
  executeChanges: (sql, params) => Number(db.prepare(sql).run(...params).changes),
  requirePermission: permission => (_req, res, next) => res.locals.authUser.permissions.includes(permission) ? next() : res.status(403).json({ error: "forbidden" }),
  ics24: { ...actualPhoneHelpers,
    validNationalCode: value => /^\d{10}$/.test(value) && !/^(\d)\1{9}$/.test(value) },
  normalizeJalaliDate: () => { throw Error("Unexpected date edit in fixture"); },
  normalizePostalCode: () => { throw Error("Unexpected postal edit in fixture"); },
};
const js = await transform(`const {${Object.keys(bindings).join(",")}}=__bindings; const router=Router();\n${helpers}\n${route}\nreturn router;`, { loader: "ts", target: "es2022" });
const router = new Function("__bindings", js.code)(bindings);
const app = express(); app.use(express.json(), (req, res, next) => {
  const role = req.header("x-role") || "admin";
  res.locals.authUser = { role, customerScope: role === "admin" ? "all" : "assigned", salespersonId: 11,
    permissions: role === "viewer" ? [] : ["customers.update"] };
  next();
}, router);
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const patch = async (id, data, role = "admin") => {
  const response = await fetch(`${base}/customers/${id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-role": role }, body: JSON.stringify(data) });
  return { status: response.status, data: await response.json() };
};
try {
  for (const status of ["in_progress", "cancelled", "completed", "cancelled"]) {
    const result = await patch(1, { status });
    assert.equal(result.status, 200); assert.equal(result.data.status, status);
    assert.equal(queryRow("SELECT status FROM customers WHERE id=1").status, status);
    assert.equal(result.data.verificationStatus, "verified", "Status-only changes preserve identity verification");
  }
  for (const status of ["in_progress", "completed"]) {
    const result = await patch(3, { status });
    assert.equal(result.status, 409);
    assert.match(result.data.error, /مشتری شماره 2/);
    assert.equal(queryRow("SELECT status FROM customers WHERE id=3").status, "cancelled");
  }
  const hidden = await patch(2, { salespersonId: 22 }, "salesperson");
  assert.equal(hidden.status, 403, "Experts cannot reassign even their own customers");
  assert.equal((await patch(2, { salespersonId: null }, "salesperson")).status, 403);
  assert.equal((await patch(1, { salespersonId: 999 })).status, 400);
  assert.equal((await patch(1, { salespersonId: 22 }, "viewer")).status, 403);
  const moved = await patch(1, { salespersonId: 22 });
  assert.equal(moved.status, 200); assert.equal(moved.data.salespersonId, 22);
  assert.equal((await patch(1, { status: "completed" }, "salesperson")).status, 404, "Old owner loses write access");
  assert.equal(queryRow("SELECT salesperson_id_snapshot FROM loan_cases WHERE id=1").salesperson_id_snapshot, 11, "Historical attribution is never rewritten");
  assert.equal((await patch(1, { salespersonId: null })).status, 200);
  assert.equal(queryRow("SELECT salesperson_id FROM customers WHERE id=1").salesperson_id, null);
  assert.equal((await patch(3, { status: "in_progress", phone: "09120000003" })).status, 200, "Resolving identity and restoring status succeeds atomically");
  assert.equal((await patch(2, { status: "invalid" })).status, 400);
  const previousVersion = queryRow("SELECT verification_version FROM customers WHERE id=1").verification_version;
  const phoneUpdate = await patch(1, { phone: "۰۹۱۲۰۰۰۰۰۰۹" });
  assert.equal(phoneUpdate.status, 200, "Admin can correct only the mobile without supplying national code or other profile fields");
  const changedIdentity = queryRow("SELECT * FROM customers WHERE id=1");
  assert.equal(changedIdentity.phone, "09120000009");
  assert.equal(changedIdentity.verification_status, "unverified");
  assert.equal(changedIdentity.verification_version, previousVersion + 1);
  assert(changedIdentity.identity_changed_at);
  for (const field of ["shahkar_ok", "person_info_ok", "postal_code_info_ok", "sana_ok"]) assert.equal(changedIdentity[field], null);
  assert.equal(queryRow("SELECT salesperson_id_snapshot FROM loan_cases WHERE id=1").salesperson_id_snapshot, 11);
  assert.equal((await patch(1, { phone: "09120000002" })).status, 409, "Another active customer's mobile is rejected");
  assert.equal((await patch(1, { phone: "123" })).status, 400);
  assert.equal(queryRow("SELECT phone FROM customers WHERE id=1").phone, "09120000009", "Rejected changes never overwrite the previous mobile");
  console.log("PASS actual customer PATCH: both cancelled transitions, admin-only owner/unassign, invalid owner, old-owner isolation, unchanged historical attribution, duplicate protection and actionable conflict messages.");
} finally { await new Promise(resolve => server.close(resolve)); db.close(); }
