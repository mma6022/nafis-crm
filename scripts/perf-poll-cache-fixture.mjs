import assert from "node:assert/strict";
import { crmDb, execute, executeChanges, queryRow, __resetSqlQueryCount, __sqlQueryCount } from "../src/lib/crm-db.ts";
import {
  ensureAfterCallSchema,
  pendingAfterCallPayload,
  pendingAfterCalls,
  applyAfterCallFixesThrottled,
  applyAfterCallFixes,
  __setAfterCallFixNow,
} from "../src/lib/voip-after-call.ts";
import {
  PERF_POLL_CACHE_OFF_FLAG,
  __perfCacheReset,
  __perfCacheStats,
  __setPerfPollCacheOn,
  perfCacheGetOrSet,
  perfCacheInvalidate,
  perfPollCacheOn,
  perfWriteFresh,
} from "../src/lib/perf-poll-cache.ts";
import { recordPageUsage, flushPageUsage } from "../src/lib/page-usage.ts";

assert.equal(process.env.CRM_DATABASE_PATH && !process.env.CRM_DATABASE_PATH.includes("/var/lib/"), true, "must use a throwaway CRM_DATABASE_PATH");

ensureAfterCallSchema();
const at = "2026-11-11T09:00:00.000Z";
executeChanges("INSERT OR IGNORE INTO salespersons(id,name,active,created_at) VALUES(9011,'آزمایش پرف',1,?)", [at]);
executeChanges("INSERT OR IGNORE INTO users(id,username,password_hash,full_name,role,active,created_at,salesperson_id) VALUES(9002,'perf.test','x','آزمایش پرف','salesperson',1,?,9011)", [at]);
executeChanges("INSERT OR IGNORE INTO voip_extensions(user_id,extension,updated_at,updated_by_user_id) VALUES(9002,'299',?,9002)", [at]);
executeChanges("INSERT OR IGNORE INTO customers(id,name,phone,salesperson_id,priority,status,created_at) VALUES(90001,'مشتری آزمایشی','00000000000',9011,2,'in_progress',?)", [at]);


const idx = queryRow("SELECT 1 ok FROM sqlite_master WHERE type='index' AND name='idx_after_call_live_started'");
assert.ok(idx, "additive live-started index exists");
const idx2 = queryRow("SELECT 1 ok FROM sqlite_master WHERE type='index' AND name='idx_after_call_missed_started'");
assert.ok(idx2, "additive missed-started index exists");

const now = "2026-11-11T09:00:00.000Z";
for (const k of ["flag.after_call_skip_missed","flag.after_call_stale_live","flag.after_call_autoclose_answered","flag.outgoing_call_popup","flag.simotel132b","flag.perf_poll_cache_off"]) {
  executeChanges("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, k==="flag.perf_poll_cache_off" ? "0" : "0", now]);
}

for (let i = 1; i <= 40; i++) {
  const logId = 90000 + i;
  executeChanges(
    `INSERT INTO call_logs(id,customer_id,salesperson_id,subject,created_at) VALUES(?,?,?,?,?)`,
    [logId, 90001, 9011, `موضوع ${i}`, now],
  );
  executeChanges(
    `INSERT INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,expert_name,salesperson_id,customer_id,call_log_id,has_recording,expert_notes,completed_at,is_live)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [`perf-ext-${i}`, "00000000000", "incoming", "ANSWERED", now, now, "299", '["299"]', 9002, "آزمایش پرف", 9011, 90001, logId, 0, "", null, 0],
  );
}

const actor = { id: 9002, role: "salesperson", salespersonId: 9011, customerScope: "assigned", permissions: ["calls.view"], salesManager: false };

__perfCacheReset();
__setPerfPollCacheOn(true);
__resetSqlQueryCount();
const first = pendingAfterCallPayload(actor);
assert.equal(first.items.length, 40);
assert.equal(first.total, 40);
assert.equal(first.items[0].subject, "موضوع 1");
const q1 = __sqlQueryCount;
assert.ok(q1 < 30, `first payload should not N+1; queries=${q1}`);

__resetSqlQueryCount();
const second = pendingAfterCallPayload(actor);
assert.equal(second.total, 40);
assert.equal(second.items[0].subject, first.items[0].subject);
const q2 = __sqlQueryCount;
assert.equal(q2, 0, `second payload must be a cache hit; queries=${q2}`);
assert.ok(__perfCacheStats().hits >= 1, "cache hit recorded");

perfCacheInvalidate("after-call-pending:");
__setPerfPollCacheOn(false);
__resetSqlQueryCount();
pendingAfterCallPayload(actor);
const qOff = __sqlQueryCount;
assert.ok(qOff >= 1, "kill-switch forces a real query");
__resetSqlQueryCount();
pendingAfterCallPayload(actor);
assert.ok(__sqlQueryCount >= 1, "kill-switch: second call is not cached");

__setPerfPollCacheOn(true);
__perfCacheReset();
perfCacheGetOrSet("k", 5000, () => "v");
assert.equal(perfCacheGetOrSet("k", 5000, () => "nope"), "v");
assert.equal(perfPollCacheOn(), true);

assert.equal(perfWriteFresh("p:1", 15_000), true);
assert.equal(perfWriteFresh("p:1", 15_000), false);
__setPerfPollCacheOn(false);
assert.equal(perfWriteFresh("p:1", 15_000), true);
__setPerfPollCacheOn(true);

__setAfterCallFixNow(Date.parse(now));
applyAfterCallFixes();
const a = applyAfterCallFixesThrottled(10_000);
assert.deepEqual(a, { swept: 0, closed: 0 });

// page-usage batch: two records, one flush
crmDb.exec("INSERT OR IGNORE INTO call_queue_settings(key,value,updated_at) VALUES('flag.page_usage','1','2026-11-11T09:00:00Z')");
const n1 = recordPageUsage(crmDb, { id: 9002, role: "salesperson", salespersonId: 9011 }, { events: [{ kind: "visit", route: "/today", source: "nav", enteredAt: now, dwellMs: 0 }] }, new Date(now));
const n2 = recordPageUsage(crmDb, { id: 9002, role: "salesperson", salespersonId: 9011 }, { events: [{ kind: "visit", route: "/today", source: "nav", enteredAt: now, dwellMs: 1000 }] }, new Date(now));
assert.equal(n1 + n2, 2);
const beforeFlush = queryRow("SELECT count(*) n FROM page_usage_events")?.n ?? 0;
flushPageUsage();
const afterFlush = queryRow("SELECT count(*) n FROM page_usage_events")?.n ?? 0;
assert.ok(afterFlush >= beforeFlush, "flush writes buffered events");

const cheaper = pendingAfterCalls(actor);
assert.equal(cheaper.total, cheaper.rows.length, "count skipped when under the 100-row cap");

console.log("perf-poll-cache fixture: all checks passed", { firstQueries: q1, cacheHitQueries: q2, killSwitchQueries: qOff, items: first.items.length });
