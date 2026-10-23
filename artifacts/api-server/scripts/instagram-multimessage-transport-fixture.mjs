import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "crm-instagram-multimessage-"));
const databasePath = path.join(tempRoot, "fixture.db");
const accountId = "synthetic-multi-account";
const bridgeSecret = "synthetic-multi-bridge-secret-only";
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT NOT NULL,mobile TEXT,active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE users(
    id INTEGER PRIMARY KEY,username TEXT NOT NULL,password_hash TEXT NOT NULL,full_name TEXT,
    mobile TEXT,priority_colors TEXT,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,salesperson_id INTEGER
  );
  CREATE TABLE customers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT NOT NULL,description TEXT,
    national_code TEXT,birth_date_jalali TEXT,postal_code TEXT,father_name TEXT,verification_status TEXT,
    verification_checked_at TEXT,identity_changed_at TEXT,verification_version INTEGER DEFAULT 0,
    verification_provider TEXT,shahkar_status TEXT,sana_status TEXT,person_info_status TEXT,
    postal_code_info_status TEXT,shahkar_ok INTEGER,person_info_ok INTEGER,postal_code_info_ok INTEGER,
    sana_ok INTEGER,salesperson_id INTEGER,merged_into_customer_id INTEGER,is_urgent INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,priority TEXT,status TEXT DEFAULT 'in_progress',credit_score REAL,
    credit_rank TEXT,credit_checked_at TEXT,first_name TEXT,last_name TEXT,address TEXT,
    official_first_name TEXT,official_last_name TEXT,official_father_name TEXT,official_address TEXT,
    official_postal_code TEXT
  );
  CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,salesperson_name_snapshot TEXT,created_at TEXT);
  CREATE TABLE reminders(id INTEGER PRIMARY KEY,user_id INTEGER,done INTEGER,remind_at TEXT,message TEXT,created_at TEXT);
  CREATE TABLE consultation_forms(id INTEGER PRIMARY KEY,customer_id INTEGER,requested_amount TEXT,updated_at TEXT);
  CREATE TABLE loan_applications(
    id INTEGER PRIMARY KEY,consultation_id INTEGER,customer_id INTEGER,requested_by_user_id INTEGER,
    plan_ids TEXT,plan_id INTEGER,requested_amount TEXT,status TEXT,notes TEXT,created_at TEXT
  );
  CREATE TABLE loan_plans(
    id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER DEFAULT 1,principal_amount TEXT,
    installment_terms TEXT,required_documents TEXT,bank_name TEXT,platform_name TEXT,
    annual_interest TEXT,installments TEXT,deposit_percents TEXT,customer_jobs TEXT,
    needs_guarantor INTEGER,notes TEXT,template_id TEXT
  );
  CREATE TABLE loan_plan_conditions(id INTEGER PRIMARY KEY,plan_id INTEGER,installment_options TEXT,customer_jobs TEXT);
  CREATE TABLE consult_options(
    id INTEGER PRIMARY KEY,field_key TEXT NOT NULL,option_value TEXT NOT NULL,label_fa TEXT NOT NULL,
    sort_order INTEGER,active INTEGER,UNIQUE(field_key,option_value)
  );
  CREATE TABLE auth_sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT NOT NULL UNIQUE,user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
  INSERT INTO schema_migrations(version, applied_at)
    VALUES ('customer-portal-loan-actor-provenance-v1', CURRENT_TIMESTAMP),
           ('customer-portal-stage-history-actor-v1', CURRENT_TIMESTAMP);
