// Shared helpers for the one-time team-sales transfer (Kazemi = qualifier).
// Pure node:sqlite (Node >= 22.5). No SMS, no contracts, no network.
import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const QUALIFIER_SALESPERSON_ID = 6; // آقای کاظمی (user 8)
export const SOURCE_SALESPERSON_IDS = [3, 4]; // خانم حسنی (user 2), خانم قاسمی (user 3)
// Trainees: never touched, never in rotation. salespersons.id (user id in comment).
export const TRAINEE_SALESPERSON_IDS = [5, 19, 20]; // اصلانیان (u6), یونسی (u27), خردکار (u28)
export const SNAPSHOT_TABLE = "team_sales_transfer_snapshot";
export const DEFAULT_DB = "/var/lib/nafisvam/customers.db";

export function parseArgs(argv) {
  const out = { apply: false, db: process.env.CRM_DATABASE_PATH || DEFAULT_DB };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--force") out.force = true;
    else if (a === "--keep-notifications") out.keepNotifications = true;
    else if (a === "--rollback") out.rollback = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.includes("=") ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
      out[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
  }
  return out;
}

/** Transfer set: Hasani/Ghasemi, in_progress, priority 2/3/NULL, not merged, no active loan application. */
export const TRANSFER_SET_SQL = `
  SELECT c.id AS customer_id, c.salesperson_id, c.priority
  FROM customers c
  WHERE c.salesperson_id IN (${SOURCE_SALESPERSON_IDS.join(",")})
    AND c.merged_into_customer_id IS NULL
    AND c.status = 'in_progress'
    AND (c.priority IS NULL OR c.priority IN (2, 3))
    AND NOT EXISTS (
      SELECT 1 FROM loan_applications la
      WHERE la.customer_id = c.id AND la.deleted_at IS NULL
        AND la.status IN ('requested', 'reviewing'))
  ORDER BY c.id`;

export const STAYING_SQL = `
  SELECT c.id AS customer_id, c.salesperson_id, c.priority, la.id AS application_id, la.status, la.stage
  FROM customers c JOIN loan_applications la ON la.customer_id = c.id
  WHERE c.salesperson_id IN (${SOURCE_SALESPERSON_IDS.join(",")})
    AND c.merged_into_customer_id IS NULL AND c.status = 'in_progress'
    AND (c.priority IS NULL OR c.priority IN (2, 3))
    AND la.deleted_at IS NULL AND la.status IN ('requested', 'reviewing')
  ORDER BY c.id`;

export function summarize(rows) {
  const t = {};
  for (const r of rows) {
    const k = `${r.salesperson_id}`;
    const p = r.priority == null ? "none" : String(r.priority);
    t[k] ??= { "2": 0, "3": 0, none: 0, total: 0 };
    t[k][p]++; t[k].total++;
  }
  return t;
}

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "T");
}

/** Full online backup; verifies non-empty, integrity_check=ok and same customer count. */
export async function fullBackup(dbPath, backupDir, label) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const target = path.join(backupDir, `customers-${label}-${stamp()}.db`);
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const src = new DatabaseSync(dbPath, { readOnly: true, timeout: 10000 });
      const before = Number(src.prepare("SELECT count(*) n FROM customers").get().n);
      await backup(src, target);
      src.close();
      fs.chmodSync(target, 0o600);
      const size = fs.statSync(target).size;
      if (!size) throw new Error("backup file is empty");
      const chk = new DatabaseSync(target, { readOnly: true });
      const integrity = chk.prepare("PRAGMA integrity_check").get().integrity_check;
      const after = Number(chk.prepare("SELECT count(*) n FROM customers").get().n);
      chk.close();
      if (integrity !== "ok") throw new Error(`integrity_check=${integrity}`);
      if (after !== before || after === 0) throw new Error(`customer count mismatch ${before}/${after}`);
      return { path: target, size, customers: after, integrity };
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(target, { force: true }); } catch {}
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`BACKUP_FAILED: ${lastErr?.message}`);
}

export function openWritable(dbPath) {
  const db = new DatabaseSync(dbPath, { timeout: 15000 });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
