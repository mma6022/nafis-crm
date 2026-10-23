import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "crm-voip-fixture-"));
const databasePath = path.join(tempRoot, "crm.db");
await copyFile(path.resolve("..", "..", "attached_assets", "customers_1789823100050.db"), databasePath);
const db = new DatabaseSync(databasePath);
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get();
const agent = db.prepare("SELECT id,salesperson_id FROM users WHERE role='salesperson' AND active=1 AND salesperson_id IS NOT NULL ORDER BY id LIMIT 1").get();
assert(admin?.id && agent?.id && agent?.salesperson_id, "Fixture requires active admin and assigned salesperson users");
const ownCustomer = db.prepare("SELECT id FROM customers WHERE salesperson_id=? ORDER BY id LIMIT 1").get(agent.salesperson_id);
const otherCustomer = db.prepare("SELECT id FROM customers WHERE salesperson_id IS NOT ? ORDER BY id LIMIT 1").get(agent.salesperson_id);
assert(ownCustomer?.id && otherCustomer?.id, "Fixture requires in-scope and out-of-scope customers");
db.prepare("UPDATE customers SET phone='09121234567' WHERE id=?").run(ownCustomer.id);
db.prepare("UPDATE customers SET phone='09129876543' WHERE id=?").run(otherCustomer.id);

const sessionSecret = "voip-fixture-secret";
const now = new Date().toISOString();
const sessions = new Map();
for (const userId of [admin.id, agent.id]) {
  const token = randomBytes(24).toString("base64url");
  sessions.set(userId, token);
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    createHmac("sha256", sessionSecret).update(token).digest("hex"),
    userId,
    new Date(Date.now() + 120_000).toISOString(),
    now,
  );
}
db.close();

