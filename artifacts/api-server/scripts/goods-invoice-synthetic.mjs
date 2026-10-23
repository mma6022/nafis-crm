import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import JSZip from "jszip";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// This fixture never opens or copies a customer database or calls providers.
const temp = await mkdtemp(path.join(os.tmpdir(), "goods-invoice-synthetic-"));
let db;
try {
  const databasePath = path.join(temp, "synthetic.sqlite");
  db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,national_code TEXT,phone TEXT,postal_code TEXT,address TEXT,salesperson_id INTEGER);
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT,platform_company_name TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY);
    CREATE TABLE goods_purchases(id INTEGER PRIMARY KEY);`);
  db.prepare("INSERT INTO customers VALUES(1,?,?,?,?,?,2)").run("خریدار آزمایشی", "0012345678", "09120000000", "1234567890", "تهران، خیابان نمونه، پلاک آزمایشی");
  db.prepare("INSERT INTO salespersons VALUES(2,'فروشنده آزمایشی نباید درج شود')").run();
  const companyName = "تأمین مالی نمونه";
  db.prepare("INSERT INTO loan_plans VALUES(1,'طرح اعتبار نمونه',?)").run(companyName);
  db.prepare("INSERT INTO users VALUES(1)").run();
  db.prepare("INSERT INTO goods_purchases VALUES(1),(2),(3),(4),(5)").run();
  Object.assign(process.env, { CRM_DATABASE_PATH: databasePath, CONTRACTS_STORAGE_DIR: path.join(temp, "contracts") });
  const bundle = path.join(temp, "documents.mjs");
  await build({
    entryPoints: ["src/lib/goods-documents.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: `import{createRequire}from'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});` },
    plugins: [{ name: "synthetic-only", setup(ctx) {
      ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
      ctx.onResolve({ filter: /routes\/contracts$/ }, () => ({ path: "contracts", namespace: "fixture" }));
      ctx.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "db"
        ? `import{DatabaseSync}from'node:sqlite';export const databasePath=process.env.CRM_DATABASE_PATH;export const crmDb=new DatabaseSync(databasePath);export const queryRow=(sql,p=[])=>crmDb.prepare(sql).get(...p);`
        : `export const evaluateFormulaTokens=()=>{throw Error('unused');};export const loanPlanFieldValue=()=>{throw Error('unused');};export const normalizeTemplatePercentDelimiters=()=>{throw Error('unused');};`, loader: "js" }));
    }}],
  });
  const docs = await import(pathToFileURL(bundle).href);
  const source = { id: 1, customerId: 1, planId: 1, invoiceVersion: 1, creditAmountToman: "48290000", principalAmountToman: "40000000", payoutAmountToman: "36000000",
    items: [{ title: "گوشی موبایل سامسونگ Galaxy A17، حافظه ۱۲۸ گیگابایت <آزمایشی>", quantity: 1, unitPriceToman: "48290000" }] };
  const buyer = db.prepare("SELECT * FROM customers WHERE id=1").get();
  const renderSource = { ...source, invoiceNumber: "140507001" };
  const bytes = await docs.createInvoiceDocx(renderSource, buyer, companyName, new Date("2026-10-03T12:00:00Z"));
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml").async("string");
  for (const text of [buyer.name, buyer.national_code, buyer.phone, buyer.postal_code, buyer.address, "تومان", "صورتحساب فروش الکترونیکی", "مهر و امضای خریدار"]) assert.ok(xml.includes(text), text);
  assert.ok(xml.includes("&lt;آزمایشی&gt;"));
  assert.ok(xml.includes(`طرح اعتبار خرید کالا: ${companyName}`));
  assert.ok(xml.includes(`مبلغ کل فاکتور از طریق کیف پول شرکت (${companyName}) پرداخت گردیده است و تمامی کالاهای فوق در این تاریخ به صورت صحیح و سالم توسط آقای محمدحسین مهرپور ابربکوه تحویل اینجانب گردید و هیچ گونه ادعایی در مورد کالاها و مبلغ خرید ندارم.`));
  assert.ok(xml.includes("140507001") && !xml.includes("۱۴۰۵۰۷۰۰۱"));
  assert.ok(xml.includes("1405/07/11") && !xml.includes("۱۴۰۵/۰۷/۱۱"));
  assert.ok(xml.includes('w:ascii="Noto Sans"') && xml.includes('<w:rtl w:val="0"/>'));
  assert.ok(!/[۰-۹٠-٩]/u.test(xml), "Every invoice digit, including product descriptions, is Latin");
  assert.ok(xml.includes("48,290,000"), "Money keeps grouping and its exact amount");
  for (const run of xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/g)) {
    if (/<w:t[^>]*>[^<]*[0-9]/.test(run[0])) {
      assert.ok(run[0].includes('w:cs="Noto Sans"') && run[0].includes('<w:rtl w:val="0"/>'), "Every numeric run uses a readable Latin font and LTR direction");
    }
  }
  const mixedBuyerXml = await (await JSZip.loadAsync(await docs.createInvoiceDocx(renderSource,
    { name: "خریدار ۲", national_code: "۰۰۱۲۳۴۵۶۷۸", phone: "٠٩١٢٠٠٠٠٠٠٠", postal_code: "۱۲۳۴۵۶۷۸۹۰", address: "خیابان ۱۲، پلاک ٠٠٢" },
    "شرکت ۳", new Date("2026-10-03T12:00:00Z")))).file("word/document.xml").async("string");
  assert.ok(!/[۰-۹٠-٩]/u.test(mixedBuyerXml), "Persian and Arabic-Indic digits in buyer and company data are converted");
  assert.ok(mixedBuyerXml.includes("0012345678") && mixedBuyerXml.includes("09120000000") && mixedBuyerXml.includes("002"), "Leading zeros in identifiers and addresses are preserved");
  assert.equal(xml.split(companyName).length - 1, 2, "Company appears in both requested locations");
  assert.ok(!xml.includes("طرح اعتبار نمونه") && !xml.includes("مبلغ قابل پرداخت"));
  await assert.rejects(() => docs.createInvoiceDocx(renderSource, buyer, "  "), /invoice_financing_company_required/);
  await assert.rejects(() => docs.createInvoiceDocx({ ...renderSource, invoiceNumber: "140507000" }, buyer, companyName), /invoice_number_invalid/);
  const escapedCompanyXml = await (await JSZip.loadAsync(await docs.createInvoiceDocx(renderSource, buyer, "شرکت <نمونه> & آزمایشی"))).file("word/document.xml").async("string");
  assert.ok(escapedCompanyXml.includes("شرکت &lt;نمونه&gt; &amp; آزمایشی"));
  assert.ok(!xml.includes("فروشنده"));
  assert.ok(!xml.includes("ریال"));
  assert.ok(xml.includes('w:orient="landscape"') && xml.includes("<w:tblHeader/>"));
  await assert.rejects(() => docs.createInvoiceDocx({ ...renderSource, creditAmountToman: "1" }, buyer, "نمونه"), /total_mismatch/);
  await assert.rejects(() => docs.createInvoiceDocx({ ...renderSource, items: [] }, buyer, "نمونه"), /items_required/);
  await assert.rejects(() => docs.createInvoiceDocx({ ...renderSource, items: [{ ...source.items[0], quantity: 1.5 }] }, buyer, "نمونه"), /item_invalid/);
  const bigintSource = { ...renderSource, creditAmountToman: "9007199254740993", items: [{ title: "مبلغ بزرگ آزمایشی", quantity: 1, unitPriceToman: "9007199254740993" }] };
  assert.ok((await (await JSZip.loadAsync(await docs.createInvoiceDocx(bigintSource, buyer, "نمونه"))).file("word/document.xml").async("string")).includes(BigInt(bigintSource.creditAmountToman).toLocaleString("en-US")));
  globalThis.fetch = async () => { throw Error("External providers are forbidden in this fixture"); };
  docs.ensureGoodsDocumentsSchema();
  const generated = await docs.generateGoodsDocument(source, "invoice", 1);
  assert.equal(generated.status, "generated");
  const generatedHash = db.prepare("SELECT source_hash FROM goods_purchase_documents WHERE id=?").get(generated.id).source_hash;
  assert.equal(generatedHash, createHash("sha256").update(JSON.stringify({ source, layout: "buyer-only-latin-digits" })).digest("hex"));
  const generatedRecord = db.prepare("SELECT invoice_number,created_at FROM goods_purchase_documents WHERE id=?").get(generated.id);
  assert.match(generatedRecord.invoice_number, /^\d{6}001$/);
  assert.equal(new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit" }).format(new Date(generatedRecord.created_at)).replace(/(\d{2})\/(\d{4}).*/, "$2$1"), generatedRecord.invoice_number.slice(0, 6));
  assert.equal((await docs.generateGoodsDocument(source, "invoice", 1)).id, generated.id, "Repeated generation reuses current layout");
  const pdf = await docs.goodsPdf(1, "invoice");
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const output = path.resolve("../../.local/fixtures");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "goods-invoice-synthetic.pdf"), pdf);
  await writeFile(path.join(output, "goods-invoice-synthetic.docx"), bytes);
  const hash = src => createHash("sha256").update(JSON.stringify(src)).digest("hex");
  const legacy = { ...source, id: 2 };
  db.prepare(`INSERT INTO goods_purchase_documents(purchase_id,kind,version,status,source_hash,idempotency_key,created_by,created_at,updated_at)
    VALUES(2,'invoice',1,'generated',?,'legacy',1,?,?)`).run(hash(legacy), new Date().toISOString(), new Date().toISOString());
  assert.equal((await docs.generateGoodsDocument(legacy, "invoice", 1)).version, 2, "Only an unsent legacy document gets the new layout");
  const signed = { ...source, id: 3 };
  db.prepare(`INSERT INTO goods_purchase_documents(purchase_id,kind,version,status,source_hash,idempotency_key,created_by,created_at,updated_at,provider_contract_id)
    VALUES(3,'invoice',1,'signed',?,'signed',1,?,?,'existing-contract')`).run(hash({ source: signed, layout: "buyer-only-grid" }), new Date().toISOString(), new Date().toISOString());
  assert.equal((await docs.generateGoodsDocument(signed, "invoice", 1)).version, 1, "Signed documents are never rewritten");
  assert.equal(db.prepare("SELECT status FROM goods_purchase_documents WHERE purchase_id=3").get().status, "signed");
  const sent = { ...source, id: 4 };
  db.prepare(`INSERT INTO goods_purchase_documents(purchase_id,kind,version,status,source_hash,idempotency_key,created_by,created_at,updated_at,provider_contract_id,pdf_path)
    VALUES(4,'invoice',1,'sent',?,'sent',1,?,?,'existing-sent-contract','original-synthetic.pdf')`).run(hash({ source: sent, layout: "buyer-only-numbered-delivery-receipt" }), new Date().toISOString(), new Date().toISOString());
  assert.equal((await docs.generateGoodsDocument(sent, "invoice", 1)).version, 1);
  assert.equal((await docs.sendGoodsDocument(sent, "invoice")).status, "sent", "Old sent layout remains compatible without resending");
  const oldGrid = { ...source, id: 5 };
  db.prepare(`INSERT INTO goods_purchase_documents(purchase_id,kind,version,status,source_hash,idempotency_key,created_by,created_at,updated_at)
    VALUES(5,'invoice',1,'generated',?,'old-grid',1,?,?)`).run(hash({ source: oldGrid, layout: "buyer-only-readable-metadata" }), new Date().toISOString(), new Date().toISOString());
  assert.equal((await docs.generateGoodsDocument(oldGrid, "invoice", 1)).version, 2, "Unsent previous grid receives the requested company wording");
  assert.equal(db.prepare("SELECT invoice_number FROM goods_purchase_documents WHERE purchase_id=2 AND version=2").get().invoice_number.slice(-3), "002");
  assert.equal(db.prepare("SELECT invoice_number FROM goods_purchase_documents WHERE purchase_id=5 AND version=2").get().invoice_number.slice(-3), "003");
  db.prepare("INSERT INTO goods_purchases VALUES(6),(7)").run();
  const receipt = { ...source, id: 6 };
  db.prepare(`INSERT INTO goods_purchase_documents(purchase_id,kind,version,status,source_hash,idempotency_key,created_by,created_at,updated_at)
    VALUES(6,'invoice',1,'generated',?,'previous-receipt',1,?,?)`).run(hash({ source: receipt, layout: "buyer-only-financing-company-receipt" }), new Date().toISOString(), new Date().toISOString());
  db.prepare("UPDATE goods_invoice_sequences SET last_number=999 WHERE month=?").run(generatedRecord.invoice_number.slice(0,6));
  await assert.rejects(() => docs.generateGoodsDocument(receipt, "invoice", 1), /invoice_monthly_sequence_exhausted/);
  assert.equal(db.prepare("SELECT status FROM goods_purchase_documents WHERE purchase_id=6").get().status, "generated", "Exhaustion must not supersede the original invoice");
  assert.equal(db.prepare("SELECT last_number FROM goods_invoice_sequences WHERE month=?").get(generatedRecord.invoice_number.slice(0,6)).last_number, 999);
  db.prepare("UPDATE goods_invoice_sequences SET last_number=3 WHERE month=?").run(generatedRecord.invoice_number.slice(0,6));
  assert.equal((await docs.generateGoodsDocument(receipt, "invoice", 1)).version, 2);
  assert.equal(db.prepare("SELECT invoice_number FROM goods_purchase_documents WHERE purchase_id=6 AND version=2").get().invoice_number.slice(-3), "004");
  const broken = { ...source, id: 7, creditAmountToman: "1" };
  await assert.rejects(() => docs.generateGoodsDocument(broken, "invoice", 1), /invoice_total_mismatch/);
  await assert.rejects(() => docs.generateGoodsDocument(broken, "invoice", 1), /invoice_total_mismatch/);
  const failedNumbers = db.prepare("SELECT invoice_number FROM goods_purchase_documents WHERE purchase_id=7 ORDER BY version").all();
  assert.deepEqual(failedNumbers.map(row => row.invoice_number.slice(-3)), ["005", "006"], "Failed document numbers are never recycled");
  Object.assign(process.env, { EMZAME_NATIONAL_CODE: "0000000000", EMZAME_PASSWORD: "synthetic-password", EMZAME_BUSINESS_ID: "synthetic-business" });
  let uploads = 0, sends = 0, failUpload = false;
  globalThis.fetch = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/login")) return Response.json({ accessToken: "synthetic-token" });
    if (pathname.endsWith("/users/checkUserActiveCertificate/")) return Response.json({ active: true });
    if (pathname.endsWith("/files")) {
      uploads++;
      assert.ok(init.body instanceof FormData);
      assert.equal((await init.body.get("file").text()).slice(0, 5), "%PDF-");
      assert.ok(init.headers["X-Idempotency-Key"]);
      if (failUpload === "nonJson") return new Response("Synthetic upstream failure", { status: 502 });
      // Actual provider response observed with a synthetic upload in production.
      return Response.json({ message: "accepted", result: { file: `synthetic-file-${uploads}` } }, { status: failUpload ? 400 : 200 });
    }
    if (pathname.endsWith("/contracts/sendContract")) {
      sends++;
      const payload = JSON.parse(init.body);
      assert.equal(payload.staticFileId, `synthetic-file-${uploads}`);
      return Response.json({ result: { contract: `synthetic-contract-${sends}` } });
    }
    throw Error("Unexpected external endpoint in synthetic test");
  };
  const beforeSend = db.prepare("SELECT invoice_number,pdf_sha256 FROM goods_purchase_documents WHERE id=?").get(generated.id);
  assert.equal((await docs.sendGoodsDocument(source, "invoice")).status, "sent");
  assert.equal(uploads, 1);
  assert.equal(sends, 1);
  assert.equal(db.prepare("SELECT provider_file_id FROM goods_purchase_documents WHERE id=?").get(generated.id).provider_file_id, "synthetic-file-1");
  await docs.sendGoodsDocument(source, "invoice");
  assert.equal(uploads, 1, "A sent invoice must not upload again");
  assert.equal(sends, 1, "A sent invoice must not create another contract");
  assert.deepEqual(db.prepare("SELECT invoice_number,pdf_sha256 FROM goods_purchase_documents WHERE id=?").get(generated.id), beforeSend);
  failUpload = true;
  await assert.rejects(() => docs.sendGoodsDocument(legacy, "invoice"), /provider_file_upload_failed/);
  const uploadFailure = db.prepare("SELECT status,provider_file_id,provider_contract_id FROM goods_purchase_documents WHERE purchase_id=2 ORDER BY version DESC LIMIT 1").get();
  assert.equal(uploadFailure.status, "generated");
  assert.equal(uploadFailure.provider_file_id, null, "Rejected uploads must not cache an ID");
  assert.equal(uploadFailure.provider_contract_id, null);
  failUpload = false;
  assert.equal((await docs.sendGoodsDocument(legacy, "invoice")).status, "sent", "Retry uses the original generated document");
  assert.equal(sends, 2, "Failed upload must not trigger a contract send");
  failUpload = "nonJson";
  await assert.rejects(() => docs.sendGoodsDocument(receipt, "invoice"), /provider_file_upload_failed/);
  assert.equal(db.prepare("SELECT status FROM goods_purchase_documents WHERE purchase_id=6 ORDER BY version DESC LIMIT 1").get().status, "generated");
  assert.equal(sends, 2, "A non-JSON upstream failure must not send a contract");
  console.log("Passed: financing company in both locations, exact receipt wording, missing-company rejection, buyer identity, seller omission, XML escaping, exact totals, PDF conversion, layout idempotency, older unsent renewal and sent/signed preservation.");
} finally {
  db?.close();
  await rm(temp, { recursive: true, force: true });
}