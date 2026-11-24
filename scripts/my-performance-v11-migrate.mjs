/**
 * Additive only: insert flag.my_performance_v1 and flag.my_performance_inquiry as '0' if absent.
 * The inquiry key is kept as an unused OFF row; /my-work no longer reads it.
 * Never updates an existing value. Never touches sales_performance_v1, expert_lockdown, multi_team_v1.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const LIVE = "/var/lib/nafisvam/customers.db";
const dbPath = process.argv[2] || process.env.CRM_DATABASE_PATH;
if (!dbPath) { console.error("usage: my-performance-v11-migrate.mjs <db>"); process.exit(2); }
if (fs.existsSync(LIVE) && fs.realpathSync(path.resolve(dbPath)) === fs.realpathSync(LIVE) && !process.env.NAFISVAM_ALLOW_LIVE_FLAG) {
  console.error("Refusing to write the live database.");
  process.exit(2);
}
const db = new DatabaseSync(dbPath);
const now = new Date().toISOString();
const keys = ["flag.my_performance_v1", "flag.my_performance_inquiry"];
for (const key of keys) {
  const row = db.prepare("SELECT value FROM call_queue_settings WHERE key=?").get(key);
  if (row) { console.log("keep", key, row.value); continue; }
  db.prepare("INSERT INTO call_queue_settings(key, value, updated_by, updated_at) VALUES(?,?,NULL,?)").run(key, "0", now);
  console.log("insert", key, "0");
}
db.close();
