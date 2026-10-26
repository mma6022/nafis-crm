// Synthetic «اسکن بله و اتصال مشتری» fixture: in-memory DB + MOCK sidecar with FAKE contacts (every match path).
// Never talks to Bale, never sends to anyone real. Run: node scripts/run-bundled-fixture.mjs scripts/bale-contact-scan-fixture.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import express from "express";
import { createBale, ensureBaleSchema } from "../src/lib/bale.ts";
import { createHttpBaleSidecar } from "../src/lib/bale-sidecar-client.ts";
import { matchContacts, normMobile, normName } from "../src/lib/bale-contact-links.ts";
import { startMockBaleSidecar } from "./bale-mock-sidecar.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bale-cs-"));
const wfile = (n, c) => { const p = path.join(tmp, n); fs.writeFileSync(p, c, { mode: 0o600 }); return p; };
const KEY1 = wfile("k1", crypto.randomBytes(32).toString("base64"));
const sidecarToken = crypto.randomBytes(32).toString("base64url"); const TOK = wfile("tok", sidecarToken);
const mock = await startMockBaleSidecar({ token: sidecarToken });
const ENV = { BALE_SESSION_KEY_FILE: KEY1, BALE_SIDECAR_TOKEN_FILE: TOK, BALE_SIDECAR_URL: `http://127.0.0.1:${mock.port}` };

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,salesperson_id INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
INSERT INTO users VALUES(1,'admin','مدیر','admin',NULL,1),(2,'s.hasani','حسنی','salesperson',3,1),(3,'m.ghasemi','قاسمی','salesperson',4,1),(4,'reg','ثبت','registrar',NULL,1),
  (5,'admin5','مدیر۵','admin',NULL,1),(6,'trainee5','کارآموز','salesperson',5,1),(8,'m.kazemi','کاظمی','salesperson',6,1),(27,'t19','کارآموز۱۹','salesperson',19,1),(28,'t20','کارآموز۲۰','salesperson',20,1),
  (29,'hasani','ادمین۲۹','admin',NULL,1),(30,'acc','حسابدار','accountant',NULL,1),(31,'old','غیرفعال','salesperson',7,0);
INSERT INTO customers VALUES(100,'علی رضایی','09120000001',3,NULL),(101,'ادغام شده','09120000002',3,100),(102,'مریم احمدی','+98 912 000 0011',3,NULL),
  (104,'سارا کریمی','',3,NULL),(105,'رضا محمدی','00989120000015',3,NULL),(106,'رضا محمدی','09120000016',3,NULL),(107,'حسین نوری','09120000017',3,NULL),
  (108,'زهرا ک','۰۹۱۲۰۰۰۰۰۱۸',3,NULL),(109,'کیوان شاد','09120000019',3,NULL),(110,'نگار قاسمی','09120000003',4,NULL),(130,'مشتری کارآموز','09120000004',5,NULL),
  (140,'پویا کاظمی','09120000040',6,NULL);
