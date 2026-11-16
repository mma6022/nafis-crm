// Operator-only synthetic verification. Bundle before copying to the VPS.
// Never expose this script or its private fixture manifest through the website.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHmac } from "node:crypto";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { registerCustomerIdentityFunctions } from "../src/lib/customer-integrity";
import { portalApi, PortalApiError } from "../../crm-dashboard/src/customer-portal/api";
import { buildPlanFinderRequest } from "../../crm-dashboard/src/customer-portal/plan-finder-answers";

const [mode, manifestPath] = process.argv.slice(2);
assert.ok(["seed", "verify", "finder", "cleanup"].includes(mode) && manifestPath?.startsWith("/var/tmp/"));
const db = new DatabaseSync("/var/lib/nafisvam/customers.db");
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
registerCustomerIdentityFunctions(db);
const root = "/var/lib/nafisvam/customer-chat";
const transaction = fn => {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
};
const run = (sql, ...params) => db.prepare(sql).run(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const sessionHash = (secret, token, customer) => createHmac("sha256", secret)
  .update((customer ? "customer-portal-session:" : "") + token).digest("hex");
let manifest;
function request(route, who, { method = "GET", body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(`https://crm.nafisvam.com${route}`, {
      method,
      lookup: (_host, options, cb) => options.all
        ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4),
      headers: {
        ...(manifest.cookies[who] ? { cookie: manifest.cookies[who] } : {}),
        ...(body ? { "Content-Type": contentType, "Content-Length": body.length } : {}),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.setTimeout(15000, () => req.destroy(new Error("probe_request_timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
function multipart(bytes, mime, name, clientId) {
  const boundary = `probe-${randomBytes(12).toString("hex")}`;
  return {
    method: "POST", contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientId"\r\n\r\n${clientId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
function samples() {
  // Valid tiny PNG, complete minimal PDF, and one second of synthetic PCM audio.
  const pcm = Buffer.alloc(16000);
  for (let i = 0; i < 8000; i++) pcm.writeInt16LE(Math.round(1000 * Math.sin(i * 2 * Math.PI * 440 / 8000)), i * 2);
  const wav = Buffer.from("524946460000000057415645666d74201000000001000100401f0000803e0000020010006461746100000000", "hex");
  wav.writeUInt32LE(36 + pcm.length, 4); wav.writeUInt32LE(pcm.length, 40);
  let pdf = "%PDF-1.4\n", offsets = [0];
  const objects = ["<</Type /Catalog /Pages 2 0 R>>", "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R>>",
    "<</Length 0>>\nstream\n\nendstream"];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<</Size 5 /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return [
    ["image.png", "image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKz8AAAAASUVORK5CYII=", "base64")],
    ["document.pdf", "application/pdf", Buffer.from(pdf)],
    ["voice.wav", "audio/wav", Buffer.concat([wav, pcm])],
  ];
}
async function cleanup() {
  for (const id of manifest.customers) {
    assert.ok(get("SELECT 1 FROM customers WHERE id=? AND description=?", id, manifest.marker),
      "Never clean a row without its exact synthetic provenance");
  }
  const placeholders = manifest.customers.map(() => "?").join(",");
  const refs = db.prepare(`SELECT object_path FROM customer_chat_messages WHERE customer_id IN (${placeholders}) AND object_path IS NOT NULL`)
    .all(...manifest.customers).map(row => row.object_path);
  for (const ref of refs) {
    assert.match(ref, /^vps-private:customer-chat\/[0-9a-f-]{36}$/);
    await unlink(`${root}/${ref.split("/").at(-1)}`).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  transaction(() => {
    run(`DELETE FROM customer_chat_messages WHERE customer_id IN (${placeholders})`, ...manifest.customers);
    run(`DELETE FROM customer_chat_reads WHERE customer_id IN (${placeholders})`, ...manifest.customers);
    run(`DELETE FROM consultation_forms WHERE customer_id IN (${placeholders})`, ...manifest.customers);
    for (const id of manifest.customers) {
      run("DELETE FROM customer_chat_presence WHERE actor_type='customer' AND actor_id=?", id);
      run("DELETE FROM customer_portal_sessions WHERE customer_id=?", id);
      run("DELETE FROM customers WHERE id=? AND description=?", id, manifest.marker);
    }
    for (const id of manifest.users) {
      run("DELETE FROM customer_chat_presence WHERE actor_type='staff' AND actor_id=?", id);
      run("DELETE FROM auth_sessions WHERE user_id=?", id);
      run("DELETE FROM users WHERE id=? AND username LIKE ?", id, `${manifest.marker}%`);
    }
    for (const id of manifest.salespersons) run("DELETE FROM salespersons WHERE id=? AND name LIKE ?", id, `${manifest.marker}%`);
    for (const role of manifest.roles) {
      run("DELETE FROM role_permissions WHERE role_slug=?", role);
      run("DELETE FROM app_roles WHERE slug=?", role);
    }
  });
  for (const id of manifest.customers) assert.equal(get("SELECT 1 FROM customers WHERE id=?", id), undefined);
  for (const id of manifest.users) assert.equal(get("SELECT 1 FROM users WHERE id=?", id), undefined);
  for (const ref of refs) assert.ok(!(await readdir(root)).includes(ref.split("/").at(-1)));
  await unlink(manifestPath);
  console.log("PASS: all synthetic records, sessions and attachments removed; real customer rows untouched.");
}
try {
  if (mode === "seed") {
    const marker = `__chat_probe_${randomBytes(10).toString("hex")}`;
    manifest = { marker, customers: [], users: [], salespersons: [], roles: [`${marker}_assigned`, `${marker}_blocked`], cookies: {} };
    // Read only the session-signing secret into this process. Never print/export it.
    const pid = execFileSync("systemctl", ["show", "nafisvam-crm.service", "-p", "MainPID", "--value"], { encoding: "utf8" }).trim();
    const env = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
    const secret = env.find(value => value.startsWith("SESSION_SECRET="))?.slice("SESSION_SECRET=".length);
    assert.ok(secret, "Running service session configuration missing");
    const now = new Date().toISOString(), expires = new Date(Date.now() + 30 * 60_000).toISOString();
    transaction(() => {
      for (const role of manifest.roles) run("INSERT INTO app_roles(slug,name,customer_scope,created_at) VALUES(?,?,'assigned',?)", role, role, now);
      run("INSERT INTO role_permissions(role_slug,permission) VALUES(?,'customers.view')", manifest.roles[0]);
      for (let i = 0; i < 2; i++) {
        const sid = Number(run("INSERT INTO salespersons(name,created_at) VALUES(?,?)", `${marker}_expert_${i}`, now).lastInsertRowid);
        manifest.salespersons.push(sid);
        let mobile;
        do { mobile = "0999" + String(parseInt(randomBytes(4).toString("hex"), 16) % 10000000).padStart(7, "0"); }
        while (get("SELECT 1 FROM customers WHERE crm_customer_mobile_key(phone)=?", mobile));
        const cid = Number(run(`INSERT INTO customers(name,phone,description,created_at,salesperson_id,
          national_code,first_name,last_name,father_name,birth_date_jalali,verification_checked_at,shahkar_ok,person_info_ok)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,1,1)`, `${marker}_customer_${i}`, mobile, marker, now, sid,
          `${marker}_${i}`, "Synthetic", "Fixture", "Fixture", "1370/01/01", now).lastInsertRowid);
        manifest.customers.push(cid);
        const token = randomBytes(32).toString("base64url");
        run("INSERT INTO customer_portal_sessions(token_hash,mobile,customer_id,created_at,expires_at) VALUES(?,?,?,?,?)",
          sessionHash(secret, token, true), mobile, cid, now, expires);
        manifest.cookies[i === 0 ? "customer" : "customer2"] = `customer_portal_session=${token}`;
      }
      for (const [i, who] of ["owner", "other", "blocked"].entries()) {
        const uid = Number(run("INSERT INTO users(username,password_hash,full_name,role,salesperson_id,created_at) VALUES(?,?,?,?,?,?)",
          `${marker}_${who}`, "!disabled-synthetic-password", `${marker}_${who}`,
          manifest.roles[who === "blocked" ? 1 : 0], manifest.salespersons[i === 1 ? 1 : 0], now).lastInsertRowid);
        manifest.users.push(uid);
        const token = randomBytes(32).toString("base64url");
        run("INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)", sessionHash(secret, token, false), uid, now, expires);
        manifest.cookies[who] = `crm_session=${token}`;
      }
    });
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    console.log("Synthetic identities prepared; session values kept in a private manifest only.");
  } else {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (mode === "cleanup") await cleanup();
      else if (mode === "finder") {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, init = {}) => {
          const reply = await request(String(url), "customer", {
            method: init.method || "GET",
            body: init.body ? Buffer.from(init.body) : undefined,
            contentType: new Headers(init.headers).get("Content-Type") || "application/json",
          });
          return new Response(reply.bytes, { status: reply.status, headers: reply.headers });
        };
        try {
          const { options } = await portalApi.planFinderOptions();
          const pick = field => {
            const option = options.find(o => o.fieldKey === field);
            assert.ok(option, `Missing questionnaire options: ${field}`);
            return option.value;
          };
          const base = { creditRank: pick("credit_rank"), jobType: pick("job_type"),
            customerCheckStatus: pick("customer_check_status"),
            hasCustomerSalaryDeduct: "no", hasGuarantor: "no" };
          for (const answers of [base, { ...base, hasGuarantor: "yes",
            guarantorCreditRank: pick("guarantor_credit_rank"),
            guarantorCheckType: pick("guarantor_check_type"), hasGuarantorSalaryDeduct: "yes" }]) {
            const result = await portalApi.planFinder(buildPlanFinderRequest(answers));
            assert.ok(Number.isSafeInteger(result.consultationId));
            assert.ok(Array.isArray(result.matches));
            for (const match of result.matches) {
              assert.ok(Number.isSafeInteger(match.plan.id));
              assert.ok(["eligible", "needs_review", "not_eligible"].includes(match.status));
              assert.ok(Array.isArray(match.failedRequirements));
              assert.ok(Array.isArray(match.missingInformation));
            }
            const row = get("SELECT customer_id, has_check, has_guarantor_check FROM consultation_forms WHERE id=?", result.consultationId);
            assert.equal(row.customer_id, manifest.customers[0]);
            assert.equal(Boolean(row.has_check), answers.customerCheckStatus !== "none");
            assert.equal(Boolean(row.has_guarantor_check), answers.hasGuarantor === "yes" && answers.guarantorCheckType !== "none");
          }
          assert.equal((await portalApi.me()).id, manifest.customers[0]);
          console.log("PASS: real questionnaire options and frontend transport produce valid saved matches with/without guarantor; ownership and derived flags stay server-controlled.");
        } finally { globalThis.fetch = originalFetch; }
      }
    else {
      try {
        for (const [name, mime, bytes] of samples()) for (const who of ["customer", "owner"]) {
          const route = who === "customer" ? "/api/customer-portal/chat/messages" : `/api/chat/${manifest.customers[0]}/messages`;
          const form = multipart(bytes, mime, name, `probe-${randomBytes(12).toString("hex")}`);
          const sent = await request(route, who, form);
          assert.equal(sent.status, 201, "live attachment upload");
          const message = JSON.parse(sent.bytes);
          const ref = get("SELECT object_path FROM customer_chat_messages WHERE id=? AND customer_id=?", message.id, manifest.customers[0]).object_path;
          assert.match(ref, /^vps-private:customer-chat\//);
          for (const reader of ["customer", "owner"]) {
            const prefix = reader === "customer" ? "/api/customer-portal/chat" : "/api/chat";
            const downloaded = await request(`${prefix}/messages/${message.id}/file`, reader);
            assert.equal(downloaded.status, 200);
            assert.equal(downloaded.headers["cache-control"], "no-store");
            assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
            assert.equal(downloaded.headers["content-type"], mime);
            assert.ok(downloaded.bytes.equals(bytes), "live HTTPS byte comparison");
          }
          for (const [reader, status] of [["customer2", 404], ["other", 404], ["blocked", 403], ["anonymous", 401]]) {
            const prefix = reader === "customer2" ? "/api/customer-portal/chat" : "/api/chat";
            assert.equal((await request(`${prefix}/messages/${message.id}/file`, reader)).status, status);
          }
          const retry = await request(route, who, form);
          assert.equal(retry.status, 200); assert.equal(JSON.parse(retry.bytes).id, message.id);
        }
        console.log("PASS: live HTTPS image/PDF/audio uploads, both readers, exact bytes, private headers, retry reuse and customer/staff authorization.");
        // Exercise the actual frontend transport, not a duplicated heartbeat URL.
        const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
        let expiryEvents = 0;
        const events = new EventTarget();
        events.addEventListener("cp-session-expired", () => { expiryEvents++; });
        globalThis.window = events;
        globalThis.fetch = async (url, init = {}) => {
          if (String(url).endsWith("/presence")) assert.equal(String(url), "/api/customer-portal/chat/presence");
          const reply = await request(String(url), "customer", {
            method: init.method || "GET",
            body: init.body ? Buffer.from(init.body) : undefined,
            contentType: new Headers(init.headers).get("Content-Type") || "application/json",
          });
          return new Response(reply.bytes, { status: reply.status, headers: reply.headers });
        };
        try {
          for (let i = 0; i < 5; i++) {
            assert.equal((await portalApi.presence()).ok, true);
            assert.equal((await portalApi.me()).id, manifest.customers[0]);
          }
          const legacyHeartbeat = await request("/api/customer-portal/presence", "customer", {
            method: "POST", body: Buffer.from("{}"), contentType: "application/json",
          });
          assert.equal(legacyHeartbeat.status, 200, "Already-open pages must retain their valid session too");
          assert.equal(expiryEvents, 0, "A valid heartbeat must never expire customer UI state");
          run("DELETE FROM customer_portal_sessions WHERE customer_id=?", manifest.customers[0]);
          await assert.rejects(portalApi.presence, e => e instanceof PortalApiError && e.status === 401);
          assert.equal(expiryEvents, 1, "Real session expiry must still reach the login gate");
          console.log("PASS: actual frontend heartbeat/profile requests retain valid sessions; real expiry still signals login.");
        } finally {
          globalThis.fetch = originalFetch;
          if (originalWindow === undefined) delete globalThis.window;
          else globalThis.window = originalWindow;
        }
      } catch (error) { await cleanup(); throw error; }
    }
  }
} finally { db.close(); }
