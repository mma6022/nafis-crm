import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temp = await mkdtemp(path.join(os.tmpdir(), "manual-verification-"));
const fixtureDb = path.join(temp, "fixture.db");
const source = new DatabaseSync(path.resolve("../../attached_assets/customers_1789823100050.db"), { readOnly: true });
await backup(source, fixtureDb);
source.close();
const secret = randomBytes(32).toString("hex");
Object.assign(process.env, {
  CRM_DATABASE_PATH: fixtureDb,
  SESSION_SECRET: secret,
  NODE_ENV: "production",
  SAPI_API_BASE_URL: "https://manual-verification.fixture.invalid",
  SAPI_API_TOKEN: "fixture-only",
});

const nativeFetch = globalThis.fetch;
let failedChecks = new Set(["shahkarLite", "personInfo", "postalCodeInfo", "sana"]);
let delayProviderResponse = false;
let delayedProviderGate;
let delayedProviderStarted;
let releaseDelayedProvider;
let notifyDelayedProviderStarted;
let delayedProviderCallCount = 0;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.startsWith("https://manual-verification.fixture.invalid/")) {
    const match = target.match(/\/(ShahkarLite|PersonInfo|PostalCodeInfo|Sana)$/);
    assert.ok(match, `Unexpected provider URL: ${target}`);
    const check = ({ ShahkarLite: "shahkarLite", PersonInfo: "personInfo", PostalCodeInfo: "postalCodeInfo", Sana: "sana" })[match[1]];
    if (delayProviderResponse) {
      delayedProviderCallCount += 1;
      if (delayedProviderCallCount === 4) notifyDelayedProviderStarted();
      await delayedProviderGate;
    }
    return failedChecks.has(check)
      ? Response.json({ error: "fixture provider unavailable" }, { status: 502 })
      : Response.json({ data: { success: true, data: true } });
  }
  if (target.startsWith("http://127.0.0.1:")) return nativeFetch(url, options);
  throw new Error(`Unexpected external request: ${target}`);
};

