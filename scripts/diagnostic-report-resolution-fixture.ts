/** Additive resolution columns on diagnostic_reports + br.py. Never hits live. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { once } from "node:events";
import { createDiagnosticRouter, ensureDiagnosticResolutionColumns } from "../src/lib/diagnostic-reports";

const OLD_SCHEMA = `
CREATE TABLE diagnostic_reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,client_id TEXT NOT NULL,
  description TEXT NOT NULL,page TEXT NOT NULL,status TEXT NOT NULL,
  browser_events_json TEXT NOT NULL,server_events_json TEXT NOT NULL,
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
  lease_hash TEXT,lease_until INTEGER,baseline_release TEXT,baseline_sha256 TEXT,
  target_release TEXT,target_sha256 TEXT,tests_json TEXT,failure TEXT,
  UNIQUE(user_id,client_id));
CREATE TABLE users(id INTEGER PRIMARY KEY, role TEXT);
`;

const dir = mkdtempSync(path.join(tmpdir(), "diag-res-"));
const dbPath = path.join(dir, "crm.db");
assert.notEqual(path.resolve(dbPath), "/var/lib/nafisvam/customers.db");

const fileDb = new DatabaseSync(dbPath);
fileDb.exec(OLD_SCHEMA);
fileDb.exec(`INSERT INTO users(id, role) VALUES (2, 'salesperson')`);
fileDb.exec(`
  INSERT INTO diagnostic_reports(user_id,client_id,description,page,status,browser_events_json,server_events_json,created_at,updated_at)
  VALUES (2,'client-open-1','مشتری با شماره 09123456789 و کد 0071234567 مشکل دارد','/loan-applications/212','failed','[]','[]','2026-11-03T07:39:00.749Z','2026-11-03T07:39:00.749Z')
`);
const colsBefore = (fileDb.prepare("PRAGMA table_info(diagnostic_reports)").all() as { name: string }[]).map((c) => c.name);
assert.ok(!colsBefore.includes("resolution_status"), "fixture starts from the live-like schema");

ensureDiagnosticResolutionColumns(fileDb);
ensureDiagnosticResolutionColumns(fileDb); // idempotent
const cols = new Set((fileDb.prepare("PRAGMA table_info(diagnostic_reports)").all() as { name: string }[]).map((c) => c.name));
for (const name of ["resolution_status", "resolved_at", "resolved_by", "resolution_note", "fix_ref"]) {
  assert.ok(cols.has(name), `missing column ${name}`);
}
const existing = fileDb.prepare("SELECT resolution_status AS s FROM diagnostic_reports WHERE id=1").get() as { s: string };
assert.equal(existing.s, "open");
fileDb.close();

const script = [
  path.resolve(process.cwd(), "scripts/br.py"),
  path.resolve(process.cwd(), "artifacts/api-server/scripts/br.py"),
  "/workspace/report-btn/src/artifacts/api-server/scripts/br.py",
].find((c) => { try { return readFileSync(c); } catch { return false; } });
assert.ok(script, "br.py not found next to the API scripts");
const undoDir = path.join(dir, "undo");
const listed = spawnSync("python3", [script, "--db", dbPath, "list-open"], { encoding: "utf8" });
assert.equal(listed.status, 0, listed.stderr || listed.stdout);
assert.match(listed.stdout, /\t\/loan-applications\/212\t/);
assert.match(listed.stdout, /salesperson/);
assert.doesNotMatch(listed.stdout, /09123456789/);
assert.doesNotMatch(listed.stdout, /0071234567/);
assert.match(listed.stdout, /0912\*\*\*89|0912\*\*\*89|\[id\]|0912\*\*\*/);

const marked = spawnSync("python3", [
  script, "--db", dbPath, "--undo-dir", undoDir,
  "mark", "1", "resolved", "--note", "fixed locally", "--ref", "fix/report-button-placement@test / RID 20261111070000", "--by", "fixture",
], { encoding: "utf8" });
assert.equal(marked.status, 0, marked.stderr || marked.stdout);
assert.match(marked.stdout, /marked 1 resolved/);
assert.match(marked.stdout, /undo /);

const after = new DatabaseSync(dbPath, { readOnly: true });
const row = after.prepare("SELECT resolution_status s, resolution_note n, fix_ref r, resolved_by b, resolved_at a, status st FROM diagnostic_reports WHERE id=1").get() as any;
assert.equal(row.s, "resolved");
assert.equal(row.n, "fixed locally");
assert.match(String(row.r), /RID 20261111070000/);
assert.equal(row.b, "fixture");
assert.ok(row.a, "resolved_at set");
assert.equal(row.st, "failed", "auto-repair status column is unchanged");
after.close();

const undoFiles = spawnSync("ls", [undoDir], { encoding: "utf8" });
assert.equal(undoFiles.status, 0);
const undoName = undoFiles.stdout.trim().split(/\s+/).filter(Boolean)[0];
assert.ok(undoName, "undo log written");
const undo = JSON.parse(readFileSync(path.join(undoDir, undoName), "utf8"));
assert.equal(undo.id, 1);
assert.equal(undo.before.status, "failed");
assert.equal(undo.before.resolution_status, "open");

// Save path: creating a report still works; new rows default to open; no webhook.
const mem = new DatabaseSync(":memory:");
const auth: express.RequestHandler = (req, res, next) => {
  const id = Number(req.get("X-Test-Actor"));
  if (!id) { res.status(401).json({ error: "unauthorized" }); return; }
  res.locals.authUser = { id, role: "staff" };
  next();
};
const app = express();
app.use(express.json());
app.use("/api", createDiagnosticRouter({
  db: mem, requireAuth: auth, workerSecret: () => undefined, currentBuild: () => null, healthy: async () => true,
}));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/reports`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Test-Actor": "2" },
  body: JSON.stringify({
    clientId: "clientid_" + "x".repeat(12),
    description: "گزارش آزمایشی برای مسیر ذخیره بدون وب‌هوک",
    page: "/customers",
    browserEvents: [],
  }),
});
assert.equal(res.status, 201, await res.text());
const saved = mem.prepare("SELECT resolution_status s, status st FROM diagnostic_reports ORDER BY id DESC LIMIT 1").get() as any;
assert.equal(saved.s, "open");
assert.ok(saved.st, "legacy status still written");
server.close();

rmSync(dir, { recursive: true, force: true });
console.log("ok - resolution columns are additive and idempotent");
console.log("ok - existing rows default to open; save path unchanged");
console.log("ok - br.py list-open masks phones/ids and mark writes an undo log");
console.log("PASS diagnostic-report-resolution");
