/**
 * One-time book rebalance for team 2 (Mohammad t961s4006):
 *   خردکار (sp 20) P1 in-progress unmerged → اصلانیان (sp 5)
 *   اصلانیان (sp 5) non-P1 in-progress unmerged → خردکار (sp 20)
 *
 * Default: dry-run (no writes). Use --execute to apply on a COPY, never on live.
 * Open cases are skipped unless --force-open-cases is passed.
 *
 * Usage:
 *   CRM_DATABASE_PATH=/path/to/copy.db node scripts/team-sales/move-team2-priorities.mjs
 *   CRM_DATABASE_PATH=/path/to/copy.db node scripts/team-sales/move-team2-priorities.mjs --execute
 *
 * Standalone (node:sqlite only). Does not import the API server, so it can run
 * against a second copy without sharing crm-db's already-open handle.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_DB = "/var/lib/nafisvam/customers.db";
export const FROM_P1 = 20;
export const TO_P1 = 5;
export const FROM_NONP1 = 5;
export const TO_NONP1 = 20;
export const SOURCE = "team2_priority_rebalance";
const WALLET_OPEN_MS = 30 * 60 * 1000;

export function assertSafeDbPath(dbPath) {
  if (!dbPath) throw new Error("Set CRM_DATABASE_PATH to a database COPY.");
  const resolved = path.resolve(dbPath);
  if (resolved === LIVE_DB) throw new Error("Refusing to run against the live database.");
  return resolved;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** Same open-case rules as lib/nonp1-transfer.ts openCaseReason, on a caller-supplied handle. */
export function openCaseReasonOn(db, customerId, now = new Date()) {
  const has = (table, sql, params = []) =>
    tableExists(db, table) && Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE customer_id=? AND ${sql} LIMIT 1`).get(customerId, ...params));
  if (has("loan_applications", "deleted_at IS NULL AND status IN ('requested','reviewing')")) return "loan_application";
  if (has("goods_purchases", "COALESCE(stage,'') <> 'completed'")) return "goods_purchase";
  if (has("customer_payment_orders", "COALESCE(stage,'') <> 'paid'")) return "payment_order";
  if (has("loan_request_drafts", "deleted_at IS NULL AND status='pending_registration'")) return "loan_draft";
  if (has("contract_generations", "deleted_at IS NULL AND superseded_at IS NULL AND status IN ('generated','sent')")) return "contract";
  if (has("wallet_payment_intents", "status='created' AND created_at >= ?", [new Date(now.getTime() - WALLET_OPEN_MS).toISOString()])) return "wallet_payment";
  return null;
}

function classify(db, rows, toSp, forceOpen, now) {
  const move = [];
  const skippedOpen = [];
  for (const r of rows) {
    const open = openCaseReasonOn(db, Number(r.id), now);
    if (open && !forceOpen) { skippedOpen.push({ id: Number(r.id), priority: r.priority ?? null, open }); continue; }
    move.push({ id: Number(r.id), from: Number(r.salesperson_id), to: toSp, priority: r.priority ?? null, open: open ?? null });
  }
  return { move, skippedOpen };
}

export function runMoveTeam2Priorities({ dbPath, executeWrites = false, forceOpen = false, now = new Date() } = {}) {
  const resolved = assertSafeDbPath(dbPath);
  const dryRun = !executeWrites;
  const db = new DatabaseSync(resolved);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const p1Rows = db.prepare(
      `SELECT id, priority, salesperson_id, status FROM customers
       WHERE merged_into_customer_id IS NULL AND status='in_progress'
         AND salesperson_id=? AND priority=1
       ORDER BY id`,
    ).all(FROM_P1);
    const nonP1Rows = db.prepare(
      `SELECT id, priority, salesperson_id, status FROM customers
       WHERE merged_into_customer_id IS NULL AND status='in_progress'
         AND salesperson_id=? AND (priority IS NULL OR priority IN (2,3))
       ORDER BY id`,
    ).all(FROM_NONP1);
    const a = classify(db, p1Rows, TO_P1, forceOpen, now);
    const b = classify(db, nonP1Rows, TO_NONP1, forceOpen, now);
    const plan = {
      dryRun,
      forceOpen: Boolean(forceOpen),
      db: resolved,
      p1ToAslanian: { count: a.move.length, skippedOpen: a.skippedOpen.length, ids: a.move.map((x) => x.id), open: a.skippedOpen },
      nonP1ToKheradkar: { count: b.move.length, skippedOpen: b.skippedOpen.length, ids: b.move.map((x) => x.id), open: b.skippedOpen },
    };
    if (dryRun) return { ...plan, applied: false };

    const at = now.toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      const upd = db.prepare("UPDATE customers SET salesperson_id=? WHERE id=? AND salesperson_id=? AND status='in_progress' AND merged_into_customer_id IS NULL");
      const hist = db.prepare(
        `INSERT INTO customer_priority_history
          (customer_id, old_priority, new_priority, old_salesperson_id, new_salesperson_id, actor_user_id, source, reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (const row of [...a.move, ...b.move]) {
        const info = upd.run(row.to, row.id, row.from);
        if (!info.changes) continue;
        hist.run(row.id, row.priority, row.priority, row.from, row.to, null, SOURCE, "جابه‌جایی یک‌باره اولویت‌های تیم ۲", at);
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* */ }
      throw err;
    }
    return { ...plan, applied: true, at };
  } finally {
    db.close();
  }
}

const isCli = path.basename(fileURLToPath(import.meta.url)) === "move-team2-priorities.mjs";

if (isCli) {
  const args = new Set(process.argv.slice(2));
  try {
    const result = runMoveTeam2Priorities({
      dbPath: process.env.CRM_DATABASE_PATH,
      executeWrites: args.has("--execute") && !args.has("--dry-run"),
      forceOpen: args.has("--force-open-cases"),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message || err);
    process.exit(2);
  }
}
