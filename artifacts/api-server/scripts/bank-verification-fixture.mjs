import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const temp = await mkdtemp(join(tmpdir(), "bank-verification-"));
try {
  const out = join(temp, "adapter.mjs");
  await build({ entryPoints: ["src/lib/bank-verification.ts"], outfile: out, bundle: true, platform: "node", format: "esm" });
  const { normalizeIban, normalizeBankBirthDate, verifyCustomerBankAccount } = await import(pathToFileURL(out).href);
  const birthDate = "۱۳۷۰/۰۱/۰۲";
  assert.equal(normalizeBankBirthDate(birthDate), "1370/1/2");
  assert.equal(normalizeBankBirthDate("1400/12/30"), null);
  assert.equal(normalizeBankBirthDate(""), null);
  const iban = "IR820540102680020817909002";
  assert.equal(normalizeIban(iban), iban);
  assert.equal(normalizeIban("IR000540102680020817909002"), null);
  process.env.SAPI_RELAY_URL = "http://relay.test/sapi";
  delete process.env.IR_RELAY_SHARED_SECRET;
  delete process.env.SAPI_API_BASE_URL;
  process.env.SAPI_API_TOKEN = "isolated-fixture-token";
  const calls = [];
  let match = true;
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    const operation = target.pathname.split("/").at(-1);
    assert.equal(target.origin, "https://s.api.ir");
    assert.equal(target.pathname, `/api/sw1/${operation}`);
    assert.equal(options.headers.Authorization, "Bearer isolated-fixture-token");
    assert.equal(options.headers["X-Relay-Signature"], undefined);
    assert.equal(options.headers["X-Relay-Timestamp"], undefined);
    assert.equal(options.redirect, "error");
    calls.push({ operation, body: JSON.parse(options.body) });
    const data = operation === "IbanMatch" ? match : operation === "CardToIban"
      ? { iban, name: "تست", bankName: "تست" } : { active: true, name: "تست", bankName: "تست" };
    return new Response(JSON.stringify({ success: true, data }));
  };
  const verified = await verifyCustomerBankAccount({ nationalCode: "0010007700", birthDate, cardNumber: "6037990000000000" });
  assert.equal(verified.iban, iban);
  assert.match(verified.providerReference, /^sapi-proof-sha256:[a-f0-9]{64}$/);
  assert.deepEqual(calls.map(c => c.operation), ["CardToIban", "IbanMatch", "IbanInfo"]);
  assert.deepEqual(calls[1].body, { nationalCode: "0010007700", birthDate: "1370/1/2", iban });
  match = false;
  await assert.rejects(verifyCustomerBankAccount({ nationalCode: "0010007700", birthDate, iban }), /bank_ownership_mismatch/);
  match = "true";
  await assert.rejects(verifyCustomerBankAccount({ nationalCode: "0010007700", birthDate, iban }), /invalid_bank_verification_response/);
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false, data: true }));
  await assert.rejects(verifyCustomerBankAccount({ nationalCode: "0010007700", birthDate, iban }), /bank_verification_unavailable/);
  delete process.env.SAPI_API_TOKEN;
  globalThis.fetch = async () => { assert.fail("Must not call provider or relay without token"); };
  await assert.rejects(verifyCustomerBankAccount({ nationalCode: "0010007700", birthDate, iban }), /bank_verification_unavailable/);
  console.log("Bank verification fixture passed: direct HTTPS/Bearer despite relay settings, exact provider schema, card conversion, false/string match rejection, missing token and failed provider fail-closed.");
} finally { await rm(temp, { recursive: true, force: true }); }