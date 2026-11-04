// VNA-DESK fixture: usage VNA_DB=/path/masked-copy.db node scripts/run-bundled-fixture.mjs scripts/vna-deskphone-fixture.ts (DB is modified; stubbed sender, no network)
import assert from "node:assert/strict";
const DBP = process.env.VNA_DB; assert.ok(DBP, "VNA_DB required");
Object.assign(process.env, { NODE_ENV: "production", SIMOTEL_API_KEY: "synthetic", OPENAI_API_KEY: "synthetic", SESSION_SECRET: "synthetic-fixture-session-secret-0123456789", CRM_DATABASE_PATH: DBP });
globalThis.fetch = (async (u: unknown) => { throw new Error("unexpected network call " + String(u)); }) as typeof fetch;
const { crmDb, queryRow, queryRows, executeChanges, execute } = await import("../src/lib/crm-db");
const A = await import("../src/lib/voip-after-call");
const V = await import("../src/lib/voip-noanswer-sms");
const D = await import("../src/lib/voip-noanswer-desk");
V.ensureVnaSchema();
let pass = 0; const ok = (n: string, f: () => void) => { f(); pass++; console.log("ok", n); };
const sent: any[] = []; let failNext = 0;
const deps = { send: async (a: any) => { if (failNext > 0) { failNext--; throw new Error("sms_failed"); } sent.push(a); return "pid-" + sent.length; }, ippanelEnabled: () => true };
const set = (k: string, v: string, at: string) => executeChanges("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [k, v, at]);
const Z = (s: string) => new Date(s);
// synthetic customers (masked copy only); numbers checked unused
const phones = Array.from({ length: 14 }, (_, i) => "0919999" + String(1000 + i));
for (const p of phones) assert.equal(queryRow("SELECT 1 x FROM customers WHERE phone=? OR phone=?", [p, p.slice(1)]), undefined, "synthetic number collides");
const cust = phones.map((p, i) => Number(execute("INSERT INTO customers(name,phone,created_at) VALUES(?,?,?)", ["مشتری تست " + i, p, "2026-11-01T00:00:00Z"])));
crmDb.exec("DELETE FROM voip_noanswer_sms WHERE tehran_day='2026-11-04'");
set("flag.voip_noanswer_sms", "1", "2026-11-04T05:00:00.000Z");
const ext2 = queryRow<{ extension: string }>("SELECT extension FROM voip_extensions WHERE user_id=2")!.extension;
let seq = 0;
const cdr = (o: { dst: string; endZ: string; dur?: number; disp?: string; billsec?: number; details?: any[]; src?: string; type?: string; record?: string; orig?: string }) => ({
  _id: "vnad-" + (++seq) + "-" + Date.now(), cuid: "vnad-cuid-" + seq, src: o.src ?? ext2, dst: o.dst, type: o.type ?? "outgoing", duration: o.dur ?? 30,
  billsec: o.billsec ?? 0, disposition: o.disp ?? "NO ANSWER", record: o.record, originated_call_id: o.orig,
  endtime: { $date: { $numberLong: String(Date.parse(o.endZ)) } }, details: o.details ?? [{ exten: o.dst, status: o.disp ?? "NO ANSWER", billsec: o.billsec ?? 0 }] });
const sync = async (rows: any[], now: Date) => { A.ingestAfterCalls(rows, now); await D.vnaDeskAfterIngest(rows as any, deps, now); };
const vrow = (r: any) => { const e = queryRow<{ id: number }>("SELECT id FROM voip_after_call_events WHERE external_id=? OR recording_provider_id=?", [r._id, r._id]); return e ? queryRow<any>("SELECT * FROM voip_noanswer_sms WHERE call_id=?", [-e.id]) : undefined; };
const t0 = Z("2026-11-04T07:00:00.000Z"); // 10:30 Tehran

// 1. desk flag absent → nothing
let r1 = cdr({ dst: phones[0], endZ: "2026-11-04T06:58:00Z" });
await sync([r1], t0);
ok("desk flag OFF → nothing written, no send", () => { assert.equal(vrow(r1), undefined); assert.equal(sent.length, 0); });
set(D.VNA_DESK_FLAG, "0", "2026-11-04T06:00:00.000Z"); await sync([r1], t0);
ok("desk flag '0' → nothing", () => { assert.equal(vrow(r1), undefined); assert.equal(sent.length, 0); });
// switch on at 06:30Z; r1 ended after → eligible now
set(D.VNA_DESK_FLAG, "1", "2026-11-04T06:30:00.000Z");
set("flag.voip_noanswer_sms", "0", "2026-11-04T06:31:00.000Z"); await sync([r1], t0);
ok("main flag OFF + desk ON → nothing", () => { assert.equal(vrow(r1), undefined); assert.equal(sent.length, 0); });
set("flag.voip_noanswer_sms", "1", "2026-11-04T05:00:00.000Z");
await sync([r1], t0);
ok("desk no-answer → sent once with pattern + params", () => { const v = vrow(r1); assert.equal(v.status, "sent"); assert.equal(v.user_id, 2); assert.equal(v.customer_id, cust[0]); assert.ok(v.call_id < 0);
  assert.equal(sent.length, 1); assert.equal(sent[0].patternCode, "0od60ofo2fkaozx"); assert.equal(sent[0].recipient.slice(-7), phones[0].slice(-7));
  assert.deepEqual(Object.keys(sent[0].params).sort(), ["agent_mobile", "agent_name", "name", "time"]); assert.equal(sent[0].params.time, "10:27"); });
await sync([r1], t0); await sync([r1], new Date(t0.getTime() + 20000));
ok("re-poll same CDR → no second send", () => assert.equal(sent.length, 1));
let r2 = cdr({ dst: phones[0], endZ: "2026-11-04T06:59:00Z" }); await sync([r1, r2], t0);
ok("second desk no-answer same customer same day → skipped already_today", () => { assert.equal(vrow(r2).status, "skipped"); assert.equal(vrow(r2).skipped_reason, "already_today"); assert.equal(sent.length, 1); });
// 2. not-answered rules
const rA = cdr({ dst: phones[1], endZ: "2026-11-04T06:58:00Z", disp: "ANSWERED", billsec: 20 });
const rB = cdr({ dst: phones[2], endZ: "2026-11-04T06:58:00Z", disp: "NO ANSWER", details: [{ exten: phones[2], status: "ANSWERED", billsec: 12 }] });
const rC = cdr({ dst: phones[3], endZ: "2026-11-04T06:58:00Z", disp: "NO ANSWER", record: "x.mp3" });
const rD = cdr({ dst: phones[4], endZ: "2026-11-04T06:58:00Z", disp: "NO ANSWER", details: [{ exten: phones[4], status: "NO ANSWER", billsec: 0 }, { exten: phones[4], status: "BUSY", billsec: 0 }] });
const rE = cdr({ dst: phones[5], endZ: "2026-11-04T06:58:00Z", type: "incoming", src: phones[5] });
const rF = cdr({ dst: phones[6], endZ: "2026-11-04T06:58:00Z", type: "local", orig: "orig-1" });
const rG = cdr({ dst: phones[7], endZ: "2026-11-04T07:05:00Z" }); // not ended yet (future)
const rH = cdr({ dst: phones[8], endZ: "2026-11-04T06:58:00Z", disp: "BUSY", details: [] });
await sync([rA, rB, rC, rD, rE, rF, rG, rH], t0);
ok("answered / customer-leg answered / recorded / mixed statuses / incoming / originate leg / unfinished → nothing", () => {
  for (const r of [rA, rB, rC, rD, rE, rF, rG]) assert.equal(vrow(r), undefined); });
ok("no details + row BUSY billsec 0 → sent (fallback rule)", () => { assert.equal(vrow(rH).status, "sent"); assert.equal(vrow(rH).cust_status, "BUSY"); assert.equal(sent.length, 2); });
// 3. dedupe with click calls (same expert + customer within the window, and event linked)
executeChanges(`INSERT INTO voip_click_calls(user_id,extension,customer_id,phone,state,active,created_at,updated_at) VALUES(2,?,?,?,'ended',0,'2026-11-04T06:57:10Z','2026-11-04T06:58:00Z')`, [ext2, cust[9], phones[9]]);
const rI = cdr({ dst: phones[9], endZ: "2026-11-04T06:58:00Z" }); await sync([rI], t0);
ok("click call of same expert/customer in window → desk path skips (no double SMS)", () => { assert.equal(vrow(rI), undefined); assert.equal(sent.length, 2); });
// 4. shared per-day with click rows
executeChanges(`INSERT INTO voip_noanswer_sms(call_id,customer_id,user_id,tehran_day,cust_status,status,created_at,updated_at) VALUES(987654321,?,3,'2026-11-04','NO ANSWER','sent',?,?)`, [cust[10], t0.toISOString(), t0.toISOString()]);
const rJ = cdr({ dst: phones[10], endZ: "2026-11-04T06:58:00Z" }); await sync([rJ], t0);
ok("customer already got the click-call SMS today → already_today", () => { assert.equal(vrow(rJ).skipped_reason, "already_today"); assert.equal(sent.length, 2); });
// 5. before switch / stale / hours / exclusions / unknown number / non-feature expert
const rK = cdr({ dst: phones[11], endZ: "2026-11-04T06:29:00Z", dur: 20 }); await sync([rK], t0);
ok("ended before the desk switch-on → nothing", () => assert.equal(vrow(rK), undefined));
const rL = cdr({ dst: phones[11], endZ: "2026-11-04T06:35:00Z", dur: 20 }); await sync([rL], Z("2026-11-04T07:10:00.000Z"));
ok("CDR >30 min old → skipped stale", () => { assert.equal(vrow(rL).skipped_reason, "stale"); assert.equal(sent.length, 2); });
const late = Z("2026-11-04T17:40:00.000Z"); // 21:10 Tehran
const rM = cdr({ dst: phones[12], endZ: "2026-11-04T17:38:00Z" }); await sync([rM], late);
ok("21:10 Tehran → skipped outside_hours", () => { assert.equal(vrow(rM).skipped_reason, "outside_hours"); assert.equal(sent.length, 2); });
executeChanges("INSERT OR IGNORE INTO voip_call_display_exclusions(phone) VALUES(?)", [phones[13]]);
const rN = cdr({ dst: phones[13], endZ: "2026-11-04T06:58:00Z" }); await sync([rN], t0);
ok("excluded number → skipped test_or_staff", () => { assert.equal(vrow(rN).skipped_reason, "test_or_staff"); assert.equal(sent.length, 2); });
const rO = cdr({ dst: "09199998888", endZ: "2026-11-04T06:58:00Z" }); await sync([rO], t0);
ok("unmatched number → nothing", () => { assert.equal(vrow(rO), undefined); assert.equal(sent.length, 2); });
executeChanges("UPDATE call_queue_settings SET value='0' WHERE key IN ('flag.voip_call','flag.voip_call.user.2')");
const c2 = Number(execute("INSERT INTO customers(name,phone,created_at) VALUES('مشتری تست x','09199997777','2026-11-01T00:00:00Z')"));
const rP = cdr({ dst: "09199997777", endZ: "2026-11-04T06:58:00Z" }); await sync([rP], t0);
ok("expert without the VoIP feature → nothing", () => { assert.equal(vrow(rP), undefined); assert.equal(sent.length, 2); });
executeChanges("UPDATE call_queue_settings SET value='1' WHERE key IN ('flag.voip_call','flag.voip_call.user.2')");
// 6. auto-off after 3 consecutive failures (shared with click path)
const fails = [0, 1, 2].map((i) => Number(execute("INSERT INTO customers(name,phone,created_at) VALUES(?,?,?)", ["مشتری تست f" + i, "091999966" + (10 + i), "2026-11-01T00:00:00Z"])));
failNext = 3;
const rf = [0, 1, 2].map((i) => cdr({ dst: "091999966" + (10 + i), endZ: "2026-11-04T06:58:00Z" }));
await sync(rf, t0);
ok("3 consecutive failures → main flag auto-off", () => { assert.deepEqual(rf.map((r) => vrow(r).status), ["failed", "failed", "failed"]);
  assert.equal(queryRow<any>("SELECT value FROM call_queue_settings WHERE key='flag.voip_noanswer_sms'").value, "0"); });
ok("logs/table carry no phone numbers", () => { const cols = queryRows<any>("PRAGMA table_info(voip_noanswer_sms)").map((c) => c.name); assert.ok(!cols.includes("phone")); });
console.log(`PASS ${pass}`);
void c2;
