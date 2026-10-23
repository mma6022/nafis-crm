import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker, workerData, parentPort } from "node:worker_threads";
import { goodsInvoiceMonth, reserveGoodsInvoiceNumber } from "../src/lib/goods-invoice-numbering.ts";

const schema = `CREATE TABLE goods_invoice_sequences(month TEXT PRIMARY KEY,last_number INTEGER NOT NULL CHECK(last_number BETWEEN 1 AND 999));
  CREATE TABLE fixture_documents(invoice_number TEXT UNIQUE);`;
function issue(db, date) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const number = reserveGoodsInvoiceNumber(db, date);
    db.prepare("INSERT INTO fixture_documents VALUES(?)").run(number);
    db.exec("COMMIT");
    return number;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

if (workerData) {
  const db = new DatabaseSync(workerData.database);
  db.exec("PRAGMA busy_timeout=10000");
  const numbers = Array.from({ length: 30 }, () => issue(db, new Date("2026-11-01T10:00:00Z")));
  db.close();
  parentPort.postMessage(numbers);
} else {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const beforeMidnight = new Date("2026-10-22T20:29:59Z");
  const afterMidnight = new Date("2026-10-22T20:30:00Z");
  assert.equal(goodsInvoiceMonth(beforeMidnight), "140507");
  assert.equal(goodsInvoiceMonth(afterMidnight), "140508");
  assert.equal(issue(db, beforeMidnight), "140507001");
  assert.equal(issue(db, beforeMidnight), "140507002");
  assert.equal(issue(db, afterMidnight), "140508001", "Reset follows Tehran's Persian month, not UTC");
  db.exec("BEGIN IMMEDIATE");
  assert.equal(reserveGoodsInvoiceNumber(db, beforeMidnight), "140507003");
  assert.throws(() => db.prepare("INSERT INTO fixture_documents VALUES('140507001')").run());
  db.exec("ROLLBACK");
  assert.equal(issue(db, beforeMidnight), "140507003", "Failed insertion rolls back number allocation");
  db.prepare("UPDATE goods_invoice_sequences SET last_number=998 WHERE month='140507'").run();
  assert.equal(issue(db, beforeMidnight), "140507999");
  assert.throws(() => issue(db, beforeMidnight), /invoice_monthly_sequence_exhausted/);
  assert.equal(db.prepare("SELECT last_number FROM goods_invoice_sequences WHERE month='140507'").get().last_number, 999);
  db.close();
  const temp = await mkdtemp(path.join(os.tmpdir(), "invoice-numbering-synthetic-"));
  try {
    const database = path.join(temp, "synthetic.sqlite");
    const setup = new DatabaseSync(database);
    setup.exec(schema);
    setup.close();
    const batches = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { database } });
      worker.on("message", resolve);
      worker.on("error", reject);
      worker.on("exit", code => { if (code) reject(new Error(`worker failed: ${code}`)); });
    })));
    const numbers = batches.flat().sort();
    assert.equal(new Set(numbers).size, 120);
    assert.equal(numbers[0], "140508001");
    assert.equal(numbers[119], "140508120");
    console.log("Passed Persian/Tehran midnight month reset, padded numbering, transaction rollback, 999 limit and 120 concurrent unique invoices across four connections.");
  } finally { await rm(temp, { recursive: true, force: true }); }
}