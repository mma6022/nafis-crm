import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temp = await mkdtemp(path.join(os.tmpdir(), "goods-documents-"));
let db;
try {
  const sourceDb = new DatabaseSync(path.resolve("../../attached_assets/customers_1789823100050.db"), { readOnly: true });
  await backup(sourceDb, path.join(temp, "fixture.db")); sourceDb.close();
  process.env.CRM_DATABASE_PATH = path.join(temp, "fixture.db");
  process.env.CONTRACTS_STORAGE_DIR = path.join(temp, "contracts");
  process.env.EMZAME_BUSINESS_ID = "isolated-business";
  process.env.EMZAME_NATIONAL_CODE = "0000000000";
  process.env.EMZAME_PASSWORD = "isolated-password";
  const bundle = path.join(temp, "documents.mjs");
  await build({
    entryPoints: ["src/lib/goods-documents.ts"], outfile: bundle, platform: "node", format: "esm", bundle: true,
    banner: { js: 'import {createRequire as _createRequire} from "node:module"; const require=_createRequire(import.meta.url);' },
    logLevel: "silent",
  });
  const docs = await import(pathToFileURL(bundle).href);
  db = new DatabaseSync(process.env.CRM_DATABASE_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS goods_purchases(id INTEGER PRIMARY KEY)");
  const customer = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get();
  const actor = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  const plan = db.prepare("SELECT id FROM loan_plans ORDER BY id LIMIT 1").get();
  assert.ok(customer && actor && plan, "fixture needs existing schema seed records");
  db.prepare("UPDATE customers SET name='مشتری آزمون',phone='09120000000',national_code='1111111111' WHERE id=?").run(customer.id);
  // Only private fixture copy is modified.
  const ids = [900001, 900002];
  for (const id of ids) db.prepare("INSERT INTO goods_purchases(id) VALUES(?)").run(id);
  const source = { id: ids[0], customerId: customer.id, planId: plan.id, invoiceVersion: 1,
    principalAmountToman: "200000", payoutAmountToman: "180000", creditAmountToman: "100000",
    items: [{ title: "کالای نمونه <امن>", quantity: 2, unitPriceToman: "50000" }] };
  const rendered = await docs.createInvoiceDocx(source, "مشتری آزمون", "طرح آزمون");
  assert.ok(rendered.length > 500);
  await assert.rejects(() => docs.createInvoiceDocx({ ...source, creditAmountToman: "99999" }, "x", "y"), /total_mismatch/);
  const generated = await docs.generateGoodsDocument(source, "invoice", actor.id);
  assert.equal(generated.status, "generated");
  assert.ok((await docs.goodsPdf(source.id, "invoice")).subarray(0, 5).equals(Buffer.from("%PDF-")));
  let sends = 0, uploads = 0, providerStatus = "readyForSign", failSend = false;
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/login")) return Response.json({ accessToken: "fixture-token" });
    if (endpoint.includes("checkUserActiveCertificate")) return Response.json({ isActive: true });
    if (endpoint.endsWith("/files")) { uploads++; return Response.json({ data: { fileId: `file-${uploads}` } }); }
    if (endpoint.endsWith("/contracts/sendContract")) {
      sends++;
      const payload = JSON.parse(init.body);
      assert.equal(payload.collaboratorList[0].nationalCode, "1111111111");
      assert.equal(payload.isElectronicSignatureRequired, true);
      assert.ok(init.headers["X-Idempotency-Key"]);
      if (failSend) throw new Error("network interrupted after submission");
      return Response.json({ data: { contractId: `contract-${sends}` } });
    }
    if (/\/contracts\/contract-\d+$/.test(endpoint)) return Response.json({ data: { status: providerStatus } });
    throw new Error("Unexpected external request blocked");
  };
  const results = await Promise.allSettled([docs.sendGoodsDocument(source, "invoice"), docs.sendGoodsDocument(source, "invoice")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(sends, 1);
  await docs.sendGoodsDocument(source, "invoice"); assert.equal(sends, 1);
  assert.throws(() => docs.assertInvoiceEditable(source.id), /locked/);
  providerStatus = "rejected";
  assert.equal((await docs.refreshGoodsDocument(source.id, "invoice")).status, "rejected");
  docs.assertInvoiceEditable(source.id);
  docs.invalidateGoodsInvoice(source.id);
  const revised = { ...source, invoiceVersion: 2 };
  assert.equal((await docs.generateGoodsDocument(revised, "invoice", actor.id)).version, 2);
  await docs.sendGoodsDocument(revised, "invoice");
  providerStatus = "accept";
  assert.equal((await docs.refreshGoodsDocument(source.id, "invoice")).signed, true);
  assert.throws(() => docs.invalidateGoodsInvoice(source.id), /locked/);
  providerStatus = "rejected";
  assert.equal((await docs.refreshGoodsDocument(source.id, "invoice")).signed, true, "signed evidence never regresses");
  const uncertain = { ...source, id: ids[1] };
  await docs.generateGoodsDocument(uncertain, "invoice", actor.id);
  failSend = true;
  await assert.rejects(() => docs.sendGoodsDocument(uncertain, "invoice"), /delivery_unknown/);
  assert.equal(docs.goodsDocumentState(uncertain.id, "invoice").status, "delivery_unknown");
  const sendCount = sends;
  await assert.rejects(() => docs.sendGoodsDocument(uncertain, "invoice"), /locked/);
  assert.equal(sends, sendCount, "ambiguous delivery must never resend");
  // Selected acknowledgement template uses the same established DOCX mapping pipeline.
  const templatePath = path.join(temp, "contracts", "templates", "11111111-1111-1111-1111-111111111111.docx");
  await writeFile(templatePath, rendered);
  const timestamp = new Date().toISOString();
  const templateId = Number(db.prepare(`INSERT INTO contract_templates(name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at)
    VALUES('Fixture acknowledgement','ack.docx',?,?,'[]','[]',?,?,?)`).run(templatePath, createHash("sha256").update(await readFile(templatePath)).digest("hex"), actor.id, timestamp, timestamp).lastInsertRowid);
  const acknowledged = { ...revised, acknowledgementTemplateId: templateId };
  assert.equal((await docs.generateGoodsDocument(acknowledged, "acknowledgement", actor.id)).status, "generated");
  failSend = false; providerStatus = "accepted";
  await docs.sendGoodsDocument(acknowledged, "acknowledgement");
  assert.equal((await docs.refreshGoodsDocument(source.id, "acknowledgement")).signed, true);
  console.log("Goods documents passed: real DOCX/PDF, totals, concurrent/repeated send, reject/edit/resend, signed monotonicity, ambiguous-send lock, configured acknowledgement and actual provider-shaped requests.");
} finally {
  db?.close();
  await rm(temp, { recursive: true, force: true });
}