// Staff GET /assistant/threads/:id/messages: wait=20 must not hold ~20s; after-cursor; additive index.
// In-memory assistant DB only. Side-effect crm-db must be pointed at a throwaway file via CRM_DATABASE_PATH (see run-assistant-thread-poll-fixture.sh).
// No SMS / Bale / calls / user 29 writes.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import {
  createAssistants,
  ensureAssistantSchema,
  STAFF_MAX_WAIT_S,
} from "../src/lib/assistants.ts";

assert.equal(STAFF_MAX_WAIT_S, 0, "staff polls must not long-wait");

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,salesperson_id INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,description TEXT,created_at TEXT,salesperson_id INTEGER,priority INTEGER,status TEXT,national_code TEXT,
  first_name TEXT,last_name TEXT,father_name TEXT,birth_date_jalali TEXT,postal_code TEXT,address TEXT,city TEXT,email TEXT,merged_into_customer_id INTEGER);
CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,subject TEXT,customer_request TEXT,expert_notes TEXT,created_at TEXT);
CREATE TABLE reminders(id INTEGER PRIMARY KEY,user_id INTEGER,salesperson_id INTEGER,message TEXT,remind_at TEXT,sent_sms INTEGER DEFAULT 0,done INTEGER DEFAULT 0,created_at TEXT,subject TEXT,customer_id INTEGER);
INSERT INTO salespersons VALUES(6,'کاظمی');
INSERT INTO users VALUES(1,'admin','مدیر','admin',NULL,1),(8,'m.kazemi','کاظمی','salesperson',6,1);
INSERT INTO customers(id,name,phone,description,created_at,salesperson_id,priority,status,national_code) VALUES
  (120,'مشتری کاظمی','09120000004','','2026-10-01',6,3,'in_progress',NULL);`);
ensureAssistantSchema(db);
const cookie = db.prepare("PRAGMA schema_version").get().schema_version;
ensureAssistantSchema(db);
assert.equal(db.prepare("PRAGMA schema_version").get().schema_version, cookie, "second start must not bump schema_version");
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_assistant_messages_thread','idx_assistant_messages_thread_author_picked')").all();
assert.equal(idx.length, 2, "both message indexes present");
const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM assistant_messages WHERE thread_id=? AND id>? ORDER BY id DESC LIMIT 80").all(1, 0);
const planTxt = plan.map((r) => r.detail).join(" | ");
assert.match(planTxt, /idx_assistant_messages_thread|SEARCH/i);

db.prepare("UPDATE assistant_settings SET value='1' WHERE key='global_enabled'").run();
db.prepare("UPDATE assistants SET enabled=1 WHERE slug='masoud'").run();
const as = createAssistants({
  db,
  now: () => new Date("2026-11-11T07:00:00Z"),
  actor: (res) => {
    const id = Number(res.locals.uid);
    return id ? { id, role: id === 1 ? "admin" : "salesperson", salespersonId: id === 8 ? 6 : null, name: "x" } : null;
  },
});
const app = express();
app.use(express.json());
app.use("/api", (req, res, next) => { res.locals.uid = Number(req.headers["x-user"] || 0); next(); }, as.staff);
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const port = srv.address().port;
const call = async (path, user = 8) => {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { headers: { "x-user": String(user) } });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { s: r.status, j, ms: Date.now() - t0 };
};

let passed = 0;
const ok = (name) => { passed++; console.log("ok", name); };

try {
  const mine = await call("/assistant/mine", 8);
  assert.equal(mine.s, 200, `mine ${mine.s}`);
  const threadId = mine.j.assistants.find((a) => a.slug === "masoud")?.threadId;
  assert.ok(threadId);

  const nowIso = "2026-11-11T07:00:00.000Z";
  for (let i = 0; i < 5; i++) {
    db.prepare(`INSERT INTO assistant_messages(thread_id,author,author_label,kind,priority,body,customer_id,origin,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(threadId, "assistant", "مسعود", "text", "normal", `m${i}`, 120, "runner", nowIso);
  }
  const maxId = db.prepare("SELECT MAX(id) id FROM assistant_messages WHERE thread_id=?").get(threadId).id;

  const first = await call(`/assistant/threads/${threadId}/messages?after=0&wait=20`, 8);
  assert.equal(first.s, 200, `first ${first.s}`);
  assert.ok(first.ms < 2000, `wait=20 must not hold ~20s, took ${first.ms}ms`);
  assert.equal(first.j.messages.length, 5);
  assert.equal(first.j.messages.at(-1).id, maxId);
  ok("wait=20 returns immediately with existing messages");

  const empty = await call(`/assistant/threads/${threadId}/messages?after=${maxId}&wait=20`, 8);
  assert.equal(empty.s, 200);
  assert.ok(empty.ms < 2000, `empty wait=20 must not hold, took ${empty.ms}ms`);
  assert.equal(empty.j.messages.length, 0);
  ok("after-cursor with no new messages is empty and fast");

  db.prepare(`INSERT INTO assistant_messages(thread_id,author,author_label,kind,priority,body,customer_id,origin,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(threadId, "assistant", "مسعود", "text", "normal", "new", 120, "runner", nowIso);
  const newer = await call(`/assistant/threads/${threadId}/messages?after=${maxId}&wait=0&limit=10`, 8);
  assert.equal(newer.s, 200);
  assert.equal(newer.j.messages.length, 1);
  assert.ok(newer.j.messages[0].id > maxId);
  assert.ok(newer.ms < 2000);
  ok("since-cursor returns only newer messages");

  console.log(`assistant-thread-poll fixture: ${passed} checks passed`);
} finally {
  await new Promise((r) => srv.close(r));
  db.close();
}
