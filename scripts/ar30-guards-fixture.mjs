// AR30 guards fixture (in-memory DB only): assistant bell recipient guard (code + trigger) and the shared official_holidays table.
// Run: node scripts/run-bundled-fixture.mjs scripts/ar30-guards-fixture.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureAssistantSchema, assistantBellBlocked } from "../src/lib/assistants.ts";
import { ensureOfficialHolidaysSchema, listOfficialHolidays, addOfficialHoliday, deleteOfficialHoliday, replaceOfficialHolidays, isOfficialHoliday, validateHoliday } from "../src/lib/official-holidays.ts";

let passed = 0; const ok = m => { passed++; console.log("ok " + m); };
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,salesperson_id INTEGER,active INTEGER DEFAULT 1);
INSERT INTO users VALUES(1,'admin','مدیر','admin',NULL,1),(5,'mhmab','ادمین۵','admin',NULL,1),(6,'t5','کارآموز','salesperson',5,1),(8,'kz','کاظمی','salesperson',6,1),
  (27,'t19','کارآموز۱۹','salesperson',19,1),(29,'h29','ادمین۲۹','admin',NULL,1),(40,'tr','کارآموز نقش','trainee',NULL,1);
CREATE TABLE site_notification_events(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,customer_name TEXT,owner_id INTEGER,resource_type TEXT,resource_id INTEGER,kind TEXT,title TEXT,body TEXT,permission TEXT,created_at TEXT,actor_key TEXT,recipient_user_id INTEGER);
INSERT INTO site_notification_events(kind,title,actor_key,recipient_user_id,created_at) VALUES('assistant','old row (kept)','assistant:sarina',29,'2026-10-01');`);
ensureAssistantSchema(db); ensureAssistantSchema(db);

// code guard
for (const id of [29, 6, 27, 40]) assert.equal(assistantBellBlocked(db.prepare("SELECT * FROM users WHERE id=?").get(id)), true, `user ${id} blocked`);
for (const id of [1, 5, 8]) assert.equal(assistantBellBlocked(db.prepare("SELECT * FROM users WHERE id=?").get(id)), false, `user ${id} allowed`);
assert.equal(assistantBellBlocked(null), true);
assert.equal(assistantBellBlocked({ id: 5, role: "admin", salesperson_id: null }), false, "user id 5 is not trainee salesperson 5 (AR29 report false positive)");
ok("code guard: 29 / role trainee / salesperson 5,19,20 blocked; admin user 5 (id ≠ salesperson id) allowed");

// trigger
const ins = db.prepare("INSERT INTO site_notification_events(kind,title,actor_key,recipient_user_id,created_at) VALUES('assistant','t',?,?,'2026-10-27')");
for (const id of [29, 6, 27, 40]) assert.equal(Number(ins.run("assistant:masoud", id).changes), 0, `trigger ignores ${id}`);
for (const id of [1, 5, 8]) assert.equal(Number(ins.run("assistant:sarina", id).changes), 1, `trigger allows ${id}`);
assert.equal(Number(ins.run("user:1", 29).changes), 1, "non-assistant rows untouched");
assert.equal(Number(ins.run("assistant:sarina", null).changes), 1, "permission broadcast (no recipient) untouched");
assert.equal(db.prepare("SELECT count(*) n FROM site_notification_events WHERE title='old row (kept)'").get().n, 1, "existing rows are never deleted");
assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_assistant_bell_recipient_guard'").get());
ok("DB trigger trg_assistant_bell_recipient_guard: assistant:* rows to 29 / trainees silently ignored; others and old rows unchanged");

// holidays: migration from the AR29 setting + shared helpers
const h = new DatabaseSync(":memory:");
h.exec(`CREATE TABLE bale_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by INTEGER);
INSERT INTO bale_settings(key,value,updated_at) VALUES('autoreply_holidays','[{"date":"2026-11-05","label":"تاسوعا"},{"date":"bad","label":"x"},{"date":"2026-11-06","label":"عاشورا"}]','x');`);
ensureOfficialHolidaysSchema(h, "2026-10-27T00:00:00Z");
assert.deepEqual(listOfficialHolidays(h).map(x => [x.date, x.label]), [["2026-11-05", "تاسوعا"], ["2026-11-06", "عاشورا"]]);
deleteOfficialHoliday(h, listOfficialHolidays(h)[0].id);
ensureOfficialHolidaysSchema(h, "2026-10-28T00:00:00Z");
assert.equal(listOfficialHolidays(h).length, 1, "migration runs once (deleted date not re-imported)");
assert.equal(validateHoliday({ date: "2026-02-30" }), "invalid_date"); assert.equal(validateHoliday({ date: "2026-03-01", label: "x".repeat(41) }), "label_too_long");
let r = addOfficialHoliday(h, { date: "2026-03-20", label: "نوروز" }, 1, "t"); assert.ok(r.ok && r.created);
r = addOfficialHoliday(h, { date: "2026-03-20", label: "عید نوروز" }, 1, "t"); assert.ok(r.ok && !r.created);
assert.equal(isOfficialHoliday(h, "2026-03-20"), true);
assert.deepEqual(replaceOfficialHolidays(h, [{ date: "2026-04-01", label: "روز جمهوری" }], 1, "t"), { added: 1, removed: 2 });
assert.deepEqual(listOfficialHolidays(h).map(x => x.date), ["2026-04-01"]);
const e = new DatabaseSync(":memory:"); ensureOfficialHolidaysSchema(e); assert.equal(listOfficialHolidays(e).length, 0, "works without bale_settings (other modules)");
ok("official_holidays: one-time migration from bale_settings.autoreply_holidays, validated add / update / delete / replace, usable by other modules");

console.log(`\nar30-guards-fixture: ${passed} groups passed`);