CREATE TABLE reminders(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,salesperson_id INTEGER,customer_id INTEGER,subject TEXT,message TEXT,remind_at TEXT,sent_sms INTEGER DEFAULT 0,done INTEGER DEFAULT 0,notified_at TEXT,call_id INTEGER,created_at TEXT);
CREATE TABLE site_notification_events(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,customer_name TEXT,owner_id INTEGER,resource_type TEXT,resource_id INTEGER,kind TEXT,title TEXT,body TEXT,permission TEXT,created_at TEXT,actor_key TEXT,recipient_user_id INTEGER);
CREATE TABLE assistants(id INTEGER PRIMARY KEY,slug TEXT,display_name TEXT,kind TEXT,bound_user_id INTEGER,bound_salesperson_id INTEGER,enabled INTEGER);
CREATE TABLE assistant_events(id INTEGER PRIMARY KEY AUTOINCREMENT,assistant_id INTEGER,type TEXT,thread_id INTEGER,user_id INTEGER,customer_id INTEGER,message_id INTEGER,data_json TEXT,created_at TEXT);
CREATE TABLE assistant_threads(id INTEGER PRIMARY KEY AUTOINCREMENT,assistant_id INTEGER,user_id INTEGER);
CREATE TABLE assistant_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id INTEGER,author TEXT,body TEXT,created_at TEXT);
CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT,active INTEGER DEFAULT 1);
INSERT INTO assistants VALUES(1,'sales-hasani','مریم','sales',2,3,1);`);
ensureBaleSchema(db); ensureBaleSchema(db);
const custBefore = JSON.stringify(db.prepare("SELECT * FROM customers ORDER BY id").all());

let clock = new Date("2026-10-27T06:30:00Z"); // 10:00 Tehran
const sidecar = createHttpBaleSidecar(() => ENV, { timeoutMs: 3000 });
const bale = createBale({ db, env: () => ENV, sidecar, now: () => clock, random: () => 0.5, actor: res => (res.locals.uid ? { id: res.locals.uid } : null), planFilesDir: path.join(tmp, "pf") });
const app = express(); app.use(bale.internal);
app.post("/runner/bale/send", express.json(), (req, res) => {
  res.locals.assistant = db.prepare("SELECT * FROM assistants WHERE id=?").get(Number(req.headers["x-asst"]));
  bale.runnerSend(req, res, { inScope: (_a, cid) => [100, 104].includes(cid) });
});
app.use(express.json({ limit: "100kb" }));
app.use("/api", (req, res, next) => { res.locals.uid = Number(req.headers["x-user"] || 0); next(); }, bale.staff);
const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r)); const port = srv.address().port;
const S = async (u, method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { "content-type": "application/json", ...(u ? { "x-user": String(u) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j };
};
const acc = uid => db.prepare("SELECT * FROM bale_accounts WHERE user_id=?").get(uid);
const tick = () => bale.worker.tick();
let passed = 0; const ok = n => { passed++; console.log("ok", n); };
// FAKE contacts (synthetic numbers, 0912000xxxx). baleUserIds 9000000xx.
const C = (id, localName, phone = null, name = "Contact") => ({ baleUserId: String(900000000 + id), name, localName, phone });
const HASANI = [
  C(1, "مشتری ۱۰۰"),                        // (a) id only (Persian digits), no name to check → confident id
  C(2, "102 مریم احمدي"),                   // (a) id + name ok (Arabic ي) → confident id
  C(3, "104 حسن"),                          // (a) id but name mismatch → review
  C(4, "Reza", "09120000015"),              // (b) phone (customer stored as 0098…) → confident phone
  C(5, "آقای رضا محمدي"),                   // (c) name → 2 candidates → review many
  C(6, "خانم زهرا\u200cك"),                  // (c) ZWNJ + Arabic ك + prefix → review (name only)
  C(7, "110 نگار"),                         // other expert's customer → not found
  C(8, "130"),                              // trainee's customer → not found
  C(9, "101"),                              // merged customer → not found
  C(10, "دوست قدیمی"),                      // nothing → not found
  C(11, "Hossein", "+989120000017"),        // (b) +98 → confident phone
  C(12, "107", "09120000018"),              // id 107 vs phone 108 → conflict → review
  C(13, "Keyvan", "9120000019"),            // (b) bare 9… → confident phone
  C(14, null, null, "کیوان شاد"),           // (c) name from profile (no local name), but 109 also by phone above → review (name)
];
try {
  // ---- unit: normalizers + matcher ----
  for (const [i, o] of [["09120000001", "09120000001"], ["+98 912 000 0001", "09120000001"], ["00989120000001", "09120000001"], ["۰۹۱۲۰۰۰۰۰۰۱", "09120000001"], ["9120000001", "09120000001"], ["0912000", null], ["02112345678", null]]) assert.equal(normMobile(i), o, i);
  assert.equal(normName("مشتری  آقای علي\u200cرضا كريمي ۱۲"), "علی رضا کریمی"); assert.equal(normName("خانم"), ""); assert.equal(normName("Mr. Ali"), "ali");
  const m = matchContacts(HASANI, db.prepare("SELECT id,name,phone FROM customers WHERE salesperson_id=3 AND merged_into_customer_id IS NULL").all());
  const where = id => ["confident", "review", "notFound"].find(g => m[g].some(r => r.contact.baleUserId === String(900000000 + id)));
  const row = id => [...m.confident, ...m.review, ...m.notFound].find(r => r.contact.baleUserId === String(900000000 + id));
  assert.deepEqual([1, 2, 4, 11, 13].map(where), Array(5).fill("confident"));
  assert.deepEqual([3, 5, 6, 12, 14].map(where), Array(5).fill("review"));
  assert.deepEqual([7, 8, 9, 10].map(where), Array(4).fill("notFound"));
  assert.deepEqual(row(1).candidates, [{ customerId: 100, method: "id" }]); assert.deepEqual(row(2).candidates, [{ customerId: 102, method: "id" }]);
  assert.equal(row(3).note, "name_mismatch"); assert.deepEqual(row(4).candidates, [{ customerId: 105, method: "phone" }]);
  assert.equal(row(5).note, "many"); assert.deepEqual(row(5).candidates.map(c => c.customerId), [105, 106]);
  assert.deepEqual(row(6).candidates, [{ customerId: 108, method: "name" }]); assert.equal(row(12).note, "conflict");
  assert.deepEqual(row(13).candidates, [{ customerId: 109, method: "phone" }]); assert.deepEqual(row(14).candidates, [{ customerId: 109, method: "name" }]);
  // the same customer claimed by two contacts strongly → both to review (duplicate)
  const d = matchContacts([C(20, "100"), C(21, "x", "09120000001")], [{ id: 100, name: "علی رضایی", phone: "09120000001" }]);
  assert.equal(d.confident.length, 0); assert.deepEqual(d.review.map(r => r.note), ["duplicate", "duplicate"]);
  ok("matcher: (a) id in name (fa/en digits, name re-checked) → (b) phone 0/+98/0098/9… → (c) normalized name (ي/ك/ZWNJ/prefixes); conflict/many/duplicate → review");

  // ---- connect hasani + kazemi via the mock wizard ----
  let r = await S(1, "PUT", "/admin/bale/master", { enabled: true }); assert.equal(r.s, 200);
  for (const [u, p] of [[2, "09120000900"], [8, "09120000908"]]) {
    r = await S(u, "POST", "/bale/connect/start", { phone: p }); assert.equal(r.s, 200, JSON.stringify(r.j));
    r = await S(u, "POST", "/bale/connect/code", { code: "11111" }); assert.equal(r.s, 200, JSON.stringify(r.j));
  }
  await new Promise(r => setTimeout(r, 100)); clock = new Date(clock.getTime() + 61_000); await tick(); assert.ok(mock.attached.has(`acc-${acc(2).id}`) && mock.attached.has(`acc-${acc(8).id}`), "sessions attached");
  const H = acc(2), K = acc(8);
  mock.state.contacts = { [`acc-${H.id}`]: HASANI, [`acc-${K.id}`]: [C(40, "140 پویا"), C(41, "100 علی رضایی"), C(42, "ناشناس")] };

  // ---- access ----
  for (const u of [6, 27, 28, 29, 4, 30, 31, 0]) {
    for (const [mth, p, b] of [["GET", "/bale/contact-scan"], ["POST", "/bale/contact-scan", {}], ["POST", "/bale/contact-links", { scanId: "x", items: [] }], ["POST", "/bale/contact-links/1/unlink"]]) {
      r = await S(u, mth, p, b); assert.ok([401, 403].includes(r.s), `user ${u} ${mth} ${p} → ${r.s}`);
    }
  }
  assert.equal(mock.log.filter(l => l.path === "/v1/contacts").length, 0, "403 → sidecar never called");
  assert.ok(db.prepare("SELECT count(*) n FROM bale_audit WHERE outcome='forbidden' AND action LIKE '%contact-%'").get().n >= 20);
  r = await S(2, "GET", "/bale/contact-scan"); assert.equal(r.s, 200); assert.equal(r.j.admin, false); assert.deepEqual(r.j.accounts.map(a => a.id), [H.id]);
  r = await S(3, "GET", "/bale/contact-scan"); assert.equal(r.s, 200); assert.deepEqual(r.j.accounts, [], "ghasemi not connected");
  r = await S(3, "POST", "/bale/contact-scan", {}); assert.equal(r.s, 409); assert.equal(r.j.error, "not_connected");
  r = await S(1, "GET", "/bale/contact-scan"); assert.equal(r.j.admin, true); assert.deepEqual(r.j.accounts.map(a => a.userId), [2, 8]);
  r = await S(5, "GET", "/bale/contact-scan"); assert.equal(r.s, 200, "admin user 5 (role admin) is an admin, not trainee salesperson 5");
  ok("access: experts 2/3/8 + admin (not 29); trainees (sp 5/19/20), 29, registrar, accountant, inactive, anonymous → 401/403, audited, sidecar untouched");

  // ---- expert scan ----
  const before = mock.log.length;
  r = await S(2, "POST", "/bale/contact-scan", { accountId: K.id }); assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.accountId, H.id, "an expert always scans their own account (accountId ignored)");
  const scan = r.j; assert.equal(scan.source, "contacts");
  assert.deepEqual(scan.counts, { contacts: 14, confident: 5, review: 5, notFound: 4 });
  const flat = [...scan.confident, ...scan.review, ...scan.notFound];
  assert.ok(flat.every(x => x.candidates.every(c => [100, 102, 104, 105, 106, 107, 108, 109].includes(c.customerId))), "own customers only");
  assert.equal(scan.confident.find(x => x.baleUserId === "900000004").phoneMasked, "0912•••15");
  const raw = JSON.stringify(scan); for (const p of ["09120000015", "09120000017", "9120000019", "09120000001"]) assert.ok(!raw.includes(p), `phone ${p} in response`);
  assert.deepEqual(mock.log.slice(before).map(l => l.path), ["/v1/contacts"], "one read-only call");
  assert.equal(mock.sent.length, 0); assert.equal(db.prepare("SELECT count(*) n FROM customer_bale_links").get().n, 0, "scan writes no links");
  const au = db.prepare("SELECT * FROM bale_audit WHERE action='contacts.scan' AND outcome='ok'").get();
  assert.deepEqual(JSON.parse(au.detail_json), { source: "contacts", contacts: 14, confident: 5, review: 5, notFound: 4, admin: false });
  r = await S(2, "POST", "/bale/contact-scan", {}); assert.equal(r.s, 429); assert.equal(r.j.error, "scan_too_soon"); assert.ok(r.j.retryAfterS > 0 && r.j.retryAfterS <= 300);
  assert.equal(mock.log.filter(l => l.path === "/v1/contacts").length, 1, "CRM cooldown: sidecar not called again");
  ok("expert scan: own account only, one read-only /v1/contacts call, 5 confident / 5 review / 4 not found, masked phones, no links written, audit = counts only, 5-min cooldown");

  // ---- link / unlink ----
  r = await S(3, "POST", "/bale/contact-links", { scanId: scan.scanId, items: [{ baleUserId: "900000001", customerId: 100 }] }); assert.equal(r.s, 410, "another expert cannot use the scan");
  r = await S(2, "POST", "/bale/contact-links", { scanId: "nope", items: [{ baleUserId: "900000001", customerId: 100 }] }); assert.equal(r.s, 410);
  const conf = scan.confident.map(x => ({ baleUserId: x.baleUserId, customerId: x.candidates[0].customerId }));
  r = await S(2, "POST", "/bale/contact-links", { scanId: scan.scanId, items: [...conf, { baleUserId: "900000007", customerId: 110 }, { baleUserId: "999", customerId: 104 }, { baleUserId: "900000009", customerId: 101 }] });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.linked.length, 5);
  assert.deepEqual(r.j.skipped.map(s => s.reason), ["out_of_scope", "not_in_scan", "out_of_scope"]);
  assert.deepEqual(r.j.linked.map(l => l.method), ["id", "id", "phone", "phone", "phone"]);
  // review: pick 106 for contact 5 (name) and a manual pick for the conflict row; contact 14 → 109 already linked → customer_linked
  r = await S(2, "POST", "/bale/contact-links", { scanId: scan.scanId, items: [{ baleUserId: "900000005", customerId: 106 }, { baleUserId: "900000003", customerId: 104 }, { baleUserId: "900000014", customerId: 109 }, { baleUserId: "900000001", customerId: 100 }] });
  assert.deepEqual(r.j.linked.map(l => [l.customerId, l.method]), [[106, "name"], [104, "name"], [100, "id"]], JSON.stringify(r.j));
  assert.deepEqual(r.j.skipped.map(s => s.reason), ["customer_linked"]);
  r = await S(2, "POST", "/bale/contact-links", { scanId: scan.scanId, items: [{ baleUserId: "900000010", customerId: 107 }] });
  assert.deepEqual(r.j.skipped.map(s => s.reason), ["customer_linked"]);
  assert.equal(db.prepare("SELECT count(*) n FROM customer_bale_links WHERE unlinked_at IS NULL").get().n, 7);
  const l104 = db.prepare("SELECT * FROM customer_bale_links WHERE customer_id=104").get();
  assert.equal(l104.expert_user_id, 2); assert.equal(l104.linked_by, 2); assert.equal(l104.bale_user_id, "900000003");
  // badge
  r = await S(2, "GET", "/bale/customers/104/link"); assert.equal(r.s, 200); assert.equal(r.j.linked, true); assert.equal(r.j.link.method, "name");
  r = await S(2, "GET", "/bale/customers/110/link"); assert.equal(r.s, 404, "foreign customer");
  r = await S(1, "GET", "/bale/customers/104/link"); assert.equal(r.j.linked, true); assert.equal(r.j.link.expertName, "حسنی");
  r = await S(2, "GET", "/bale/customers/109/link"); assert.equal(r.j.linked, true);
  for (const u of [6, 29, 4]) { r = await S(u, "GET", "/bale/customers/104/link"); assert.equal(r.s, 403, `badge user ${u}`); }
  // unlink: other expert cannot; own can; relink after unlink works
  const l106 = db.prepare("SELECT id FROM customer_bale_links WHERE customer_id=106 AND unlinked_at IS NULL").get().id;
  r = await S(8, "POST", `/bale/contact-links/${l106}/unlink`); assert.equal(r.s, 404);
  r = await S(2, "POST", `/bale/contact-links/${l106}/unlink`); assert.equal(r.s, 200);
  r = await S(2, "POST", `/bale/contact-links/${l106}/unlink`); assert.equal(r.s, 404, "already unlinked");
  assert.equal(db.prepare("SELECT unlink_reason r, unlinked_by b FROM customer_bale_links WHERE id=?").get(l106).r, "expert");
  r = await S(2, "POST", "/bale/contact-links", { scanId: scan.scanId, items: [{ baleUserId: "900000005", customerId: 105 }] });
  assert.deepEqual(r.j.skipped.map(s => s.reason), ["customer_linked"], "105 is linked to contact 4");
  r = await S(2, "POST", "/bale/contact-links", { scanId: scan.scanId, items: [{ baleUserId: "900000005", customerId: 106 }] }); assert.equal(r.j.linked.length, 1, "relink after unlink");
  clock = new Date(clock.getTime() + 31 * 60_000);
  r = await S(2, "POST", "/bale/contact-links", { scanId: scan.scanId, items: [{ baleUserId: "900000006", customerId: 108 }] }); assert.equal(r.s, 410, "scan expires after 30 min");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM customers ORDER BY id").all()), custBefore, "customer rows untouched");
  const auL = db.prepare("SELECT detail_json detail FROM bale_audit WHERE action IN ('contacts.link','contacts.unlink')").all().map(x => x.detail).join("\n");
  assert.ok(!/0912|9000000|رضا|زهرا/.test(auL), "audit: no phones, no bale ids, no names"); assert.match(auL, /"peer":"[0-9a-f]{10}"/);
  ok("links: confident-all + per-row pick; scope/scan/duplicate guards; badge (own/admin, 403 others); unlink + relink; scan TTL; customers untouched; audit has only ids + peer hash");

  // ---- admin: picks an expert account, matches ALL customers, link belongs to that expert ----
  r = await S(1, "POST", "/bale/contact-scan", { accountId: 999 }); assert.equal(r.s, 409);
  r = await S(1, "POST", "/bale/contact-scan", { accountId: K.id }); assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.all, true); assert.deepEqual(r.j.counts, { contacts: 3, confident: 2, review: 0, notFound: 1 });
  assert.ok(r.j.confident.some(x => x.candidates[0].customerId === 100), "admin matches all customers (100 belongs to hasani)");
  const ad = r.j;
  r = await S(1, "POST", "/bale/contact-links", { scanId: ad.scanId, items: [{ baleUserId: "900000040", customerId: 140 }] }); assert.equal(r.j.linked.length, 1);
  const l140 = db.prepare("SELECT * FROM customer_bale_links WHERE customer_id=140").get(); assert.equal(l140.expert_user_id, 8); assert.equal(l140.linked_by, 1);
  r = await S(8, "POST", "/bale/contact-scan", {}); assert.equal(r.s, 429, "admin scan counts for that account's cooldown");
  r = await S(8, "GET", "/bale/customers/140/link"); assert.equal(r.j.linked, true);
  ok("admin: chooses a connected expert's account, matches all customers, link stored under that expert (linked_by = admin); cooldown shared per account");

  // ---- sidecar errors / dialogs fallback / master off ----
  clock = new Date(clock.getTime() + 6 * 60_000);
  mock.state.contactsError = "session_invalid"; r = await S(2, "POST", "/bale/contact-scan", {}); assert.equal(r.s, 409); assert.equal(r.j.error, "session_invalid"); assert.ok(r.j.message);
  mock.state.contactsError = null; clock = new Date(clock.getTime() + 6 * 60_000);
  mock.state.contactsCooldownMs = 60_000; mock.state.contactsAt = { [`acc-${H.id}`]: Date.now() };
  r = await S(2, "POST", "/bale/contact-scan", {}); assert.equal(r.s, 429); assert.equal(r.j.error, "scan_too_soon", "sidecar 429 mapped");
  mock.state.contactsCooldownMs = 0; clock = new Date(clock.getTime() + 6 * 60_000); mock.state.contactsSource = "dialogs";
  r = await S(2, "POST", "/bale/contact-scan", {}); assert.equal(r.s, 200); assert.equal(r.j.source, "dialogs");
  assert.ok(r.j.confident.every(x => x.candidates[0].method === "id"), "dialogs: no phones → id/name only");
  assert.equal(r.j.confident.find(x => x.baleUserId === "900000004")?.link?.customerId ?? r.j.notFound.concat(r.j.review).find(x => x.baleUserId === "900000004").link.customerId, 105, "existing link shown");
  mock.state.contactsSource = "contacts";
  await S(1, "PUT", "/admin/bale/master", { enabled: false }); clock = new Date(clock.getTime() + 6 * 60_000);
  r = await S(2, "POST", "/bale/contact-scan", {}); assert.equal(r.s, 423);
  await S(1, "PUT", "/admin/bale/master", { enabled: true });
  ok("errors: session_invalid → Persian message; sidecar rate_limited → scan_too_soon; dialogs fallback reported as source; master OFF → 423");

  // ---- recipient resolution through the link (mock only) ----
  r = await S(2, "PUT", "/bale/me/mode", { mode: "auto" }); assert.equal(r.s, 200, JSON.stringify(r.j));
  await tick(); clock = new Date(clock.getTime() + 61_000); await tick();
  r = await S(2, "POST", "/bale/customers/104/send", { text: "سلام، وقت بخیر" }); assert.equal(r.s, 200, `no-phone customer linked → sendable: ${JSON.stringify(r.j)}`);
  let t = await tick(); assert.equal(t.results[H.id], "sent", JSON.stringify(t));
  assert.deepEqual([mock.sent.at(-1).phone, mock.sent.at(-1).peerId], ["", "900000003"], "sent to the linked Bale user, no phone");
  clock = new Date(clock.getTime() + 10 * 60_000);
  r = await S(2, "POST", "/bale/customers/100/send", { text: "سلام" }); assert.equal(r.s, 200); t = await tick(); assert.equal(t.results[H.id], "sent");
  assert.equal(mock.sent.at(-1).peerId, "900000001", "link wins over the phone lookup"); assert.equal(mock.sent.at(-1).phone, "09120000001");
  // runner (assistant) → same resolution
  clock = new Date(clock.getTime() + 10 * 60_000);
  r = await fetch(`http://127.0.0.1:${port}/runner/bale/send`, { method: "POST", headers: { "content-type": "application/json", "x-asst": "1" }, body: JSON.stringify({ customerId: 104, text: "سلام از دستیار" }) }).then(async x => ({ s: x.status, j: await x.json() }));
  assert.equal(r.j.error, "no_prior_chat", "runner passes the phone check via the link; the unchanged prior-chat rule still applies: " + JSON.stringify(r.j));
  // unlinked → back to no_phone
  const l104b = db.prepare("SELECT id FROM customer_bale_links WHERE customer_id=104 AND unlinked_at IS NULL").get().id;
  await S(2, "POST", `/bale/contact-links/${l104b}/unlink`);
  r = await S(2, "POST", "/bale/customers/104/send", { text: "سلام" }); assert.equal(r.s, 422); assert.equal(r.j.error, "no_phone");
  // inbound from a linked peer lands on the customer
  r = await mock.inbound(`http://127.0.0.1:${port}`, `acc-${H.id}`, [{ messageId: "m-1", peerId: "900000005", text: "سلام خانم", date: clock.toISOString() }]);
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.stored, 1);
  assert.equal(db.prepare("SELECT customer_id c FROM bale_messages WHERE bale_msg_id='m-1'").get()?.c, 106);
  ok("send + assistant resolve the recipient via the link (peerId, phone may be empty; link beats phone); unlink → no_phone again; inbound from a linked peer → that customer");

  // ---- no secrets / phones ----
  const dump = JSON.stringify(["bale_audit", "bale_outbox", "bale_contacts", "customer_bale_links", "site_notification_events", "assistant_events"].map(x => db.prepare(`SELECT * FROM ${x}`).all()));
  for (const p of ["09120000015", "09120000017", "9120000019", "09120000900", "09120000908"]) assert.ok(!dump.includes(p), `phone ${p} stored`);
  ok("no contact / customer phone in audit, outbox, links or bells");
  console.log(`\nbale-contact-scan-fixture: ${passed} groups passed`);
} finally { srv.close(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