`);
db.close();

const attempts = [];
let releaseProviderWait;
let providerWaitStarted;
let providerWait = null;
const providerCounts = new Map();
const probe = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/provider-send") {
    const text = url.searchParams.get("text") ?? "";
    attempts.push(text);
    const count = (providerCounts.get(text) ?? 0) + 1;
    providerCounts.set(text, count);
    let action = "success";
    if (text === "SYNTHETIC_RETRY_ITEM" && count === 1) action = "429";
    if (text === "SYNTHETIC_UNCERTAIN_ITEM") action = "uncertain";
    if (text === "SYNTHETIC_REVISION_FIRST" && providerWait) {
      action = "wait";
      providerWaitStarted?.();
      await new Promise((resolve) => { releaseProviderWait = resolve; });
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ action }));
    return;
  }
  if (url.pathname === "/provider-send/release") {
    releaseProviderWait?.();
    response.writeHead(204).end();
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const notifyUrl = `http://127.0.0.1:${probe.address().port}/provider-send`;

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let child;
let childLogs = "";
let baseUrl = "";
async function startServer() {
  const port = await unusedPort();
  child = spawn(process.execPath, [
    "--import", "./scripts/manychat-fetch-mock.mjs",
    "--enable-source-maps", "dist/index.mjs",
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: "test",
      AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9/fixture-disabled",
      AI_INTEGRATIONS_OPENAI_API_KEY: "synthetic-ai-key",
      PORT: String(port),
      CRM_DATABASE_PATH: databasePath,
      SESSION_SECRET: "synthetic-multi-session-secret",
      MANYCHAT_ACCOUNT_ID: accountId,
      MANYCHAT_BRIDGE_SECRET: bridgeSecret,
      MANYCHAT_API_TOKEN: "synthetic-token-for-tests-only",
      MANYCHAT_AUTOREPLY_ENABLED: "1",
      INSTAGRAM_MULTIMESSAGE_NOTIFY_URL: notifyUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { childLogs = `${childLogs}${chunk}`.slice(-12_000); });
  child.stderr.on("data", (chunk) => { childLogs = `${childLogs}${chunk}`.slice(-12_000); });
  baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${baseUrl}/api/healthz`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Synthetic Instagram server did not start. ${childLogs}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && child.exitCode === null) await sleep(50);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function openDb() {
  const fixtureDb = new DatabaseSync(databasePath);
  fixtureDb.exec("PRAGMA busy_timeout=5000");
  return fixtureDb;
}

function seedTransportBatch(subscriberId, texts) {
  const fixtureDb = openDb();
  const now = new Date().toISOString();
  const inboundId = `synthetic-multi-inbound-${subscriberId}`;
  const threadId = Number(fixtureDb.prepare(`
    INSERT INTO instagram_threads(sender_id,status,last_message_at,created_at,updated_at)
    VALUES(?, 'open', ?, ?, ?)
  `).run(`mc:${accountId}:${subscriberId}`, now, now, now).lastInsertRowid);
  fixtureDb.prepare(`
    INSERT INTO instagram_messages(thread_id,mid,direction,content,sent_at)
    VALUES(?, ?, 'inbound', 'Synthetic transport fixture', ?)
  `).run(threadId, inboundId, now);
  fixtureDb.prepare(`
    INSERT INTO instagram_send_queue(
      thread_id,state,revision,due_at,created_at,updated_at,error,reply_messages_json,next_message_index
    ) VALUES(?, 'pending', 1, ?, ?, ?, NULL, ?, 0)
  `).run(threadId, new Date(Date.now() - 20_000).toISOString(), now, now, JSON.stringify(texts));
  fixtureDb.close();
  return threadId;
}

function queueRow(threadId) {
  const fixtureDb = openDb();
  const row = fixtureDb.prepare("SELECT * FROM instagram_send_queue WHERE thread_id=?").get(threadId);
  fixtureDb.close();
  return row;
}

function outboundRows(threadId) {
  const fixtureDb = openDb();
  const rows = fixtureDb.prepare(`
    SELECT content FROM instagram_messages WHERE thread_id=? AND direction='outbound' ORDER BY id
  `).all(threadId).map((row) => row.content);
  fixtureDb.close();
  return rows;
}

function outboundRecords(threadId) {
  const fixtureDb = openDb();
  const rows = fixtureDb.prepare(`
    SELECT mid,content FROM instagram_messages WHERE thread_id=? AND direction='outbound' ORDER BY id
  `).all(threadId);
  fixtureDb.close();
  return rows;
}

function makeDueNow(threadId) {
  const fixtureDb = openDb();
  const past = new Date(Date.now() - 20_000).toISOString();
  fixtureDb.prepare("UPDATE instagram_send_state SET last_sent_at=? WHERE id=1").run(past);
  fixtureDb.prepare("UPDATE instagram_send_queue SET due_at=? WHERE thread_id=? AND state='pending'").run(past, threadId);
  fixtureDb.close();
}

async function waitFor(description, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function main() {
  await startServer();

  const recommendationTexts = [
    "طرح مصنوعی: بخش اول",
    "SYNTHETIC_RETRY_ITEM",
    "طرح مصنوعی: بخش سوم",
  ];
  const recommendationThread = seedTransportBatch("123450001", recommendationTexts);
  await waitFor("first independently sent recommendation message", () => providerCounts.has(recommendationTexts[0]));
  await waitFor("first outbound message row", () => outboundRows(recommendationThread).length === 1);
  assert(JSON.stringify(outboundRows(recommendationThread)) === JSON.stringify([recommendationTexts[0]]),
    "The first package recommendation is persisted as one message, not concatenated with later items");
  makeDueNow(recommendationThread);

  await waitFor("second message's initial 429 attempt", () => providerCounts.get("SYNTHETIC_RETRY_ITEM") === 1);
  await waitFor("durable rate-limited pending batch", () => queueRow(recommendationThread)?.error === "rate_limited");
  const rateLimited = queueRow(recommendationThread);
  assert(rateLimited.next_message_index === 1 &&
    JSON.stringify(JSON.parse(rateLimited.reply_messages_json)) === JSON.stringify(recommendationTexts) &&
    outboundRows(recommendationThread).length === 1,
  "429 retains the frozen ordered batch and the exact unsent ordinal without replaying an accepted item");

  await stopServer();
  makeDueNow(recommendationThread);
  await startServer();
  await waitFor("second message retry after server restart", () => providerCounts.get("SYNTHETIC_RETRY_ITEM") === 2);
  await waitFor("second successful outbound row", () => outboundRows(recommendationThread).length === 2);
  assert(JSON.stringify(outboundRows(recommendationThread)) === JSON.stringify(recommendationTexts.slice(0, 2)),
    "Restart resumes at the rate-limited message without duplicating the previously accepted message");
  makeDueNow(recommendationThread);
  await waitFor("third recommendation message", () => providerCounts.has(recommendationTexts[2]));
  await waitFor("all recommendation rows", () => outboundRows(recommendationThread).length === 3);
  assert(JSON.stringify(outboundRows(recommendationThread)) === JSON.stringify(recommendationTexts),
    "Each package recommendation is a distinct provider send and outbound row");
  assert(queueRow(recommendationThread).state === "sent" &&
    queueRow(recommendationThread).next_message_index === recommendationTexts.length,
  "The durable batch completes only after every item is accepted");

  const uncertainThread = seedTransportBatch("123450002", ["SYNTHETIC_UNCERTAIN_ITEM", "must-not-replay"]);
  await waitFor("uncertain provider outcome", () => providerCounts.has("SYNTHETIC_UNCERTAIN_ITEM"));
  await waitFor("fail-closed uncertain queue", () =>
    queueRow(uncertainThread)?.error === "send_outcome_uncertain");
  await sleep(2_500);
  assert(providerCounts.get("SYNTHETIC_UNCERTAIN_ITEM") === 1 &&
    outboundRows(uncertainThread).length === 0 &&
    queueRow(uncertainThread).state === "failed",
  "An uncertain network result fails closed and is never automatically replayed");

  const releaseWait = () => releaseProviderWait?.();
  const sendStarted = new Promise((resolve) => { providerWaitStarted = resolve; });
  providerWait = true;
  const revisionThread = seedTransportBatch("123450003", [
    "SYNTHETIC_REVISION_FIRST", "SYNTHETIC_REVISION_MUST_CANCEL",
  ]);
  const originalRevision = queueRow(revisionThread).revision;
  await sendStarted;
  const fixtureDb = openDb();
  fixtureDb.prepare("UPDATE instagram_threads SET paused=1 WHERE id=?").run(revisionThread);
  fixtureDb.close();
  const inboundResponse = await fetch(`${baseUrl}/api/manychat/inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CRM-Bridge-Secret": bridgeSecret },
    body: JSON.stringify({
      subscriberId: "123450003",
      text: "Synthetic newer inbound revision",
      messageId: "synthetic-newer-revision",
    }),
  });
  assert(inboundResponse.ok, "Newer inbound revision is accepted while a provider send is in flight");
  releaseWait();
  try {
    await waitFor("first already-authorized send to settle", () => outboundRows(revisionThread).length === 1);
  } catch (error) {
    throw new Error(
      `${error.message}; acceptedAttempts=${providerCounts.get("SYNTHETIC_REVISION_FIRST") ?? 0}; ` +
      `queue=${JSON.stringify(queueRow(revisionThread))}; ` +
      `outbound=${JSON.stringify(outboundRecords(revisionThread))}; childLogs=${childLogs}`,
    );
  }
  await sleep(2_500);
  const revisionQueue = queueRow(revisionThread);
  const revisionOutbound = outboundRecords(revisionThread);
  const threadDb = openDb();
  const revisionThreadRow = threadDb.prepare(
    "SELECT paused,last_reply_at FROM instagram_threads WHERE id=?",
  ).get(revisionThread);
  threadDb.close();
  assert(providerCounts.get("SYNTHETIC_REVISION_MUST_CANCEL") === undefined &&
    revisionQueue.state === "failed" && revisionQueue.revision === originalRevision + 1 &&
    revisionQueue.error === "identity_pending" &&
    revisionQueue.next_message_index === 0 && revisionQueue.reply_messages_json === null &&
    JSON.stringify(revisionOutbound) === JSON.stringify([{
      mid: `out:${revisionQueue.id}:${originalRevision}:0`,
      content: "SYNTHETIC_REVISION_FIRST",
    }]) && revisionThreadRow.paused === 1 && revisionThreadRow.last_reply_at === null,
  "A newer inbound revision cancels the remaining frozen batch without allowing the old job to overwrite it");

  console.log("Instagram multi-message transport fixture passed");
}

try {
  await main();
} finally {
  releaseProviderWait?.();
  await stopServer();
  await new Promise((resolve) => probe.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}