// t847u: parseSapiDebtBody — UnpaidChequePro / ChequeColor / ActiveLoans envelopes.
// No network, no live DB, no secrets. Usage: node scripts/run-bundled-fixture.mjs scripts/sapi-debt-parse-fixture.mjs
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_LEVEL = "silent";
process.env.NODE_ENV = "production";
for (const k of Object.keys(process.env)) if (/^(SAPI_|IR_RELAY|ICS24_|NAFIS_IDTEST)/.test(k)) delete process.env[k];
const src = process.env.SMC_FIXTURE_DB || "/workspace/sam-v12/shots-masked-live-510000.db";
if (!fs.existsSync(src)) { console.log("SKIP (need a masked CRM DB at SMC_FIXTURE_DB)"); process.exit(0); }
if (fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") throw new Error("refusing live DB");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sapi-debt-parse-"));
const dbPath = path.join(tmp, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
process.env.CRM_DATABASE_PATH = dbPath;

const { parseSapiDebtBody, SapiDebtError, sapiDebtStaffMessage } = await import("../src/lib/sapi.ts");

let passed = 0;
const ok = (n, f) => { f(); passed++; console.log("ok -", n); };

const cheques = [{ chequeNumber: "0001234567", amount: 250000000, bouncedAmount: 250000000, chequeDate: "14030120", backDate: "14030122" }];

ok("documented shape: success + data.chequeList", () => {
  const d = parseSapiDebtBody({ success: true, data: { count: 1, chequeList: cheques } }, "unpaidChequePro");
  assert.equal(d.count, 1);
  assert.equal(d.chequeList[0].amount, 250000000);
  assert.equal(d.chequeList[0].chequeDate, "14030120");
});

ok("UnpaidChequePro: useful object on result (not data) is not dropped as {}", () => {
  const d = parseSapiDebtBody({ success: true, result: { count: 2, chequeList: cheques.concat(cheques) } }, "unpaidChequePro");
  assert.equal(d.count, 2);
  assert.equal(d.chequeList.length, 2);
  assert.notDeepEqual(d, {});
});

ok("isSuccess + data colour (سفید / 1) kept", () => {
  const d = parseSapiDebtBody({ isSuccess: true, data: { chequeColor: "سفید", chequeColorCode: 1 } }, "chequeColor");
  assert.equal(d.chequeColor, "سفید");
  assert.equal(d.chequeColorCode, 1);
});

ok("colour payload with a numeric `code` is not treated as a failed envelope", () => {
  const d = parseSapiDebtBody({ success: true, data: { chequeColor: "قرمز", chequeColorCode: 5, code: 5 } }, "chequeColor");
  assert.equal(d.chequeColor, "قرمز");
  assert.equal(d.chequeColorCode, 5);
});

ok("ChequeColor provider 503 («استعلام مورد نظر پاسخ نمی دهد») throws and keeps the Persian message", () => {
  let err;
  try {
    parseSapiDebtBody({
      success: false, code: 503,
      message: "استعلام مورد نظر پاسخ نمی دهد | باز گشت هزینه فراخوانی",
    }, "chequeColor");
  } catch (e) { err = e; }
  assert.ok(err instanceof SapiDebtError);
  assert.equal(err.kind, "sapi_debt_failed");
  assert.match(err.providerMessage, /استعلام مورد نظر پاسخ نمی دهد/);
  assert.match(sapiDebtStaffMessage({ success: false, code: 503, message: "استعلام مورد نظر پاسخ نمی دهد | باز گشت هزینه فراخوانی" }), /پاسخ نمی دهد/);
});

ok("success + empty data object stays empty (no invented cheques)", () => {
  assert.deepEqual(parseSapiDebtBody({ success: true, data: {} }, "unpaidChequePro"), {});
});

ok("success + data array of cheques becomes count + chequeList", () => {
  const d = parseSapiDebtBody({ success: true, data: cheques }, "unpaidChequePro");
  assert.equal(d.count, 1);
  assert.equal(d.chequeList[0].bouncedAmount, 250000000);
});

ok("zero-cheque result on result: { count: 0, chequeList: [] }", () => {
  const d = parseSapiDebtBody({ success: true, result: { count: 0, chequeList: [] } }, "unpaidChequePro");
  assert.equal(d.count, 0);
  assert.deepEqual(d.chequeList, []);
});

ok("ActiveLoans documented shape unchanged", () => {
  const d = parseSapiDebtBody({ success: true, data: { count: 3, info: { totalAmount: 2500000000, debtTotalAmount: 1450000000 } } }, "activeLoans");
  assert.equal(d.count, 3);
  assert.equal(d.info.debtTotalAmount, 1450000000);
});

ok("double envelope: inner data is the payload", () => {
  const d = parseSapiDebtBody({
    success: true,
    data: { success: true, data: { chequeColor: "زرد", chequeColorCode: 2 } },
  }, "chequeColor");
  assert.equal(d.chequeColor, "زرد");
  assert.equal(d.chequeColorCode, 2);
});

console.log(`\n${passed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