const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["--enable-source-maps", "dist/index.mjs"], {
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NODE_ENV: "test",
    PORT: String(port),
    CRM_DATABASE_PATH: databasePath,
    SESSION_SECRET: sessionSecret,
    CONTRACTS_STORAGE_DIR: path.join(tempRoot, "contracts"),
    AUTO_BACKUP_DIR: path.join(tempRoot, "backups"),
    AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:1",
    AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-disabled",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childOutput = "";
child.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });
const request = async (pathName, userId, options = {}) => {
  const response = await fetch(`${baseUrl}/api${pathName}`, {
    ...options,
    headers: {
      cookie: `crm_session=${sessions.get(userId)}`,
      ...(options.body ? { "content-type": "application/json", origin: baseUrl } : {}),
    },
  });
  return { response, body: await response.json().catch(() => ({})) };
};

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode != null) throw new Error(`API exited early (${child.exitCode}): ${childOutput}`);
    try {
      if ((await fetch(`${baseUrl}/api/healthz`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  let result = await request("/voip/extensions", agent.id);
  assert(result.response.status === 403, "Non-admin extension listing must be forbidden");
  result = await request("/voip/config", agent.id, {
    method: "PUT",
    body: JSON.stringify({ enabled: false, wssUrl: "", sipDomain: "phone.avabom.com", stunUrls: [] }),
  });
  assert(result.response.status === 403, "Non-admin config mutation must be forbidden");

  result = await request("/voip/config", admin.id, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, wssUrl: "ws://token@example.test/socket?token=secret", sipDomain: "bad domain", stunUrls: [] }),
  });
  assert(result.response.status === 400, "Invalid config must be rejected");

  result = await request(`/voip/extensions/${agent.id}`, admin.id, {
    method: "PUT",
    body: JSON.stringify({ extension: "2201", authorizationUsername: "agent.2201" }),
  });
  assert(result.response.ok, "Admin should assign an extension");
  result = await request("/voip/config", admin.id, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, wssUrl: "wss://pbx.example.test/ws", sipDomain: "phone.avabom.com", stunUrls: [] }),
  });
  assert(result.response.ok, "Admin should enable a documented WSS endpoint");

  result = await request("/voip/lookup?phone=09129876543", agent.id);
  assert(result.response.ok && result.body.customer === null, "Lookup must hide out-of-scope customers");
  result = await request(`/voip/calls?customerId=${otherCustomer.id}`, agent.id);
  assert(result.response.status === 404, "Out-of-scope call filter must be rejected");

  const callId = randomUUID();
  const startedAt = new Date(Date.now() - 10_000).toISOString();
  const ringing = { callId, direction: "outgoing", phone: "09121234567", status: "ringing", startedAt };
  result = await request("/voip/calls", agent.id, { method: "POST", body: JSON.stringify(ringing) });
  assert(result.response.ok, "Initial call event must be accepted");
  result = await request("/voip/calls", agent.id, { method: "POST", body: JSON.stringify(ringing) });
  assert(result.response.ok, "Identical retry must be idempotent");
  const answeredAt = new Date(Date.now() - 5_000).toISOString();
  result = await request("/voip/calls", agent.id, {
    method: "POST",
    body: JSON.stringify({ ...ringing, status: "answered", answeredAt }),
  });
  assert(result.response.ok, "Monotonic answered event must be accepted");
  result = await request("/voip/config", admin.id, {
    method: "PUT",
    body: JSON.stringify({ enabled: false, wssUrl: "", sipDomain: "phone.avabom.com", stunUrls: [] }),
  });
  assert(result.response.ok, "Admin should be able to disable new browser calls");
  result = await request(`/voip/extensions/${agent.id}`, admin.id, {
    method: "PUT",
    body: JSON.stringify({ extension: null, authorizationUsername: null }),
  });
  assert(result.response.ok, "Admin should be able to remove an extension");
  result = await request("/voip/calls", agent.id, { method: "POST", body: JSON.stringify(ringing) });
  assert(result.response.status === 409, "Stale ringing event must be rejected");
  const endedAt = new Date().toISOString();
  result = await request("/voip/calls", agent.id, {
    method: "POST",
    body: JSON.stringify({ ...ringing, status: "completed", answeredAt, endedAt }),
  });
  assert(result.response.ok, "Existing call must finalize after config or extension removal");

  result = await request("/voip/calls?page=1", agent.id);
  assert(result.response.ok && result.body.total === 1 && result.body.items.length === 1,
    "Retries must not duplicate browser call history");
  assert(result.body.items[0].status === "completed" && result.body.items[0].customerId === ownCustomer.id,
    "History must retain latest monotonic state and scoped customer");

  const permissionDb = new DatabaseSync(databasePath);
  permissionDb.prepare("DELETE FROM role_permissions WHERE role_slug='salesperson' AND permission='customers.view'").run();
  permissionDb.close();
  result = await request("/voip/calls?page=1", agent.id);
  assert(result.response.ok && result.body.items[0].customerId === null
    && result.body.items[0].customerName === null,
  "History must hide customer details without customers.view");
  result = await request("/voip/contacts", agent.id);
  assert(result.response.status === 403, "Contacts require customers.view");
  result = await request(`/voip/extensions/${agent.id}`, admin.id, {
    method: "PUT",
    body: JSON.stringify({ extension: "2201", authorizationUsername: "agent.2201" }),
  });
  assert(result.response.ok, "Admin should restore the test extension");
  result = await request("/voip/config", admin.id, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, wssUrl: "wss://pbx.example.test/ws", sipDomain: "phone.avabom.com", stunUrls: [] }),
  });
  assert(result.response.ok, "Admin should restore test config");
  const unassociatedCallId = randomUUID();
  result = await request("/voip/calls", agent.id, {
    method: "POST",
    body: JSON.stringify({
      callId: unassociatedCallId,
      direction: "incoming",
      phone: "09121234567",
      status: "ringing",
      startedAt: new Date().toISOString(),
    }),
  });
  assert(result.response.ok, "Agent without customers.view should still log a call");
  const verificationDb = new DatabaseSync(databasePath);
  const unassociated = verificationDb.prepare(
    "SELECT customer_id FROM voip_browser_calls WHERE user_id=? AND call_id=?",
  ).get(agent.id, unassociatedCallId);
  assert(unassociated && unassociated.customer_id === null,
    "Call creation must not associate a customer without customers.view");
  verificationDb.prepare("DELETE FROM role_permissions WHERE role_slug='salesperson' AND permission='calls.view'").run();
  verificationDb.close();
  result = await request("/voip/config", agent.id);
  assert(result.response.status === 403, "VoIP config requires calls.view");
  process.stdout.write("PASS VoIP admin, scope, config, idempotency, ordering, and history fixture\n");
} finally {
  if (child.exitCode == null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  await rm(tempRoot, { recursive: true, force: true });
}