const bundle = path.join(temp, "manual-verification-http.mjs");
await build({
  stdin: {
    contents: `
      import express from "express";
      import cookieParser from "cookie-parser";
      import { requireAuth } from "./src/lib/auth";
      import crm from "./src/routes/crm";
      export * from "./src/lib/crm-db";
      export const app = express();
      app.use(express.json(), cookieParser(), requireAuth, crm);
    `,
    resolveDir: process.cwd(),
    sourcefile: "manual-verification-fixture.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundle,
  logLevel: "silent",
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(process.cwd(), "package.json")).href)});` },
});

let server;
let fixture;
try {
  fixture = await import(pathToFileURL(bundle).href);
  const db = fixture.crmDb;
  const now = new Date().toISOString();
  const owner = fixture.execute("INSERT INTO salespersons(name,created_at) VALUES('Manual fixture owner',?)", [now]);
  const otherOwner = fixture.execute("INSERT INTO salespersons(name,created_at) VALUES('Manual fixture other',?)", [now]);
  const sessions = {};
  for (const [role, salespersonId] of [["admin", null], ["salesperson", owner], ["other", otherOwner]]) {
    const userId = fixture.execute(
      "INSERT INTO users(username,password_hash,role,salesperson_id,created_at) VALUES(?,'unused',?,?,?)",
      [`manual-fixture-${role}-${randomBytes(3).toString("hex")}`, "salesperson", salespersonId, now],
    );
    if (role === "admin") fixture.execute("UPDATE users SET role='admin' WHERE id=?", [userId]);
    const token = randomBytes(24).toString("base64url");
    fixture.execute(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      [createHmac("sha256", secret).update(token).digest("hex"), userId, new Date(Date.now() + 300_000).toISOString(), now],
    );
    sessions[role] = { userId, cookie: `crm_session=${token}` };
  }
  const validNationalCode = (prefix) => {
    const sum = [...prefix].reduce((n, digit, index) => n + Number(digit) * (10 - index), 0) % 11;
    return prefix + String(sum < 2 ? sum : 11 - sum);
  };
  const addCustomer = (name, suffix, salespersonId) => fixture.execute(
    `INSERT INTO customers(name,phone,national_code,birth_date_jalali,postal_code,verification_status,created_at,salesperson_id)
     VALUES(?,?,?,?,?,'unverified',?,?)`,
    [name, `091200000${suffix}`, validNationalCode(`0012345${suffix}`), "1370/01/02", `1234567${suffix}0`, now, salespersonId],
  );
  const first = addCustomer("Manual fixture one", "01", owner);
  const second = addCustomer("Manual fixture two", "02", owner);
  const third = addCustomer("Manual fixture three", "03", owner);
  const fourth = addCustomer("Manual fixture four", "04", owner);
  const fifth = addCustomer("Manual fixture five", "05", owner);
  server = fixture.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (role, method, route, body) => {
    const response = await nativeFetch(`${base}${route}`, {
      method,
      headers: {
        ...(role ? { Cookie: sessions[role].cookie } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const expect = async (role, method, route, body, status = 200) => {
    const response = await call(role, method, route, body);
    assert.equal(response.status, status, `${role ?? "anonymous"} ${method} ${route}: ${JSON.stringify(response.body)}`);
    return response.body;
  };

  const directCustomer = addCustomer("Direct admin fixture", "06", owner);
  const directBody = {
    correctedValues: { address: "Synthetic reviewed address", fatherName: "Synthetic father" },
    checks: Object.fromEntries(["shahkarLite", "personInfo", "postalCodeInfo", "sana"].map(check =>
      [check, { method: "manual", reason: "Administrator inspected synthetic evidence" }])),
  };
  await expect(null, "POST", `/customers/${directCustomer}/manual-verify`, directBody, 401);
  await expect("salesperson", "POST", `/customers/${directCustomer}/manual-verify`, directBody, 403);
  await expect("other", "POST", `/customers/${directCustomer}/manual-verify`, directBody, 403);
  await expect("admin", "POST", `/customers/${directCustomer}/manual-verify`, { ...directBody, correctedValues: {} }, 400);
  await expect("admin", "POST", `/customers/${directCustomer}/manual-verify`, {
    ...directBody, correctedValues: { address: "Synthetic address", nationalCode: "123" },
  }, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_manual_verification_requests WHERE customer_id=?").get(directCustomer).n, 0,
    "failed direct validations leave no approval requests");
  const direct = await expect("admin", "POST", `/customers/${directCustomer}/manual-verify`, directBody);
  assert.equal(direct.status, "approved");
  let directRow = db.prepare("SELECT * FROM customers WHERE id=?").get(directCustomer);
  assert.equal(directRow.verification_status, "verified");
  assert.equal(directRow.address, directBody.correctedValues.address);
  assert.equal(directRow.official_address, directBody.correctedValues.address);
  assert.equal(directRow.verification_provider, "manual");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_verification_events WHERE customer_id=?").get(directCustomer).n, 0,
    "direct approvals do not fabricate provider attempts");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_credit_checks WHERE customer_id=?").get(directCustomer).n, 0);
  const oldPhone = directRow.phone;
  await expect("admin", "POST", `/customers/${directCustomer}/manual-verify`, {
    ...directBody, correctedValues: { address: "Corrected synthetic address", mobile: "09120000999" },
  });
  directRow = db.prepare("SELECT * FROM customers WHERE id=?").get(directCustomer);
  assert.equal(directRow.phone, "09120000999");
  assert.ok(directRow.identity_changed_at, "identity correction invalidates old eligibility");
  const audit = db.prepare("SELECT * FROM customer_manual_verification_decisions WHERE customer_id=? ORDER BY id DESC LIMIT 1").get(directCustomer);
  assert.equal(JSON.parse(audit.original_values_json).phone, oldPhone);
  assert.equal(JSON.parse(audit.corrected_values_json).phone, directRow.phone);
  assert.ok(audit.actor_user_id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_credit_checks WHERE customer_id=?").get(directCustomer).n, 0);
  console.log("Direct admin fixture passed: role isolation, no prior inquiry, required address, profile correction, re-verification, audit, unchanged credit.");

  await expect("other", "POST", `/customers/${first}/manual-verification-requests`, {}, 404);
  await expect("salesperson", "POST", `/customers/${first}/manual-verification-requests`, {}, 400);
  const failed = await expect("salesperson", "POST", `/customers/${first}/verify`, {}, 200);
  assert.equal(failed.status, "failed", "provider 502 attempt is persisted as a failed SAPI verification event");
  const beforeCredit = db.prepare("SELECT national_code,credit_score,credit_rank,credit_checked_at FROM customers WHERE id=?").get(first);
  const noCreditRowsBefore = db.prepare("SELECT COUNT(*) AS n FROM customer_credit_checks WHERE customer_id=?").get(first).n;
  failedChecks = new Set(["shahkarLite", "personInfo", "sana"]);
  await expect("salesperson", "POST", `/customers/${first}/verify`, {}, 200);
  const request = await expect("salesperson", "POST", `/customers/${first}/manual-verification-requests`, {}, 201);
  const duplicateRequest = await expect("salesperson", "POST", `/customers/${first}/manual-verification-requests`, {}, 200);
  assert.equal(duplicateRequest.id, request.id, "a pending request is idempotent");
  await expect("salesperson", "GET", "/manual-verifications", undefined, 403);
  const detail = await expect("admin", "GET", `/manual-verifications/${request.id}`);
  assert.deepEqual(detail.sourceFailures.sort(), ["personInfo", "sana", "shahkarLite"]);
  assert.equal(detail.currentChecks.postalCodeInfo.ok, true);

  const approval = (nationalCode) => ({
    checks: {
      shahkarLite: { method: "manual", reason: "Reviewed identity document" },
      personInfo: { method: "manual", reason: "Reviewed identity document" },
      postalCodeInfo: { method: "system" },
      sana: { method: "manual", reason: "Reviewed identity document" },
    },
    ...(nationalCode ? { correctedValues: { nationalCode } } : {}),
  });
  await expect("admin", "POST", `/manual-verifications/${request.id}/approve`, approval("1111111111"), 400);
  await expect("admin", "POST", `/manual-verifications/${request.id}/approve`, {
    ...approval(),
    correctedValues: { mobile: "00000000000" },
  }, 400);
  await expect("admin", "POST", `/manual-verifications/${request.id}/approve`, {
    ...approval(),
    correctedValues: { postalCode: "123" },
  }, 400);
  await expect("admin", "POST", `/manual-verifications/${request.id}/approve`, {
    ...approval(),
    correctedValues: { birthDateJalali: "1370/13/01" },
  }, 400);
  const resolved = await expect("admin", "POST", `/manual-verifications/${request.id}/approve`, approval());
  assert.equal(resolved.status, "approved");
  await expect("admin", "POST", `/manual-verifications/${request.id}/approve`, approval(), 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customer_manual_verification_decisions WHERE request_id=?").get(request.id).n, 1);
  assert.throws(() => db.prepare("UPDATE customer_manual_verification_decisions SET decision='system_verified' WHERE request_id=?").run(request.id), /immutable/);
  const afterCredit = db.prepare("SELECT national_code,credit_score,credit_rank,credit_checked_at FROM customers WHERE id=?").get(first);
  assert.deepEqual(afterCredit, beforeCredit, "manual identity review never changes credit fields");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customer_credit_checks WHERE customer_id=?").get(first).n, noCreditRowsBefore);
  await expect("salesperson", "PATCH", `/customers/${first}`, { verificationStatus: "verified" }, 403);

  failedChecks = new Set(["shahkarLite", "personInfo", "postalCodeInfo", "sana"]);
  await expect("salesperson", "POST", `/customers/${second}/verify`, {}, 200);
  const systemRequest = await expect("salesperson", "POST", `/customers/${second}/manual-verification-requests`, {}, 201);
  failedChecks = new Set();
  const requery = await expect("admin", "POST", `/customers/${second}/verify`, {}, 200);
  assert.equal(requery.status, "verified");
  assert.equal((await expect("admin", "GET", `/manual-verifications/${systemRequest.id}`)).status, "system_verified");
  assert.equal(db.prepare("SELECT decision FROM customer_manual_verification_decisions WHERE request_id=?").get(systemRequest.id).decision, "system_verified");

  failedChecks = new Set(["shahkarLite", "personInfo", "postalCodeInfo", "sana"]);
  await expect("salesperson", "POST", `/customers/${third}/verify`, {}, 200);
  const staleRequest = await expect("salesperson", "POST", `/customers/${third}/manual-verification-requests`, {}, 201);
  const changedCode = validNationalCode("009876503");
  await expect("salesperson", "PATCH", `/customers/${third}`, { nationalCode: changedCode });
  failedChecks = new Set(["sana"]);
  await expect("salesperson", "POST", `/customers/${third}/verify`, {}, 200);
  const refreshedRequest = await expect("salesperson", "POST", `/customers/${third}/manual-verification-requests`, {}, 201);
  assert.notEqual(refreshedRequest.id, staleRequest.id, "changed profile and requery supersede stale request");
  assert.equal((await expect("admin", "GET", `/manual-verifications/${staleRequest.id}`)).status, "superseded");
  await expect("admin", "POST", `/manual-verifications/${staleRequest.id}/approve`, approval(), 409);
  assert.deepEqual(refreshedRequest.sourceFailures, ["sana"]);
  const refreshedApproval = await expect("admin", "POST", `/manual-verifications/${refreshedRequest.id}/approve`, {
    checks: {
      shahkarLite: { method: "system" },
      personInfo: { method: "system" },
      postalCodeInfo: { method: "system" },
      sana: { method: "manual", reason: "Reviewed current identity document" },
    },
  });
  assert.equal(refreshedApproval.status, "approved", "latest request can be resolved after stale request supersession");

  failedChecks = new Set(["shahkarLite", "personInfo", "postalCodeInfo", "sana"]);
  await expect("salesperson", "POST", `/customers/${fourth}/verify`, {}, 200);
  const delayedRequest = await expect("salesperson", "POST", `/customers/${fourth}/manual-verification-requests`, {}, 201);
  failedChecks = new Set();
  delayProviderResponse = true;
  delayedProviderCallCount = 0;
  delayedProviderStarted = new Promise((resolve) => { notifyDelayedProviderStarted = resolve; });
  delayedProviderGate = new Promise((resolve) => { releaseDelayedProvider = resolve; });
  const delayedVerify = call("admin", "POST", `/customers/${fourth}/verify`, {});
  await delayedProviderStarted;
  const allManual = {
    checks: {
      shahkarLite: { method: "manual", reason: "Reviewed identity document" },
      personInfo: { method: "manual", reason: "Reviewed identity document" },
      postalCodeInfo: { method: "manual", reason: "Reviewed identity document" },
      sana: { method: "manual", reason: "Reviewed identity document" },
    },
  };
  assert.equal((await expect("admin", "POST", `/manual-verifications/${delayedRequest.id}/approve`, allManual)).status, "approved");
  delayProviderResponse = false;
  releaseDelayedProvider();
  const delayedResponse = await delayedVerify;
  assert.equal(delayedResponse.status, 409, "late SAPI response must not overwrite a newer manual approval");
  const afterDelayed = db.prepare(
    "SELECT verification_status,verification_provider,shahkar_status,person_info_status,postal_code_info_status,sana_status FROM customers WHERE id=?",
  ).get(fourth);
  assert.deepEqual({ ...afterDelayed }, {
    verification_status: "verified",
    verification_provider: "sapi.ir+manual",
    shahkar_status: "manual_verified",
    person_info_status: "manual_verified",
    postal_code_info_status: "manual_verified",
    sana_status: "manual_verified",
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customer_verification_events WHERE customer_id=? AND is_current=0").get(fourth).n, 1);

  failedChecks = new Set(["shahkarLite", "personInfo", "postalCodeInfo", "sana"]);
  db.exec(`CREATE TRIGGER fixture_force_verification_persist_fallback
    BEFORE UPDATE OF verification_status ON customers
    WHEN NEW.verification_status='failed'
    BEGIN SELECT RAISE(ABORT,'fixture force verification fallback'); END`);
  const correctedBirthDate = "1371/03/04";
  await expect("admin", "POST", `/customers/${fifth}/verify`, { birthDateJalali: correctedBirthDate }, 502);
  db.exec("DROP TRIGGER fixture_force_verification_persist_fallback");
  const correctedCustomer = db.prepare(
    "SELECT verification_status,birth_date_jalali,shahkar_status,person_info_status,postal_code_info_status,sana_status FROM customers WHERE id=?",
  ).get(fifth);
  assert.equal(correctedCustomer.birth_date_jalali, correctedBirthDate, "current failed transport attempt persists validated corrected inputs");
  assert.equal(correctedCustomer.verification_status, "unverified");
  assert.deepEqual(
    [correctedCustomer.shahkar_status, correctedCustomer.person_info_status, correctedCustomer.postal_code_info_status, correctedCustomer.sana_status],
    ["unavailable", "unavailable", "unavailable", "unavailable"],
  );
  const afterFailureRequest = await expect("admin", "POST", `/customers/${fifth}/manual-verification-requests`, {}, 201);
  assert.deepEqual(afterFailureRequest.sourceFailures.sort(), ["personInfo", "postalCodeInfo", "sana", "shahkarLite"]);
  const fallbackApproval = await expect("admin", "POST", `/manual-verifications/${afterFailureRequest.id}/approve`, {
    checks: {
      shahkarLite: { method: "manual", reason: "Reviewed identity document" },
      personInfo: { method: "manual", reason: "Reviewed identity document" },
      postalCodeInfo: { method: "manual", reason: "Reviewed identity document" },
      sana: { method: "manual", reason: "Reviewed identity document" },
    },
  });
  assert.equal(fallbackApproval.status, "approved", "manual approval succeeds for unavailable checks after transport fallback");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fixture?.crmDb) fixture.crmDb.close();
  globalThis.fetch = nativeFetch;
  await rm(temp, { recursive: true, force: true });
}