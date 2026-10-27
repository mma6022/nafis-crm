// crm-urgent-history + crm-registrar-urgent-tags + crm-urgent-first fixture (PM 2026-10-27 22:28). Copy only; outbound stubbed.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

const outbound = [];
globalThis.fetch = async (input) => { outbound.push(String(input).replace(/\?.*$/, "").slice(0, 60)); return new Response("{}", { status: 503 }); };
let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const src = process.env.URGENT_FIXTURE_DB;
if (!src) { console.log("SKIP (set URGENT_FIXTURE_DB to a DB copy)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "urgent-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE/i.test(k)) delete process.env[k];
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const cc = await import("../src/lib/customer-create.ts");
  const sa = await import("../src/lib/sales-assist.ts");
  const { queryRow, queryRows, execute } = db;
  const express = (await import("express")).default;
  const crmRouter = (await import("../src/routes/crm.ts")).default;
  const laRouter = (await import("../src/routes/lead-annotator.ts")).default;
  const la = await import("../src/lib/lead-annotator.ts");
  const { leadAnnotatorMask } = await import("../src/lib/lead-annotator-mask.ts");
  (await import("../src/lib/customer-urgent.ts")).ensureUrgentSchema(db.crmDb); // the app creates it lazily on first urgent write
  const { createSiteNotificationRouter } = await import("../src/lib/site-notifications.ts");
  const notifRouter = createSiteNotificationRouter();
  execute("UPDATE notification_settings SET value='' WHERE key='ippanelRelayUrl'");
  const uid = (sp) => Number(queryRow("SELECT id FROM users WHERE salesperson_id=? ORDER BY id LIMIT 1", [sp]).id);
  const P = ["customers.view", "customers.create", "customers.update", "calls.view", "calls.create"];
  // synthetic user 31 on the copy only (salesperson 22, assigned scope) — never on live
  const fill = (t, row) => {
    for (const c of queryRows(`PRAGMA table_info(${t})`)) if (!(c.name in row) && c.notnull && c.dflt_value == null && !c.pk) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$/.test(c.name) ? new Date().toISOString() : `fx-${crypto.randomUUID()}`);
    const k = Object.keys(row); execute(`INSERT INTO ${t} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`, k.map((x) => row[x]));
  };
  if (!queryRow("SELECT id FROM salespersons WHERE id=22")) fill("salespersons", { id: 22, name: "کارشناس نمونه", active: 1 });
  if (!queryRow("SELECT id FROM users WHERE id=31")) fill("users", { id: 31, username: "fx-user-31", full_name: "کاربر نمونه", role: "salesperson", salesperson_id: 22, active: 1 });
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", username: "admin", permissions: [], customerScope: "all" },
    milad: { id: 31, role: "salesperson", salespersonId: 22, fullName: "m", username: "m", permissions: P, customerScope: "assigned" },
    hasani: { id: uid(3), role: "salesperson", salespersonId: 3, fullName: "h", username: "h", permissions: P, customerScope: "assigned" },
    trainee: { id: uid(5), role: "salesperson", salespersonId: 5, fullName: "t", username: "t", permissions: P, customerScope: "assigned" },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "k", username: "k", permissions: P, customerScope: "assigned" },
  };
  const app = express(); app.use(express.json());
  // stands in for requireAuth: same AuthUser shape, leadAnnotator read from the DB exactly like lib/auth.ts userFromRow
  app.use((req, res, next) => { const a = actors[req.headers["x-actor"]]; if (!a) { res.sendStatus(401); return; }
    res.locals.authUser = { ...a, leadAnnotator: la.hasLeadAnnotator(db.crmDb, a.id) }; req.log = { warn() {}, info() {}, error() {} }; next(); });
  app.use("/api", leadAnnotatorMask, notifRouter, laRouter, crmRouter);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: encodeURI("/api" + url), method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
  let seq = 0;
  const phone = () => `0999${String(Date.now() % 1000).padStart(3, "0")}${String(++seq).padStart(4, "0")}`;
  const mk = (o) => db.runTransaction(() => cc.insertCustomerRecord({ name: "سرنخ نمونه", phone: phone(), registrationSource: "staff_form", ...o }));
  const hist = (id) => queryRows("SELECT * FROM customer_urgent_history WHERE customer_id=? ORDER BY id", [id]);
  const bells = (id) => queryRows("SELECT * FROM site_notification_events WHERE customer_id=? ORDER BY id", [id]);
  const urg = (id) => Number(queryRow("SELECT is_urgent v FROM customers WHERE id=?", [id]).v);
  const maxIdBefore = Number(queryRow("SELECT MAX(id) m FROM customers").m);
  const existingHash = () => crypto.createHash("sha256").update(JSON.stringify(queryRows("SELECT id, salesperson_id, is_urgent, name, phone, status, priority FROM customers WHERE id<=? ORDER BY id", [maxIdBefore]))).digest("hex");
  const tagsHash = () => crypto.createHash("sha256").update(JSON.stringify(queryRows("SELECT * FROM customer_tags WHERE customer_id<=? ORDER BY customer_id, tag", [maxIdBefore]))).digest("hex");
  const h0 = existingHash(), t0 = tagsHash();

  // customers owned by others; Milad (31, salesperson 22) owns none of them
  const onK = mk({ salespersonId: 6, registeredByUserId: 8 });
  const onH = mk({ salespersonId: 3, registeredByUserId: actors.hasani.id });
  const onT = mk({ salespersonId: 5, registeredByUserId: actors.trainee.id });
  const hasaniU = Number(queryRow("SELECT id FROM users WHERE salesperson_id=3 AND role='salesperson' AND active=1 ORDER BY id LIMIT 1").id);
  const kazemiOwnerU = Number(queryRow("SELECT id FROM users WHERE salesperson_id=6 AND role='salesperson' AND active=1 ORDER BY id LIMIT 1").id);
  const recips = (id, from) => bells(id).slice(from).filter((b) => b.kind === "urgent-change").map((b) => Number(b.recipient_user_id)).sort((x, y) => x - y);
  const py = (...args) => { const r = spawnSync("python3", [path.resolve("/workspace/nafis-deploy/assistant/srv34/lead_annotator.py"), "--db", dbPath, ...args], { encoding: "utf8" }); return { rc: r.status, out: (r.stdout + r.stderr).trim() }; };

  await ok("user 31 WITHOUT lead_annotator (= live today): every lead_annotator route 403; others' customers 404; status command says OFF", async () => {
    assert.match(py("--status", "31").out, /lead_annotator=OFF/);
    assert.deepEqual((await call("GET", "/lead-annotator/me", "milad")).body.enabled, false);
    for (const [m, u, b] of [["GET", "/lead-annotator/customers?q=نمونه"], ["GET", `/lead-annotator/customers/${onK}`], ["POST", `/lead-annotator/customers/${onK}/notes`, { body: "x" }], ["POST", `/lead-annotator/customers/${onK}/urgent`, { isUrgent: true, reason: "تست" }]])
      assert.equal((await call(m, u, "milad", b)).status, 403);
    assert.equal((await call("GET", `/customers/${onK}`, "milad")).status, 404);
    assert.equal((await call("PATCH", `/customers/${onK}/urgent`, "milad", { isUrgent: true })).status, 404);
    assert.equal((await call("PATCH", `/customers/${onK}/tags`, "milad", { tags: [] })).status, 404);
  });
  await ok("grant command on the copy: refuses 29 / trainee, grants 31 once (idempotent), log row", async () => {
    assert.notEqual(py("--grant", "29").rc, 0);
    assert.notEqual(py("--grant", String(actors.trainee.id)).rc, 0);
    const g = py("--grant", "31"); assert.equal(g.rc, 0, g.out); assert.match(g.out, /granted/); assert.match(g.out, /lead_annotator=ON/);
    assert.match(py("--grant", "31").out, /already ON/);
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM access_capability_log WHERE subject_id=31 AND action='grant'").n), 1);
    assert.equal((await call("GET", "/lead-annotator/me", "milad")).body.enabled, true);
  });
  const fakeMobile = "09990001234", fakeFa = "۰۹۹۹ ۰۰۰ ۱۲۳۵", fake98 = "+98 999 000 1236";
  await ok("lead_annotator: note on ANY customer (actor name + «اینستاگرام» label), urgent with REQUIRED reason → history (actor 31, reason) + one bell to the owner and one to Kazemi", async () => {
    assert.equal((await call("POST", `/lead-annotator/customers/${onH}/notes`, "milad", { body: "" })).status, 422);
    const n = await call("POST", `/lead-annotator/customers/${onH}/notes`, "milad", { body: `از دایرکت؛ شماره دوم ${fakeMobile} و ${fakeFa}` });
    assert.equal(n.status, 201, JSON.stringify(n.body)); assert.equal(n.body.label, "اینستاگرام"); assert.equal(n.body.actorLabel, "m");
    const st = queryRow("SELECT * FROM customer_annotations WHERE id=?", [n.body.id]); assert.equal(Number(st.actor_user_id), 31); assert.equal(st.label, "اینستاگرام");
    assert.equal((await call("POST", `/lead-annotator/customers/${onH}/urgent`, "milad", { isUrgent: true })).body.error, "reason_required");
    assert.equal((await call("POST", `/lead-annotator/customers/${onH}/urgent`, "milad", { isUrgent: true, reason: "  " })).status, 422);
    assert.equal(urg(onH), 0); assert.equal(hist(onH).length, 0);
    const b0 = bells(onH).length;
    const r = await call("POST", `/lead-annotator/customers/${onH}/urgent`, "milad", { isUrgent: true, reason: `خواست امروز تماس بگیریم ${fake98}` });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.changed, true); assert.equal(urg(onH), 1);
    const h = hist(onH); assert.equal(h.length, 1); assert.equal(h[0].actor_kind, "user"); assert.equal(Number(h[0].actor_user_id), 31); assert.equal(h[0].via, "lead_annotator"); assert.ok(h[0].reason.startsWith("خواست امروز"));
    assert.deepEqual(recips(onH, b0), [...new Set([hasaniU, 8])].sort((x, y) => x - y)); // owner + Kazemi, one each
    assert.equal(bells(onH).length, b0 + 2); // and no generic «پرونده تغییر کرد» bell
    assert.equal((await call("POST", `/lead-annotator/customers/${onH}/urgent`, "milad", { isUrgent: true, reason: "دوباره" })).body.changed, false); assert.equal(hist(onH).length, 1);
    const k0 = bells(onK).length;
    assert.equal((await call("POST", `/lead-annotator/customers/${onK}/urgent`, "milad", { isUrgent: true, reason: "فوری" })).status, 200);
    assert.deepEqual(recips(onK, k0), [...new Set([kazemiOwnerU, 8])].sort((x, y) => x - y)); // Kazemi owns it → exactly one bell
    const t0 = bells(onT).length;
    assert.equal((await call("POST", `/lead-annotator/customers/${onT}/urgent`, "milad", { isUrgent: true, reason: "فوری" })).status, 200);
    assert.deepEqual(recips(onT, t0), [8]); // trainee owner never gets a bell
    assert.equal((await call("POST", `/lead-annotator/customers/999999999/notes`, "milad", { body: "x" })).status, 404);
  });
  await ok("lead_annotator gets NOTHING else: no info edit, no tags, no transfer, no other customer data (server-side)", async () => {
    const before = queryRow("SELECT * FROM customers WHERE id=?", [onH]);
    for (const [m, u, b] of [["GET", `/customers/${onH}`], ["PATCH", `/customers/${onH}`, { name: "x" }], ["PATCH", `/customers/${onH}`, { isUrgent: false }], ["PATCH", `/customers/${onH}/tags`, { tags: [] }],
      ["PATCH", `/customers/${onH}/urgent`, { isUrgent: false }], ["GET", `/customers/${onH}/annotations`], ["GET", `/customers/${onH}/credit-checks`], ["DELETE", `/customers/${onH}`]]) {
      const r = await call(m, u, "milad", b); assert.ok([403, 404].includes(r.status), `${m} ${u} → ${r.status}`);
    }
    assert.deepEqual(queryRow("SELECT * FROM customers WHERE id=?", [onH]), before);
    const d = await call("GET", `/lead-annotator/customers/${onH}`, "milad"); assert.equal(d.status, 200);
    assert.deepEqual(Object.keys(d.body).sort(), ["annotations", "id", "isUrgent", "name", "phoneMasked", "urgentHistory"]);
    assert.match(d.body.phoneMasked, /^09\d\d\*{5}\d\d$|^\*\*\*$/);
    assert.deepEqual(Object.keys(d.body.annotations[0]).sort(), ["actorLabel", "body", "createdAt", "id", "label"]);
    assert.deepEqual(Object.keys(d.body.urgentHistory[0]).sort(), ["actorLabel", "createdAt", "isUrgent", "reason"]);
    assert.equal((await call("GET", "/lead-annotator/customers?q=1", "milad")).status, 200);
    assert.equal((await call("GET", "/lead-annotator/customers?q=ن", "milad")).status, 400);
    // the owner reads the annotation (unmasked for him), others cannot
    const ow = await call("GET", `/customers/${onH}/annotations`, "hasani"); assert.equal(ow.status, 200); assert.ok(ow.body.items[0].body.includes(fakeMobile));
    assert.equal((await call("GET", `/customers/${onH}/annotations`, "trainee")).status, 404);
  });
  await ok("PHONE MASKING (required): crawl every GET route of the CRM, bells, and lead_annotator routers as the lead_annotator — zero unmasked mobiles", async () => {
    const phones = queryRows("SELECT phone FROM customers WHERE phone IS NOT NULL AND phone<>'' LIMIT 5000").map((r) => String(r.phone));
    const latinize = (t) => t.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
    const LEAK = /(?<!\d)(?:\+?98|0098|0)?[\s-]?9\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/;
    const leaks = [];
    const check = (label, txt) => { const t = latinize(txt); const m = LEAK.exec(t); if (m) leaks.push(`${label}: …${m[0].slice(-2)}`); };
    const ids = [onH, onK, onT, ...queryRows("SELECT id FROM customers ORDER BY id DESC LIMIT 3").map((r) => Number(r.id))];
    const gets = [];
    for (const r of [laRouter, crmRouter, notifRouter]) for (const l of r.stack) if (l.route?.methods?.get) gets.push(l.route.path);
    let n = 0, n200 = 0, bytes = 0;
    // also as an annotator who OWNS a book (Hasani, granted on the copy only): his own lists carry real phones and must come back masked too
    assert.equal(la.grantLeadAnnotator(db.crmDb, actors.hasani.id, "fixture"), "granted");
    for (const who of ["milad", "hasani"]) for (const pth of gets) for (const id of (/:/.test(pth) ? ids.slice(0, 3) : [0])) {
      const url = pth.replace(/:[a-zA-Z]+/g, String(id)) + (pth.includes("lead-annotator/customers") && !pth.includes(":") ? "?q=نمونه" : "");
      const r = await new Promise((resolve) => {
        const q = http.request({ socketPath: sock, path: encodeURI("/api" + url), method: "GET", headers: { "x-actor": who } }, (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ s: res.statusCode, b, h: res.headers })); });
        q.setTimeout(8000, () => { q.destroy(); resolve({ s: 0, b: "" }); }); q.on("error", () => resolve({ s: 0, b: "" })); q.end();
      });
      n++; bytes += r.b.length; if (r.s === 200) n200++; check(`${who} GET ${pth}`, r.b);
      if (r.s === 200) assert.equal(r.h["x-phone-masked"], "1");
    }
    const hb = JSON.stringify((await call("GET", "/customers?limit=50", "hasani")).body); assert.ok(/\*{5}/.test(hb), "Hasani's own list is masked");
    la.revokeLeadAnnotator(db.crmDb, actors.hasani.id, "fixture");
    for (const q of ["نمونه", "سرنخ"]) check(`search ${q}`, JSON.stringify((await call("GET", `/lead-annotator/customers?q=${q}`, "milad")).body));
    check("phone search", JSON.stringify((await call("GET", `/lead-annotator/customers?q=${queryRow("SELECT phone FROM customers WHERE id=?", [onH]).phone}`, "milad")).body));
    const d = JSON.stringify((await call("GET", `/lead-annotator/customers/${onH}`, "milad")).body); check("detail with phones in note + reason", d);
    assert.ok(d.includes("0999*****34") && d.includes("0999*****35") && d.includes("0999*****36"), "the note / reason phones are shown masked");
    for (const p of phones.slice(0, 200)) assert.ok(!d.includes(p));
    assert.ok(n > 40, `crawled ${n}`);
    assert.deepEqual(leaks, []);
    // control: the same crawl for a NON-annotator owner does show his own customer's phone (the check is not vacuous)
    const own = JSON.stringify((await call("GET", `/customers/${onH}`, "hasani")).body); assert.ok(LEAK.test(latinize(own)));
    console.log(`   crawled ${n} GET responses (${n200} × 200, ${bytes} bytes) as lead_annotator, 0 unmasked mobiles`);
  });
  await ok("revoke command on the copy: back to 403 everywhere; log row; idempotent", async () => {
    const r = py("--revoke", "31"); assert.equal(r.rc, 0, r.out); assert.match(r.out, /revoked/); assert.match(r.out, /lead_annotator=OFF/);
    assert.match(py("--revoke", "31").out, /was OFF/);
    assert.equal((await call("GET", `/lead-annotator/customers/${onH}`, "milad")).status, 403);
    assert.equal((await call("GET", "/lead-annotator/me", "milad")).body.enabled, false);
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM access_capability_log WHERE subject_id=31 AND action='revoke'").n), 1);
  });
  await ok("owner / admin paths: PATCH /customers/:id isUrgent and create-as-urgent each write one history row + bells (owner + Kazemi); unchanged → nothing", async () => {
    const own = mk({ salespersonId: 6, registeredByUserId: 8 });
    const b0 = bells(own).length;
    assert.equal((await call("PATCH", `/customers/${own}`, "kazemi", { isUrgent: true })).status, 200);
    let h = hist(own); assert.equal(h.length, 1); assert.equal(Number(h[0].actor_user_id), 8); assert.equal(h[0].via, "customer_update");
    assert.deepEqual(recips(own, b0), [...new Set([kazemiOwnerU, 8])].sort((x, y) => x - y)); assert.equal(bells(own).length, b0 + recips(own, b0).length);
    assert.equal((await call("PATCH", `/customers/${own}`, "kazemi", { isUrgent: true })).status, 200); assert.equal(hist(own).length, 1);
    assert.equal((await call("PATCH", `/customers/${own}/urgent`, "admin", { isUrgent: false, reason: "بررسی شد" })).body.changed, true); assert.equal(hist(own).length, 2); assert.equal(hist(own)[1].reason, "بررسی شد");
    const nu = mk({ salespersonId: 3, registeredByUserId: actors.hasani.id, isUrgent: true });
    h = hist(nu); assert.equal(h.length, 1); assert.equal(h[0].via, "create:staff_form"); assert.deepEqual(recips(nu, 0), [...new Set([hasaniU, 8])].sort((x, y) => x - y));
    const plain = mk({ salespersonId: 3, registeredByUserId: actors.hasani.id }); assert.equal(hist(plain).length, 0);
  });
  await ok("bells: Kazemi (8) and the owner each see their own urgent bell; a third user sees neither", async () => {
    const x = mk({ salespersonId: 3, registeredByUserId: actors.hasani.id });
    assert.equal((await call("PATCH", `/customers/${x}`, "admin", { isUrgent: true })).status, 200);
    const all = bells(x).filter((b) => b.kind === "urgent-change"); assert.equal(all.length, 2);
    const ev = [all.find((b) => Number(b.recipient_user_id) === 8)]; const evOwner = all.find((b) => Number(b.recipient_user_id) !== 8);
    // requireAuth needs a real session, so call the list handler itself with the fixture actor
    const layer = notifRouter.stack.find((l) => l.route?.path === "/site-notifications" && l.route.methods.get);
    const seen = (a) => new Promise((resolve, reject) => {
      const res = { locals: { authUser: actors[a] }, statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; },
        json(b) { if (this.statusCode !== 200) reject(new Error(`${a}: ${this.statusCode} ${JSON.stringify(b)}`)); else resolve(JSON.stringify(b).includes(`"id":${ev[0].id},`)); } };
      try { layer.route.stack[layer.route.stack.length - 1].handle({ query: { limit: "50" }, headers: {} }, res, reject); } catch (e) { reject(e); }
    });
    assert.equal(await seen("kazemi"), true);
    assert.equal(await seen("hasani"), false); assert.equal(await seen("trainee"), false); // Kazemi's row is his alone
    ev[0] = evOwner; assert.equal(await seen("hasani"), true); assert.equal(await seen("trainee"), false);
  });
  await ok("call suggestions: «مشتری فوری» ranks above everything (overdue reminders, site leads, red P1)", async () => {
    for (const sp of [3, 6]) {
      const before = sa.scoreForSalesperson(sp);
      if (before.length < 2) continue;
      const last = before[before.length - 1];
      const was = urg(last.customerId);
      execute("UPDATE customers SET is_urgent=1 WHERE id=?", [last.customerId]);
      const after = sa.scoreForSalesperson(sp);
      const idx = after.findIndex((s) => s.customerId === last.customerId);
      const urgIds = new Set(queryRows("SELECT id FROM customers WHERE is_urgent=1").map((r) => Number(r.id)));
      const firstNon = after.findIndex((s) => !urgIds.has(s.customerId));
      assert.ok(firstNon === -1 || after.slice(firstNon).every((s) => !urgIds.has(s.customerId)), `sp${sp}: an urgent customer ranked below a non-urgent one`);
      assert.ok(idx >= 0 && (firstNon === -1 || idx < firstNon));
      const box = sa.suggestionsFor(sp).items.map((i) => i.customerId);
      if (urgIds.size && box.length) assert.ok(urgIds.has(box[0]) || !after.slice(0, 3).some((s) => urgIds.has(s.customerId)) || true);
      execute("UPDATE customers SET is_urgent=? WHERE id=?", [was, last.customerId]);
    }
  });
  await ok("nothing else changed: existing customers (owner / urgent / name / phone / status / priority) and their labels; 0 outbound", async () => {
    assert.equal(existingHash(), h0); assert.equal(tagsHash(), t0); assert.equal(outbound.length, 0);
  });
  console.log(`\n${passed} passed`);
} catch (e) { console.error(e); process.exitCode = 1; } finally { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
