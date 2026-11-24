/**
 * Additive only: insert flag.my_performance_v12 as '0' if absent.
 * Never updates an existing value. Never touches my_performance_v1, inquiry,
 * sales_performance_v1, expert_lockdown, or multi_team_v1.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const LIVE = "/var/lib/nafisvam/customers.db";
const dbPath = process.argv[2] || process.env.CRM_DATABASE_PATH;
if (!dbPath) { console.error("usage: my-performance-v12-migrate.mjs <db>"); process.exit(2); }
if (fs.existsSync(LIVE) && fs.realpathSync(path.resolve(dbPath)) === fs.realpathSync(LIVE) && !process.env.NAFISVAM_ALLOW_LIVE_FLAG) {
  console.error("Refusing to write the live database.");
  process.exit(2);
}
const db = new DatabaseSync(dbPath);
const now = new Date().toISOString();
const key = "flag.my_performance_v12";
const row = db.prepare("SELECT value FROM call_queue_settings WHERE key=?").get(key);
if (row) console.log("keep", key, row.value);
else {
  db.prepare("INSERT INTO call_queue_settings(key, value, updated_by, updated_at) VALUES(?,?,NULL,?)").run(key, "0", now);
  console.log("insert", key, "0");
}
db.close();
