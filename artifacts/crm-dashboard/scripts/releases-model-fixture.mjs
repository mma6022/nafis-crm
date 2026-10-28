// Release 84(A) unit fixture: Tehran time, operation status mapping, schema cut-off gate, pagination, refresh.
// Run: node --experimental-strip-types scripts/releases-model-fixture.mjs
import assert from "node:assert/strict";
import { ridToDate, ridToTehran, mapOperation, releaseGate, paginate, crmRefetchMs } from "../src/lib/releases-model.ts";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("ridToDate 14 + 12 digit (manager appends 00)", () => {
  assert.equal(ridToDate("20261028211337").toISOString(), "2026-10-28T21:13:37.000Z");
  assert.equal(ridToDate("202610282113").toISOString(), "2026-10-28T21:13:00.000Z");
  assert.equal(ridToDate("20261028211337-uploaded").toISOString(), "2026-10-28T21:13:37.000Z");
  for (const bad of ["", null, undefined, "2026", "20261340000000", "20260231000000"]) assert.equal(ridToDate(bad), null, String(bad));
});
t("ridToTehran UTC+03:30 with Persian digits/Jalali date", () => {
  const a = ridToTehran("20261028212415");
  assert.equal(a.iso, "2026-10-29 00:54");
  assert.equal(a.time, "۰۰:۵۴");
  assert.match(a.date, /۱۴۰۵/); // 2026-10-29 = 7 Aban 1405
  assert.equal(ridToTehran("20261231210000").iso, "2027-01-01 00:30");
  assert.equal(ridToTehran("bad"), null);
});
t("mapOperation status mapping", () => {
  assert.deepEqual([mapOperation(null).kind, mapOperation(null).blocksActions], ["none", false]);
  assert.deepEqual([mapOperation({}).kind], ["none"]);
  for (const s of ["running", "applying", "RUNNING"]) { const v = mapOperation({ status: s, target: "20261028211337" }); assert.equal(v.kind, "running"); assert.equal(v.blocksActions, true); assert.match(v.title, /20261028211337/); }
  for (const s of ["succeeded", "success"]) { const v = mapOperation({ status: s }); assert.equal(v.kind, "success"); assert.equal(v.blocksActions, false); }
  const f = mapOperation({ status: "failed", error: "activation_failed" });
  assert.equal(f.kind, "failed"); assert.equal(f.blocksActions, false); assert.match(f.message, /نسخه‌ی قبلی/);
  for (const e of ["database_schema_changed", "failed_to_restore_links"]) {
    const m = mapOperation({ status: "manual_recovery_required", error: e });
    assert.equal(m.kind, "manual_recovery"); assert.equal(m.blocksActions, true);
    assert.equal(m.title, "CRM متوقف است؛ بازیابی دستی لازم است");
  }
  const u = mapOperation({ status: "weird" }); assert.equal(u.kind, "unknown"); assert.equal(u.blocksActions, true);
  assert.equal(mapOperation({ status: "failed", error: "zzz" }).message, "zzz");
});
t("releaseGate schema cut-off", () => {
  const base = { current: "20261028211337", cutoff: "20261028203444", ready: true, busy: false };
  assert.equal(releaseGate({ ...base, version: "20261028211337" }).action, "none");
  // older than cut-off -> disabled with reason
  const old = releaseGate({ ...base, version: "20261028145657" });
  assert.deepEqual([old.action, old.allowed], ["rollback", false]); assert.match(old.reason, /20261028203444/);
  // exactly the cut-off release -> allowed (its code matches the schema)
  assert.deepEqual([releaseGate({ ...base, version: "20261028203444" }).allowed], [true]);
  // between cut-off and current -> allowed
  assert.equal(releaseGate({ ...base, cutoff: "20261028200000", version: "20261028203444" }).allowed, true);
  // unknown cut-off blocks every rollback
  const unk = releaseGate({ ...base, cutoff: null, version: "20261028203444" });
  assert.deepEqual([unk.action, unk.allowed], ["rollback", false]);
  // newer than current = deploy, cut-off irrelevant
  assert.deepEqual(Object.values(releaseGate({ ...base, cutoff: null, version: "20261029000000" })).slice(0, 2), ["deploy", true]);
  // 12-digit cut-off normalised
  assert.equal(releaseGate({ ...base, cutoff: "202610282034", version: "20261028203300" }).allowed, false);
  // busy / not ready
  assert.equal(releaseGate({ ...base, busy: true, version: "20261029000000" }).allowed, false);
  assert.equal(releaseGate({ ...base, ready: false, version: "20261029000000" }).allowed, false);
  // seed: cut-off = current (82) -> every rollback disabled
  assert.equal(releaseGate({ current: "20261028211337", cutoff: "20261028211337", ready: true, busy: false, version: "20261028203444" }).allowed, false);
});
t("paginate", () => {
  const xs = Array.from({ length: 37 }, (_, i) => i);
  assert.deepEqual(paginate(xs, 1, 15), { rows: xs.slice(0, 15), page: 1, pages: 3, total: 37 });
  assert.deepEqual(paginate(xs, 3, 15).rows, xs.slice(30));
  assert.equal(paginate(xs, 99, 15).page, 3);
  assert.equal(paginate(xs, 0, 15).page, 1);
  assert.equal(paginate(xs, NaN, 15).page, 1);
  assert.deepEqual(paginate([], 1, 10), { rows: [], page: 1, pages: 1, total: 0 });
});
t("refresh: 30s idle, 4s only while running", () => {
  assert.equal(crmRefetchMs("running"), 4000);
  for (const k of ["none", "success", "failed", "manual_recovery", "unknown"]) assert.equal(crmRefetchMs(k), 30000);
});
console.log(`releases-model fixture: ${n} passed`);
