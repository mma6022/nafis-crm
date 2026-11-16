// REAL official Agent, REAL signed HTTP protocol, synthetic report + memory DB.
// Its publisher is explicitly preflight-only and can NEVER activate a release.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { createDiagnosticRouter } from "../src/lib/diagnostic-reports.ts";
import { RepairWorker, releaseOperation } from "../../../deploy/repair/repair-worker.mjs";
import { signedTransport } from "../../../deploy/repair/worker-transport.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const root = fs.realpathSync("/opt/nafisvam/current");
const baseline = { release: root.split("/").at(-1),
  sha256: hash(fs.readFileSync(root + "/artifacts/api-server/dist/index.mjs")) };
const schemaBefore = new DatabaseSync("/var/lib/nafisvam/customers.db", { readOnly: true });
const schemaVersion = schemaBefore.prepare("PRAGMA schema_version").get().schema_version;
schemaBefore.close();
const db = new DatabaseSync(":memory:");
const secret = randomBytes(48).toString("base64url");
const brokerKey = fs.readFileSync("/etc/nafisvam-repair-transport/broker-key", "utf8").trim();
const app = express();
app.use(express.json({ limit: "200kb" }));
app.use("/api", createDiagnosticRouter({ db, workerSecret: () => secret, currentBuild: () => baseline,
  healthy: async () => true,
  requireAuth: (req, res, next) => {
    if (req.headers["x-synthetic-actor"] !== "701") { res.sendStatus(401); return; }
    res.locals.authUser = { id: 701, role: "staff" }; next();
  } }));
const server = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
const origin = "http://127.0.0.1:" + server.address().port;
try {
  const api = signedTransport({ origin, key: secret });
  const broker = signedTransport({ origin: "http://127.0.0.1:7437", key: brokerKey, timeout: 140_000 });
  await api("/api/diagnostics-worker/claim");
  const response = await fetch(origin + "/api/diagnostics/reports", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Synthetic-Actor": "701" },
    body: JSON.stringify({ clientId: randomUUID(), page: "/synthetic-repair-preflight",
      description: "گزارش کاملاً ساختگی برای آزمون عامل: کارت repair-fixture-card با max-width برابر 100px بسیار باریک است و متن با white-space برابر nowrap می‌زند بیرون. در CSS آزمایشی عرض بیشینه را 360px و white-space را normal کن. همچنین تابع مستقل trimLabel در JavaScript آزمایشی متن hello را اشتباهاً به he کوتاه می‌کند؛ حد برش باید 20 نویسه باشد، نه 2؛ با hello و یک متن طولانی امتحان کن. هر دو فایل مستقل آزمایشی باید اصلاح و آزموده شوند، نه سایت اصلی.",
      browserEvents: [] }),
  });
  assert.equal(response.status, 201);
  const submitted = await response.json(), claim = (await api("/api/diagnostics-worker/claim")).job;
  assert.equal(claim.reportId, submitted.id);
  // Resume a genuine previously produced result after a verifier-only fix;
  // never spend another Agent turn or substitute a synthetic candidate.
  const resumeId = process.argv[2];
  if (resumeId) {
    assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(resumeId));
    const saved = JSON.parse(fs.readFileSync("/var/lib/nafisvam-repair-publisher/jobs/" + resumeId + "/state.json", "utf8"));
    assert.equal(saved.preflight, true);
    assert.equal(saved.baselineRelease, baseline.release);
    assert.equal(saved.baselineApiHash, baseline.sha256);
    Object.assign(claim, { jobId: resumeId, source: saved.source, brokerSubmitted: true });
  }
  const phases = [];
  const worker = new RepairWorker({ api, broker, pollMs: 12_000, deadlineMs: 18 * 60_000,
    release: input => releaseOperation(input.operation === "snapshot" ? { ...input, operation: "preflight-snapshot" } : input),
    audit: event => { phases.push(event.status); console.log(JSON.stringify(event)); },
  });
  const result = await worker.run(claim);
  assert.equal(result.status, "failed", "Preflight must NEVER claim a production repair succeeded.");
  assert(phases.includes("testing") && phases.includes("deploying"), "Actual candidate must pass independent validation before the publication refusal.");
  const proof = JSON.parse(fs.readFileSync("/var/lib/nafisvam-repair-publisher/preflight-proof.json", "utf8"));
  assert.equal(typeof proof.agentProof, "string");
  assert(proof.tests.length >= 5 && proof.tests.every(test => test.passed));
  assert(proof.tests.some(test => test.name.startsWith("isolated-javascript-checkJs-")));
  assert(proof.tests.some(test => test.name.startsWith("isolated-function-regression-")));
  assert.equal(fs.realpathSync("/opt/nafisvam/current"), root);
  assert.equal(hash(fs.readFileSync(root + "/artifacts/api-server/dist/index.mjs")), baseline.sha256);
  const check = new DatabaseSync("/var/lib/nafisvam/customers.db", { readOnly: true });
  assert.equal(check.prepare("PRAGMA schema_version").get().schema_version, schemaVersion);
  check.close();
  console.log(JSON.stringify({ passed: true, realAgentResultVerified: true, independentlyTested: true,
    preflightPublicationBlocked: true, fakeSuccessBlocked: true, mainReleaseUnchanged: true,
    mainDatabaseSchemaUnchanged: true, jobId: proof.jobId }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db.close();
}
