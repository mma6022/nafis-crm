// FILE-DETAIL v1.1: synthetic fixture for the per-user flag and «ارسال دوباره‌ی لینک امضا».
// Only a temporary SQLite database with synthetic rows is opened. No provider or SMS call is made.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "file-detail-v1-"));
const dbPath = path.join(temp, "fixture.sqlite");
const dbModule = `
  import { DatabaseSync } from "node:sqlite";
  export const crmDb = new DatabaseSync(${JSON.stringify(dbPath)});
  export const queryRow = (sql, p=[]) => crmDb.prepare(sql).get(...p);
  export const queryRows = (sql, p=[]) => crmDb.prepare(sql).all(...p);
`;
try {
  const out = path.join(temp, "lib.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/file-detail-v1.ts")], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent",
    plugins: [{ name: "db", setup(b) { b.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fx" })); b.onLoad({ filter: /.*/, namespace: "fx" }, () => ({ contents: dbModule, loader: "js" })); } }],
  });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE call_queue_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE customers(id INTEGER PRIMARY KEY, salesperson_id INTEGER);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, stage TEXT, deleted_at TEXT, current_primary_generation_id INTEGER);
    CREATE TABLE contract_generations(id INTEGER PRIMARY KEY, loan_application_id INTEGER, status TEXT, provider_contract_id TEXT, generation_purpose TEXT,
      contract_number TEXT, provider_status TEXT, created_at TEXT, sent_at TEXT, superseded_at TEXT, deleted_at TEXT);
    CREATE TABLE loan_application_stage_history(id INTEGER PRIMARY KEY, application_id INTEGER, from_stage TEXT, to_stage TEXT, action TEXT, reason TEXT, actor_id INTEGER, created_at TEXT);
    INSERT INTO call_queue_settings VALUES ('flag.file_detail_v1.user.3','1','x'),('flag.file_detail_v1.user.29','1','x'),('flag.file_detail_v1.user.5','1','x');
    INSERT INTO customers VALUES (10,4),(11,9);
    INSERT INTO loan_applications VALUES (98,10,'reviewing','approved_contract_pending_signature',NULL,263),(99,11,'reviewing','approved_contract_pending_signature',NULL,300),(100,10,'rejected','approved_contract_pending_signature',NULL,301);
    INSERT INTO contract_generations VALUES (263,98,'sent','P-1','primary','N1','readyForSign','2026-01-01T09:00:00.000Z','2026-01-01T09:00:00.000Z',NULL,NULL),
      (119,98,'signed','P-0','primary','N0','signed','2025-12-01T09:00:00.000Z','2025-12-01T09:00:00.000Z','2026-01-01T08:00:00.000Z',NULL),
      (300,99,'sent','P-2','primary','N2','readyForSign','2026-01-01T09:00:00.000Z','2026-01-01T09:00:00.000Z',NULL,NULL),
      (301,100,'sent','P-3','primary','N3','readyForSign','2026-01-01T09:00:00.000Z','2026-01-01T09:00:00.000Z',NULL,NULL);`);
  const L = await import(pathToFileURL(out).href);
  const sp = (id, extra = {}) => ({ id, role: "salesperson", salespersonId: 4, permissions: ["contracts.send"], ...extra });
  const t0 = new Date("2026-01-01T09:05:00.000Z");
  const count = (sql) => db.prepare(sql).get().n;
  const gens = () => JSON.stringify(db.prepare("SELECT * FROM contract_generations ORDER BY id").all());
  const before = gens();

  assert.equal(L.fdOn(3), true); assert.equal(L.fdOn(29), false, "user 29 is never ON"); assert.equal(L.fdOn(4), false, "missing key = OFF");
  assert.equal((await L.fdResendSignatureLink(sp(4), 98, 263, t0)).status, 404, "flag OFF");
  assert.equal((await L.fdResendSignatureLink(sp(3, { permissions: [] }), 98, 263, t0)).status, 403, "no contracts.send");
  assert.equal((await L.fdResendSignatureLink(sp(3), 99, 300, t0)).status, 404, "other salesperson's customer");
  assert.equal((await L.fdResendSignatureLink(sp(3), 100, 301, t0)).error, "file_closed");
  assert.equal((await L.fdResendSignatureLink(sp(3), 98, 119, t0)).error, "generation_not_current", "signed/superseded contract has no resend");
  assert.equal((await L.fdResendSignatureLink(sp(3), 98, 300, t0)).error, "generation_not_current", "generation of another file");
  const early = await L.fdResendSignatureLink(sp(3), 98, 263, t0);
  assert.equal(early.status, 429, "the original send counts"); assert.equal(early.retryAfterSeconds, 300);
  const t1 = new Date("2026-01-01T09:11:00.000Z");
  assert.equal((await L.fdResendSignatureLink(sp(3), 98, 263, t1)).status, 501, "provider not confirmed: refuse honestly");
  assert.equal(count("SELECT COUNT(*) n FROM file_detail_link_resends"), 0);
  assert.equal(gens(), before, "501: no contract/generation row created or changed");
  assert.equal(count("SELECT COUNT(*) n FROM contract_generations"), 4, "501: no new generation");
  assert.equal(count("SELECT COUNT(*) n FROM loan_application_stage_history"), 0, "501: nothing logged as sent");
  assert.deepEqual(L.fdLinkResendState(98, t1), { available: false, items: [{ generationId: 263, purpose: "primary", contractNumber: "N1", providerStatus: "readyForSign",
    createdAt: "2026-01-01T09:00:00.000Z", firstSentAt: "2026-01-01T09:00:00.000Z", lastSentAt: "2026-01-01T09:00:00.000Z", retryAfterSeconds: 0 }] });

  let calls = []; let release;
  L.setFdDeliverResendForTests((g) => { calls.push(g); return new Promise((r) => { release = () => r("sent"); }); });
  const p1 = L.fdResendSignatureLink(sp(3), 98, 263, t1);
  const p2 = await L.fdResendSignatureLink(sp(3), 98, 263, t1);
  assert.equal(p2.status, 429, "a second press while sending does not send twice");
  release(); const ok = await p1;
  assert.deepEqual(ok, { ok: true, status: 200, sentAt: t1.toISOString() });
  assert.deepEqual(calls, [{ id: 263, providerContractId: "P-1" }], "same generation, same provider contract");
  const h = db.prepare("SELECT from_stage, to_stage, action, actor_id, created_at FROM loan_application_stage_history").all().map((r) => ({ ...r }));
  assert.deepEqual(h, [{ from_stage: "approved_contract_pending_signature", to_stage: "approved_contract_pending_signature", action: "signature-link-resent:263", actor_id: 3, created_at: t1.toISOString() }]);
  const w = await L.fdResendSignatureLink(sp(3), 98, 263, new Date("2026-01-01T09:20:30.000Z"));
  assert.equal(w.status, 429); assert.equal(w.retryAfterSeconds, 30);
  assert.equal(L.fdLinkResendState(98, new Date("2026-01-01T09:20:30.000Z")).items[0].lastSentAt, t1.toISOString());
  L.setFdDeliverResendForTests(async () => { throw new Error("provider down"); });
  assert.equal((await L.fdResendSignatureLink(sp(3), 98, 263, new Date("2026-01-01T09:30:00.000Z"))).status, 502);
  assert.equal(gens(), before, "contract rows are never written");
  assert.equal(count("SELECT COUNT(*) n FROM contract_generations"), 4);
  console.log("file-detail-v1 fixture: ok");
} finally { await rm(temp, { recursive: true, force: true }); }
