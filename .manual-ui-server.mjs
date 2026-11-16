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
  await import('node:fs/promises').then(fs=>fs.writeFile('/tmp/manual-ui-connection.json', JSON.stringify({base, sessions})));
  console.log(JSON.stringify({base, sessions}));
} finally {}
await new Promise(()=>{});
